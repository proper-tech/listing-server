# Гэр360 API

Гэр360 үл хөдлөх хөрөнгийн зарын сайтын backend — **Cloudflare Worker + Hono**.

- **Өгөгдөл:** PostgreSQL — [Neon](https://neon.tech) (`postgres.js`, сонголтоор Hyperdrive)
- **Зураг:** Cloudflare R2 (`ger360-uploads`)
- **Нэвтрэлт:** зөвхөн админ, агент (имэйл + нууц үг)

Frontend нь тусдаа төсөл — [`listing-web`](../ger360) (Next.js, Vercel). Тэр `/api/*`, `/uploads/*` хүсэлтийг `API_URL`-аар энд дамжуулна.

## Анх тохируулах

Node.js 22.18+ хэрэгтэй.

```bash
npm install
```

`.dev.vars.example`-г `.dev.vars` нэрээр хуулна (git-д орохгүй). `DATABASE_URL`-д аль нэгийг нь тавина:

- **Neon:** [neon.tech](https://neon.tech) → project үүсгэх → Dashboard → **Connect** → connection string (`…neon.tech/neondb?sslmode=require`).
- **Компьютер дээрх Postgres** (Neon-гүй турших): `postgresql://postgres:postgres@127.0.0.1:5433/postgres` — доорх `npm run db:local`-ыг тусдаа терминалд асаана.

Дараа нь хүснэгт үүсгээд жишээ өгөгдөл оруулна:

```bash
npm run db:migrate
```

```bash
npm run import:local
```

`db:migrate` нь `migrations/*.sql`-ийг дарааллаар нэг удаа ажиллуулж (давтан ажиллуулахад аюулгүй), анхны админыг үүсгэнэ.
`import:local` нь `data/db.json` (байхгүй бол жишээ өгөгдөл үүсгэнэ)-ийг Postgres руу, `uploads/`-ийг wrangler-ийн локал R2 руу хуулна.

## Ажиллуулах

```bash
npm run dev
```

http://localhost:4000 (wrangler dev). Компьютер дээрх Postgres-ээр ажиллах бол өөр терминалд:

```bash
npm run db:local
```

([PGlite](https://pglite.dev) — жинхэнэ Postgres, `data/pglite`-д хадгална.)

## Нэвтрэлт

Зөвхөн **админ** болон **агент** нэвтэрнэ. Нийтийн бүртгэлгүй — агентыг админ Админ самбар → "Агентууд" хэсэгт үүсгэнэ.

- Анхны админ: `.dev.vars`-ийн `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Өгөөгүй бол `admin@example.com` / `admin`, анх нэвтрэхэд заавал солино.
- Жишээ агент (жишээ өгөгдөл импортлоход): `agent@example.com` / `agent1234`.
- Нууц үг: PBKDF2-SHA256 (WebCrypto, 100 000 давталт). Сесс: HttpOnly cookie, Postgres-д зөвхөн токены SHA-256 хэш.
- 15 минутад 10 буруу оролдлого хаагдана (Postgres-д, бүх Worker instance-д нийтлэг).

## Өгөгдлийн сан

| Хүснэгт | Агуулга |
|---|---|
| `users` | админ, агент (имэйл, утас, эрх, нууц үгийн хэш) |
| `sessions` | нэвтрэлтийн токены хэш, дуусах хугацаа |
| `login_attempts` | буруу нэвтрэх оролдлого (хурдны хязгаар) |
| `listings` | шүүлтүүрт хэрэгтэй талбарууд багана, бусад нь `data` (jsonb: тайлбар, зураг, 360° аялал…). Нийтэд `L` + `no` |
| `reports` | зарын мэдээлэл |

Хайлт, шүүлтүүр, эрэмбэ бүгд SQL дээр (`src/search.ts`). Кирилл хайлт `search_text` (JS-ээр жижигрүүлсэн) дээр тул DB-ийн locale-оос үл хамаарна.
Схем өөрчлөх бол `migrations/0002_….sql` шинэ файл нэмээд `npm run db:migrate`.

## Байршуулах (deploy)

1. R2 bucket: `npx wrangler r2 bucket create ger360-uploads`
2. Neon-д хүснэгт үүсгэх (`.dev.vars`-ийн `DATABASE_URL` Neon руу заасан үед): `npm run db:migrate`
   — өгөгдөл шилжүүлэх бол `npm run import:remote` (Postgres + Cloudflare R2).
3. Worker-т Neon-ий хаяг: `npx wrangler secret put DATABASE_URL`
4. `npm run deploy` → олгосон `https://listing-server-api.<account>.workers.dev` хаягийг frontend-ийн Vercel төсөлд `API_URL` болгоно.
5. Сонголтоор — хурдасгах: Hyperdrive үүсгээд `wrangler.jsonc`-д `HYPERDRIVE` binding нэмнэ (тайлбар файлд бий). Код автоматаар түүнийг ашиглана.

Анхаар:
- Нууц үгийн хэш (PBKDF2) нэвтрэх бүрд ~CPU зарцуулдаг тул Workers **Paid** план (CPU хязгаар өндөр) зөвлөнө.
- "Утас харах" хурдны хязгаар isolate бүрийн санах ойд (ойролцоо).
