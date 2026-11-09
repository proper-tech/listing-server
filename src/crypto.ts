// Нууц үг, токены хэш — зөвхөн WebCrypto (Worker болон Node 20+ хоёуланд ажиллана).

const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer | Uint8Array) =>
  Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex: string) => new Uint8Array((hex.match(/../g) || []).map((h) => parseInt(h, 16)));

export const randomHex = (bytes: number) => toHex(crypto.getRandomValues(new Uint8Array(bytes)));

export async function sha256Hex(s: string) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

// Workers WebCrypto PBKDF2-ийн дээд хязгаар 100 000 давталт.
const ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

/** Returns "pbkdf2-sha256$<iterations>$<saltHex>$<hashHex>". */
export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${toHex(salt)}$${toHex(await pbkdf2(password, salt, ITERATIONS))}`;
}

export async function verifyPassword(stored: string, password: string) {
  const [alg, iter, saltHex, hashHex] = stored.split('$');
  if (alg !== 'pbkdf2-sha256' || !iter || !saltHex || !hashHex) return false;
  const got = await pbkdf2(String(password), fromHex(saltHex), Number(iter));
  const want = fromHex(hashHex);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i]; // constant time
  return diff === 0;
}

// Same amount of work for unknown emails, so response time doesn't reveal which emails exist.
export const DUMMY_PASSWORD_HASH = `pbkdf2-sha256$${ITERATIONS}$00000000000000000000000000000000$${'0'.repeat(64)}`;
