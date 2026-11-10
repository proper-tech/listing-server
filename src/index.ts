// listing-server API — Cloudflare Worker + Hono.
// Өгөгдөл D1 (DB)-д, зураг R2 (UPLOADS)-д.
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { cors } from "hono/cors";
import { sql } from "drizzle-orm";
import { createDb } from "./db/index.ts";
import { testRoutes } from "./routes/test.ts";
import { mockRoutes } from "./routes/mock.ts";
import type { AppEnv } from "./types.ts";

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "https://listing-web-five.vercel.app",
];

const app = new Hono<AppEnv>().basePath("/api");

app.use(
  "*",
  cors({
    origin: (origin) => (ALLOWED_ORIGINS.includes(origin) ? origin : null),
    credentials: true,
    allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  }),
);
app.use("*", secureHeaders());

// Drizzle: route бүрт `c.var.db`
app.use("*", async (c, next) => {
  c.set("db", createDb(c.env.DB));
  await next();
});

app.get("/health", async (c) => {
  const [db, storage] = await Promise.all([
    c.var.db
      .run(sql`select 1`)
      .then(() => "ok")
      .catch((e) => (console.error("D1 health:", e), "error")),
    c.env.UPLOADS.list({ limit: 1 })
      .then(() => "ok")
      .catch((e) => (console.error("R2 health:", e), "error")),
  ]);
  const ok = db === "ok" && storage === "ok";
  // local = `npm run dev` (.wrangler/state), testing / production = Cloudflare дээрх D1, R2
  const environment = c.env.ENVIRONMENT;
  return c.json({ ok, environment, db, storage }, ok ? 200 : 503, {
    "cache-control": "no-store",
  });
});

app.route("/test", testRoutes);
app.route("/mock", mockRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Серверийн алдаа" }, 500);
});

export default app satisfies ExportedHandler<Env>;
