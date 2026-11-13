// Агент удирдлага (зөвхөн админ). Нийтийн бүртгэлгүй — агентыг админ үүсгэнэ.
//   GET   /api/agents          → { agents: [PublicAgent & { listings }] }
//   POST  /api/agents          { name, email, phone?, password, role? } → 201 { agent }
//                              түр нууц үг: агент анх нэвтрэхэд солино (mustChangePassword)
//   PATCH /api/agents/:id      { name?, email?, phone?, active?, password?, role? } → { agent }
//                              password → түр нууц үг, бүх төхөөрөмжөөс гаргана; active=false → шууд гаргана.
//                              Админ өөрийгөө идэвхгүй болгох, эрхээ бууруулах боломжгүй.
import { Hono } from "hono";
import { count, desc, eq, sql } from "drizzle-orm";
import { agents, posts } from "../db/schema.ts";
import { requireAdmin, toPublicAgent } from "../auth.ts";
import { hashPassword } from "../crypto.ts";
import type { AppEnv } from "../types.ts";

export const agentRoutes = new Hono<AppEnv>();
agentRoutes.use("*", requireAdmin);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ["admin", "agent"] as const;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;

type AgentSet = Partial<typeof agents.$inferInsert>;

/** Body → өөрчлөх утгууд. `creating` үед name, email, password заавал. */
async function parse(body: Record<string, unknown>, creating: boolean): Promise<AgentSet | { error: string }> {
  const v: AgentSet = {};
  const has = (k: string) => creating || k in body;
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : undefined);

  if (has("name")) {
    const name = str("name");
    if (!name || name.length > 60) return { error: "Нэр 1–60 тэмдэгт" };
    v.name = name;
  }
  if (has("email")) {
    const email = str("email")?.toLowerCase();
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) return { error: "Имэйл хаяг буруу байна" };
    v.email = email;
  }
  if ("phone" in body) {
    const phone = str("phone") ?? "";
    if (phone.length > 30 || (phone && !/^[0-9+\-\s()]+$/.test(phone)))
      return { error: "Утас 30 хүртэл тэмдэгт (тоо, +, -, хаалт)" };
    v.phone = phone;
  }
  if ("role" in body) {
    if (!ROLES.includes(body.role as never)) return { error: `role: ${ROLES.join(" | ")}` };
    v.role = body.role as (typeof ROLES)[number];
  }
  if ("active" in body) {
    if (typeof body.active !== "boolean") return { error: "active: true | false" };
    v.active = body.active;
  }
  if (has("password")) {
    const pw = typeof body.password === "string" ? body.password : "";
    if (pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX)
      return { error: `Нууц үг ${PASSWORD_MIN}–${PASSWORD_MAX} тэмдэгт` };
    v.passwordHash = await hashPassword(pw);
    v.mustChangePassword = true; // түр нууц үг — агент өөрөө солино
  }
  return v;
}

const emailTaken = async (c: { var: AppEnv["Variables"] }, email: string, exceptId?: number) => {
  const [row] = await c.var.db.select({ id: agents.id }).from(agents).where(eq(agents.email, email)).limit(1);
  return !!row && row.id !== exceptId;
};

agentRoutes.get("/", async (c) => {
  const db = c.var.db;
  const [rows, counts] = await Promise.all([
    db.select().from(agents).orderBy(desc(agents.createdAt)),
    db.select({ agentId: posts.agentId, n: count() }).from(posts).groupBy(posts.agentId),
  ]);
  const byAgent = new Map(counts.map((r) => [r.agentId, r.n]));
  return c.json(
    { agents: rows.map((a) => ({ ...toPublicAgent(a), listings: byAgent.get(a.id) ?? 0 })) },
    200,
    { "cache-control": "no-store" },
  );
});

agentRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "JSON объект илгээнэ үү" }, 400);
  const v = await parse(body, true);
  if ("error" in v) return c.json({ error: v.error }, 400);
  if (await emailTaken(c, v.email!)) return c.json({ error: "Энэ имэйлтэй хэрэглэгч бүртгэлтэй байна" }, 409);

  const [created] = await c.var.db
    .insert(agents)
    .values({ ...v, name: v.name!, email: v.email!, passwordHash: v.passwordHash! })
    .returning();
  return c.json({ agent: { ...toPublicAgent(created!), listings: 0 } }, 201);
});

agentRoutes.patch("/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const me = c.var.agent!;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "JSON объект илгээнэ үү" }, 400);
  const v = await parse(body, false);
  if ("error" in v) return c.json({ error: v.error }, 400);
  if (!Object.keys(v).length) return c.json({ error: "Өөрчлөх талбар алга" }, 400);
  if (id === me.id && (v.active === false || v.role === "agent"))
    return c.json({ error: "Өөрийгөө идэвхгүй болгох, эрхээ бууруулах боломжгүй" }, 400);
  if (v.email && (await emailTaken(c, v.email, id))) return c.json({ error: "Энэ имэйлтэй хэрэглэгч бүртгэлтэй байна" }, 409);

  // нууц үг солих, идэвхгүй болгох → өмнөх бүх токен хүчингүй
  const revoke = !!v.passwordHash || v.active === false;
  const [updated] = await c.var.db
    .update(agents)
    .set({ ...v, ...(revoke ? { tokenVersion: sql`${agents.tokenVersion} + 1` } : {}) })
    .where(eq(agents.id, id))
    .returning();
  if (!updated) return c.json({ error: "Хэрэглэгч олдсонгүй" }, 404);
  const [{ n }] = await c.var.db.select({ n: count() }).from(posts).where(eq(posts.agentId, id));
  return c.json({ agent: { ...toPublicAgent(updated), listings: n } });
});
