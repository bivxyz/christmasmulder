const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const state = { me: null, account: null, members: [], seasons: [], season: null, view: 'season', movies: [], lastSync: null };
const today = new Date().toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- rendering helpers ----------

const seasonLabel = (s) => (s === 'classics' ? 'Classics' : s);
const memberName = (id) => state.members.find((m) => m.id === id)?.name || id;
const isFamily = (id) => !!state.members.find((m) => m.id === id)?.is_family;
const amFamily = () => !!state.account?.is_family;
const stars = (score10) => Math.min(score10, 10) / 2;
const fmtStars = (n) => (Number.isInteger(n) ? `${n}` : n.toFixed(1));
// Stars or /10 is only how ratings read. Both views use the same stored 1-10 scores.
let scale = store.get('scale') === 'ten' ? 'ten' : 'stars';
const ten = () => scale === 'ten';
const fmtTen = (n) => (Number.isInteger(n) ? `${n}` : (Math.round(n * 10) / 10).toFixed(1));
// an average, in whichever scale is showing
const avgText = (score10) => (ten() ? fmtTen(score10) : `${fmtStars(Math.round(stars(score10) * 10) / 10)}★`);

function starsHtml(score10, small) {
  const pct = score10 == null ? 0 : Math.min(score10, 10) * 10;
  return `<span class="stars${small ? ' stars--sm' : ''}" style="--pct:${pct}%" role="img"
    aria-label="${score10 == null ? 'no rating' : `${fmtStars(stars(score10))} of 5 stars`}"><span class="stars__fill"></span></span>`;
}

function dateHtml(m) {
  if (m.release_date) {
    const [, mo, d] = m.release_date.split('-');
    const up = m.release_date > today;
    return `${MONTHS[+mo - 1]} ${+d}${up ? '<small>🔜 coming up</small>' : ''}`;
  }
  return m.release_year ? `${m.release_year}` : '';
}

function chip(memberId, r, fav) {
  return chipBody(memberId, r || {}, fav)
    .replace(/^<span class="([^"]*)"/, `<a href="/u/${memberId}" data-nav class="$1"`).replace(/<\/span>$/, '</a>');
}

function chipBody(memberId, r, fav) {
  const name = esc(memberName(memberId)) + (fav ? ' 🌟' : '');
  if (!r.score && r.score !== 0 && !r.verdict && !r.watched) return `<span class="chip" title="One of their favorites">${name}</span>`;
  const from = r.source === 'sheet' ? ' (from the sheet)' : '';
  if (r.score != null) {
    const extra = r.score > 10 ? ` ... a ${r.score}/10!` : '';
    const fire = r.score > 10 ? ' 🔥' : '';
    const half = Math.round(stars(r.score) * 2) / 2; // star chips speak the half-star scale; exact score on hover
    const shown = ten() ? fmtTen(r.score) : `${fmtStars(half)}★`;
    return `<span class="chip" title="${r.score}/10${from}${extra}">${name} <b>${shown}</b>${fire}</span>`;
  }
  if (r.verdict === 'sucks') return `<span class="chip" title="It sucked${from}">${name} 💩</span>`;
  if (r.verdict === 'turned-off') return `<span class="chip" title="Turned it off${from}">${name} 📴</span>`;
  if (r.verdict === 'skipped') return `<span class="chip chip--plain" title="Recorded it, deleted it unwatched">${name} 🗑️</span>`;
  if (r.watched) return `<span class="chip chip--plain" title="Watched it">${name} 👀</span>`;
  return '';
}

function avgOf(ratings) {
  const scores = ratings.filter((r) => r.score != null).map((r) => Math.min(r.score, 10));
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}
const familyAvg = (m) => avgOf(Object.entries(m.ratings).filter(([id]) => isFamily(id)).map(([, r]) => r));
const everyoneAvg = (m) => avgOf(Object.values(m.ratings));
const scoredBy = (m, family) => Object.entries(m.ratings).filter(([id, r]) => r.score != null && (!family || isFamily(id))).length;
const FRIEND_CHIPS = 6;

function familyHtml(m) {
  const avg = familyAvg(m);
  let head;
  if (avg == null) head = '<span class="family__none">No family ratings yet 🍿</span>';
  else if (ten()) {
    // /10 puts the family right next to IMDb, same scale
    head = `<div class="family__avg"><span class="ten" title="Family average">${fmtTen(avg)}<small>/10 family</small></span>`
      + `${m.imdb != null ? `<span class="family__imdb">IMDb ${m.imdb.toFixed(1)}</span>` : ''}</div>`;
  } else head = `<div class="family__avg">${starsHtml(avg)} <b title="${avg.toFixed(1)}/10">${fmtStars(Math.round(stars(avg) * 10) / 10)}</b></div>`;
  // Everyone only says something once a friend has rated
  const everyone = everyoneAvg(m);
  const all = scoredBy(m, false);
  const foot = all > scoredBy(m, true) && everyone != null
    ? `<div class="family__everyone" title="${everyone.toFixed(1)}/10">Everyone ${avgText(everyone)} · ${all} ${all === 1 ? 'rating' : 'ratings'}</div>` : '';
  const favs = m.favorites || [];
  const shows = (mem) => (m.ratings[mem.id] || favs.includes(mem.id)) && mem.id !== state.me;
  const fam = state.members.filter((mem) => mem.is_family && shows(mem));
  const friends = state.members.filter((mem) => !mem.is_family && shows(mem));
  const chips = fam.map((mem) => chip(mem.id, m.ratings[mem.id], favs.includes(mem.id))).join('')
    + friends.slice(0, FRIEND_CHIPS).map((mem) => chip(mem.id, m.ratings[mem.id], favs.includes(mem.id)).replace('class="chip', 'class="chip chip--friend')).join('')
    + (friends.length > FRIEND_CHIPS ? `<span class="chip chip--plain">+${friends.length - FRIEND_CHIPS} more</span>` : '');
  return `${head}${foot}${chips ? `<div class="chips">${chips}</div>` : ''}`;
}

