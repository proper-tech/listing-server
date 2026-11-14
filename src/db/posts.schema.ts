// Зар (post / listing) — үл хөдлөх хөрөнгийн зар. Агент үүсгэнэ, нийтэд `active` төлөвтэй нь харагдана.
// Агентын зар `pending` төлөвтэй үүсч админ баталсны дараа `active` болно; админы зар шууд `active`.
// Зураг нь тусдаа `post_images` хүснэгтэд (R2 түлхүүрээр), дэс дараалалтай.
// Ангилал, талбаруудыг вэбийн "Зар нэмэх" маягттай (listing-web lib/types.ts) ижил байлгана.
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { agents } from "./agents.schema.ts";

export const DEAL_TYPES = ["sale", "rent"] as const; // зарах | түрээс
export const CATEGORIES = [
  "apartment", // орон сууц
  "house", // хашаа байшин
  "land", // газар
  "office", // оффис
  "shop", // худалдаа, үйлчилгээний талбай
  "warehouse", // үйлдвэр, агуулах
  "garage", // гараж, зогсоол
  "summer_house", // зуслан
] as const;
// unpaid = агентын зар, төлбөр хүлээгдэж буй (нийтэд болон админы хяналтад харагдахгүй);
// pending = админ хянаж байна, rejected = админ татгалзсан
export const POST_STATUSES = ["draft", "unpaid", "pending", "active", "rejected", "sold", "archived"] as const;
export const SELLER_TYPES = ["owner", "agent", "company"] as const;
// Зарын байршуулалт: free = энгийн, vip / top = 7 хоног жагсаалтын эхэнд. Үнэ: src/pricing.ts
export const PLACEMENTS = ["free", "vip", "top"] as const;

export type DealType = (typeof DEAL_TYPES)[number];
export type Category = (typeof CATEGORIES)[number];
export type PostStatus = (typeof POST_STATUSES)[number];
export type SellerType = (typeof SELLER_TYPES)[number];
export type Placement = (typeof PLACEMENTS)[number];

// 360° аялал (вэбийн Tour-тэй ижил бүтэц). Панорамын `src` нь /api/uploads/listings/… зам.
export type TourHotspot = { yaw: number; pitch: number; targetRoomId: string; label?: string };
export type TourRoom = {
  id: string;
  name: string;
  source: "upload360" | "stitched" | "ai" | "splat";
  panorama: { src: string; width: number; height: number };
  status: "ready";
  startYaw: number;
  hotspots: TourHotspot[];
  // хэсэгчилсэн панорама (утасны Pano): хэвтээ/босоо хамрах өнцөг, градусаар. Байхгүй бол бүтэн 360° бөмбөрцөг
  haov?: number;
  vaov?: number;
};
export type Tour = { startRoomId: string | null; rooms: TourRoom[] };

export const posts = sqliteTable(
  "posts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Үүсгэсэн агент. Агентыг устгавал зар үлдэнэ (эзэнгүй болно).
    agentId: integer("agent_id").references(() => agents.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    dealType: text("deal_type", { enum: DEAL_TYPES }).notNull(),
    category: text("category", { enum: CATEGORIES }).notNull(),
    district: text("district").notNull(), // дүүрэг / байршил
    khoroo: text("khoroo").notNull().default(""),
    address: text("address").notNull().default(""),
    lat: real("lat"), // газрын зураг дээрх цэг
    lng: real("lng"),
    price: integer("price").notNull(), // ₮ (бүхэл тоо)
    area: real("area").notNull(), // м²
    rooms: integer("rooms"), // өрөөний тоо (газар г.м-д null)
    floor: integer("floor"), // давхар
    totalFloors: integer("total_floors"), // нийт давхар
    yearInUse: integer("year_in_use"), // ашиглалтад орсон он
    floorMaterial: text("floor_material"), // шал
    balconies: integer("balconies"), // тагт
    windowType: text("window_type"), // цонх
    windowCount: integer("window_count"), // цонхны тоо
    doorType: text("door_type"), // хаалга
    garage: integer("garage", { mode: "boolean" }).notNull().default(false),
    leasing: integer("leasing", { mode: "boolean" }).notNull().default(false),
    paymentTerms: text("payment_terms", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    tour: text("tour", { mode: "json" }).$type<Tour>(), // 360° аялал, байхгүй бол null
    sellerName: text("seller_name").notNull().default(""), // зар дээр харагдах нэр
    sellerType: text("seller_type", { enum: SELLER_TYPES }).notNull().default("agent"),
    contactPhone: text("contact_phone").notNull().default(""),
    placement: text("placement", { enum: PLACEMENTS }).notNull().default("free"),
    placementUntil: integer("placement_until", { mode: "timestamp" }), // vip/top дуусах хугацаа (админ баталмагц эхэлнэ)
    // төлөгдсөн хугацаа: агентын зар QPay-ээр төлөхөд, админы зар үүсгэхэд (төлбөргүй). null = төлөөгүй
    paidAt: integer("paid_at", { mode: "timestamp" }),
    status: text("status", { enum: POST_STATUSES }).notNull().default("active"),
    views: integer("views").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("posts_browse_idx").on(t.status, t.dealType, t.category),
    index("posts_district_idx").on(t.district),
    index("posts_price_idx").on(t.price),
    index("posts_agent_idx").on(t.agentId),
    index("posts_created_idx").on(t.createdAt),
  ],
);

export const postImages = sqliteTable(
  "post_images",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    key: text("key").notNull(), // R2 (UPLOADS) доторх түлхүүр
    width: integer("width"), // px — вэб зургийн харьцааг урьдчилан мэднэ
    height: integer("height"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [index("post_images_post_idx").on(t.postId, t.sortOrder)],
);

export type Post = typeof posts.$inferSelect;
export type PostImage = typeof postImages.$inferSelect;
