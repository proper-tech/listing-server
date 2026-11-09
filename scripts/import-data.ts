// data/db.json + uploads/ → Postgres (Neon) + R2.
//   node scripts/import-data.ts --local            (Postgres: .dev.vars-ийн DATABASE_URL, R2: wrangler dev-ийн локал)
//   node scripts/import-data.ts --remote           (Postgres: DATABASE_URL, R2: Cloudflare дээрх bucket)
//   ... --force                                    (Postgres-д зар байгаа ч устгаад дахин оруулна)
//   ... --skip-images                              (R2 руу зураг хуулахгүй)
// data/db.json байхгүй бол seed.cjs-ээр жишээ өгөгдөл, зураг үүсгэнэ. Эхлээд `npm run db:migrate`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import postgres from 'postgres';
import { noFromId, toRow, type Listing } from '../src/listings.ts';
import { hashPassword } from '../src/crypto.ts';

const BUCKET = 'ger360-uploads';
const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const target = args.includes('--remote') ? '--remote' : args.includes('--local') ? '--local' : null;
if (!target) { console.error('--local эсвэл --remote гэж зааж өгнө үү.'); process.exit(1); }
const force = args.includes('--force');

try { process.loadEnvFile(path.join(root, '.dev.vars')); } catch { /* use real environment variables */ }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL алга (.dev.vars).'); process.exit(1); }

const dbFile = path.join(root, 'data/db.json');
const uploadDir = path.join(root, 'uploads');
if (!existsSync(dbFile)) {
  console.log('data/db.json байхгүй — жишээ өгөгдөл, зураг үүсгэж байна...');
  mkdirSync(path.dirname(dbFile), { recursive: true });
  createRequire(import.meta.url)('./seed.cjs').seed({ dbFile, uploadDir });
}

/* ---------- Postgres ---------- */
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const data = JSON.parse(readFileSync(dbFile, 'utf8')) as { nextNo?: number; listings: Listing[]; reports?: any[] };
try {
  const [{ n: existing }] = await sql<{ n: number }[]>`select count(*)::int as n from listings`;
  if (existing > 0 && !force) {
    console.error(`Postgres дээр аль хэдийн ${existing} зар байна. Устгаад дахин оруулах бол --force нэмнэ үү.`);
    process.exit(1);
  }
  await sql.begin(async (tx) => {
    await tx`delete from reports`;
    await tx`delete from listings`;
    for (const l of data.listings) {
      const no = noFromId(l.id);
      if (no === null) throw new Error(`Зарын id "${l.id}" нь L<тоо> хэлбэртэй биш`);
      const row: Record<string, unknown> = { no, ...toRow(l) };
      const cols = Object.keys(row);
      const vals = cols.map((k, i) => `$${i + 1}${k === 'data' ? '::jsonb' : ''}`);
      // postgres.js serializes the jsonb `data` object itself — don't JSON.stringify it (it would be stored as a string)
      await tx.unsafe(`insert into listings (${cols.join(', ')}) values (${vals.join(', ')})`, Object.values(row) as any[]);
    }
    for (const r of data.reports || []) {
      await tx`insert into reports (id, listing_id, reason, note, created_at)
               values (${r.id}, ${r.listingId}, ${r.reason}, ${r.note || ''}, ${r.createdAt})`;
    }
    // Устгагдсан зарын дугаарыг дахин ашиглахгүйн тулд дараагийн дугаарыг nextNo-оос эхлүүлнэ
    await tx`select setval(pg_get_serial_sequence('listings', 'no'),
             greatest((select coalesce(max(no), 100000) from listings), ${(data.nextNo || 100001) - 1}::int))`;

    // Жишээ агентлагийн заруудыг эзэмших агент (зөвхөн жишээ өгөгдөлд, агент огт байхгүй үед)
    const [{ agents }] = await tx<{ agents: number }[]>`select count(*)::int as agents from users where role = 'agent'`;
    const demo = data.listings.some((l) => String(l.ownerToken || '').startsWith('demo-') && l.ownerPhone === '99000004');
    if (agents === 0 && demo) {
      await tx`insert into users (id, name, email, phone, role, must_change_password, password)
               values ('u-demo-agent', 'Гэр Агент ХХК', 'agent@example.com', '99000004', 'agent', false, ${await hashPassword('agent1234')})`;
      console.log('Жишээ агент: agent@example.com / "agent1234"');
    }
    // Эзэмшигчгүй заруудыг ижил утастай агентад холбоно
    await tx`update listings l set owner_id = u.id from users u
             where l.owner_id is null and u.role = 'agent' and u.phone <> '' and u.phone = l.owner_phone`;
  });
  console.log(`Postgres: ${data.listings.length} зар, ${(data.reports || []).length} гомдол оруулав.`);
} finally {
  await sql.end();
}

/* ---------- R2 ---------- */
if (args.includes('--skip-images')) process.exit(0);
// run wrangler's JS entry with this Node (no shell, works the same on Windows/macOS/Linux)
const wranglerBin = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const wrangler = (...a: string[]) =>
  execFileSync(process.execPath, [wranglerBin, ...a], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = existsSync(uploadDir) ? walk(uploadDir).filter((f) => MIME[path.extname(f).slice(1).toLowerCase()]) : [];
files.forEach((f, i) => {
  const key = path.relative(uploadDir, f).split(path.sep).join('/');
  process.stdout.write(`\rR2: ${i + 1}/${files.length} ${key}`.padEnd(70));
  wrangler('r2', 'object', 'put', `${BUCKET}/${key}`, target, '--file', f, '--content-type', MIME[path.extname(f).slice(1).toLowerCase()]);
});
console.log(`\nR2: ${files.length} зураг байршууллаа. Дууслаа.`);