function mineHtml(m) {
  if (!state.me) return '';
  const r = m.ratings[state.me];
  const score = r?.score ?? null;
  const sucks = r?.verdict === 'sucks';
  const fromSheet = r?.source === 'sheet' ? ' <span title="Imported from Chris\'s sheet">(sheet)</span>' : '';
  let input;
  if (ten()) {
    // same 1-10 as two taps per star; a sheet decimal like 6.8 shows in the label, no button lights up
    const btns = Array.from({ length: 10 }, (_, i) => `<button type="button" data-ten="${i + 1}" aria-pressed="${score === i + 1}" aria-label="${i + 1} out of 10">${i + 1}</button>`).join('');
    input = `<div class="tens" data-movie="${m.id}">${btns}</div>`;
  } else {
    const hits = Array.from({ length: 10 }, (_, i) => `<button type="button" data-score="${i + 1}" aria-label="${(i + 1) / 2} stars"></button>`).join('');
    input = `<span class="rater" data-movie="${m.id}">${starsHtml(score)}<span class="rater__hit">${hits}</span></span>`;
  }
  const exact = ten() && score != null && !Number.isInteger(score) ? `: ${fmtTen(score)}` : '';
  return `<span class="mine__label">Your rating${exact}${fromSheet}</span>
    <div class="mine__row">
      ${input}
      <button type="button" class="pill pill--poop" data-sucks="${m.id}" aria-pressed="${sucks}" title="It sucked" aria-label="It sucked">💩</button>
      <button type="button" class="pill pill--fav" data-fav="${m.id}" aria-pressed="${(m.favorites || []).includes(state.me)}" title="One of my favorites" aria-label="One of my favorites">🌟</button>
      ${r?.source === 'site' ? `<button type="button" class="pill pill--clear" data-clear="${m.id}" title="Remove my rating">✕ clear</button>` : ''}
    </div>`;
}

function movieHtml(m) {
  const up = m.release_date && m.release_date > today;
  const meta = [
    m.network ? `<span title="${esc(m.network_code)}">${esc(m.network)}</span>` : '',
    // in /10 view IMDb sits beside the family score instead
    m.imdb != null && !(ten() && familyAvg(m) != null) ? `IMDb ${m.imdb.toFixed(1)}` : '',
    state.view !== 'season' && m.season ? seasonLabel(m.season) : '',
    $('#sort').value === 'recent' ? lastRatedText(m) : '',
  ].filter(Boolean).join(' · ');
  const imdbUrl = m.imdb_id ? `https://www.imdb.com/title/${m.imdb_id}/` : null;
  const poster = m.poster_url
    ? `<img class="poster" src="${esc(m.poster_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=&quot;poster poster--empty&quot;>🎄</span>'">`
    : '<span class="poster poster--empty" aria-hidden="true">🎄</span>';
  const title = imdbUrl ? `<a href="${imdbUrl}" target="_blank" rel="noopener">${esc(m.title)}</a>` : esc(m.title);
  return `<li class="movie${up ? ' upcoming' : ''}" data-id="${m.id}">
    <div class="movie__date">${dateHtml(m)}</div>
    ${imdbUrl ? `<a href="${imdbUrl}" target="_blank" rel="noopener" tabindex="-1">${poster}</a>` : poster}
    <div class="movie__main">
      <h3 class="movie__title">${title}</h3>
      <div class="movie__meta">${meta}</div>
      ${m.comment ? `<p class="movie__comment">${esc(m.comment)}</p>` : ''}
    </div>
    <div class="movie__family">${familyHtml(m)}</div>
    <div class="movie__mine">${mineHtml(m)}</div>
  </li>`;
}

// ---------- views ----------

function renderScale() {
  for (const b of document.querySelectorAll('[data-scale]')) b.setAttribute('aria-pressed', b.dataset.scale === scale);
}

function setScale(next) {
  if (next === scale) return;
  scale = next;
  store.set('scale', scale);
  renderScale();
  renderMovies(); // the toggle lives on the list; profiles pick it up next time they open
}

function renderMe() {
  if (!state.me) { $('#me').innerHTML = '<button id="signin">Sign in to rate</button>'; return; }
  const links = [
    amFamily() ? '<button class="link" id="invite-open">invite friends</button>' : '',
    '<button class="link" id="logout">sign out</button>',
  ].filter(Boolean).join(' · ');
  $('#me').innerHTML = `Rating as <a href="/u/${state.me}" data-nav><b>${esc(memberName(state.me))}</b></a> 🌟<br>${links}`;
}

// Two tabs: Movies and Family.
// On the movie list, the Movies tab is a native year picker (phones get their own scroll wheel).
// Anywhere else it's a plain tab that takes you back to the season you were on.
function renderSeasons() {
  const onMovies = state.view === 'season' || state.view === 'rated' || state.view === 'search';
  const current = state.season || state.seasons[0]?.season;
  let movies;
  if (onMovies) {
    const options = state.seasons.map((s) =>
      `<option value="${s.season}"${state.view === 'season' && s.season === state.season ? ' selected' : ''}>${seasonLabel(s.season)}</option>`).join('');
    const all = state.view === 'rated' || state.view === 'search' ? '<option value="" selected>All years</option>' : '';
    movies = `<label class="tab tab--picker" aria-current="true">🎬
      <select id="season-pick" aria-label="Season">${all}${options}</select></label>`;
  } else {
    movies = `<button type="button" class="tab" id="movies-tab">🎬 ${current ? seasonLabel(current) : 'Movies'}</button>`;
  }
  $('#seasons').innerHTML = movies
    + `<a href="/family" data-nav class="tab" aria-current="${state.view === 'family'}">🧦 Family</a>`;
}

