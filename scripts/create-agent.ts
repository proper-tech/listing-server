// Агент / админ үүсгэх (нийтийн бүртгэлгүй тул эхний админыг ингэж үүсгэнэ).
// Түр нууц үг хэвлэнэ — анх нэвтрэхэд солиулна (must_change_password = 1).
//
//   npm run agent:create -- <email> "<нэр>" [admin|agent] [wrangler d1 execute-ийн flag-ууд]
//   npm run agent:create -- admin@example.mn "Бат" admin --local
//   npm run agent:create -- admin@example.mn "Бат" admin --remote                     # testing
//   npm run agent:create -- admin@example.mn "Бат" admin --remote --env production
import { execFileSync } from "node:child_process";
import initArgon2 from "@phi-ag/argon2/node";
import { hashWith } from "../src/password.ts";

const [emailArg, name, roleArg, ...wranglerFlags] = process.argv.slice(2);
const email = emailArg?.trim().toLowerCase();
const role = roleArg ?? "agent";

if (!email?.includes("@") || !name?.trim() || !["admin", "agent"].includes(role)) {
  console.error('Хэрэглээ: npm run agent:create -- <email> "<нэр>" [admin|agent] [--local | --remote [--env production]]');
  process.exit(1);
}

const password = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
  "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 55],
).join("");
const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
const sql = `INSERT INTO agents (name, email, role, password_hash, must_change_password)
VALUES (${q(name.trim())}, ${q(email)}, ${q(role)}, ${q(hashWith(await initArgon2(), password))}, 1);`;

execFileSync("npx", ["wrangler", "d1", "execute", "DB", ...wranglerFlags, "--command", sql], {
  stdio: "inherit",
});
console.log(`\n✅ ${role} үүслээ: ${email}\n   Түр нууц үг: ${password}\n`);
