import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./types.ts";

// Тест route-ууд production-д байхгүй мэт 404 буцаана.
export const testingOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (c.env.ENVIRONMENT === "production") return c.json({ error: "Not found" }, 404);
  await next();
});