function renderNetworks() {
  const counts = {};
  for (const m of state.movies) if (m.network) counts[m.network] = (counts[m.network] || 0) + 1;
  const current = $('#network').value;
  $('#network').innerHTML = '<option value="">All networks</option>' + Object.entries(counts)
    .sort((a, b) => b[1] - a[1]).map(([n, c]) => `<option value="${esc(n)}">${esc(n)} (${c})</option>`).join('');
  if (counts[current]) $('#network').value = current;
}

// a real verdict, not just a 2021-style "watched" check mark
const hasRated = (r) => r && (r.score != null || r.verdict);
const latestRating = (m, who) => (who ? [m.ratings[who]] : Object.values(m.ratings))
  .filter(hasRated).map((r) => r.rated_at || '').sort().pop() || '';

function renderBy() {
  const current = $('#by').value;
  const opts = (list) => list.map((m) => `<option value="${m.id}">Rated by ${esc(m.name)}</option>`).join('');
  const fam = state.members.filter((m) => m.is_family);
  const friends = state.members.filter((m) => !m.is_family);
  $('#by').innerHTML = '<option value="">Rated by anyone</option>'
    + (friends.length ? `<optgroup label="Family">${opts(fam)}</optgroup><optgroup label="Friends">${opts(friends)}</optgroup>` : opts(fam));
  $('#by').value = current;
  syncPersonSort();
}

// "Dana's score" sort only exists while a person is picked
function syncPersonSort() {
  const by = $('#by').value;
  const opt = $('#sort').querySelector('[value="person"]');
  opt.hidden = opt.disabled = !by;
  opt.textContent = by ? `${memberName(by)}'s score` : 'Their score';
  if (!by && $('#sort').value === 'person') $('#sort').value = 'date';
}

function renderMovies() {
  const q = $('#q').value.trim().toLowerCase();
  const network = $('#network').value;
  const show = $('#show').value;
  const who = $('#by').value;
  const sort = $('#sort').value;
  let list = state.movies.filter((m) => {
    if (q && !m.title.toLowerCase().includes(q)) return false;
    if (network && m.network !== network) return false;
    if (who && !hasRated(m.ratings[who])) return false;
    const up = m.release_date && m.release_date > today;
    if (show === 'aired' && up) return false;
    if (show === 'upcoming' && !up) return false;
    if (show === 'unrated' && (!state.me || m.ratings[state.me])) return false;
    return true;
  });
  const by = {
    family: (a, b) => (familyAvg(b) ?? -1) - (familyAvg(a) ?? -1),
    everyone: (a, b) => (everyoneAvg(b) ?? -1) - (everyoneAvg(a) ?? -1),
    imdb: (a, b) => (b.imdb ?? -1) - (a.imdb ?? -1),
    title: (a, b) => a.title.localeCompare(b.title),
    // newest first; old sheet ratings (no timestamp) fall to the bottom in air-date order
    recent: (a, b) => latestRating(b, who).localeCompare(latestRating(a, who)),
    // sucks counts below any star score
    person: (a, b) => personScore(b, who) - personScore(a, who),
  }[sort];
  if (by) list = [...list].sort(by);

  if (sort === 'recent') list = list.filter((m) => Object.values(m.ratings).some(hasRated));
  $('#count').textContent = (state.view === 'search' ? `${list.length} ${list.length === 1 ? 'match' : 'matches'} across every season`
    : state.view === 'rated' ? `${list.length} rated movies across every season` : `${list.length} of ${state.movies.length} movies`)
    + (show === 'unrated' && !state.me ? '... sign in to see what you haven\'t rated' : '');
  $('#movies').innerHTML = list.map(movieHtml).join('');
}

function lastRatedText(m) {
  const who = $('#by').value;
  const entries = Object.entries(m.ratings).filter(([id, r]) => hasRated(r) && r.rated_at && (!who || id === who));
  if (!entries.length) return '';
  const [id, r] = entries.sort((a, b) => b[1].rated_at.localeCompare(a[1].rated_at))[0];
  return `${esc(memberName(id))} rated ${timeAgo(r.rated_at)}`;
}

function personScore(m, who) {
  const r = m.ratings[who];
  if (!r) return -3;
  if (r.score != null) return r.score;
  return r.verdict === 'sucks' ? -1 : -2;
}

function renderFooter() {
  const s = state.lastSync;
  const ago = s ? timeAgo(s.at) : 'never';
  $('#footer').innerHTML = `Movies come straight from Chris's Google Sheet. Last synced ${ago}.`
    + (amFamily() ? ' <button type="button" id="sync">🔄 Sync now</button>' : '');
}

