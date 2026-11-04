import { readXlsx } from './xlsx.js';
import { parseWorkbook, MEMBER_ALIASES } from './sheet.js';
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
  const known = (await env.DB.prepare('SELECT id, name FROM members').all()).results;
  const aliases = { ...MEMBER_ALIASES };
  for (const m of known) aliases[m.name.trim().toLowerCase()] ??= m.id;
  const { movies, seasons, warnings } = parseWorkbook(await readXlsx(buf), aliases);
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
        `INSERT INTO ratings (movie_id, member_id, score, verdict, watched, source, updated_at, rated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'sheet', ?6, ?6)
         ON CONFLICT (movie_id, member_id) DO UPDATE SET
           rated_at = CASE WHEN ratings.score IS excluded.score AND ratings.verdict IS excluded.verdict
                           THEN ratings.rated_at ELSE excluded.rated_at END,
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

const MOVIE_COLS = `m.id, m.season, m.title, m.release_date, m.release_year, m.network, m.network_code, m.imdb,
  m.rec, m.view, m.comment, m.imdb_id, m.poster_url`;
const RATED = `(r.score IS NOT NULL OR r.verdict IS NOT NULL)`;
const MAX_FAVORITES = 4;

// Attaches { ratings: {member: {...}}, favorites: [member ids] } to a list of movie rows.
async function withRatings(env, movies) {
  if (!movies.length) return [];
  // the whole family's ratings are a few hundred rows; cheaper than fighting D1's 100-parameter cap
  const ids = new Set(movies.map((m) => m.id));
  const [allRatings, allFavs] = await env.DB.batch([
    env.DB.prepare('SELECT movie_id, member_id, score, verdict, watched, source, rated_at FROM ratings'),
    env.DB.prepare('SELECT movie_id, member_id FROM favorites ORDER BY created_at'),
  ]);
  const ratings = { results: allRatings.results.filter((r) => ids.has(r.movie_id)) };
  const favs = { results: allFavs.results.filter((f) => ids.has(f.movie_id)) };
  const byMovie = {};
  for (const r of ratings.results) {
    (byMovie[r.movie_id] ||= {})[r.member_id] = { score: r.score, verdict: r.verdict, watched: r.watched, source: r.source, rated_at: r.rated_at };
  }
  const favBy = {};
  for (const f of favs.results) (favBy[f.movie_id] ||= []).push(f.member_id);
  return movies.map((m) => ({ ...m, ratings: byMovie[m.id] || {}, favorites: favBy[m.id] || [] }));
}

// season=2026 etc, or season=rated for every rated movie across all seasons (the Recently rated view)
async function listMovies(url, env) {
  const season = url.searchParams.get('season');
  if (!season) return fail(400, 'season is required');
  const stmt = season === 'rated'
    ? env.DB.prepare(`SELECT ${MOVIE_COLS} FROM movies m WHERE m.missing_since IS NULL
        AND EXISTS (SELECT 1 FROM ratings r WHERE r.movie_id = m.id AND ${RATED})`)
    : season === 'all'
    ? env.DB.prepare(`SELECT ${MOVIE_COLS} FROM movies m WHERE m.missing_since IS NULL
        ORDER BY m.season = 'classics', m.season DESC, m.release_date IS NULL, m.release_date, m.row_order`)
    : env.DB.prepare(`SELECT ${MOVIE_COLS} FROM movies m WHERE m.season = ? AND m.missing_since IS NULL
        ORDER BY m.release_date IS NULL, m.release_date, m.row_order`).bind(season);
  return json(await withRatings(env, (await stmt.all()).results));
}

// Everyone, with what the tree needs: rating count and their #1 favorite's poster.
async function family(env) {
  const { results } = await env.DB.prepare(`
    SELECT p.id, p.name,
      (SELECT COUNT(*) FROM ratings r WHERE r.member_id = p.id AND ${RATED}) AS rated,
      (SELECT m.poster_url FROM favorites f JOIN movies m ON m.id = f.movie_id
        WHERE f.member_id = p.id ORDER BY f.created_at LIMIT 1) AS poster_url,
      (SELECT m.title FROM favorites f JOIN movies m ON m.id = f.movie_id
        WHERE f.member_id = p.id ORDER BY f.created_at LIMIT 1) AS favorite
    FROM members p WHERE p.active = 1 ORDER BY p.sort`).all();
  return json(results);
}

async function profile(url, env) {
  const id = url.searchParams.get('member');
  const member = await env.DB.prepare('SELECT id, name, active FROM members WHERE id = ?').bind(String(id || '')).first();
  if (!member) return fail(404, 'no such family member');
  const [favs, recent, stats] = await env.DB.batch([
    env.DB.prepare(`SELECT ${MOVIE_COLS} FROM favorites f JOIN movies m ON m.id = f.movie_id
      WHERE f.member_id = ? ORDER BY f.created_at`).bind(member.id),
    env.DB.prepare(`SELECT ${MOVIE_COLS} FROM ratings r JOIN movies m ON m.id = r.movie_id
      WHERE r.member_id = ? AND ${RATED} AND m.missing_since IS NULL
      ORDER BY r.rated_at IS NULL, r.rated_at DESC, m.release_date DESC LIMIT 12`).bind(member.id),
    env.DB.prepare(`SELECT COUNT(*) AS rated, AVG(MIN(r.score, 10)) AS avg,
        SUM(r.verdict = 'sucks') AS sucks, SUM(r.score >= 9) AS fives
      FROM ratings r WHERE r.member_id = ? AND ${RATED}`).bind(member.id),
  ]);
  return json({
    member,
    favorites: await withRatings(env, favs.results),
    recent: await withRatings(env, recent.results),
    stats: stats.results[0],
  });
}

async function favorite(request, env, me) {
  const { movie_id, on } = await request.json().catch(() => ({}));
  const movieId = Number(movie_id);
  if (!Number.isInteger(movieId)) return fail(400, 'movie_id is required');
  if (!on) {
    await env.DB.prepare('DELETE FROM favorites WHERE member_id = ? AND movie_id = ?').bind(me, movieId).run();
    return json({ ok: true, on: false });
  }
  const movie = await env.DB.prepare('SELECT id FROM movies WHERE id = ?').bind(movieId).first();
  if (!movie) return fail(404, 'no such movie');
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM favorites WHERE member_id = ? AND movie_id != ?').bind(me, movieId).first();
  if (count.n >= MAX_FAVORITES) return fail(409, `you already have ${MAX_FAVORITES} favorites... un-star one first`);
  await env.DB.prepare('INSERT OR IGNORE INTO favorites (member_id, movie_id, created_at) VALUES (?, ?, ?)')
    .bind(me, movieId, new Date().toISOString()).run();
  return json({ ok: true, on: true });
}

// Read-only CSV for Excel, laid out like Chris's sheet (10-point scores, his verdict codes).
// Never writes to the Google Sheet.
const VERDICT_CODES = { sucks: 'Sucks', 'turned-off': 'TO', skipped: 'DWD' };
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function exportCsv(url, env) {
  const season = url.searchParams.get('season') || 'all';
  const where = season === 'all' ? '' : 'AND m.season = ?';
  const moviesStmt = env.DB.prepare(`SELECT ${MOVIE_COLS} FROM movies m WHERE m.missing_since IS NULL ${where}
    ORDER BY m.season = 'classics', m.season DESC, m.release_date IS NULL, m.release_date, m.row_order`);
  const [members, movies] = await env.DB.batch([
    env.DB.prepare('SELECT id, name FROM members ORDER BY sort'),
    season === 'all' ? moviesStmt : moviesStmt.bind(season),
  ]);
  const rows = await withRatings(env, movies.results);
  const names = Object.fromEntries(members.results.map((m) => [m.id, m.name]));
  // only include people who have rated something in this export
  const people = members.results.filter((p) => rows.some((m) => m.ratings[p.id]));

  const header = ['Season', 'Release Date', 'Name', 'App', 'IMDB', 'Rec', 'View',
    ...people.map((p) => p.name), 'Family Avg', 'Last Rated', 'Favorites', 'Comment', 'IMDb Link'];
  const lines = [header];
  for (const m of rows) {
    const cells = people.map((p) => {
      const r = m.ratings[p.id];
      if (!r) return '';
      if (r.score != null) return r.score;
      if (r.verdict) return VERDICT_CODES[r.verdict] || r.verdict;
      return r.watched ? 'X' : '';
    });
    const scores = Object.values(m.ratings).filter((r) => r.score != null).map((r) => Math.min(r.score, 10));
    const avg = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : '';
    lines.push([
      m.season === 'classics' ? 'Classics' : m.season,
      m.release_date || m.release_year || '',
      m.title, m.network_code || m.network || '', m.imdb ?? '', m.rec || '', m.view || '',
      // newest rating date on the row, so Chris can sort by it and see what changed
      ...cells, avg, Object.values(m.ratings).map((r) => r.rated_at || '').sort().pop()?.slice(0, 10) || '',
      (m.favorites || []).map((id) => names[id] || id).join(', '),
      m.comment || '', m.imdb_id ? `https://www.imdb.com/title/${m.imdb_id}/` : '',
    ]);
  }
  // BOM so Excel reads emoji and accents (Catnip Cafe) as UTF-8
  const body = '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const stamp = new Date().toISOString().slice(0, 10);
  const label = season === 'all' ? 'ratings' : season;
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="christmas-movies-${label}-${stamp}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

