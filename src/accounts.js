// Invite links + personal sign-in links. No email, no passwords.
//
// Family members make one shareable invite link each. A friend opens it, picks a name, and is
// signed in. To sign in on another phone, they open their personal sign-in link (from their
// profile). Family still signs in with pick-your-name + the family code, or their own personal link.
import { sessionCookie, clearCookie, currentMember } from './auth.js';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});
const fail = (status, error) => json({ error }, status);

const INVITE_USES = 25;
const JOINS_PER_IP_HOUR = 10;

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
const nowIso = () => new Date().toISOString();

// invite links stop working Jan 15 after this season
function inviteExpiry(now = new Date()) {
  const y = now.getUTCMonth() === 0 && now.getUTCDate() < 15 ? now.getUTCFullYear() : now.getUTCFullYear() + 1;
  return new Date(Date.UTC(y, 0, 15, 8)).toISOString();
}

// The signed-in member's row, or null. A cookie for a deleted account signs nobody in.
export async function loadMe(request, env) {
  const id = await currentMember(request, env);
  if (!id) return null;
  return env.DB.prepare('SELECT id, name, is_family FROM members WHERE id = ? AND active = 1').bind(id).first();
}

async function activeInvite(env, code) {
  return env.DB.prepare(`SELECT i.code, i.created_by, i.uses, i.max_uses, m.name AS from_name
    FROM invites i JOIN members m ON m.id = i.created_by
    WHERE i.code = ? AND i.revoked_at IS NULL AND i.expires_at > ? AND i.uses < i.max_uses AND m.is_family = 1`)
    .bind(String(code || ''), nowIso()).first();
}

// ---------- invites ----------

const inviteJson = (inv, origin) => inv && {
  code: inv.code, url: `${origin}/i/${inv.code}`, uses: inv.uses, max_uses: inv.max_uses, expires_at: inv.expires_at,
};

// GET: your current link, if any. POST: make one (or hand back the one you have).
export async function myInvite(request, env, me, origin) {
  if (!me.is_family) return fail(403, 'only family can invite people');
  const current = await env.DB.prepare(`SELECT * FROM invites WHERE created_by = ? AND revoked_at IS NULL
    AND expires_at > ? AND uses < max_uses ORDER BY created_at DESC LIMIT 1`).bind(me.id, nowIso()).first();
  if (current || request.method === 'GET') return json({ invite: inviteJson(current, origin) });
  const inv = { code: randomToken(6), created_by: me.id, created_at: nowIso(), expires_at: inviteExpiry(), max_uses: INVITE_USES, uses: 0 };
  await env.DB.prepare('INSERT INTO invites (code, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?)')
    .bind(inv.code, inv.created_by, inv.created_at, inv.expires_at, inv.max_uses).run();
  return json({ invite: inviteJson(inv, origin) });
}

export async function revokeInvite(request, env, me) {
  if (!me.is_family) return fail(403, 'only family can invite people');
  const { code } = await request.json().catch(() => ({}));
  const res = await env.DB.prepare('UPDATE invites SET revoked_at = ? WHERE code = ? AND created_by = ? AND revoked_at IS NULL')
    .bind(nowIso(), String(code || ''), me.id).run();
  if (!res.meta.changes) return fail(404, 'no such invite link');
  return json({ ok: true });
}

// what the /i/<code> page shows before anyone picks a name
export async function inviteInfo(url, env) {
  const inv = await activeInvite(env, url.searchParams.get('code'));
  if (!inv) return fail(404, "that invite link doesn't work anymore... ask whoever sent it for a new one");
  return json({ from: inv.from_name });
}

// ---------- personal sign-in links ----------

// A fresh personal link for a member. Making one turns the old one off. Only the hash is stored.
async function issueKey(env, memberId, origin) {
  const key = randomToken(24);
  await env.DB.prepare('UPDATE members SET key_hash = ? WHERE id = ?').bind(await sha256(key), memberId).run();
  return `${origin}/k/${key}`;
}

// your own link, or (family only) a link for someone else who lost theirs
export async function newKey(request, env, me, origin) {
  const { member } = await request.json().catch(() => ({}));
  const id = member ? String(member) : me.id;
  if (id !== me.id && !me.is_family) return fail(403, 'only family can make a link for someone else');
  const row = await env.DB.prepare('SELECT id, name FROM members WHERE id = ? AND active = 1').bind(id).first();
  if (!row) return fail(404, 'no such person');
  return json({ url: await issueKey(env, row.id, origin), name: row.name });
}