function timeAgo(iso) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} hr ago`;
  return `${Math.round(min / 1440)} days ago`;
}

// ---------- actions ----------

function showList() {
  $('#list-view').hidden = false;
  $('#profile-view').hidden = true;
}

async function loadSeason(season) {
  if (location.pathname !== '/') history.pushState(null, '', '/');
  document.title = 'CHRIStmas Mulder';
  showList();
  state.view = 'season';
  if ($('#sort').value === 'recent') $('#sort').value = 'date';
  $('#q').value = '';
  state.season = season;
  store.set('season', season);
  renderSeasons();
  $('#movies').innerHTML = '';
  $('#count').textContent = 'Loading...';
  state.movies = await api(`/api/movies?season=${encodeURIComponent(season)}`);
  renderNetworks();
  renderMovies();
}

// Recently rated looks across every season
// Search looks through every season, not just the year in the picker
async function loadAll() {
  showList();
  state.view = 'search';
  renderSeasons();
  $('#count').textContent = 'Searching every season...';
  state.movies = await api('/api/movies?season=all');
  renderNetworks();
  renderMovies();
}

async function loadRated() {
  showList();
  state.view = 'rated';
  renderSeasons();
  $('#movies').innerHTML = '';
  $('#count').textContent = 'Loading...';
  state.movies = await api('/api/movies?season=rated');
  renderNetworks();
  renderMovies();
}

function posterCard(m) {
  const img = m.poster_url
    ? `<img src="${esc(m.poster_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : '<span class="fav__empty">🎄</span>';
  return `<a class="fav" href="${m.imdb_id ? `https://www.imdb.com/title/${m.imdb_id}/` : '#'}" target="_blank" rel="noopener">
    ${img}<span class="fav__title">${esc(m.title)}</span><span class="fav__season">${seasonLabel(m.season)}</span></a>`;
}

async function showProfile(id) {
  $('#list-view').hidden = true;
  const view = $('#profile-view');
  view.hidden = false;
  state.view = 'profile';
  renderSeasons();
  view.innerHTML = '<p class="count">Loading...</p>';
  let data;
  try { data = await api(`/api/profile?member=${encodeURIComponent(id)}`); } catch (err) {
    view.innerHTML = `<p class="count">${esc(err.message)}</p>`;
    return;
  }
  const { member, favorites, recent, stats } = data;
  const seen = new Set();
  state.movies = [...favorites, ...recent].filter((m) => !seen.has(m.id) && seen.add(m.id));
  const mine = member.id === state.me;
  const slots = [...favorites.map(posterCard)];
  while (slots.length < 4) slots.push(`<div class="fav fav--slot"><span class="fav__empty">🌟</span><span class="fav__title">${mine ? 'Star a movie to fill this' : 'Empty'}</span></div>`);
  const avg = stats.avg != null ? `${avgText(stats.avg)} average` : null;
  const statLine = [
    `${stats.rated || 0} rated`, avg, stats.fives ? `${stats.fives} rated ${ten() ? '9' : '4.5★'} or better` : null, stats.sucks ? `${stats.sucks} 💩` : null,
  ].filter(Boolean).join(' · ');
  document.title = `${member.name} · CHRIStmas Mulder`;
  const who = member.is_family ? '🧦 Family' : `Friend${member.invited_by ? `, invited by ${esc(member.invited_by)}` : ''}`;
  const famToggle = amFamily() && !mine
    ? `<button type="button" class="link" data-family="${esc(member.id)}" data-on="${member.is_family ? 0 : 1}">${member.is_family ? 'take down their stocking' : '🧦 hang a stocking (add to the family)'}</button>` : '';
  const keyBtn = mine
    ? `<button type="button" class="link" data-key="${esc(member.id)}">🔗 my sign-in link</button>`
    : amFamily() ? `<button type="button" class="link" data-key="${esc(member.id)}">🔗 make a sign-in link for ${esc(member.name)}</button>` : '';
  const leave = mine && !member.is_family
    ? '<button type="button" class="link link--danger" id="delete-account">delete my account</button>' : '';
  view.innerHTML = `<a href="/" data-nav class="back">← All movies</a>
    <h2 class="profile__name">${esc(member.name)}${mine ? ' <small>(you)</small>' : ''}</h2>
    <p class="profile__stats">${who} · ${statLine}</p>
    ${keyBtn || famToggle || leave ? `<p class="profile__actions">${keyBtn}${famToggle}${leave}</p>` : ''}
    <h3 class="profile__h">🌟 Favorites</h3>
    <div class="favs">${slots.join('')}</div>
    <h3 class="profile__h">Recent ratings</h3>
    ${recent.length ? `<ol class="movies">${recent.map(movieHtml).join('')}</ol>` : '<p class="count">Nothing rated yet.</p>'}
    <h3 class="profile__h">More of the family</h3>
    <div class="strip" id="family-strip"></div>`;
  const people = await api('/api/family').catch(() => []);
  const strip = $('#family-strip');
  if (strip) strip.innerHTML = people.map((p, i) => (p.id === member.id ? '' : stocking(p, i, true))).join('')
    + '<a class="strip__all" href="/family" data-nav>🧦 Whole family</a>';
}

// stocking colors from the site palette: [body, stripe/toe]
const STOCKINGS = [['#a4161a', '#e8c25a'], ['#1e5631', '#e8c25a'], ['#d4a017', '#a4161a'], ['#1e5631', '#fffaf2'], ['#a4161a', '#fffaf2'], ['#d4a017', '#1e5631']];
const INK = '#2b1d17';
const CUFF = '#fffaf2';

function stockingSvg(i, uid) {
  const [body, accent] = STOCKINGS[i % STOCKINGS.length];
  const leg = 'M16 46 V104 C16 140 38 152 62 152 H86 C100 152 106 142 106 130 C106 118 98 110 84 108 L74 106 V46 Z';
  return `<svg viewBox="0 0 110 160" aria-hidden="true">
    <defs><clipPath id="leg-${uid}"><path d="${leg}"/></clipPath></defs>
    <rect x="50" y="0" width="10" height="14" rx="2" fill="${INK}"/>
    <path d="${leg}" fill="${body}"/>
    <g clip-path="url(#leg-${uid})" fill="none" stroke-width="6" stroke-linejoin="round">
      <polyline points="8,66 20,58 32,66 44,58 56,66 68,58 80,66" stroke="${accent}"/>
      <polyline points="8,84 20,76 32,84 44,76 56,84 68,76 80,84" stroke="${CUFF}"/>
      <circle cx="22" cy="142" r="15" fill="${accent}" stroke="none"/>
      <path d="M70 160 C76 136 86 118 96 108 L120 110 V160 Z" fill="${accent}" stroke="none"/>
    </g>
    <path d="${leg}" fill="none" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
    <rect x="8" y="10" width="82" height="36" rx="7" fill="${CUFF}" stroke="${INK}" stroke-width="3"/>
  </svg>`;
}

function stocking(p, i, small) {
  const title = p.favorite ? `${p.name}... favorite: ${p.favorite}` : p.name;
  const stat = small ? '' : `<span class="stocking__stat">${p.rated ? `${p.rated} rated` : 'no ratings yet'}</span>`;
  return `<a class="stocking${small ? ' stocking--sm' : ''}" href="/u/${p.id}" data-nav title="${esc(title)}">
    <span class="stocking__art">${stockingSvg(i, `${p.id}${small ? '-sm' : ''}`)}<span class="stocking__name">${esc(p.name)}</span></span>${stat}</a>`;
}

// stockings per mantel: 3 on phones, more on wider screens; a big family gets more mantels
function perMantel() {
  const w = $('#profile-view').clientWidth || innerWidth;
  return w < 520 ? 3 : w < 760 ? 4 : 6;
}

function renderFireplace(people) {
  const n = perMantel();
  const rows = [];
  for (let i = 0; i < people.length; i += n) rows.push(people.slice(i, i + n));
  let i = 0;
  return `<div class="fireplace">${rows.map((row, r) => `
    <div class="mantel-row">
      <div class="mantel">${r === 0 ? '<span class="mantel__deco mantel__deco--l" aria-hidden="true">🔮</span><span class="mantel__deco mantel__deco--m" aria-hidden="true">✨</span><span class="mantel__deco mantel__deco--r" aria-hidden="true">🎁</span>' : ''}</div>
      <div class="hearth">${row.map((p) => stocking(p, i++)).join('')}</div>
    </div>`).join('')}</div>`;
}

let familyCache = null;
async function showFamily() {
  $('#list-view').hidden = true;
  const view = $('#profile-view');
  view.hidden = false;
  state.view = 'family';
  renderSeasons();
  document.title = 'Family · CHRIStmas Mulder';
  view.innerHTML = '<p class="count">Loading...</p>';
  familyCache = await api('/api/family');
  view.innerHTML = `<h2 class="profile__name">The family</h2>
    <p class="profile__stats">Tap a stocking to see someone's favorites and ratings.</p>
    <div id="fireplace">${renderFireplace(familyCache)}</div>`;
}
// re-hang the stockings if the screen width changes how many fit on a mantel
let lastPer = 0;
window.addEventListener('resize', () => {
  if (state.view !== 'family' || !familyCache) return;
  const n = perMantel();
  if (n !== lastPer && $('#fireplace')) $('#fireplace').innerHTML = renderFireplace(familyCache);
  lastPer = n;
});

async function route() {
  if (location.pathname === '/family') return showFamily();
  const inv = location.pathname.match(/^\/i\/([A-Za-z0-9_-]+)$/);
  if (inv) { history.replaceState(null, '', '/'); openInvite(inv[1]); return route(); }
  const key = location.pathname.match(/^\/k\/([A-Za-z0-9_-]+)$/);
  if (key) { history.replaceState(null, '', '/'); signInWithKey(key[1]); return route(); }
  const m = location.pathname.match(/^\/u\/([a-z0-9-]+)/);
  if (m?.[1] === 'sniff') { history.replaceState(null, '', '/u/jen'); return showProfile('jen'); } // old link
  if (m) return showProfile(m[1]);
  document.title = 'CHRIStmas Mulder';
  if (state.view === 'profile' || state.view === 'family' || !state.movies.length) {
    const saved = store.get('season');
    const season = state.seasons.some((s) => s.season === saved) ? saved : state.seasons[0]?.season;
    if (season) return loadSeason(season);
    $('#count').textContent = 'No movies yet... the sheet hasn\'t been synced.';
  }
}

async function boot() {
  const data = await api('/api/bootstrap');
  Object.assign(state, { me: data.me, account: data.account, members: data.members, seasons: data.seasons, lastSync: data.lastSync });
  renderMe();
  renderScale();
  renderBy();
  renderFooter();
  const listShowing = state.movies.length && (state.view === 'season' || state.view === 'rated' || state.view === 'search');
  await route();
  if (listShowing && location.pathname === '/') renderMovies(); // signing in adds your rating controls
}

// ---------- the sleigh ----------
// Like Asana's unicorn: a little reward, not a every-time thing.
// Always on a 5-star rating or a new favorite; otherwise about 1 rating in 4.
function reindeer(x, y) {
  return `<g transform="translate(${x} ${y})">
    <ellipse cx="40" cy="60" rx="32" ry="12" transform="rotate(-12 40 60)"/>
    <path d="M60 54 L76 26 L86 28 L72 60 Z"/>
    <ellipse cx="88" cy="25" rx="12" ry="6" transform="rotate(-18 88 25)"/>
    <path d="M78 21 L74 15 L82 18 Z"/>
    <g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="82,20 76,4 70,-8"/><polyline points="77,7 86,-2"/><polyline points="73,-2 64,-6"/>
      <polyline points="86,20 88,6 96,-4"/><polyline points="88,9 98,6"/>
      <polyline points="62,64 82,78 96,72"/><polyline points="56,68 70,86 84,84"/>
      <polyline points="16,66 -4,78 -18,72"/><polyline points="22,68 6,88 -8,88"/>
    </g>
    <path d="M8 54 L-4 48 L4 60 Z"/>
  </g>`;
}

const SLEIGH_SVG = `<svg viewBox="-10 -30 580 180" aria-hidden="true" fill="currentColor">
  <g fill="none" stroke="currentColor" stroke-width="3">
    <path d="M100 78 C150 90 190 112 262 120"/><path d="M336 92 C350 96 370 90 382 88"/><path d="M456 62 C470 64 490 58 502 58"/>
  </g>
  <path d="M86 76 L94 66 L106 76 L98 86 Z"/>
  <circle cx="84" cy="56" r="11"/>
  <path d="M73 52 L97 48 L80 30 Z"/><circle cx="78" cy="30" r="5"/>
  <rect x="70" y="62" width="32" height="40" rx="12"/>
  <path d="M30 122 L26 84 Q26 68 42 70 L62 74 L72 100 L132 100 Q152 100 152 80 L166 82 Q168 120 136 122 Z"/>
  <g fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round">
    <path d="M14 136 H152 Q172 136 174 122"/><path d="M48 122 V136 M120 122 V136"/>
  </g>
  ${reindeer(196, 56)}${reindeer(320, 28)}${reindeer(444, -2)}
