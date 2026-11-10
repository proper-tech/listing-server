// Бүх хүснэгтийг нэгтгэнэ — хүснэгт бүр өөрийн `*.schema.ts` файлд.
// Шинэ `*.schema.ts` нэмбэл энд `export *` мөр нэмнэ (drizzle-kit болон `c.var.db` эндээс уншина).
// Өөрчилсний дараа `npm run db:generate` → migrations/ дотор SQL үүснэ → `npm run db:migrate:local`.
export * from "./agents.schema.ts";
export * from "./test.schema.ts";
export * from "./login-attempts.schema.ts";
