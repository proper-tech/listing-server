// Төлбөр (агентын зар байршуулах + VIP/Онцгой). Нэг зарт олон оролдлого (нэхэмжлэх) байж болно;
// `paid` болсон нь зарын `paid_at`-ийг тавьж, зарыг админы хяналт (`pending`) руу шилжүүлнэ.
// Зар/агент устсан ч төлбөрийн бүртгэл үлдэнэ (set null) — санхүүгийн түүх.
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agents } from "./agents.schema.ts";
import { posts } from "./posts.schema.ts";

export const PAYMENT_STATUSES = ["pending", "paid", "cancelled"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const payments = sqliteTable(
  "payments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    postId: integer("post_id").references(() => posts.id, { onDelete: "set null" }),
    agentId: integer("agent_id").references(() => agents.id, { onDelete: "set null" }),
    amount: integer("amount").notNull(), // ₮, сервер тооцсон (src/pricing.ts)
    items: text("items", { mode: "json" }).$type<{ code: string; label: string; amount: number }[]>().notNull(),
    status: text("status", { enum: PAYMENT_STATUSES }).notNull().default("pending"),
    provider: text("provider").notNull().default("qpay"), // qpay | mock (туршилт)
    senderInvoiceNo: text("sender_invoice_no").notNull().unique(), // бидний нэхэмжлэхийн дугаар (QPay-д илгээнэ)
    invoiceId: text("invoice_id"), // QPay invoice_id
    providerPaymentId: text("provider_payment_id"), // QPay payment_id (төлөгдсөний дараа)
    qrText: text("qr_text"),
    qrImage: text("qr_image"), // base64 PNG (QPay өгнө) — дахин нээхэд QR-ийг дахин үүсгэхгүй
    shortUrl: text("short_url"),
    links: text("links", { mode: "json" }).$type<{ name: string; description: string; logo: string; link: string }[]>(),
    paidAt: integer("paid_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index("payments_post_idx").on(t.postId, t.status), index("payments_status_idx").on(t.status, t.paidAt)],
);

export type Payment = typeof payments.$inferSelect;