</svg>`;

function flySleigh() {
  if (document.querySelector('.sleigh')) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const el = document.createElement('div');
  el.className = 'sleigh';
  el.innerHTML = SLEIGH_SVG;
  el.addEventListener('animationend', () => el.remove());
  document.body.append(el);
}

async function toggleFavorite(movieId, on) {
  const m = state.movies.find((x) => x.id === movieId);
  try {
    await api('/api/favorite', { method: 'POST', body: { movie_id: movieId, on } });
    m.favorites = (m.favorites || []).filter((id) => id !== state.me);
    if (on) { m.favorites.push(state.me); flySleigh(); }
    if (state.view === 'profile') return route();
    document.querySelector(`.movie[data-id="${movieId}"]`).outerHTML = movieHtml(m);
  } catch (err) {
    alert(err.message);
  }
}

async function saveRating(movieId, body) {
  const m = state.movies.find((x) => x.id === movieId);
  const li = document.querySelector(`.movie[data-id="${movieId}"]`);
  li?.classList.add('saving');
  try {
    const { rating } = await api('/api/rate', { method: 'POST', body: { movie_id: movieId, ...body } });
    if (rating) m.ratings[state.me] = rating; else delete m.ratings[state.me];
    li.outerHTML = movieHtml(m);
    if (rating?.score === 10 || (rating?.score != null && Math.random() < 0.25)) flySleigh();
  } catch (err) {
    li?.classList.remove('saving');
    alert(err.message);
  }
}

// ---------- sign in ----------
let pendingInvite = null;

function openLogin() {
  $('#login-error').textContent = '';
  $('#names').innerHTML = state.members.filter((m) => m.active && m.is_family).map((m) =>
    `<label><input type="radio" name="member" value="${m.id}" required><span>${esc(m.name)}</span></label>`).join('');
  $('#login').showModal();
}

function showStatus(text) {
  $('#status-text').textContent = text;
  if (!$('#status').open) $('#status').showModal();
}

async function openInvite(code) {
  try {
    const { from } = await api(`/api/invite?code=${encodeURIComponent(code)}`);
    if (state.me) return showStatus(`You're already signed in as ${memberName(state.me)}... no need for ${from}'s invite.`);
    pendingInvite = code;
    $('#join-intro').textContent = `${from} invited you to rate Christmas movies with the Mulders. Pick a name and you're in... no email, no password.`;
    $('#join-error').textContent = '';
    $('#join').showModal();
  } catch (err) {
    showStatus(err.message);
  }
}

