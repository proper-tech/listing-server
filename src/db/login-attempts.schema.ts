// Буруу нэвтрэх оролдлого — хурдны хязгаар (бүх Worker instance-д нийтлэг).
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// key: "email:<имэйл>" | "ip:<IP>"
export const loginAttempts = sqliteTable(
  "login_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    key: text("key").notNull(),
    at: integer("at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index("login_attempts_key_at_idx").on(t.key, t.at)],
);
