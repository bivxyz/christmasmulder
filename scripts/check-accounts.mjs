// End-to-end check of invite links + personal sign-in links against `npm run dev`.
// usage: npm run dev &   then   node scripts/check-accounts.mjs <local FAMILY_CODE>
const BASE = process.env.BASE || 'http://localhost:8787';
const CODE = process.argv[2];
let pass = 0, failn = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : failn++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(extra)}`}`); };

function jar() {
  let cookie = '';
  return async (path, body) => {
    const res = await fetch(BASE + path, {
      method: body ? 'POST' : 'GET',
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
}
const keyOf = (url) => String(url || '').split('/k/')[1];

const dana = jar(), pat = jar(), anon = jar(), phone2 = jar();
const name = `Pat${Date.now() % 100000}`;
const id = name.toLowerCase();

let r = await dana('/api/login', { member: 'dana', code: CODE });
check('dana signs in with the family code', r.status === 200, r);
r = await dana('/api/bootstrap');
check('dana is family', r.data.account?.is_family === true, r.data.account);

r = await dana('/api/invites', {});
const code = r.data.invite?.code;
check('dana makes an invite link', r.status === 200 && /\/i\//.test(r.data.invite?.url), r);
r = await dana('/api/invites', {});
check('asking again hands back the same link', r.data.invite?.code === code, r.data);

r = await anon(`/api/invite?code=${code}`);
check('invite page says who it is from', r.data.from === 'Dana', r);
r = await anon('/api/invite?code=nope');
check('a made-up invite code is refused', r.status === 404, r);

r = await pat('/api/join', { invite: code, name: 'Dana' });
check('a name already taken is refused', r.status === 409, r);
r = await pat('/api/join', { invite: code, name: '' });
check('a blank name is refused', r.status === 400, r);
r = await pat('/api/join', { invite: code, name });
check('friend joins and is signed in', r.status === 200 && r.data.me === id && r.data.from === 'Dana', r);
const key1 = keyOf(r.data.key_url);
check('joining hands back a personal sign-in link', !!key1 && key1.length >= 30, r.data);

r = await pat('/api/bootstrap');
check('friend is signed in, not family', r.data.me === id && r.data.account?.is_family === false, r.data);
check('bootstrap never leaks key hashes', !JSON.stringify(r.data).includes('key_hash'), null);
r = await dana('/api/invites');
check('invite counts one use', r.data.invite?.uses === 1, r.data);

// another phone: the personal link signs you in
r = await phone2('/api/auth/key', { key: key1 });
check('personal link signs in on another phone', r.status === 200 && r.data.me === id, r);
r = await phone2('/api/auth/key', { key: 'wrong' });
check('a wrong personal link is refused', r.status === 410, r);
r = await pat('/api/account/key', {});
const key2 = keyOf(r.data.url);
check('friend makes a new personal link', r.status === 200 && key2 && key2 !== key1, r);
r = await anon('/api/auth/key', { key: key1 });
check('the old personal link stops working', r.status === 410, r);
r = await pat('/api/account/key', { member: 'dana' });
check("friend can't make a link for someone else", r.status === 403, r);
r = await dana('/api/account/key', { member: id });
check('family can make a new link for a friend', r.status === 200 && keyOf(r.data.url), r);
r = await anon('/api/auth/key', { key: key2 });
check("that turns off the friend's previous link", r.status === 410, r);

const movies = (await anon('/api/movies?season=2025')).data;
const movie = movies[0].id;
r = await pat('/api/rate', { movie_id: movie, score: 8 });
check('friend can rate', r.status === 200 && r.data.rating?.score === 8, r);
r = await pat('/api/favorite', { movie_id: movie, on: true });
check('friend can star a favorite', r.status === 200, r);
r = await pat('/api/invites');
check('friend cannot make invite links', r.status === 403, r);
r = await pat('/api/sync', {});
check('friend cannot press sync', r.status === 403, r);
r = await anon('/api/login', { member: id, code: CODE });
check('the family code does not work for a friend', r.status === 400, r);
r = await pat('/api/members/family', { member: id, on: true });
check('friend cannot make themself family', r.status === 403, r);

r = await anon('/api/family');
check('stockings page is family only', Array.isArray(r.data) && !r.data.some((p) => p.id === id), r.data);
r = await anon('/api/export.csv?season=2025');
const header = String(r.data).split('\r\n')[0];
check('export has Everyone Avg and no friend column', header.includes('Everyone Avg') && !header.includes(name), header);
r = await anon(`/api/profile?member=${id}`);
check('friend profile shows who invited them', r.data.member?.invited_by === 'Dana' && r.data.member?.is_family === 0, r.data.member);
check('profile never leaks key hashes', !JSON.stringify(r.data).includes('key_hash'), null);

// turn the link off
r = await dana('/api/invites/revoke', { code });
check('dana turns the link off', r.status === 200, r);
r = await anon(`/api/invite?code=${code}`);
check('a turned-off link stops working', r.status === 404, r);
r = await anon('/api/join', { invite: code, name: `Late${Date.now() % 100000}` });
check('nobody new can join through it', r.status === 404, r);

// family toggle, then delete
r = await dana('/api/members/family', { member: id, on: true });
check('family can hang a stocking for a friend', r.status === 200 && (await anon('/api/family')).data.some((p) => p.id === id), r);
r = await pat('/api/account/delete', {});
check('family accounts cannot self-delete', r.status === 403, r);
await dana('/api/members/family', { member: id, on: false });
r = await pat('/api/account/delete', {});
check('friend deletes their account', r.status === 200, r);
r = await phone2('/api/rate', { movie_id: movie, score: 6 });
check('their other phone is signed out too', r.status === 401, r);
r = await anon(`/api/profile?member=${id}`);
check('their profile is gone', r.status === 404, r);

console.log(`\n${pass} passed, ${failn} failed`);
process.exit(failn ? 1 : 0);
