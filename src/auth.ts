// Нэвтрэлт: зөвхөн админ, агент (имэйл + нууц үг). Нийтийн бүртгэлгүй — агентыг админ үүсгэнэ.
// Сесс: HttpOnly cookie-д санамсаргүй токен, Postgres-д зөвхөн түүний SHA-256 хэш.
import type { Sql } from './db.ts';
import { DUMMY_PASSWORD_HASH, hashPassword, randomHex, sha256Hex, verifyPassword } from './crypto.ts';

export type Role = 'admin' | 'agent';
export type User = {
  id: string; name: string; email: string; phone: string; role: Role; active: boolean;
  mustChangePassword: boolean; password: string; createdAt: string;
};
type UserRow = {
  id: string; name: string; email: string; phone: string; role: Role; active: boolean;
  must_change_password: boolean; password: string; created_at: Date;
};

export const SESSION_COOKIE = 'ger360_session';
export const SESSION_DAYS = 14;
export const ROLES: Role[] = ['admin', 'agent'];

const toUser = (r: UserRow): User => ({
  id: r.id, name: r.name, email: r.email, phone: r.phone, role: r.role, active: r.active,
  mustChangePassword: r.must_change_password, password: r.password, createdAt: new Date(r.created_at).toISOString(),
});
export const publicUser = (u: User) => ({
  id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, active: u.active,
  createdAt: u.createdAt, mustChangePassword: u.mustChangePassword,
});

export const normEmail = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().slice(0, 254) : '');
export const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
export const validPassword = (pw: unknown): pw is string => typeof pw === 'string' && pw.length >= 8 && pw.length <= 200;

/* ---------- users ---------- */
export async function userById(sql: Sql, id: string) {
  const [r] = await sql<UserRow[]>`select * from users where id = ${id}`;
  return r ? toUser(r) : null;
}
export async function userByEmail(sql: Sql, email: string) {
  const [r] = await sql<UserRow[]>`select * from users where email = ${email}`;
  return r ? toUser(r) : null;
}
export async function emailTaken(sql: Sql, email: string, exceptId = '') {
  const rows = await sql`select 1 from users where email = ${email} and id <> ${exceptId}`;
  return rows.length > 0;
}
export async function createUser(sql: Sql, u: { name: string; email: string; phone: string; role: Role; password: string; mustChangePassword: boolean; id?: string }) {
  const id = u.id || 'u-' + randomHex(6);
  const [r] = await sql<UserRow[]>`
    insert into users (id, name, email, phone, role, must_change_password, password)
    values (${id}, ${u.name}, ${u.email}, ${u.phone}, ${u.role}, ${u.mustChangePassword}, ${await hashPassword(u.password)})
    returning *`;
  return toUser(r);
}
export async function updateUser(sql: Sql, id: string, p: { name?: string; email?: string; active?: boolean; password?: string; mustChangePassword?: boolean }) {
  const [r] = await sql<UserRow[]>`
    update users set
      name = coalesce(${p.name ?? null}::text, name),
      email = coalesce(${p.email ?? null}::text, email),
      active = coalesce(${p.active ?? null}::boolean, active),
      password = coalesce(${p.password ? await hashPassword(p.password) : null}::text, password),
      must_change_password = coalesce(${p.mustChangePassword ?? null}::boolean, must_change_password)
    where id = ${id}
    returning *`;
  return r ? toUser(r) : null;
}
export async function listUsers(sql: Sql) {
  const rows = await sql<(UserRow & { listings: number })[]>`
    select u.*, (select count(*)::int from listings l where l.owner_id = u.id) as listings
    from users u order by u.role, u.created_at`;
  return rows.map((r) => ({ ...publicUser(toUser(r)), listings: r.listings }));
}

/* ---------- sessions ---------- */
export function readCookie(header: string | undefined, name: string) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}
export function sessionCookie(token: string, maxAgeSec: number, secure: boolean) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}
export async function createSession(sql: Sql, userId: string) {
  const token = randomHex(32);
  await sql`delete from sessions where expires_at < now()`;
  await sql`insert into sessions (token_hash, user_id, expires_at)
            values (${await sha256Hex(token)}, ${userId}, now() + ${SESSION_DAYS}::int * interval '1 day')`;
  return token;
}
export async function sessionUser(sql: Sql, token: string | null) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const [r] = await sql<UserRow[]>`
    select u.* from sessions s join users u on u.id = s.user_id
    where s.token_hash = ${await sha256Hex(token)} and s.expires_at > now() and u.active`;
  return r ? toUser(r) : null;
}
export async function deleteSession(sql: Sql, token: string | null) {
  if (token) await sql`delete from sessions where token_hash = ${await sha256Hex(token)}`;
}
/** Logs a user out everywhere (except, optionally, the current session). */
export async function deleteUserSessions(sql: Sql, userId: string, keepToken: string | null = null) {
  const keep = keepToken ? await sha256Hex(keepToken) : '';
  await sql`delete from sessions where user_id = ${userId} and token_hash <> ${keep}`;
}

/* ---------- login ---------- */
const MAX_FAILS = 10, WINDOW_MIN = 15;
export async function loginBlocked(sql: Sql, key: string) {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from login_attempts where key = ${key} and at > now() - ${WINDOW_MIN}::int * interval '1 minute'`;
  return n >= MAX_FAILS;
}
export async function recordLoginFailure(sql: Sql, key: string) {
  await sql`insert into login_attempts (key) values (${key})`;
  await sql`delete from login_attempts where at < now() - interval '1 day'`;
}
export async function clearLoginFailures(sql: Sql, key: string) {
  await sql`delete from login_attempts where key = ${key}`;
}
/** Checks the password; always does the same hashing work so unknown emails aren't revealed by timing. */
export async function checkLogin(user: User | null, password: unknown) {
  const ok = await verifyPassword(user?.password || DUMMY_PASSWORD_HASH, String(password ?? ''));
  return ok && !!user;
}