// the /k/<key> page posts here
export async function keySignIn(request, env, secure) {
  const { key } = await request.json().catch(() => ({}));
  if (!key) return fail(400, 'that sign-in link is missing a piece');
  const row = await env.DB.prepare('SELECT id, name FROM members WHERE key_hash = ? AND active = 1').bind(await sha256(String(key))).first();
  if (!row) return fail(410, "that sign-in link doesn't work anymore... a newer one replaced it, or ask the family for a new one");
  return json({ me: row.id, name: row.name }, 200, { 'set-cookie': await sessionCookie(env, row.id, secure) });
}

// ---------- joining ----------

const NAME_RE = /^[\p{L}][\p{L}\p{N} .'-]{0,23}$/u;
const slug = (name) => name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// open an invite link, pick a name, you're in
export async function join(request, env, secure, origin) {
  const body = await request.json().catch(() => ({}));
  const inv = await activeInvite(env, body.invite);
  if (!inv) return fail(404, "that invite link doesn't work anymore... ask whoever sent it for a new one");
  const name = String(body.name || '').replace(/\s+/g, ' ').trim();
  if (!NAME_RE.test(name)) return fail(400, 'use letters (and numbers if you want), up to 24 characters');
  const clash = await env.DB.prepare('SELECT 1 FROM members WHERE lower(name) = lower(?)').bind(name).first();
  if (clash) return fail(409, `someone already goes by ${name}... add a last initial?`);

  // a shared link can't be used to mint accounts in bulk
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM join_log WHERE ip = ? AND at > ?').bind(ip, hourAgo).first();
  if (recent.n >= JOINS_PER_IP_HOUR) return fail(429, 'lots of new accounts from here... try again in an hour');

  const base = slug(name) || 'friend';
  let id = base;
  for (let i = 2; await env.DB.prepare('SELECT 1 FROM members WHERE id = ?').bind(id).first(); i++) id = `${base}-${i}`;
  const [made] = await env.DB.batch([
    // the uses check rides along, so two people racing for the last spot can't both get in
    env.DB.prepare(`INSERT INTO members (id, name, sort, active, is_family, invited_by, created_at)
      SELECT ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM members), 1, 0, ?, ?
      WHERE (SELECT uses < max_uses FROM invites WHERE code = ?)`).bind(id, name, inv.created_by, nowIso(), inv.code),
    env.DB.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ? AND EXISTS (SELECT 1 FROM members WHERE id = ?)').bind(inv.code, id),
    env.DB.prepare('INSERT INTO join_log (ip, at) VALUES (?, ?)').bind(ip, nowIso()),
    env.DB.prepare('DELETE FROM join_log WHERE at < ?').bind(new Date(Date.now() - 86400_000).toISOString()),
  ]);
  if (!made.meta.changes) return fail(410, 'that invite link just ran out... ask whoever sent it for a new one');
  const url = await issueKey(env, id, origin);
  return json({ me: id, from: inv.from_name, key_url: url }, 200, { 'set-cookie': await sessionCookie(env, id, secure) });
}

// ---------- your account ----------

export async function deleteAccount(env, me, secure) {
  // family accounts hold the sheet's ratings; removing one would break the sync
  if (me.is_family) return fail(403, 'family accounts can only be removed by biv');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM ratings WHERE member_id = ?').bind(me.id),
    env.DB.prepare('DELETE FROM favorites WHERE member_id = ?').bind(me.id),
    env.DB.prepare('DELETE FROM members WHERE id = ?').bind(me.id),
  ]);
  return json({ ok: true }, 200, { 'set-cookie': clearCookie(secure) });
}

// family hangs a stocking for someone (or takes it down)
export async function setFamily(request, env, me) {
  if (!me.is_family) return fail(403, 'only family can do that');
  const { member, on } = await request.json().catch(() => ({}));
  if (member === me.id && !on) return fail(400, "you can't take yourself out of the family");
  const res = await env.DB.prepare('UPDATE members SET is_family = ? WHERE id = ?').bind(on ? 1 : 0, String(member || '')).run();
  if (!res.meta.changes) return fail(404, 'no such person');
  return json({ ok: true });
}
