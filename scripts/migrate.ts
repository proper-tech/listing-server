// migrations/*.sql-ийг Postgres (Neon) дээр дарааллаар нь нэг удаа ажиллуулж, анхны админыг үүсгэнэ.
//   npm run db:migrate          (.dev.vars-ийн DATABASE_URL-аар)
// Аль хэдийн ажилласан migration-ыг schema_migrations хүснэгтээр алгасна — давтан ажиллуулахад аюулгүй.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { hashPassword } from '../src/crypto.ts';

const root = path.resolve(import.meta.dirname, '..');
try { process.loadEnvFile(path.join(root, '.dev.vars')); } catch { /* use real environment variables */ }
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL алга. .dev.vars файлд оруулна уу (.dev.vars.example-г үзнэ үү).'); process.exit(1); }

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const done = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
  const dir = path.join(root, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(path.join(dir, f), 'utf8')).simple();
      await tx`insert into schema_migrations (name) values (${f})`;
    });
    console.log(`✓ ${f}`);
  }
  console.log(`Migration: ${files.length - done.size} шинэ, ${done.size} өмнө нь ажилласан.`);

  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from users where role = 'admin'`;
  if (n === 0) {
    const email = (process.env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase();
    const pw = process.env.ADMIN_PASSWORD;
    if (pw !== undefined && pw !== '' && pw.length < 8) throw new Error('ADMIN_PASSWORD хамгийн багадаа 8 тэмдэгт байна');
    await sql`insert into users (id, name, email, role, must_change_password, password)
              values ('u-admin', 'Админ', ${email}, 'admin', ${!pw}, ${await hashPassword(pw || 'admin')})`;
    console.log(pw ? `Админ үүслээ: ${email}` : `Админ үүслээ: ${email} / "admin" — анх нэвтрээд нууц үгээ заавал солино.`);
  }
} finally {
  await sql.end();
}
