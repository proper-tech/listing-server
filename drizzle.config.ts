import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` нь src/db/schema.ts-ээс SQL migration үүсгэж migrations/-д бичнэ.
// Тэдгээрийг wrangler хэрэгжүүлнэ: `npm run db:migrate:local | db:migrate:testing | db:migrate:production`.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
