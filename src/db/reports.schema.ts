// Зарыг мэдээлэх (report) — зарын хуудсан дээрх "⚑ Зарыг мэдээлэх". Хэн ч (нэвтрээгүй) илгээнэ;
// админ "Админ самбар → Мэдээлэгдсэн"-д харж шийдвэрлэнэ (resolved_at). Зар устгавал cascade.
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { posts } from "./posts.schema.ts";

export const REPORT_REASONS = ["fake", "duplicate", "wrong_price", "sold", "other"] as const;

export const reports = sqliteTable(
  "reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    reason: text("reason", { enum: REPORT_REASONS }).notNull(),
    note: text("note").notNull().default(""), // ≤500
    ip: text("ip"), // зөвхөн хурдны хязгаар, давхардал шалгахад — клиент рүү бүү буцаа
    resolvedAt: integer("resolved_at", { mode: "timestamp" }), // админ шийдвэрлэсэн; null = нээлттэй
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index("reports_post_idx").on(t.postId, t.resolvedAt),
    index("reports_ip_idx").on(t.ip, t.createdAt),
  ],
);

export type Report = typeof reports.$inferSelect;
