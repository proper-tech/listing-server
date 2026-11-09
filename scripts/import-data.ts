// data/db.json + uploads/ → D1 + R2.
//   node scripts/import-data.ts --local            (wrangler dev-ийн локал D1/R2)
//   node scripts/import-data.ts --remote           (Cloudflare дээрх D1/R2)
//   ... --force                                    (D1-д зар байгаа ч устгаад дахин оруулна)
// data/db.json байхгүй бол seed.cjs-ээр жишээ өгөгдөл, зураг үүсгэнэ.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { noFromId, toRow, type Listing } from '../src/listings.ts';

const DB_NAME = 'ger360';
const BUCKET = 'ger360-uploads';
const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const target = args.includes('--remote') ? '--remote' : args.includes('--local') ? '--local' : null;
if (!target) { console.error('--local эсвэл --remote гэж зааж өгнө үү.'); process.exit(1); }
const force = args.includes('--force');

const dbFile = path.join(root, 'data/db.json');
const uploadDir = path.join(root, 'uploads');
if (!existsSync(dbFile)) {
  console.log('data/db.json байхгүй — жишээ өгөгдөл, зураг үүсгэж байна...');
  mkdirSync(path.dirname(dbFile), { recursive: true });
  createRequire(import.meta.url)('./seed.cjs').seed({ dbFile, uploadDir });
}

const wrangler = (...a: string[]) =>
  execFileSync('npx', ['wrangler', ...a], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

/* ---------- D1 ---------- */
const existing = JSON.parse(wrangler('d1', 'execute', DB_NAME, target, '--json', '--command', 'SELECT COUNT(*) AS n FROM listings'))[0].results[0].n;
if (existing > 0 && !force) {
  console.error(`D1 (${target}) дээр аль хэдийн ${existing} зар байна. Устгаад дахин оруулах бол --force нэмнэ үү.`);
  process.exit(1);
}

const db = JSON.parse(readFileSync(dbFile, 'utf8')) as { nextNo: number; listings: Listing[]; reports: any[] };
const lit = (v: unknown) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const insert = (table: string, row: Record<string, unknown>) =>
  `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(lit).join(', ')});`;

const sql = ['DELETE FROM reports;', 'DELETE FROM listings;'];
for (const l of db.listings) {
  const no = noFromId(l.id);
  if (no === null) throw new Error(`Зарын id "${l.id}" нь L<тоо> хэлбэртэй биш`);
  sql.push(insert('listings', { no, ...toRow(l) }));
}
for (const r of db.reports) {
  sql.push(insert('reports', { id: r.id, listing_id: r.listingId, reason: r.reason, note: r.note || '', created_at: r.createdAt }));
}
// Устгагдсан зарын дугаарыг дахин ашиглахгүйн тулд дараагийн дугаарыг nextNo-оос эхлүүлнэ
if (db.nextNo) sql.push(`UPDATE sqlite_sequence SET seq = MAX(seq, ${db.nextNo - 1}) WHERE name = 'listings';`);

const sqlFile = path.join(root, '.wrangler/import.sql');
mkdirSync(path.dirname(sqlFile), { recursive: true });
writeFileSync(sqlFile, sql.join('\n'));
wrangler('d1', 'execute', DB_NAME, target, '--yes', '--file', sqlFile);
console.log(`D1: ${db.listings.length} зар, ${db.reports.length} гомдол оруулав.`);

/* ---------- R2 ---------- */
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