// a personal link: open it on any phone to be signed in as that person
function showKey(url, name, yours, fresh) {
  $('#key-title').textContent = yours ? 'Your sign-in link' : `Sign-in link for ${name}`;
  $('#key-intro').textContent = yours
    ? `${fresh ? 'You\'re in! ' : ''}Save this somewhere (notes, a text to yourself). Opening it signs you in as ${name} on any phone or computer.`
    : `Send this to ${name}. Opening it signs them in as ${name} on any phone.`;
  $('#key-hint').textContent = 'Treat it like a key... anyone with it can rate as that person. Making a new one turns this one off.';
  $('#key-url').value = url;
  $('#key-copy').textContent = 'Copy';
  if (!$('#key').open) $('#key').showModal();
}

async function signInWithKey(key) {
  try {
    const { name } = await api('/api/auth/key', { method: 'POST', body: { key } });
    await boot();
    showStatus(`Signed in as ${name} 🎄`);
  } catch (err) {
    showStatus(err.message);
  }
}

// ---------- invites ----------
function inviteBody(invite) {
  if (!invite) {
    return '<p><button type="button" class="btn" id="invite-make">Make my invite link</button></p>'
      + '<p class="hint">Works for 25 people and stops Jan 15. You can turn it off any time.</p>';
  }
  const ends = new Date(invite.expires_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `<div class="invite__link"><input readonly value="${esc(invite.url)}" aria-label="Invite link" id="invite-url">
      <button type="button" class="btn" id="invite-copy">Copy</button></div>
    <p class="hint">${invite.uses} of ${invite.max_uses} used · works until ${ends} ·
      <button type="button" class="link link--danger" id="invite-revoke" data-code="${esc(invite.code)}">turn it off</button></p>`;
}

async function openInviteDialog() {
  $('#invite-error').textContent = '';
  $('#invite-body').innerHTML = '<p class="hint">Loading...</p>';
  $('#invite').showModal();
  try {
    const { invite } = await api('/api/invites');
    $('#invite-body').innerHTML = inviteBody(invite);
  } catch (err) { $('#invite-error').textContent = err.message; }
}

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('#signin')) return openLogin();
  if (t.closest('#logout')) { await api('/api/logout', { method: 'POST' }); location.reload(); return; }
  if (t.closest('[data-close]')) return t.closest('dialog').close();
  if (t.closest('#invite-open')) return openInviteDialog();
  if (t.closest('#invite-make')) {
    try { $('#invite-body').innerHTML = inviteBody((await api('/api/invites', { method: 'POST' })).invite); } catch (err) { $('#invite-error').textContent = err.message; }
    return;
  }
  if (t.closest('#invite-copy')) {
    const url = $('#invite-url').value;
    try { await navigator.clipboard.writeText(url); t.textContent = 'Copied'; } catch { $('#invite-url').select(); }
    return;
  }
  if (t.closest('#invite-revoke')) {
    if (!confirm('Turn off this link? Anyone who already joined stays. Nobody new can use it.')) return;
    try {
      await api('/api/invites/revoke', { method: 'POST', body: { code: t.dataset.code } });
      $('#invite-body').innerHTML = inviteBody(null);
    } catch (err) { $('#invite-error').textContent = err.message; }
    return;
  }
  if (t.closest('#key-copy')) {
    try { await navigator.clipboard.writeText($('#key-url').value); t.textContent = 'Copied'; } catch { $('#key-url').select(); }
    return;
  }
  const keyBtn = t.closest('[data-key]');
  if (keyBtn) {
    const id = keyBtn.dataset.key;
    const yours = id === state.me;
    if (!confirm(yours ? 'Make your sign-in link? If you made one before, the old one stops working.'
      : `Make a sign-in link for ${memberName(id)}? Their old link (if any) stops working. They stay signed in where they already are.`)) return;
    try {
      const { url, name } = await api('/api/account/key', { method: 'POST', body: yours ? {} : { member: id } });
      showKey(url, name, yours, false);
    } catch (err) { alert(err.message); }
    return;
  }
  const famBtn = t.closest('[data-family]');
  if (famBtn) {
    const on = famBtn.dataset.on === '1';
    const name = memberName(famBtn.dataset.family);
    if (!confirm(on ? `Hang a stocking for ${name}? They'll show on the family page and in Chris's export.` : `Take down ${name}'s stocking?`)) return;
    try {
      await api('/api/members/family', { method: 'POST', body: { member: famBtn.dataset.family, on } });
      await boot();
    } catch (err) { alert(err.message); }
    return;
  }
  if (t.closest('#delete-account')) {
    if (!confirm('Delete your account? Your ratings and favorites go with it. This can\'t be undone.')) return;
    try { await api('/api/account/delete', { method: 'POST' }); location.href = '/'; } catch (err) { alert(err.message); }
    return;
  }
  if (t.closest('#movies-tab')) return loadSeason(state.season || state.seasons[0]?.season);
  const scaleBtn = t.closest('[data-scale]');
  if (scaleBtn) return setScale(scaleBtn.dataset.scale);
  const tenBtn = t.closest('.tens [data-ten]');
  if (tenBtn) {
    const movieId = +tenBtn.closest('.tens').dataset.movie;
    const score = +tenBtn.dataset.ten;
    const current = state.movies.find((m) => m.id === movieId)?.ratings[state.me];
    // tapping your current score again clears it, same as the stars
    return saveRating(movieId, current?.source === 'site' && current.score === score ? { score: null } : { score });
  }
  const hit = t.closest('.rater__hit button');
  // mouse and touch go through the pointer handlers below; this path is keyboard only
  if (hit && e.detail === 0) {
    const movieId = +hit.closest('.rater').dataset.movie;
    const score = +hit.dataset.score;
    const current = state.movies.find((m) => m.id === movieId)?.ratings[state.me];
    // tapping your current score again clears it
    return saveRating(movieId, current?.source === 'site' && current.score === score ? { score: null } : { score });
  }
  const nav = t.closest('a[data-nav]');
  if (nav && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    history.pushState(null, '', nav.getAttribute('href'));
    return route();
  }
  const clear = t.closest('[data-clear]');
  if (clear) return saveRating(+clear.dataset.clear, { score: null });
  const fav = t.closest('[data-fav]');
  if (fav) return toggleFavorite(+fav.dataset.fav, fav.getAttribute('aria-pressed') !== 'true');
  const sucks = t.closest('[data-sucks]');
  if (sucks) {
    const pressed = sucks.getAttribute('aria-pressed') === 'true';
    return saveRating(+sucks.dataset.sucks, pressed ? { verdict: null } : { verdict: 'sucks' });
  }
  if (t.closest('#sync')) {
    t.textContent = 'Syncing...';
    try {
      state.lastSync = await api('/api/sync', { method: 'POST' });
      const data = await api('/api/bootstrap');
      state.seasons = data.seasons;
      await loadSeason(state.season);
    } catch (err) { alert(err.message); }
    renderFooter();
  }
});

