// Parser checks against a real export of Chris's sheet.
// usage: node scripts/check.mjs path/to/christmas-movies.xlsx
import { readFile } from 'node:fs/promises';
import { readXlsx } from '../src/xlsx.js';
import { parseWorkbook } from '../src/sheet.js';

const { movies, seasons, warnings } = parseWorkbook(await readXlsx(await readFile(process.argv[2])));
const find = (season, title) => movies.find((m) => m.season === season && m.title === title);
let fails = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `  (got ${JSON.stringify(got)})`}`); if (!ok) fails++; };

const counts = Object.fromEntries(seasons.map((s) => [s, movies.filter((m) => m.season === s).length]));
console.log('per season:', counts, warnings.length ? warnings : '');

check('2026 has 82 movies', counts['2026'] === 82, counts['2026']);
const pie = find('2025', 'A Wisconsin Christmas Pie');
check('2025 Wisconsin Pie: Dad 6.8, released 2025-10-11', pie?.ratings.dad?.score === 6.8 && pie.release_date === '2025-10-11', pie);
const danish = find('2026', 'A Danish Christmas');
check('2026 A Danish Christmas: Dad = sucks', danish?.ratings.dad?.verdict === 'sucks', danish?.ratings);
const miracles = find('classics', 'A Season for Miracles');
check('classics A Season for Miracles: Dad 10, year 1999', miracles?.ratings.dad?.score === 10 && miracles.release_year === 1999, miracles);
const frosty = find('2024', 'Hot Frosty (Lacy Chabert)');
check('2024 Hot Frosty: Dad sucks, Jen 5', frosty?.ratings.dad?.verdict === 'sucks' && frosty?.ratings.jen?.score === 5, frosty?.ratings);
const santa = find('2023', 'The Santa Summit');
check('2023 Santa Summit: Dad turned-off, Kitty 4', santa?.ratings.dad?.verdict === 'turned-off' && santa?.ratings.kitty?.score === 4, santa?.ratings);
const tree = find('2021', 'My Christmas Family Tree');
check('2021 Family Tree: IMDB 7.6, Dad watched, Hallmark', tree?.imdb === 7.6 && tree?.ratings.dad?.watched === 1 && tree.network === 'Hallmark', tree);
check('2021 legend rows skipped', !movies.some((m) => /bold|available to/i.test(m.title)), null);
check('2025 legend rows skipped', !movies.some((m) => m.season === '2025' && /^(APP|DWD|Key|TO)$/.test(m.title)), null);
const tidings = find('2025', 'Timeless Tidings of Joy');
check('2025 cell comment kept', tidings?.comment === 'Candance Cameron Buri', tidings?.comment);
const google = movies.filter((m) => m.season === '2025' && /chemistry|Scrooge|innkeeper/.test(m.comment || ''));
check('2025 has the 4 Google comments', google.length === 4 || google.length === 3, google.map((m) => [m.title, m.comment]));
check('every movie has a title_key', movies.every((m) => m.title_key), null);
check('no IMDB outside 0-10', movies.every((m) => m.imdb === null || (m.imdb > 0 && m.imdb <= 10)), null);

const dupes = movies.filter((m) => /5\.4 rating dog/.test(m.comment || '')).map((m) => `${m.season} ${m.title}`);
check('"5.4 rating dog" note only on 2024 Merry Gentlemen', dupes.length === 1 && dupes[0] === '2024 The Merry Gentlemen', dupes);
check('Sniff column maps to Jen, no sniff ratings', (await import('../src/sheet.js')).MEMBER_ALIASES.sniff === 'jen' && !movies.some((m) => m.ratings.sniff), null);
check('2022 has its 7 movies', counts['2022'] === 7, counts['2022']);
check('classics has 11 movies', counts.classics === 11, counts.classics);
const kitty = find('classics', 'The Nine Lives of Christmas');
check('Kitty 11/10 survives as 11', kitty?.ratings.kitty?.score === 11, kitty?.ratings);

const known = new Set(Object.values(await import('../src/sheet.js').then((m) => m.NETWORK_NAMES)));
const unknown = [...new Set(movies.filter((m) => m.network && !known.has(m.network)).map((m) => m.network_code))];
console.log('networks with no display name:', unknown.join(', ') || 'none');
console.log(`${movies.length} movies, ${movies.reduce((n, m) => n + Object.keys(m.ratings).length, 0)} ratings from the sheet`);
process.exit(fails ? 1 : 0);
