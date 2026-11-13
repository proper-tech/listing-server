// Нэвтрэлт — JWT, HttpOnly cookie-д. Клиент `fetch(..., { credentials: "include" })` ашиглана.
//   POST /api/auth/login            { email, password } → JWT cookie тавина, { agent }
//   POST /api/auth/logout           cookie арилгана
//   GET  /api/auth/me               { agent } | 401
//   PATCH /api/auth/me              { name?, phone?, company?, bio?, avatarKey? } → { agent } (профайл засах)
//   POST /api/auth/change-password  { currentPassword, newPassword } → шинэ JWT, { agent }
//                                   бусад төхөөрөмж дээрх токенууд хүчингүй болно
import { Hono, type Context } from "hono";
import { and, count, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { agents, loginAttempts } from "../db/schema.ts";
import { getDummyHash, hashPassword, verifyPassword } from "../crypto.ts";
import { clearToken, issueToken, requireAuth, toPublicAgent } from "../auth.ts";
import { IMAGE_KEY_PREFIX } from "./uploads.ts";
import type { AppEnv } from "../types.ts";

export const authRoutes = new Hono<AppEnv>();

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_EMAIL = 5;
const MAX_FAILS_PER_IP = 20;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const invalidCredentials = (c: Context<AppEnv>) =>
  c.json({ error: "Имэйл эсвэл нууц үг буруу" }, 401);

authRoutes.post("/login", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = str(body?.email).trim().toLowerCase();
  const password = str(body?.password);
  if (!email || !password || email.length > 254 || password.length > PASSWORD_MAX)
    return c.json({ error: "Имэйл, нууц үгээ оруулна уу" }, 400);

  const db = c.var.db;
  const emailKey = `email:${email}`;
  const ipKey = `ip:${c.req.header("cf-connecting-ip") ?? "unknown"}`;
  const windowStart = new Date(Date.now() - ATTEMPT_WINDOW_MS);

  const fails = await db
    .select({ key: loginAttempts.key, n: count() })
    .from(loginAttempts)
    .where(and(inArray(loginAttempts.key, [emailKey, ipKey]), gt(loginAttempts.at, windowStart)))
    .groupBy(loginAttempts.key);
  const failsFor = (key: string) => fails.find((f) => f.key === key)?.n ?? 0;
  if (failsFor(emailKey) >= MAX_FAILS_PER_EMAIL || failsFor(ipKey) >= MAX_FAILS_PER_IP)
    return c.json({ error: "Олон удаа буруу оролдлоо. 15 минутын дараа дахин оролдоно уу" }, 429);

  const [agent] = await db.select().from(agents).where(eq(agents.email, email)).limit(1);
  // Агент байхгүй ч хэш тооцно — хариуны хугацаагаар имэйл байгаа эсэх мэдэгдэхгүй
  const ok = await verifyPassword(password, agent?.passwordHash ?? (await getDummyHash()));

  if (!agent || !ok || !agent.active) {
    await db.batch([
      db.insert(loginAttempts).values([{ key: emailKey }, { key: ipKey }]),
      db.delete(loginAttempts).where(lt(loginAttempts.at, windowStart)),
    ]);
    return invalidCredentials(c);
  }

  const now = new Date();
  await db.batch([
    db.delete(loginAttempts).where(eq(loginAttempts.key, emailKey)),
    db.update(agents).set({ lastLoginAt: now }).where(eq(agents.id, agent.id)),
  ]);
  await issueToken(c, agent);
  return c.json({ agent: toPublicAgent({ ...agent, lastLoginAt: now }) });
});

// JWT өөрөө хугацаа дуустлаа хүчинтэй — бүх төхөөрөмжөөс гаргахад token_version-ийг нэмэгдүүлнэ
authRoutes.post("/logout", (c) => {
  clearToken(c);
  return c.json({ ok: true });
});

authRoutes.get("/me", (c) => {
  const agent = c.var.agent;
  if (!agent) return c.json({ error: "Нэвтрээгүй байна" }, 401);
  return c.json({ agent }, 200, { "cache-control": "no-store" });
});

