'use strict';
// Хуучин JSON өгөгдлийг (data/db.json) PostgreSQL руу шилжүүлэх нэг удаагийн скрипт.
//   npm run import-json -- path/to/db.json
// Аль хэдийн байгаа мөрийг (ижил id) алгасна, тиймээс дахин ажиллуулахад аюулгүй.
const path = require('path');
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* use real env */ }
const fs = require('fs');
const db = require('../db');

async function main() {
  const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data', 'db.json'));
  if (!fs.existsSync(file)) { console.error(`Файл олдсонгүй: ${file}`); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  await db.migrate();

  let users = 0;
  for (const u of data.users || []) {
    const email = (u.email || (String(u.login || '').includes('@') ? u.login : '') || '').toLowerCase() || null;
    if (!u.salt || !u.hash) continue;
    await db.insertUser({ ...u, email, mustChangePassword: !!u.mustChangePassword });
    users++;
  }
  let listings = 0;
  for (const l of data.listings || []) { await db.insertListing(l); listings++; }
  let reports = 0;
  for (const r of data.reports || []) {
    try { await db.addReport(r); reports++; } catch { /* listing missing or duplicate */ }
  }
  await db.syncListingSequence();
  await db.linkListingsToAgents();
  console.log(`Импорт дууслаа: ${users} хэрэглэгч, ${listings} зар, ${reports} мэдээлэл (${file}).`);
  console.log('Зургуудыг (uploads/) шинэ серверийн STORAGE_DIR руу хуулахаа мартуузай.');
  await db.pool.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
