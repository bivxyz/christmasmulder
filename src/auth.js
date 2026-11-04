// Family sign-in: pick your name, enter the shared family code, get a signed cookie.
const enc = new TextEncoder();
const COOKIE = 'cm_session';
const YEAR = 365 * 24 * 3600;

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sign(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export async function sessionCookie(env, memberId, secure) {
  const exp = Math.floor(Date.now() / 1000) + YEAR;
  const payload = `${memberId}.${exp}`;
  const value = `${payload}.${await sign(env.COOKIE_SECRET, payload)}`;
  return `${COOKIE}=${value}; Path=/; Max-Age=${YEAR}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export const clearCookie = (secure) => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

// Returns the member id, or null.
export async function currentMember(request, env) {
  const raw = (request.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const [member, exp, sig] = raw.slice(COOKIE.length + 1).split('.');
  if (!member || !exp || !sig || +exp < Date.now() / 1000) return null;
  return safeEqual(sig, await sign(env.COOKIE_SECRET, `${member}.${exp}`)) ? member : null;
}
