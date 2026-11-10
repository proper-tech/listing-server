// Worker-ийн криптограф: нууц үг (Argon2id, WASM), session токен (WebCrypto).
// Worker-т native addon (`argon2`, `bcrypt`) ажиллахгүй, мөн байтаас WASM ажиллах үед compile хийхийг
// хориглодог — тиймээс `.wasm`-ийг wrangler bundle үед compile хийгдсэн модулиар import хийнэ.
import Argon2 from "@phi-ag/argon2";
import argon2Wasm from "@phi-ag/argon2/argon2.wasm";
import { hashWith, verifyWith } from "./password.ts";

let argon2: Promise<Argon2> | undefined;
const getArgon2 = () =>
  (argon2 ??= WebAssembly.instantiate(argon2Wasm).then((instance) => new Argon2(instance)));

export const hashPassword = async (password: string) => hashWith(await getArgon2(), password);
export const verifyPassword = async (password: string, encoded: string) =>
  verifyWith(await getArgon2(), password, encoded);

// Байхгүй имэйлээр нэвтрэхэд ч мөн адил хугацаа зарцуулахын тулд (имэйл байгаа эсэхийг задруулахгүй)
let dummyHash: Promise<string> | undefined;
export const getDummyHash = () => (dummyHash ??= hashPassword(crypto.randomUUID()));

const enc = new TextEncoder();
const toHex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

export const randomToken = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
export const sha256Hex = async (value: string) =>
  toHex(await crypto.subtle.digest("SHA-256", enc.encode(value)));
