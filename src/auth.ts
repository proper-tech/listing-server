// JWT нэвтрэлт + middleware.
//
// Токен: HS256 JWT { sub: агентын id, role, ver: token_version, iat, exp }, JWT_SECRET-ээр гарын үсэг зурна.
// Клиент рүү зөвхөн HttpOnly cookie-оор (JS уншиж чадахгүй — XSS-ээс хамгаална).
// Cookie: HttpOnly, Secure, SameSite —
//   production → Lax  (API, вэб нэг site дээр байх ёстой, жишээ нь api.example.mn + example.mn)
//   бусад      → None (localhost:3000 / vercel.app → workers.dev cross-site хүсэлт)
//
// Хүчингүй болгох: хүсэлт бүрт агентыг id-аар (primary key) уншиж `active`, `ver === token_version`
// шалгана — нууц үг солих, идэвхгүй болгоход хуучин токенууд шууд хүчингүй.
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { sign, verify } from "hono/jwt";
import { and, eq, getTableColumns } from "drizzle-orm";
import { agents, type Agent, type PublicAgent } from "./db/schema.ts";
import type { AppEnv } from "./types.ts";

export const AUTH_COOKIE = "token";
const TOKEN_TTL = 30 * 24 * 60 * 60; // 30 хоног (секунд)
const ALG = "HS256";

const cookieOptions = (c: Context<AppEnv>) =>
  ({
    path: "/",
    httpOnly: true,
    secure: true, // SameSite=None-д заавал; localhost дээр хөтчүүд зөвшөөрдөг
    sameSite: c.env.ENVIRONMENT === "production" ? "Lax" : "None",
  }) as const;

const jwtSecret = (c: Context<AppEnv>) => {
  const secret = c.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("JWT_SECRET тохируулаагүй (≥ 32 тэмдэгт)");
  return secret;
};

// Клиент рүү буцаах баганууд (passwordHash, tokenVersion-гүй)
const {
  passwordHash: _hash,
  tokenVersion: _version,
  ...publicAgentColumns
} = getTableColumns(agents);
export const toPublicAgent = ({
  passwordHash: _h,
  tokenVersion: _v,
  ...agent
}: Agent): PublicAgent => agent;

// JWT үүсгэж cookie-д тавина
export async function issueToken(
  c: Context<AppEnv>,
  agent: Pick<Agent, "id" | "role" | "tokenVersion">,
) {
  const now = Math.floor(Date.now() / 1000);
  const token = await sign(
    { sub: String(agent.id), role: agent.role, ver: agent.tokenVersion, iat: now, exp: now + TOKEN_TTL },
    jwtSecret(c),
    ALG,
  );
  setCookie(c, AUTH_COOKIE, token, { ...cookieOptions(c), maxAge: TOKEN_TTL });
}

export const clearToken = (c: Context<AppEnv>) => deleteCookie(c, AUTH_COOKIE, cookieOptions(c));

// Cookie-ийн JWT-г шалгаж `c.var.agent`-д тавина (буруу, хугацаа дууссан, хүчингүй бол null)
export const loadAuth = createMiddleware<AppEnv>(async (c, next) => {
  c.set("agent", null);
  const token = getCookie(c, AUTH_COOKIE);
  if (token) {
    const claims = await verify(token, jwtSecret(c), ALG).catch(() => null);
    const id = Number(claims?.sub);
    if (claims && Number.isInteger(id) && typeof claims.ver === "number") {
      const [agent] = await c.var.db
        .select(publicAgentColumns)
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.active, true), eq(agents.tokenVersion, claims.ver)))
        .limit(1);
      if (agent) c.set("agent", agent);
    }
  }
  await next();
});

// Нэвтэрсэн, түр нууц үгээ сольсон агент шаардана.
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const agent = c.var.agent;
  if (!agent) return c.json({ error: "Нэвтрээгүй байна" }, 401);
  if (agent.mustChangePassword)
    return c.json({ error: "Нууц үгээ солино уу", code: "PASSWORD_CHANGE_REQUIRED" }, 403);
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.var.agent) return c.json({ error: "Нэвтрээгүй байна" }, 401);
  if (c.var.agent.role !== "admin") return c.json({ error: "Зөвхөн админ" }, 403);
  return requireAuth(c, next);
});
