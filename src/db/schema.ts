// D1 (SQLite) хүснэгтүүд — Drizzle schema.
// Өөрчилсний дараа `npm run db:generate` → migrations/ дотор SQL үүснэ → `npm run db:migrate:local`.
import { relations, sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// DB шалгах тест хүснэгт (/api/test — зөвхөн testing орчинд)
export const testItems = sqliteTable("test_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  message: text("message").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/* ---------- Mock схем (зөвхөн testing) — /api/mock, өгөгдөл: seeds/mock.sql ---------- */

export const mockAgents = sqliteTable("mock_agents", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  phone: text("phone").notNull(),
  role: text("role", { enum: ["admin", "agent"] }).notNull().default("agent"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const mockListings = sqliteTable(
  "mock_listings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agentId: integer("agent_id").references(() => mockAgents.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    dealType: text("deal_type", { enum: ["sale", "rent"] }).notNull(),
    category: text("category", {
      enum: ["apartment", "house", "land", "office", "shop", "garage"],
    }).notNull(),
    district: text("district").notNull(),
    price: integer("price").notNull(), // ₮
    area: real("area").notNull(), // м²
    rooms: integer("rooms"),
    floor: integer("floor"),
    status: text("status", { enum: ["active", "sold", "expired"] })
      .notNull()
      .default("active"),
    views: integer("views").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index("mock_listings_browse_idx").on(t.status, t.dealType, t.category),
    index("mock_listings_district_idx").on(t.district),
    index("mock_listings_price_idx").on(t.price),
    index("mock_listings_agent_idx").on(t.agentId),
  ],
);

export const mockListingImages = sqliteTable(
  "mock_listing_images",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    listingId: integer("listing_id")
      .notNull()
      .references(() => mockListings.id, { onDelete: "cascade" }),
    r2Key: text("r2_key").notNull(), // UPLOADS bucket доторх түлхүүр
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("mock_listing_images_listing_idx").on(t.listingId, t.sortOrder)],
);

// db.query.* (relational query)-д хэрэгтэй холбоосууд
export const mockAgentsRelations = relations(mockAgents, ({ many }) => ({
  listings: many(mockListings),
}));
export const mockListingsRelations = relations(mockListings, ({ one, many }) => ({
  agent: one(mockAgents, {
    fields: [mockListings.agentId],
    references: [mockAgents.id],
  }),
  images: many(mockListingImages),
}));
export const mockListingImagesRelations = relations(mockListingImages, ({ one }) => ({
  listing: one(mockListings, {
    fields: [mockListingImages.listingId],
    references: [mockListings.id],
  }),
}));
