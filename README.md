# listing-server

Үл хөдлөх хөрөнгийн зарын сайтын (listing-web) backend — **Cloudflare Worker + Hono**.

- **Өгөгдөл:** Cloudflare D1 (`DB` binding) + [Drizzle ORM](https://orm.drizzle.team)
- **Зураг:** Cloudflare R2 (`UPLOADS` binding)

Endpoint-ууд:

- `GET /api/health` — D1, R2 холболт шалгах
- `/api/test` — DB шалгах тест API (`test_items` хүснэгт), **зөвхөн testing/локал** (production-д 404):

```bash
curl -X POST localhost:4000/api/test -H 'content-type: application/json' -d '{"message":"hello"}'
curl localhost:4000/api/test            # сүүлийн 50
curl -X DELETE localhost:4000/api/test/1
```
- `/api/mock` — mock схем (`mock_agents`, `mock_listings`, `mock_listing_images`), **зөвхөн testing/локал**:
  - `GET /api/mock/agents` — агентууд + идэвхтэй зарын тоо
  - `GET /api/mock/listings?dealType=sale&category=apartment&district=Хан-Уул&minPrice=&maxPrice=&rooms=2&q=&status=active|sold|expired|all&sort=newest|price_asc|price_desc|views&page=1&limit=20`
  - `GET /api/mock/listings/:id` — агент, зурагтай
  - `GET /api/mock/stats` — төлөв, ангилал, дүүргээр нэгтгэл

Mock өгөгдөл (`seeds/mock.sql`, давтан ажиллуулж болно — хоослоод дахин бөглөнө):

```bash
npm run db:seed:local
npm run db:seed:testing
```

Seed нь `migrations/`-д биш тул production-д ордоггүй, production-д seed скрипт ч байхгүй.

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

Анхаар: локал болон testing-д ижил `seeds/mock.sql` өгөгдөл байгаа тул `/api/mock/*` хоёуланд нь адилхан харагдана —
аль орчинд байгааг `/api/health`-ийн `environment`-оор шалгана.

## Өгөгдлийн сан (D1 + Drizzle ORM)

- Схем: `src/db/schema.ts` (Drizzle `sqliteTable`)
- Route дотор: `c.var.db` — жишээ нь `await c.var.db.select().from(users)`
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
