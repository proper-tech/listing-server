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
  - `POST /api/auth/change-password` `{ currentPassword, newPassword }` — шинэ JWT; бусад төхөөрөмжийн токенууд хүчингүй (`agents.token_version` +1)
  - JWT: HS256, 30 хоног, `{ sub, role, ver, iat, exp }`. Хүсэлт бүрт агентыг id-аар шалгана (идэвхгүй эсвэл `ver` зөрвөл хүчингүй)
  - Нууц үг: Argon2id (WASM, `@phi-ag/argon2`)
  - Cookie `SameSite`: production → `Lax`, бусад (локал, testing) → `None`
  - `agent.mustChangePassword` үнэн бол `requireAuth`-тай route-ууд 403 `PASSWORD_CHANGE_REQUIRED` буцаана
  - Хамгаалалт: имэйлээр 15 минутад 5, IP-ээр 20 буруу оролдлого → 429; өөр сайтаас form POST → 403

Агент / админ үүсгэх (нийтийн бүртгэлгүй; түр нууц үг хэвлэнэ, анх нэвтрэхэд солиулна):

```bash
npm run agent:create -- admin@example.mn "Нэр" admin --local
npm run agent:create -- admin@example.mn "Нэр" admin --remote                     # testing
npm run agent:create -- admin@example.mn "Нэр" admin --remote --env production
```
- `/api/test` — DB шалгах тест API (`test_items` хүснэгт), **зөвхөн testing/локал** (production-д 404):

```bash
curl -X POST localhost:4000/api/test -H 'content-type: application/json' -d '{"message":"hello"}'
curl localhost:4000/api/test            # сүүлийн 50
curl -X DELETE localhost:4000/api/test/1
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
