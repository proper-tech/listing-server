// Зарын талаар холбогдох хүсэлт (inquiry) — зарын хуудсан дээрх "Энэ зарын талаар холбогдох" форм.
// Хэн ч (нэвтрээгүй) илгээнэ; зарын эзэн агент (админ бүгдийг) "Миний зар" хуудсандаа харна.
// Зарыг устгавал хүсэлтүүд нь хамт устна (cascade).
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { posts } from "./posts.schema.ts";

export const inquiries = sqliteTable(
  "inquiries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // 2–60 тэмдэгт, зөвхөн үсэг
    phone: text("phone").notNull(), // 8 оронтой, 5–9-өөр эхэлнэ (+976-г хассан)
    email: text("email"), // заавал биш, жижиг үсгээр
    message: text("message").notNull(), // 5–1000 тэмдэгт
    readAt: integer("read_at", { mode: "timestamp" }), // эзэн нээж уншсан хугацаа; null = шинэ
    ip: text("ip"), // илгээгчийн IP — зөвхөн хурдны хязгаарт (спам)
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index("inquiries_post_idx").on(t.postId, t.createdAt),
    index("inquiries_ip_idx").on(t.ip, t.createdAt),
  ],
);

export type Inquiry = typeof inquiries.$inferSelect;
