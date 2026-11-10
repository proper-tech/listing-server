// Нууц үгийн хэш — Argon2id (OWASP-ийн 1-р сонголт), Worker болон Node аль алинд ажиллана.
// WASM-ийг ачаалах арга орчноос хамаарна, тиймээс Argon2 instance-ийг гаднаас өгнө:
//   Worker: src/crypto.ts (`.wasm`-ийг модулиар import)
//   Node:   scripts/create-agent.ts (`@phi-ag/argon2/node`)
import { Argon2Type, type Argon2HashOptions } from "@phi-ag/argon2";
import type Argon2 from "@phi-ag/argon2";

// OWASP Password Storage Cheat Sheet: m=19 MiB, t=2, p=1 (WASM нэг thread-тэй тул p=1)
export const ARGON2_OPTIONS: Partial<Argon2HashOptions> = {
  type: Argon2Type.Argon2id,
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
};

// $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
export const hashWith = (argon2: Argon2, password: string) =>
  argon2.hash(password, ARGON2_OPTIONS).encoded;

export const verifyWith = (argon2: Argon2, password: string, encoded: string) =>
  encoded.startsWith("$argon2id$") &&
  argon2.tryVerify(encoded, password, Argon2Type.Argon2id).success;
