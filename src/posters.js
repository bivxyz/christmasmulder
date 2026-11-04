// Poster lookup via IMDb's public title-suggestion endpoint (no API key).
// Strict on purpose: a wrong poster is worse than the placeholder.
import { titleKey } from './sheet.js';

const TYPES = new Set(['movie', 'tvMovie', 'tvSeries', 'tvMiniSeries', 'tvSpecial', 'video']);

function similarity(a, b) {
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return (2 * both) / (A.size + B.size);
}

// IMDb image URLs accept size hints; ask for a small thumbnail.
const thumb = (url) => url.replace(/\._V1_.*?\.(jpg|png)$/i, '._V1_QL75_UX240_.$1');

export async function lookupPoster(title, year) {
  const key = titleKey(title.replace(/\s*\((?:[^)]*)\)\s*$/, '').replace(/\s+season\s+\d+$/i, '')); // drop "(Lacy Chabert)" style notes
  if (!key) return null;
  const res = await fetch(`https://v3.sg.media-imdb.com/suggestion/${key[0]}/${encodeURIComponent(key)}.json`, {
    headers: { 'user-agent': 'Mozilla/5.0 (christmasmulder.com family movie list)' },
  });
  if (!res.ok) throw new Error(`imdb suggestion HTTP ${res.status}`);
  const { d = [] } = await res.json();

  let best = null;
  for (const c of d) {
    if (!TYPES.has(c.qid) || !c.id?.startsWith('tt')) continue;
    const sim = titleKey(c.l || '') === key ? 1 : similarity(key, titleKey(c.l || ''));
    const yearOk = !year || !c.y || Math.abs(c.y - year) <= 1;
    if (!yearOk || sim < 0.8) continue;
    const score = sim + (c.y === year ? 0.1 : 0) + (c.qid === 'tvMovie' ? 0.05 : 0);
    if (!best || score > best.score) best = { score, imdb_id: c.id, poster_url: c.i?.imageUrl ? thumb(c.i.imageUrl) : null };
  }
  return best && { imdb_id: best.imdb_id, poster_url: best.poster_url };
}

// Checks up to `limit` movies that haven't been looked up yet. Returns counts.
export async function backfillPosters(env, limit = 40) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, season, release_year FROM movies
     WHERE poster_checked_at IS NULL AND missing_since IS NULL
     ORDER BY season = 'classics', season DESC, row_order LIMIT ?`,
  ).bind(limit).all();
  let found = 0;
  const now = new Date().toISOString();
  for (const m of results) {
    let hit = null;
    try {
      hit = await lookupPoster(m.title, m.release_year);
    } catch (err) {
      console.error('poster lookup failed', m.title, err.message);
      break; // try the rest next run
    }
    if (hit?.poster_url) found++;
    await env.DB.prepare('UPDATE movies SET imdb_id = ?, poster_url = ?, poster_checked_at = ? WHERE id = ?')
      .bind(hit?.imdb_id ?? null, hit?.poster_url ?? null, now, m.id).run();
  }
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM movies WHERE poster_checked_at IS NULL AND missing_since IS NULL').first();
  return { checked: results.length, found, remaining: left.n };
}
