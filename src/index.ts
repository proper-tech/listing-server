// listing-server API — Cloudflare Worker + Hono.
// Өгөгдөл D1 (DB)-д, зураг R2 (UPLOADS)-д.
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import { createDb } from "./db/index.ts";
import { loadAuth } from "./auth.ts";
import { authRoutes } from "./routes/auth.ts";
import { inquiryRoutes } from "./routes/inquiries.ts";
import { postRoutes } from "./routes/posts.ts";
import { uploadsRoutes } from "./routes/uploads.ts";
import type { AppEnv } from "./types.ts";

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "https://listing-web-five.vercel.app",
  "https://listing-web-testing.vercel.app",
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
// Зургийг (GET /api/uploads/…) вэб өөр origin-оос <img>-ээр ачаалдаг тул CORP-ийг cross-origin болгоно.
const apiSecureHeaders = secureHeaders();
const imageSecureHeaders = secureHeaders({ crossOriginResourcePolicy: "cross-origin" });
app.use("*", (c, next) =>
  c.req.method === "GET" && c.req.path.startsWith("/api/uploads/")
    ? imageSecureHeaders(c, next)
    : apiSecureHeaders(c, next),
);
// Cookie-тэй тул: өөр сайтаас form (text/plain, urlencoded, multipart)-оор илгээсэн POST-ыг хаана.
// JSON хүсэлтийг CORS preflight хамгаална.
app.use("*", csrf({ origin: ALLOWED_ORIGINS }));

// Drizzle: route бүрт `c.var.db`
app.use("*", async (c, next) => {
  c.set("db", createDb(c.env.DB));
  await next();
});
// JWT cookie → `c.var.agent` (нэвтрээгүй бол null)
app.use("*", loadAuth);

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

app.route("/auth", authRoutes);
app.route("/posts", postRoutes);
app.route("/uploads", uploadsRoutes);
// /posts/:id/inquiries ба /inquiries — routes/inquiries.ts
app.route("/", inquiryRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  // Hono-ийн middleware-ийн алдаа (жишээ нь csrf → 403)-г хэвээр нь буцаана
  if (err instanceof HTTPException) return c.json({ error: err.message || "Хориглосон" }, err.status);
  console.error(err);
  return c.json({ error: "Серверийн алдаа" }, 500);
});

export default app satisfies ExportedHandler<Env>;
