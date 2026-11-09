# Гэр360 API

Гэр360 үл хөдлөх хөрөнгийн зарын сайтын backend. Хамааралгүй Node.js HTTP сервер: JSON API, зураг хүлээн авах, `/uploads/*` зураг үйлчлэх.
Frontend нь тусдаа төсөл — [`listing-web`](../listing-web) (Next.js, Vercel дээр).

## Ажиллуулах

Node.js 20+ хэрэгтэй, `npm install` шаардлагагүй (хамааралгүй).

```bash
npm run dev     # файл өөрчлөгдөхөд дахин асна
npm start
```

http://localhost:4000 дээр ажиллана. Анх асаахад жишээ зар, зургуудыг `data/`, `uploads/demo*`-д үүсгэнэ (~5 сек).
Өгөгдлийг шинэчлэх бол `data/db.json`-г устгаад дахин асаана.

## Орчны хувьсагч

| Нэр | Default | Тайлбар |
|---|---|---|
| `PORT` (эсвэл `API_PORT`) | `4000` | Хостинг автоматаар өгнө |
| `ADMIN_KEY` | `admin` | Админ хуудасны түлхүүр. `NODE_ENV=production` үед заавал солих |
| `STORAGE_DIR` | төслийн хавтас | `data/`, `uploads/` хадгалах газар. Production дээр байнгын диск (volume) руу заана |

## Байршуулах (deploy)

Өгөгдөл JSON файлд, зураг диск дээр хадгалагддаг тул **байнгын диск (persistent volume)** бүхий, тасралтгүй ажилладаг хостинг хэрэгтэй:
Railway, Render (Persistent Disk), Fly.io (volume) гэх мэт. Vercel/serverless дээр ажиллахгүй (файлын систем түр зуурын).

Жишээ — Railway:

1. Энэ хавтсыг тусдаа git repo болгон push хийж, Railway-д холбоно (Node автоматаар танигдана, `npm start`).
2. Volume нэмж `/data` руу mount хийнэ.
3. Хувьсагч: `STORAGE_DIR=/data`, `ADMIN_KEY=<урт нууц үг>`, `NODE_ENV=production`.
4. Health check: `/health`.
5. Олгосон URL-ыг (жишээ нь `https://ger360-api.up.railway.app`) frontend-ийн Vercel төсөлд `API_URL` болгон тохируулна.

Анхаар: тохиргоо нэг instance-д зориулагдсан (өгөгдөл санах ойд + нэг файлд). Хэд хэдэн instance болгож өргөтгөж болохгүй.
# listing-server
# listing-server