async function addMember(request, env) {
  const { name } = await request.json().catch(() => ({}));
  const clean = String(name || '').replace(/\s+/g, ' ').trim();
  if (!/^[\p{L}][\p{L} .'-]{0,23}$/u.test(clean)) return fail(400, 'use a name with letters, up to 24 characters');
  const id = clean.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!id) return fail(400, 'use a name with letters');
  const clash = await env.DB.prepare('SELECT name FROM members WHERE id = ? OR lower(name) = lower(?)').bind(id, clean).first();
  if (clash) return fail(409, `${clash.name} is already in the family`);
  await env.DB.prepare(`INSERT INTO members (id, name, sort, active)
    VALUES (?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM members), 1)`).bind(id, clean).run();
  const members = await env.DB.prepare('SELECT id, name, active FROM members ORDER BY sort').all();
  return json({ ok: true, id, members: members.results });
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
  const now = new Date().toISOString();
  const rating = { score: verdict ? null : score, verdict, watched: 1, source: 'site', rated_at: now };
  await env.DB.prepare(`INSERT INTO ratings (movie_id, member_id, score, verdict, watched, source, updated_at, rated_at)
    VALUES (?1, ?2, ?3, ?4, 1, 'site', ?5, ?5)
    ON CONFLICT (movie_id, member_id) DO UPDATE SET score = excluded.score, verdict = excluded.verdict,
      watched = 1, source = 'site', updated_at = excluded.updated_at, rated_at = excluded.rated_at`)
    .bind(movieId, me, rating.score, rating.verdict, now).run();
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
      if (route === 'GET /api/profile') return profile(url, env);
      if (route === 'GET /api/family') return family(env);
      if (route === 'GET /api/export.csv') return exportCsv(url, env);
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
      if (route === 'POST /api/favorite') return me ? favorite(request, env, me) : fail(401, 'sign in first');
      if (route === 'POST /api/members') return me ? addMember(request, env) : fail(401, 'sign in first');
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
