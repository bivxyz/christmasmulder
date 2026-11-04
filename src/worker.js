import { readXlsx } from './xlsx.js';
import { parseWorkbook } from './sheet.js';
import { currentMember, sessionCookie, clearCookie, safeEqual } from './auth.js';
import { backfillPosters } from './posters.js';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});
const fail = (status, error) => json({ error }, status);

// ---------- sheet sync (the sheet is the master for the movie list) ----------

async function fetchSheet(env) {
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${env.SHEET_ID}/export?format=xlsx`, { redirect: 'follow' });
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 2));
  if (!res.ok || head[0] !== 0x50 || head[1] !== 0x4b) {
    throw new Error(`couldn't download the sheet (HTTP ${res.status}). Is link sharing set to "Anyone with the link"?`);
  }
  return buf;
}

async function batched(db, statements, size = 80) {
  for (let i = 0; i < statements.length; i += size) await db.batch(statements.slice(i, i + size));
}

export async function syncFromXlsx(env, buf, via) {
  const { movies, seasons, warnings } = parseWorkbook(await readXlsx(buf));
  if (movies.length < 20) throw new Error(`only found ${movies.length} movies in the sheet... refusing to sync`);
  const db = env.DB;
  const now = new Date().toISOString();

  await batched(db, movies.map((m) => db.prepare(
    `INSERT INTO movies (season, title_key, title, row_order, release_date, release_year, network, network_code, imdb, rec, view, comment, missing_since, synced_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, ?13)
     ON CONFLICT (season, title_key) DO UPDATE SET
       title = excluded.title, row_order = excluded.row_order, release_date = excluded.release_date,
       release_year = excluded.release_year, network = excluded.network, network_code = excluded.network_code,
       imdb = excluded.imdb, rec = excluded.rec, view = excluded.view, comment = excluded.comment,
       missing_since = NULL, synced_at = excluded.synced_at`,
  ).bind(m.season, m.title_key, m.title, m.row_order, m.release_date, m.release_year, m.network,
    m.network_code, m.imdb, m.rec, m.view, m.comment, now)));

  const inSeasons = `season IN (${seasons.map(() => '?').join(',')})`;
  const missing = await db.prepare(
    `UPDATE movies SET missing_since = ? WHERE ${inSeasons} AND synced_at < ? AND missing_since IS NULL`,
  ).bind(now, ...seasons, now).run();

  const ids = new Map((await db.prepare('SELECT id, season, title_key FROM movies').all()).results
    .map((r) => [`${r.season}|${r.title_key}`, r.id]));

  const ratingStatements = [];
  for (const m of movies) {
    const movieId = ids.get(`${m.season}|${m.title_key}`);
    for (const [member, r] of Object.entries(m.ratings)) {
      ratingStatements.push(db.prepare(
        `INSERT INTO ratings (movie_id, member_id, score, verdict, watched, source, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'sheet', ?6)
         ON CONFLICT (movie_id, member_id) DO UPDATE SET
           score = excluded.score, verdict = excluded.verdict, watched = excluded.watched, updated_at = excluded.updated_at
         WHERE ratings.source = 'sheet'`,
      ).bind(movieId, member, r.score, r.verdict, r.watched, now));
    }
  }
  await batched(db, ratingStatements);

  // a rating cleared in the sheet goes away here too (site ratings are never touched)
  await db.prepare(
    `DELETE FROM ratings WHERE source = 'sheet' AND updated_at < ?
       AND movie_id IN (SELECT id FROM movies WHERE ${inSeasons})`,
  ).bind(now, ...seasons).run();

  const summary = { at: now, via, movies: movies.length, ratings: ratingStatements.length, missing: missing.meta.changes, warnings };
  await db.prepare(`INSERT INTO meta (key, value) VALUES ('last_sync', ?1)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(JSON.stringify(summary)).run();
  return summary;
}

// ---------- api ----------

async function bootstrap(request, env) {
  const [members, seasons, meta] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, active FROM members ORDER BY sort'),
    env.DB.prepare('SELECT season, COUNT(*) AS movies FROM movies WHERE missing_since IS NULL GROUP BY season'),
    env.DB.prepare(`SELECT value FROM meta WHERE key = 'last_sync'`),
  ]);
  const order = (s) => (s === 'classics' ? -1 : +s);
  return json({
    me: await currentMember(request, env),
    members: members.results,
    seasons: seasons.results.sort((a, b) => order(b.season) - order(a.season)),
    lastSync: meta.results[0] ? JSON.parse(meta.results[0].value) : null,
  });
}

async function listMovies(url, env) {
  const season = url.searchParams.get('season');
  if (!season) return fail(400, 'season is required');
  const [movies, ratings] = await env.DB.batch([
    env.DB.prepare(`SELECT id, title, release_date, release_year, network, network_code, imdb, rec, view, comment, imdb_id, poster_url
      FROM movies WHERE season = ? AND missing_since IS NULL ORDER BY release_date IS NULL, release_date, row_order`).bind(season),
    env.DB.prepare(`SELECT r.movie_id, r.member_id, r.score, r.verdict, r.watched, r.source FROM ratings r
      JOIN movies m ON m.id = r.movie_id WHERE m.season = ? AND m.missing_since IS NULL`).bind(season),
  ]);
  const byMovie = {};
  for (const r of ratings.results) {
    (byMovie[r.movie_id] ||= {})[r.member_id] = { score: r.score, verdict: r.verdict, watched: r.watched, source: r.source };
  }
  return json(movies.results.map((m) => ({ ...m, ratings: byMovie[m.id] || {} })));
}

async function login(request, env, secure) {
  const { member, code } = await request.json().catch(() => ({}));
  const row = await env.DB.prepare('SELECT id FROM members WHERE id = ? AND active = 1').bind(String(member || '')).first();
  if (!row) return fail(400, 'pick your name');
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const tries = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND at > ?').bind(ip, hourAgo).first();
  if (tries.n >= 10) return fail(429, 'too many wrong codes... try again in an hour');
  if (!env.FAMILY_CODE || !safeEqual(String(code || '').trim().toLowerCase(), env.FAMILY_CODE.trim().toLowerCase())) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO login_failures (ip, at) VALUES (?, ?)').bind(ip, new Date().toISOString()),
      env.DB.prepare('DELETE FROM login_failures WHERE at < ?').bind(new Date(Date.now() - 86400_000).toISOString()),
    ]);
    await new Promise((r) => setTimeout(r, 800));
    return fail(401, "that's not the family code");
  }
  return json({ me: row.id }, 200, { 'set-cookie': await sessionCookie(env, row.id, secure) });
}

async function rate(request, env, me) {
  const body = await request.json().catch(() => ({}));
  const movieId = Number(body.movie_id);
  const score = body.score == null ? null : Number(body.score);
  const verdict = body.verdict == null ? null : String(body.verdict);
  if (!Number.isInteger(movieId)) return fail(400, 'movie_id is required');
  if (score !== null && !(Number.isInteger(score) && score >= 1 && score <= 10)) return fail(400, 'score is 1-10 (half stars x 2)');
  if (verdict !== null && !['sucks', 'turned-off'].includes(verdict)) return fail(400, 'unknown verdict');
  const movie = await env.DB.prepare('SELECT id FROM movies WHERE id = ?').bind(movieId).first();
  if (!movie) return fail(404, 'no such movie');

  if (score === null && verdict === null) {
    // clearing your site rating... the sheet's value (if any) comes back on the next sync
    await env.DB.prepare('DELETE FROM ratings WHERE movie_id = ? AND member_id = ?').bind(movieId, me).run();
    return json({ ok: true, rating: null });
  }
  const rating = { score: verdict ? null : score, verdict, watched: 1, source: 'site' };
  await env.DB.prepare(`INSERT INTO ratings (movie_id, member_id, score, verdict, watched, source, updated_at)
    VALUES (?1, ?2, ?3, ?4, 1, 'site', ?5)
    ON CONFLICT (movie_id, member_id) DO UPDATE SET score = excluded.score, verdict = excluded.verdict,
      watched = 1, source = 'site', updated_at = excluded.updated_at`)
    .bind(movieId, me, rating.score, rating.verdict, new Date().toISOString()).run();
  return json({ ok: true, rating });
}

async function syncNow(env) {
  const last = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'last_sync'`).first();
  if (last && Date.now() - Date.parse(JSON.parse(last.value).at) < 60_000) return fail(429, 'synced less than a minute ago');
  return json(await syncFromXlsx(env, await fetchSheet(env), 'button'));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const secure = url.protocol === 'https:';
    const route = `${request.method} ${url.pathname}`;
    try {
      if (route === 'GET /api/bootstrap') return bootstrap(request, env);
      if (route === 'GET /api/movies') return listMovies(url, env);
      if (route === 'POST /api/login') return login(request, env, secure);
      if (route === 'POST /api/logout') return json({ ok: true }, 200, { 'set-cookie': clearCookie(secure) });

      if (route === 'POST /api/import' || route === 'POST /api/posters') {
        const auth = request.headers.get('authorization') || '';
        if (!env.ADMIN_TOKEN || !safeEqual(auth, `Bearer ${env.ADMIN_TOKEN}`)) return fail(401, 'admin token required');
        if (route === 'POST /api/posters') return json(await backfillPosters(env, Math.min(+url.searchParams.get('limit') || 40, 45)));
        return json(await syncFromXlsx(env, await request.arrayBuffer(), 'import'));
      }

      const me = await currentMember(request, env);
      if (route === 'POST /api/rate') return me ? rate(request, env, me) : fail(401, 'sign in to rate');
      if (route === 'POST /api/sync') return me ? syncNow(env) : fail(401, 'sign in first');
      return fail(404, 'not found');
    } catch (err) {
      console.error(err);
      return fail(500, err.message);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try { await syncFromXlsx(env, await fetchSheet(env), 'cron'); } catch (err) { console.error('sync failed:', err.message); }
      try { console.log('posters', await backfillPosters(env, 40)); } catch (err) { console.error('posters failed:', err.message); }
    })());
  },
};
