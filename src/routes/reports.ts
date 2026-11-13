// Зарыг мэдээлэх (report).
//   POST   /api/posts/:id/reports   (нийтийн)  { reason, note? } → 201 { ok }
//                                   reason: fake | duplicate | wrong_price | sold | other. Зөвхөн `active` зарт.
//                                   IP-ээр цагт 10; нэг IP нэг зарыг нээлттэй байхад дахин мэдээлбэл давхардуулахгүй (200)
//   GET    /api/reports             (админ)    нээлттэй мэдээллүүд → { reports: [{ id, postId, reason, note, createdAt }] }
//   DELETE /api/posts/:id/reports   (админ)    зарын нээлттэй мэдээллүүдийг шийдвэрлэсэн болгоно → { resolved }
import { Hono } from "hono";
import { and, count, desc, eq, gt, isNull } from "drizzle-orm";
import { posts, reports, REPORT_REASONS } from "../db/schema.ts";
import { requireAdmin } from "../auth.ts";
import type { AppEnv } from "../types.ts";

export const reportRoutes = new Hono<AppEnv>();

const RATE = { windowMs: 60 * 60 * 1000, max: 10 }; // цагт 10
const NOTE_MAX = 500;

reportRoutes.post("/posts/:id{[0-9]+}/reports", async (c) => {
  const postId = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => null);
  const reason = body?.reason;
  if (!REPORT_REASONS.includes(reason)) return c.json({ error: `reason: ${REPORT_REASONS.join(" | ")}` }, 400);
  const note = typeof body?.note === "string" ? body.note.trim() : "";
  if (note.length > NOTE_MAX) return c.json({ error: `Тайлбар ${NOTE_MAX} тэмдэгтээс хэтрэхгүй` }, 400);

  const db = c.var.db;
  const ip = c.req.header("cf-connecting-ip") ?? null;
  const [[post], recent, dup] = await Promise.all([
    db.select({ status: posts.status }).from(posts).where(eq(posts.id, postId)).limit(1),
    ip
      ? db
          .select({ n: count() })
          .from(reports)
          .where(and(eq(reports.ip, ip), gt(reports.createdAt, new Date(Date.now() - RATE.windowMs))))
          .then(([r]) => r?.n ?? 0)
      : 0,
    ip
      ? db
          .select({ id: reports.id })
          .from(reports)
          .where(and(eq(reports.ip, ip), eq(reports.postId, postId), isNull(reports.resolvedAt)))
          .limit(1)
          .then(([r]) => !!r)
      : false,
  ]);
  if (!post || post.status !== "active") return c.json({ error: "Зар олдсонгүй" }, 404);
  if (dup) return c.json({ ok: true }); // аль хэдийн мэдээлсэн — дахин тоолохгүй
  if (recent >= RATE.max) return c.json({ error: "Хэт олон мэдээлэл илгээлээ. Түр хүлээгээд дахин оролдоно уу" }, 429);

  await db.insert(reports).values({ postId, reason, note, ip });
  return c.json({ ok: true }, 201);
});

reportRoutes.get("/reports", requireAdmin, async (c) => {
  const rows = await c.var.db
    .select({ id: reports.id, postId: reports.postId, reason: reports.reason, note: reports.note, createdAt: reports.createdAt })
    .from(reports)
    .where(isNull(reports.resolvedAt))
    .orderBy(desc(reports.createdAt))
    .limit(1000);
  return c.json({ reports: rows }, 200, { "cache-control": "no-store" });
});

reportRoutes.delete("/posts/:id{[0-9]+}/reports", requireAdmin, async (c) => {
  const postId = Number(c.req.param("id"));
  const done = await c.var.db
    .update(reports)
    .set({ resolvedAt: new Date() })
    .where(and(eq(reports.postId, postId), isNull(reports.resolvedAt)))
    .returning({ id: reports.id });
  return c.json({ resolved: done.length });
});
