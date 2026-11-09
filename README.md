# Гэр360 API

Гэр360 үл хөдлөх хөрөнгийн зарын сайтын backend. Node.js HTTP сервер: JSON API, нэвтрэлт (админ, агент), зураг хүлээн авах, `/uploads/*` зураг үйлчлэх.
**Өгөгдөл: PostgreSQL ([Neon](https://neon.tech))**, зураг: диск.
Frontend нь тусдаа төсөл — [`listing-web`](../ger360) (Next.js, Vercel дээр).

## Ажиллуулах

Node.js 20.12+ хэрэгтэй.

```bash
npm install
```

### Neon-той (жинхэнэ өгөгдлийн сан)

1. [neon.tech](https://neon.tech) дээр project үүсгэнэ (Postgres 16+, ойр байгаа region — жишээ нь Singapore).
2. Dashboard → **Connect** → connection string-ийг хуулна (`postgresql://…neon.tech/neondb?sslmode=require`).
3. `.env.example`-г `.env` нэрээр хуулаад `DATABASE_URL=` дээр тавина. `.env` git-д орохгүй.
4. Асаана:

```bash
npm run dev
```

Анх асаахад хүснэгтүүд автоматаар үүснэ (`db.js` → `SCHEMA`, давтан ажиллуулахад аюулгүй),
хоосон бол жишээ зар оруулж, анхны админ болон жишээ агентыг үүсгэнэ.

### Компьютер дээрх Postgres-ээр (Neon-гүй, хурдан турших)

```bash
npm run dev:local
```

[PGlite](https://pglite.dev) (жинхэнэ Postgres, WASM) `data/pglite` дотор ажиллаж, `DATABASE_URL`-г автоматаар өгнө.
Өгөгдлийг шинэчлэх бол серверийг зогсоогоод `data/pglite` хавтсыг устгана.

### Хуучин JSON өгөгдлийг шилжүүлэх

Өмнөх хувилбарын `data/db.json`-оос Postgres руу (ижил id-тай мөрийг алгасна):

```bash
npm run import-json -- data/db.json
```

Зургуудыг (`uploads/`) шинэ серверийн `STORAGE_DIR` руу тусад нь хуулна.

## Нэвтрэлт

Зөвхөн **админ** болон **агент** нэвтэрнэ (имэйл + нууц үг). Нийтийн бүртгэлгүй — агентыг админ үүсгэнэ.

- Анхны админ: `ADMIN_EMAIL` / `ADMIN_PASSWORD` (өгөөгүй бол dev дээр `admin@example.com` / `admin`, анх нэвтрэхэд заавал солино).
  Production дээр `ADMIN_PASSWORD` заавал — эс бөгөөс сервер асахгүй.
- Жишээ агент (зөвхөн жишээ өгөгдөлтэй үед): `agent@example.com` / `agent1234`.
- Нууц үг: scrypt + salt. Сесс: HttpOnly cookie, Postgres-д зөвхөн токены хэш. 15 минутад 10 буруу оролдлого хаагдана.

## Өгөгдлийн сангийн бүтэц

| Хүснэгт | Агуулга |
|---|---|
| `users` | админ, агент (имэйл, утас, эрх, нууц үгийн хэш) |
| `sessions` | нэвтрэлтийн токены хэш, дуусах хугацаа |
| `listings` | шүүлтүүрт хэрэгтэй талбарууд багана хэлбэрээр (үнэ, дүүрэг, өрөө, давхар…), бусад нь `details` (JSONB: тайлбар, зураг, 360° аялал…) |
| `reports` | зарын мэдээлэл (зар устгахад хамт устна) |

Хайлт, шүүлтүүр, эрэмбэ бүгд SQL дээр (`db.js` → `searchListings`). Зарын дугаар `listing_no` sequence-ээс (`L100018`, …).

## Орчны хувьсагч

| Нэр | Default | Тайлбар |
|---|---|---|
| `DATABASE_URL` | — (заавал) | Neon-ий connection string |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | — | Анхны админ (админ байхгүй үед л үүснэ) |
| `PORT` (эсвэл `API_PORT`) | `4000` | Хостинг автоматаар өгнө |
| `STORAGE_DIR` | төслийн хавтас | `uploads/` хадгалах газар. Production дээр байнгын диск руу заана |
| `SEED_DEMO` | dev: `1`, production: `0` | Хоосон сан дээр жишээ зар оруулах эсэх |
| `COOKIE_SECURE` | production дээр `1` | HTTPS-ээр ажиллахад cookie-г Secure болгоно |
| `PG_POOL_MAX` | `10` | Postgres холболтын тоо |

## Байршуулах (deploy)

Өгөгдөл Neon дээр тул сервер өөрөө өгөгдөл хадгалахгүй. **Зураг** диск дээр хадгалагддаг тул байнгын диск (volume) бүхий хостинг хэрэгтэй хэвээр:
Railway, Render (Persistent Disk), Fly.io (volume) гэх мэт.

Жишээ — Railway:

1. Энэ repo-г Railway-д холбоно (`npm start`).
2. Volume нэмж `/data` руу mount хийнэ.
3. Хувьсагч: `DATABASE_URL=<Neon>`, `STORAGE_DIR=/data`, `ADMIN_EMAIL=…`, `ADMIN_PASSWORD=<урт нууц үг>`, `NODE_ENV=production`.
4. Health check: `/health` (Postgres холболтыг мөн шалгана).
5. Олгосон URL-ыг frontend-ийн Vercel төсөлд `API_URL` болгон тохируулна.

Анхаар: нэвтрэх болон "утас харах" хурдны хязгаар санах ойд байдаг тул нэг instance-д зориулагдсан.
Зургийг S3 / Cloudflare R2 руу шилжүүлбэл диск хэрэггүй болж, хэд хэдэн instance болгож өргөтгөх боломжтой.
