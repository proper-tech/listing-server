// Агент, админ. Нийтийн бүртгэлгүй — агентыг админ үүсгэнэ.
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(), // нэвтрэх нэр, жижиг үсгээр хадгална
  phone: text("phone").notNull().default(""), // зар дээрх холбоо барих утас
  role: text("role", { enum: ["admin", "agent"] }).notNull().default("agent"),
  passwordHash: text("password_hash").notNull(), // argon2id ($argon2id$v=19$m=19456,t=2,p=1$…)
  mustChangePassword: integer("must_change_password", { mode: "boolean" })
    .notNull()
    .default(true), // админ үүсгэсэн түр нууц үгийг анх нэвтрэхэд солиулна
  active: integer("active", { mode: "boolean" }).notNull().default(true), // false = нэвтрэх эрхгүй
  // JWT-ийн `ver`-тэй тулгана — нэмэгдүүлбэл өмнө олгосон бүх токен хүчингүй (нууц үг солих г.м.)
  tokenVersion: integer("token_version").notNull().default(0),
  avatarKey: text("avatar_key"), // UPLOADS bucket доторх зургийн түлхүүр
  // Профайл (/account): агент өөрөө засна
  company: text("company").notNull().default(""), // компани / агентлаг (≤80)
  bio: text("bio").notNull().default(""), // танилцуулга (≤400)
  lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`)
    .$onUpdate(() => new Date()),
});

export type Agent = typeof agents.$inferSelect;
// Клиент рүү буцаахдаа passwordHash, tokenVersion-ийг хэзээ ч бүү оруул
export type PublicAgent = Omit<Agent, "passwordHash" | "tokenVersion">;
