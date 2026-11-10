// DB шалгах тест API — зөвхөн testing / локал орчинд (production-д 404).
//   GET    /api/test       сүүлийн 50 мөр
//   POST   /api/test       { "message": "..." } → шинэ мөр
//   DELETE /api/test/:id   мөр устгах
import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { testItems } from "../db/schema.ts";
import { testingOnly } from "../middleware.ts";
import type { AppEnv } from "../types.ts";

export const testRoutes = new Hono<AppEnv>();

testRoutes.use("*", testingOnly);

testRoutes.get("/", async (c) => {
  const items = await c.var.db
    .select()
    .from(testItems)
    .orderBy(desc(testItems.id))
    .limit(50);
  return c.json({ items });
});

testRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message || message.length > 500)
    return c.json({ error: "message: 1–500 тэмдэгт" }, 400);

  const [item] = await c.var.db
    .insert(testItems)
    .values({ message })
    .returning();
  return c.json({ item }, 201);
});

testRoutes.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "Буруу id" }, 400);

  const [item] = await c.var.db
    .delete(testItems)
    .where(eq(testItems.id, id))
    .returning();
  if (!item) return c.json({ error: "Not found" }, 404);
  return c.json({ item });
});