// Rating by pointer: press anywhere on the stars and slide, release to save.
// The score comes from the finger position, so half stars don't need a precise tap.
let drag = null;
function scoreAt(rater, x) {
  const box = rater.querySelector('.stars').getBoundingClientRect();
  return Math.min(10, Math.max(1, Math.ceil(((x - box.left) / box.width) * 10)));
}
function previewScore(rater, score) {
  rater.querySelector('.stars').style.setProperty('--pct', `${score * 10}%`);
  rater.dataset.preview = `${score / 2}★`;
}
function commitScore(rater, score) {
  const movieId = +rater.dataset.movie;
  const current = state.movies.find((m) => m.id === movieId)?.ratings[state.me];
  // landing on your current score again clears it
  saveRating(movieId, current?.source === 'site' && current.score === score ? { score: null } : { score });
}
// Touch: the page owns vertical swipes (touch-action: pan-y), so a scroll that starts on the stars
// cancels the rating instead of making one. A tap that only stops a fling doesn't count either.
let lastScroll = 0;
window.addEventListener('scroll', () => { lastScroll = Date.now(); }, { passive: true });
function cancelDrag() {
  if (!drag) return;
  const { rater } = drag;
  drag = null;
  delete rater.dataset.preview;
  const s = state.movies.find((m) => m.id === +rater.dataset.movie)?.ratings[state.me]?.score;
  rater.querySelector('.stars').style.setProperty('--pct', `${s == null ? 0 : Math.min(s, 10) * 10}%`);
}
document.addEventListener('pointerdown', (e) => {
  const rater = e.target.closest('.rater');
  if (!rater || e.button !== 0) return;
  const touch = e.pointerType !== 'mouse';
  if (touch && Date.now() - lastScroll < 300) return; // finger landed to stop a scroll
  if (!touch) e.preventDefault();
  drag = { rater, touch, x: e.clientX, y: e.clientY, scrollY: window.scrollY, score: scoreAt(rater, e.clientX), moved: false };
  if (!touch) { try { rater.setPointerCapture(e.pointerId); } catch { /* ignore */ } previewScore(rater, drag.score); }
});
document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = Math.abs(e.clientX - drag.x);
  const dy = Math.abs(e.clientY - drag.y);
  if (drag.touch && !drag.moved) {
    if (dy > 8 && dy > dx) return cancelDrag(); // that's a scroll
    if (dx < 6) return; // not decided yet
    drag.moved = true; // sideways: it's a rating slide
    try { drag.rater.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  }
  drag.score = scoreAt(drag.rater, e.clientX);
  previewScore(drag.rater, drag.score);
});
document.addEventListener('pointerup', (e) => {
  if (!drag) return;
  if (drag.touch && (Math.abs(window.scrollY - drag.scrollY) > 2 || Math.abs(e.clientY - drag.y) > 12)) return cancelDrag();
  const { rater } = drag;
  const score = drag.touch && !drag.moved ? scoreAt(rater, e.clientX) : drag.score; // a clean tap rates where it landed
  drag = null;
  delete rater.dataset.preview;
  commitScore(rater, score);
});
document.addEventListener('pointercancel', cancelDrag);

