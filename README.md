# listing-server

Үл хөдлөх хөрөнгийн зарын сайтын (listing-web) backend — **Cloudflare Worker + Hono**.

- **Өгөгдөл:** Cloudflare D1 (`DB` binding) + [Drizzle ORM](https://orm.drizzle.team)
- **Зураг:** Cloudflare R2 (`UPLOADS` binding)

Endpoint-ууд:

- `GET /api/health` — D1, R2 холболт шалгах
- `/api/auth` — нэвтрэлт (JWT, HttpOnly cookie `token`-д; клиент `fetch(url, { credentials: "include" })`):
  - `POST /api/auth/login` `{ email, password }` → JWT cookie тавина, `{ agent }`
  - `POST /api/auth/logout`
  - `GET /api/auth/me` → `{ agent }` | 401
  - `PATCH /api/auth/me` `{ name?, phone?, company?, bio?, avatarKey? }` → `{ agent }` — профайл засах (/account). Хэсэгчилсэн; нэр 1–60, утас ≤30 (тоо, `+ - ( )`), компани ≤80, танилцуулга ≤400. `avatarKey`: эхлээд `POST /api/uploads` → `key` (`listings/…`, R2-д байх ёстой), `null` бол арилгана. Имэйл, эрхийг зөвхөн админ солино
  - `POST /api/auth/change-password` `{ currentPassword, newPassword }` — шинэ JWT; бусад төхөөрөмжийн токенууд хүчингүй (`agents.token_version` +1)
  - JWT: HS256, 30 хоног, `{ sub, role, ver, iat, exp }`. Хүсэлт бүрт агентыг id-аар шалгана (идэвхгүй эсвэл `ver` зөрвөл хүчингүй)
  - Нууц үг: Argon2id (WASM, `@phi-ag/argon2`)
  - Cookie `SameSite`: `wrangler.jsonc`-ийн `COOKIE_SAMESITE`. Одоо хоёр орчинд `None` + `Partitioned` (вэб `vercel.app`, API `workers.dev` өөр site). Нэг домэйн авмагц `Lax` болгоно
  - `agent.mustChangePassword` үнэн бол `requireAuth`-тай route-ууд 403 `PASSWORD_CHANGE_REQUIRED` буцаана
  - Хамгаалалт: имэйлээр 15 минутад 5, IP-ээр 20 буруу оролдлого → 429; өөр сайтаас form POST → 403
- `/api/posts` — зар (listing). Нийтийн GET-ууд нэвтрэлт шаардахгүй; бичих үйлдэл агент шаардана:
  - `GET  /api/posts` — жагсаалт (зөвхөн `active`; админ бүгдийг, `status`-аар шүүнэ). Query: `page`, `limit` (≤60), `dealType` (`sale|rent`), `category` (`apartment|house|land|office|shop|warehouse|garage|summer_house`), `district`, `rooms` (`1,2,5` — 5 = 5+), `minPrice/maxPrice`, `minPpm/maxPpm` (м² үнэ), `minArea/maxArea`, `minFloor/maxFloor`, `minTotalFloors/maxTotalFloors`, `minYear/maxYear`, `notFirst=1`, `notLast=1`, `leasing=1`, `garage=1`, `hasTour=1`, `postedDays`, `sellerType` (`owner|agent`), `placement` (`vip|top`), `q` (гарчиг, тайлбар, дүүрэг, хаяг), `sort` (`newest|price_asc|price_desc|area_desc|ppm_asc`), `plain=1` (vip/top-ыг эхэнд гаргахгүй), `mine=1` (нэвтэрсэн — өөрийн бүх зар), `facets=deal` (бусад шүүлтүүрээр `dealCounts: { sale, rent }` нэмж буцаана — хайлтын табуудын тоо). → `{ posts, total, page, limit, pages, dealCounts? }`. Зар бүр `agent` (id, name, phone, avatarKey) ба `images` ([{ key, url, width, height, sortOrder }])-тэй
  - `GET  /api/posts/pins` — газрын зургийн тэмдэг: жагсаалттай ижил шүүлтүүр (`facets=deal` мөн), хуудаслалтгүй, 1000 хүртэл зар. Зар бүр зөвхөн `{ id, title, price, dealType, category, district, lat, lng, rooms, area, promo, cover }` → `{ pins, total, truncated, dealCounts? }` (`truncated` — нийт нь 1000-аас их)
  - `GET  /api/posts/stats` — идэвхтэй зарын тоо `{ counts: { "sale:apartment": n, … }, total }`
  - `GET  /api/posts/:id` — дэлгэрэнгүй (`active`; бусад төлөв зөвхөн эзэн/админд). Үзсэн тоо (`views`) нэмэгдэнэ (`?view=0` бол үгүй)
  - `POST /api/posts` (нэвтэрсэн) — үүсгэх. Агентын зар `pending` (админ батална), админых `active`; `status: "draft"` бол ноорог. Шаардлагатай: `title, dealType, category, district, price, area`. Сонголт: `description, khoroo, address, lat, lng, rooms, floor, totalFloors, yearInUse, floorMaterial, balconies, windowType, windowCount, doorType, garage, leasing, paymentTerms ([текст]), sellerName, sellerType (owner|agent|company), contactPhone, placement (free|vip|top — 7 хоног, одоохондоо төлбөргүй), tour (360° аялал, панорам нь /api/uploads/listings/…), images ([R2 түлхүүр эсвэл { key, width, height }])`
  - `PATCH /api/posts/:id` (эзэн эсвэл админ) — хэсэгчилсэн засвар (ижил талбарууд; `images` өгвөл бүрэн солино). Агент төлөвийг зөвхөн `draft|pending|sold|archived` болгоно; `active|rejected` — зөвхөн админ
  - `DELETE /api/posts/:id` (эзэн эсвэл админ) — устгах (зураг cascade)
- Зарыг мэдээлэх (report):
  - `POST /api/posts/:id/reports` (нийтийн) `{ reason: fake|duplicate|wrong_price|sold|other, note? (≤500) }` — зөвхөн `active` зарт. IP-ээр цагт 10; нэг IP нэг зарыг дахин мэдээлбэл давхардуулахгүй
  - `GET /api/reports` (админ) — нээлттэй мэдээллүүд `{ reports: [{ id, postId, reason, note, createdAt }] }`
  - `DELETE /api/posts/:id/reports` (админ) — зарын нээлттэй мэдээллүүдийг шийдвэрлэсэн болгоно `{ resolved }`
- `/api/agents` — агент удирдлага (зөвхөн админ):
  - `GET /api/agents` → `{ agents: [{ …agent, listings }] }`
  - `POST /api/agents` `{ name, email, phone?, password }` — түр нууц үгтэй (анх нэвтрэхэд солиулна). Имэйл давхардвал 409
  - `PATCH /api/agents/:id` `{ name?, email?, phone?, active?, password?, role? }` — `password` (түр) эсвэл `active: false` бол бүх төхөөрөмжөөс гаргана. Админ өөрийгөө идэвхгүй болгох, эрхээ бууруулах боломжгүй
- `/api/uploads` — зураг (R2):
  - `POST /api/uploads` (нэвтэрсэн) — `multipart/form-data`, талбар `file` (JPEG/PNG/WebP/AVIF, ≤15MB — 360° панорам багтана) → `{ key, url }`. Дараа нь `key`-г зарын `images`-д дамжуулна
  - `GET  /api/uploads/:key` — зургийг нийтэд дамжуулна (нэг жил cache)

Агент / админ үүсгэх (нийтийн бүртгэлгүй; түр нууц үг хэвлэнэ, анх нэвтрэхэд солиулна):

```bash
npm run agent:create -- admin@example.mn "Нэр" admin --local
npm run agent:create -- admin@example.mn "Нэр" admin --remote                     # testing
npm run agent:create -- admin@example.mn "Нэр" admin --remote --env production
```

## Орчнууд

| | testing (анхдагч) | production |
|---|---|---|
| Worker | `listing-server-api-testing` | `listing-server-api` |
| D1 | `listing-server-testing` | `listing-server-production` |
| R2 | `listing-server-testing` | `listing-server-production` |
| Deploy | `npm run deploy:testing` | `npm run deploy:production` |
| Migration | `npm run db:migrate:testing` | `npm run db:migrate:production` |

Тохиргоо `wrangler.jsonc`-д: дээд түвшин нь testing, `env.production` нь production.
Binding-ууд env-д өвлөгддөггүй тул production-д дахин бичсэн — шинэ binding нэмбэл хоёуланд нь нэмнэ,
дараа нь `npm run cf-typegen`.

## Нууц түлхүүр (JWT_SECRET)

JWT-д гарын үсэг зурах түлхүүр (≥ 32 тэмдэгт). Орчин бүрт өөр байна, git-д орохгүй.

```bash
# локал: .dev.vars (gitignore-д орсон)
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .dev.vars

# Cloudflare
openssl rand -hex 32 | npx wrangler secret put JWT_SECRET                    # testing
openssl rand -hex 32 | npx wrangler secret put JWT_SECRET --env production   # production
```

Түлхүүрийг солиход бүх хэрэглэгч дахин нэвтэрнэ.

## Ажиллуулах

```bash
npm install
npm run dev
```

http://localhost:4000/api/health → `{"ok":true,"environment":"local","db":"ok","storage":"ok"}`

| Команд | D1 / R2 | `/api/health` → `environment` |
|---|---|---|
| `npm run dev` | **локал** (`.wrangler/state`) — testing/production-д хүрэхгүй | `"local"` |
| `npm run dev:remote` | Cloudflare дээрх **testing** D1, R2 | `"testing"` |

## Өгөгдлийн сан (D1 + Drizzle ORM)

- Схем: хүснэгт бүр `src/db/<нэр>.schema.ts` файлд (жишээ нь `agents.schema.ts`), `src/db/schema.ts` тэднийг нэгтгэнэ
- Route дотор: `c.var.db` — жишээ нь `await c.var.db.select().from(agents)`
- `drizzle.config.ts` → migration-ууд `migrations/`-д үүснэ, wrangler тэднийг хэрэгжүүлнэ

Схем өөрчлөх:

```bash
npm run db:generate              # schema.ts-ээс migrations/0000_….sql үүсгэнэ
npm run db:migrate:local         # локал
npm run db:migrate:testing       # testing D1
npm run db:migrate:production    # production D1
```

`migrations/meta/` (Drizzle-ийн snapshot)-ийг git-д хамт commit хийнэ — дараагийн `db:generate` түүнээс зөрүүг тооцно.

## Байршуулах

```bash
npm run deploy:testing
npm run deploy:production
```

Шалгах: `curl https://<worker-нэр>.<account>.workers.dev/api/health`
