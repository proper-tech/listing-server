// Зураг байршуулах / үзүүлэх — Cloudflare R2 (UPLOADS binding).
//   POST /api/uploads            (нэвтэрсэн)  multipart/form-data, талбар "file" → { key, url }
//   GET  /api/uploads/:key       (нийтийн)    R2-оос зургийг дамжуулна (урт cache)
// Зураг зөвхөн энд үүсгэсэн `listings/…` түлхүүртэй — зар үүсгэхэд энэ түлхүүрүүдийг дамжуулна.
import { Hono } from "hono";
import { requireAuth } from "../auth.ts";
import type { AppEnv } from "../types.ts";

export const uploadsRoutes = new Hono<AppEnv>();

export const IMAGE_KEY_PREFIX = "listings/";
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB — 360° панорам (6000×3000 JPEG) 5MB-аас давж болно
// content-type → өргөтгөл
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

uploadsRoutes.post("/", requireAuth, async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return c.json({ error: "Зураг (file) оруулна уу" }, 400);

  const ext = EXT[file.type];
  if (!ext) return c.json({ error: "Зөвхөн JPEG, PNG, WebP, AVIF зураг" }, 415);
  if (file.size === 0 || file.size > MAX_BYTES)
    return c.json({ error: "Зураг 15MB-аас хэтрэхгүй байх ёстой" }, 413);

  const key = `${IMAGE_KEY_PREFIX}${crypto.randomUUID()}.${ext}`;
  await c.env.UPLOADS.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });
  return c.json({ key, url: `/api/uploads/${key}` }, 201);
});

uploadsRoutes.get("/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const obj = await c.env.UPLOADS.get(key);
  if (!obj) return c.json({ error: "Олдсонгүй" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
      etag: obj.httpEtag,
    },
  });
});