// hover preview on the star rater
document.addEventListener('mouseover', (e) => {
  const hit = e.target.closest('.rater__hit button');
  if (!hit) return;
  hit.closest('.rater').querySelector('.stars').style.setProperty('--pct', `${hit.dataset.score * 10}%`);
});
document.addEventListener('mouseout', (e) => {
  const rater = e.target.closest('.rater');
  if (!rater || rater.contains(e.relatedTarget)) return;
  const m = state.movies.find((x) => x.id === +rater.dataset.movie);
  const s = m?.ratings[state.me]?.score;
  rater.querySelector('.stars').style.setProperty('--pct', `${s == null ? 0 : Math.min(s, 10) * 10}%`);
});

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#join-error').textContent = '';
  const btn = e.target.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    const res = await api('/api/join', { method: 'POST', body: { invite: pendingInvite, name: $('#display-name').value } });
    $('#join').close();
    await boot();
    flySleigh();
    showKey(res.key_url, memberName(res.me), true, true);
  } catch (err) {
    $('#join-error').textContent = err.message;
  } finally { btn.disabled = false; }
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    await api('/api/login', { method: 'POST', body: { member: form.get('member'), code: form.get('code') } });
    $('#login').close();
    await boot();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#by').addEventListener('input', syncPersonSort);
$('#seasons').addEventListener('change', (e) => {
  if (e.target.id === 'season-pick' && e.target.value) loadSeason(e.target.value);
});

// phones: dropdowns stay tucked behind the Filters button; the badge counts what's changed from default
$('#filters-toggle').addEventListener('click', () => {
  const open = $('.controls').classList.toggle('controls--open');
  $('#filters-toggle').setAttribute('aria-expanded', open);
});
function countFilters() {
  const n = [$('#network').value !== '', $('#show').value !== 'all', $('#by').value !== '', $('#sort').value !== 'date'].filter(Boolean).length;
  $('#filters-n').hidden = !n;
  $('#filters-n').textContent = n;
}
for (const id of ['#network', '#show', '#by', '#sort']) $(id).addEventListener('input', countFilters);
// Recently rated swaps the data to every season; leaving it goes back to the season tab
$('#sort').addEventListener('change', () => {
  if (state.view === 'search') return; // search already covers every season; the sort just reorders it
  if ($('#sort').value === 'recent' && state.view !== 'rated') loadRated();
  else if ($('#sort').value !== 'recent' && state.view === 'rated') loadSeason(state.season);
});
// typing switches to every season; clearing the box goes back where you were
$('#q').addEventListener('input', () => {
  const q = $('#q').value.trim();
  if (q && state.view !== 'search') loadAll();
  else if (!q && state.view === 'search') {
    if ($('#sort').value === 'recent') loadRated(); else loadSeason(state.season);
  }
});
window.addEventListener('popstate', route);
for (const id of ['#q', '#network', '#show', '#by', '#sort']) $(id).addEventListener('input', renderMovies);

boot().catch((err) => { $('#count').textContent = `Couldn't load: ${err.message}`; });
