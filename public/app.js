const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const state = { me: null, members: [], seasons: [], season: null, view: 'season', movies: [], lastSync: null };
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
const stars = (score10) => Math.min(score10, 10) / 2;
const fmtStars = (n) => (Number.isInteger(n) ? `${n}` : n.toFixed(1));

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
    const half = Math.round(stars(r.score) * 2) / 2; // chips speak the half-star scale; exact score on hover
    return `<span class="chip" title="${r.score}/10${from}${extra}">${name} <b>${fmtStars(half)}★</b>${fire}</span>`;
  }
  if (r.verdict === 'sucks') return `<span class="chip" title="It sucked${from}">${name} 💩</span>`;
  if (r.verdict === 'turned-off') return `<span class="chip" title="Turned it off${from}">${name} 📴</span>`;
  if (r.verdict === 'skipped') return `<span class="chip chip--plain" title="Recorded it, deleted it unwatched">${name} 🗑️</span>`;
  if (r.watched) return `<span class="chip chip--plain" title="Watched it">${name} 👀</span>`;
  return '';
}

function familyAvg(m) {
  const scores = Object.values(m.ratings).filter((r) => r.score != null).map((r) => Math.min(r.score, 10));
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

function familyHtml(m) {
  const avg = familyAvg(m);
  const n = Object.values(m.ratings).filter((r) => r.score != null).length;
  const head = avg == null
    ? '<span class="family__none">No family ratings yet 🍿</span>'
    : `<div class="family__avg">${starsHtml(avg)} <b title="${avg.toFixed(1)}/10">${fmtStars(Math.round(stars(avg) * 10) / 10)}</b></div>`;
  const favs = m.favorites || [];
  const others = state.members.map((mem) => ((m.ratings[mem.id] || favs.includes(mem.id)) && mem.id !== state.me
    ? chip(mem.id, m.ratings[mem.id], favs.includes(mem.id)) : '')).join('');
  return `${head}${others ? `<div class="chips">${others}</div>` : ''}${n ? '' : ''}`;
}

function mineHtml(m) {
  if (!state.me) return '';
  const r = m.ratings[state.me];
  const score = r?.score ?? null;
  const sucks = r?.verdict === 'sucks';
  const fromSheet = r?.source === 'sheet' ? ' <span title="Imported from Chris\'s sheet">(sheet)</span>' : '';
  const hits = Array.from({ length: 10 }, (_, i) => `<button type="button" data-score="${i + 1}" aria-label="${(i + 1) / 2} stars"></button>`).join('');
  return `<span class="mine__label">Your rating${fromSheet}</span>
    <div class="mine__row">
      <span class="rater" data-movie="${m.id}">${starsHtml(score)}<span class="rater__hit">${hits}</span></span>
      <button type="button" class="pill pill--poop" data-sucks="${m.id}" aria-pressed="${sucks}" title="It sucked" aria-label="It sucked">💩</button>
      <button type="button" class="pill pill--fav" data-fav="${m.id}" aria-pressed="${(m.favorites || []).includes(state.me)}" title="One of my favorites" aria-label="One of my favorites">🌟</button>
    </div>`;
}

function movieHtml(m) {
  const up = m.release_date && m.release_date > today;
  const meta = [
    m.network ? `<span title="${esc(m.network_code)}">${esc(m.network)}</span>` : '',
    m.imdb != null ? `IMDB ${m.imdb.toFixed(1)}` : '',
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

function renderMe() {
  $('#me').innerHTML = state.me
    ? `Rating as <a href="/u/${state.me}" data-nav><b>${esc(memberName(state.me))}</b></a> 🌟<br><button class="link" id="logout">sign out</button>`
    : '<button id="signin">Sign in to rate</button>';
}

function renderSeasons() {
  $('#seasons').innerHTML = state.seasons.map((s) =>
    `<button type="button" data-season="${s.season}" aria-current="${state.view === 'season' && s.season === state.season}">${seasonLabel(s.season)}</button>`).join('');
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
  $('#by').innerHTML = '<option value="">Rated by anyone</option>'
    + state.members.map((m) => `<option value="${m.id}">Rated by ${esc(m.name)}</option>`).join('');
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
    imdb: (a, b) => (b.imdb ?? -1) - (a.imdb ?? -1),
    title: (a, b) => a.title.localeCompare(b.title),
    // newest first; old sheet ratings (no timestamp) fall to the bottom in air-date order
    recent: (a, b) => latestRating(b, who).localeCompare(latestRating(a, who)),
    // sucks counts below any star score
    person: (a, b) => personScore(b, who) - personScore(a, who),
  }[sort];
  if (by) list = [...list].sort(by);

  if (sort === 'recent') list = list.filter((m) => Object.values(m.ratings).some(hasRated));
  $('#csv-season').href = state.view === 'season' ? `/api/export.csv?season=${encodeURIComponent(state.season)}` : '/api/export.csv?season=all';
  $('#count').textContent = (state.view === 'rated' ? `${list.length} rated movies across every season` : `${list.length} of ${state.movies.length} movies`)
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
    + (state.me ? ' <button type="button" id="sync">🔄 Sync now</button>' : '');
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
  showList();
  state.view = 'season';
  if ($('#sort').value === 'recent') $('#sort').value = 'date';
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
  const avg = stats.avg != null ? `${fmtStars(Math.round(stars(stats.avg) * 10) / 10)}★ average` : null;
  const statLine = [
    `${stats.rated || 0} rated`, avg, stats.fives ? `${stats.fives} rated 4.5★ or better` : null, stats.sucks ? `${stats.sucks} 💩` : null,
  ].filter(Boolean).join(' · ');
  document.title = `${member.name} · Christmas Mulder`;
  view.innerHTML = `<a href="/" data-nav class="back">← All movies</a>
    <h2 class="profile__name">${esc(member.name)}${mine ? ' <small>(you)</small>' : ''}</h2>
    <p class="profile__stats">${statLine}</p>
    <h3 class="profile__h">🌟 Favorites</h3>
    <div class="favs">${slots.join('')}</div>
    <h3 class="profile__h">Recent ratings</h3>
    ${recent.length ? `<ol class="movies">${recent.map(movieHtml).join('')}</ol>` : '<p class="count">Nothing rated yet.</p>'}`;
}

async function route() {
  const m = location.pathname.match(/^\/u\/([a-z0-9-]+)/);
  if (m) return showProfile(m[1]);
  document.title = 'Christmas Mulder';
  if (state.view === 'profile' || !state.movies.length) {
    const saved = store.get('season');
    const season = state.seasons.some((s) => s.season === saved) ? saved : state.seasons[0]?.season;
    if (season) return loadSeason(season);
    $('#count').textContent = 'No movies yet... the sheet hasn\'t been synced.';
  }
}

async function boot() {
  const data = await api('/api/bootstrap');
  Object.assign(state, { me: data.me, members: data.members, seasons: data.seasons, lastSync: data.lastSync });
  renderMe();
  renderBy();
  renderFooter();
  await route();
}

async function toggleFavorite(movieId, on) {
  const m = state.movies.find((x) => x.id === movieId);
  try {
    await api('/api/favorite', { method: 'POST', body: { movie_id: movieId, on } });
    m.favorites = (m.favorites || []).filter((id) => id !== state.me);
    if (on) m.favorites.push(state.me);
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
  } catch (err) {
    li?.classList.remove('saving');
    alert(err.message);
  }
}

function openLogin() {
  $('#names').innerHTML = state.members.filter((m) => m.active).map((m) =>
    `<label><input type="radio" name="member" value="${m.id}" required><span>${esc(m.name)}</span></label>`).join('');
  $('#login-error').textContent = '';
  $('#login').showModal();
}

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('#signin')) return openLogin();
  if (t.closest('#logout')) { await api('/api/logout', { method: 'POST' }); location.reload(); return; }
  if (t.closest('#login-cancel')) return $('#login').close();
  const seasonBtn = t.closest('[data-season]');
  if (seasonBtn) return loadSeason(seasonBtn.dataset.season);
  const hit = t.closest('.rater__hit button');
  if (hit) {
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

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    const { me } = await api('/api/login', { method: 'POST', body: { member: form.get('member'), code: form.get('code') } });
    state.me = me;
    $('#login').close();
    renderMe();
    renderFooter();
    renderMovies();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#by').addEventListener('input', syncPersonSort);
// Recently rated swaps the data to every season; leaving it goes back to the season tab
$('#sort').addEventListener('change', () => {
  if ($('#sort').value === 'recent' && state.view !== 'rated') loadRated();
  else if ($('#sort').value !== 'recent' && state.view === 'rated') loadSeason(state.season);
});
window.addEventListener('popstate', route);
for (const id of ['#q', '#network', '#show', '#by', '#sort']) $(id).addEventListener('input', renderMovies);

boot().catch((err) => { $('#count').textContent = `Couldn't load: ${err.message}`; });