// Профайл засах (/account). Хэсэгчилсэн: өгсөн талбаруудыг л шинэчилнэ.
// Имэйл, эрх, идэвх — зөвхөн админ (энд солихгүй).
const PROFILE_TEXT = [
  ["name", 1, 60, "Нэр"],
  ["phone", 0, 30, "Утас"],
  ["company", 0, 80, "Компани"],
  ["bio", 0, 400, "Танилцуулга"],
] as const;

authRoutes.patch("/me", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body))
    return c.json({ error: "JSON объект илгээнэ үү" }, 400);

  const v: Partial<Pick<typeof agents.$inferInsert, "name" | "phone" | "company" | "bio" | "avatarKey">> = {};
  for (const [k, min, max, label] of PROFILE_TEXT) {
    if (!(k in body)) continue;
    if (typeof body[k] !== "string") return c.json({ error: `${label}: текст байна` }, 400);
    const s = body[k].trim();
    if (s.length < min || s.length > max)
      return c.json({ error: min ? `${label} ${min}–${max} тэмдэгт` : `${label} ${max} тэмдэгтээс хэтрэхгүй` }, 400);
    v[k] = s;
  }
  if (v.phone && !/^[0-9+\-\s()]+$/.test(v.phone))
    return c.json({ error: "Утас зөвхөн тоо, +, -, хаалт агуулна" }, 400);

  // Зураг: эхлээд POST /api/uploads → key; null бол арилгана
  if ("avatarKey" in body) {
    const key = body.avatarKey;
    if (key === null) v.avatarKey = null;
    else if (typeof key !== "string" || !key.startsWith(IMAGE_KEY_PREFIX) || key.length > 200)
      return c.json({ error: "Зургийн түлхүүр буруу (эхлээд /api/uploads-руу байршуулна)" }, 400);
    else if (!(await c.env.UPLOADS.head(key))) return c.json({ error: "Зураг олдсонгүй" }, 400);
    else v.avatarKey = key;
  }
  if (!Object.keys(v).length) return c.json({ error: "Өөрчлөх талбар алга" }, 400);

  const [updated] = await c.var.db
    .update(agents)
    .set(v)
    .where(eq(agents.id, c.var.agent!.id))
    .returning();
  if (!updated) return c.json({ error: "Олдсонгүй" }, 404);
  return c.json({ agent: toPublicAgent(updated) }, 200, { "cache-control": "no-store" });
});

// Түр нууц үгтэй (mustChangePassword) агент ч ашиглана — тиймээс requireAuth биш.
authRoutes.post("/change-password", async (c) => {
  const current = c.var.agent;
  if (!current) return c.json({ error: "Нэвтрээгүй байна" }, 401);

  const body = await c.req.json().catch(() => null);
  const currentPassword = str(body?.currentPassword);
  const newPassword = str(body?.newPassword);
  if (newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX)
    return c.json({ error: `Шинэ нууц үг ${PASSWORD_MIN}–${PASSWORD_MAX} тэмдэгт байна` }, 400);
  if (newPassword === currentPassword)
    return c.json({ error: "Шинэ нууц үг хуучнаасаа өөр байх ёстой" }, 400);

  const db = c.var.db;
  const [row] = await db
    .select({ passwordHash: agents.passwordHash })
    .from(agents)
    .where(eq(agents.id, current.id))
    .limit(1);
  if (!row || !(await verifyPassword(currentPassword, row.passwordHash)))
    return c.json({ error: "Одоогийн нууц үг буруу" }, 400);

  // token_version + 1 → өмнөх бүх JWT хүчингүй; энэ төхөөрөмжид шинэ токен олгоно
  const [updated] = await db
    .update(agents)
    .set({
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
      tokenVersion: sql`${agents.tokenVersion} + 1`,
    })
    .where(eq(agents.id, current.id))
    .returning();
  await issueToken(c, updated!);
  return c.json({ agent: toPublicAgent(updated!) });
});
