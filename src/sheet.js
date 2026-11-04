// Turns Chris's tabs into normalized movie rows.
// Columns move around every year, so everything is mapped by header label, never by letter.

export const MEMBER_ALIASES = {
  dad: 'dad', dada: 'dad',
  dana: 'dana', kitty: 'kitty', sniff: 'sniff', robin: 'robin', jen: 'jen',
};

export const NETWORK_NAMES = {
  'hm': 'Hallmark', 'own': 'OWN', 'lmn': 'LMN', 'hulu': 'Hulu', 'hallmark': 'Hallmark', 'hm chan.': 'Hallmark', 'hm+': 'Hallmark+', 'hallmark now': 'Hallmark+',
  'gaf': 'Great American Family', 'gat': 'Great American Family', 'gac': 'GAC Family',
  'uptv': 'UPtv', 'life': 'Lifetime', 'lifet': 'Lifetime', 'lifetime': 'Lifetime', 'lt': 'Lifetime',
  'lmn': 'LMN', 'nflx': 'Netflix', 'nlfx': 'Netflix', 'ntfx': 'Netflix', 'netflix': 'Netflix',
  'prime': 'Prime Video', 'hulu': 'Hulu', 'roku': 'Roku Channel',
  'dsny+': 'Disney+', 'disn+': 'Disney+', 'disn': 'Disney+',
  'appl': 'Apple TV+', 'appl+': 'Apple TV+', 'aptv': 'Apple TV+',
  'freevee': 'Freevee', 'frevee': 'Freevee', 'foxn': 'Fox Nation', 'fox/vudu': 'Fox / Vudu',
  'shudr': 'Shudder', 'shutr': 'Shudder', 'acorn': 'Acorn TV', 'own': 'OWN', 'bet': 'BET+',
  'pt/cbs': 'Paramount+ / CBS', 'prmt': 'Paramount+', 'cbs': 'CBS', 'et/byu': 'BYUtv',
  'nick': 'Nickelodeon', 'tlc+': 'TLC', 'pck': 'Peacock', 'peacock': 'Peacock', 'ion': 'ION',
  'aspire': 'Aspire TV', 'plex/pluto': 'Plex / Pluto',
};

const VERDICTS = { sucks: 'sucks', sckd: 'sucks', sucked: 'sucks', to: 'turned-off', dwd: 'skipped' };

const norm = (v) => String(v ?? '').trim().toLowerCase();
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

export function titleKey(title) {
  return title.toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[’‘`]/g, "'").replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

export function seasonFor(sheetName) {
  if (/^\s*\d{4}\s*$/.test(sheetName)) return sheetName.trim();
  if (/prior/i.test(sheetName)) return 'classics';
  return null;
}

function parseNumber(v) {
  const s = clean(v);
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100) / 100;
}

function parseRelease(v) {
  const s = clean(v);
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return { date: s, year: +m[1] };
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/))) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return { date: `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`, year: y };
  }
  if ((m = s.match(/^(19|20)(\d{2})(\.0+)?$/))) return { date: null, year: +(m[1] + m[2]) };
  return null;
}

function parseCell(v) {
  const s = norm(v);
  if (!s || s === 'n/a') return null;
  const n = parseNumber(s);
  if (n !== null) return { score: Math.max(0, n), verdict: null, watched: 1 };
  if (VERDICTS[s]) return { score: null, verdict: VERDICTS[s], watched: VERDICTS[s] === 'skipped' ? 0 : 1 };
  if (s === 'x') return { score: null, verdict: null, watched: 1 };
  return null;
}

function mapColumns(header, above) {
  const cols = { members: {} };
  const hasImdb = header.some((h) => norm(h) === 'imdb');
  header.forEach((h, j) => {
    const label = norm(h);
    const ab = norm(above[j]);
    if (label === 'name' || label === 'description') cols.title ??= j;
    else if (label === 'date' && ab !== 'show') cols.release ??= j;
    else if (label === 'imdb' || (label === 'rating' && !hasImdb)) cols.imdb ??= j;
    else if (label === 'app' || label === 'network') cols.network ??= j;
    else if (label === 'rec' || label === 'rec?' || label === "rec'd") cols.rec ??= j;
    else if (label === 'view') cols.view ??= j;
    else if (label === 'comment') cols.comment ??= j;
    else {
      const member = MEMBER_ALIASES[label] || (label === 'rate' ? MEMBER_ALIASES[ab] : null);
      if (member && !(member in cols.members)) cols.members[member] = j;
    }
  });
  return cols;
}

// sheets: output of readXlsx(). Returns { movies, seasons, warnings }.
export function parseWorkbook(sheets) {
  const movies = [];
  const seasons = [];
  const warnings = [];

  // classics ('Prior Movies') is a hand-kept list, not a duplicated year tab, so it never counts as older
  const isOlder = (a, b) => /^\d{4}$/.test(a ?? '') && /^\d{4}$/.test(b) && +a < +b;

  for (const sheet of sheets) {
    const season = seasonFor(sheet.name);
    if (!season) { warnings.push(`skipped tab "${sheet.name}"`); continue; }
    const rows = sheet.rows;
    // 'Name' wins; 2020 uses 'Description'. (2022 and Prior have a legend with a Description column above the real header.)
    const isHeader = (label) => (r) => r && r.some((c) => norm(c) === label);
    let h = rows.findIndex(isHeader('name'));
    if (h < 0) h = rows.findIndex(isHeader('description'));
    if (h < 0) { warnings.push(`no header row in "${sheet.name}"`); continue; }
    const cols = mapColumns(rows[h], rows[h - 1] || []);
    seasons.push(season);

    // Chris starts each year by duplicating last year's tab, which drags old notes onto random rows.
    // A note whose text also exists on an older tab is a copy... keep it only where it started.
    const notes = {};
    for (const c of sheet.comments) {
      if (sheets.some((other) => isOlder(seasonFor(other.name), season) && other.comments.some((o) => o.text === c.text))) continue;
      (notes[c.row] ||= []).push(c.text);
    }
    const seen = new Set();

    for (let r = h + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const title = clean(row[cols.title]);
      if (!title) continue;
      const release = cols.release != null ? parseRelease(row[cols.release]) : null;
      const imdb = cols.imdb != null ? parseNumber(row[cols.imdb]) : null;
      const code = cols.network != null ? clean(row[cols.network]) : '';
      // legend / key rows sit in the same grid... a real movie has at least one of these
      if (!release && imdb === null && !code) continue;

      let key = titleKey(title);
      if (!key) continue;
      for (let i = 2; seen.has(key); i++) key = `${titleKey(title)} ~${i}`;
      seen.add(key);

      const ratings = {};
      for (const [member, j] of Object.entries(cols.members)) {
        const cell = parseCell(row[j]);
        if (cell) ratings[member] = cell;
      }
      const comment = [cols.comment != null ? clean(row[cols.comment]) : '', ...(notes[r] || [])]
        .filter(Boolean).join('\n') || null;

      movies.push({
        season,
        title_key: key,
        title,
        row_order: r,
        release_date: release?.date ?? null,
        release_year: release?.year ?? (/^\d{4}$/.test(season) ? +season : null),
        network: code ? (NETWORK_NAMES[norm(code)] || code) : null,
        network_code: code || null,
        imdb: imdb !== null && imdb > 0 && imdb <= 10 ? imdb : null,
        rec: cols.rec != null ? clean(row[cols.rec]) || null : null,
        view: cols.view != null ? clean(row[cols.view]) || null : null,
        comment,
        ratings,
      });
    }
  }
  return { movies, seasons, warnings };
}
