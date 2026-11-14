// QPay (merchant API v2) — нэхэмжлэх үүсгэх, төлөгдсөн эсэх шалгах.
//
// Тохиргоо (wrangler.jsonc vars + secrets):
//   QPAY_MODE          mock | sandbox | live
//                      mock    — QPay руу хүсэлт явуулахгүй; туршилтын "төлөх" товчоор төлөгдсөн болно (testing/local)
//                      sandbox — https://merchant-sandbox.qpay.mn (QPay-ийн туршилтын данс)
//                      live    — https://merchant.qpay.mn (жинхэнэ мөнгө)
//   QPAY_BASE_URL      (заавал биш) дээрхийг дарж бичнэ
//   QPAY_INVOICE_CODE  QPay-ээс өгсөн нэхэмжлэхийн код
//   QPAY_USERNAME, QPAY_PASSWORD   (secret) QPay merchant нэвтрэх
//   QPAY_CALLBACK_SECRET           (secret) callback URL-д орох нууц үг — QPay-ээс өөр хэн ч дуудахгүйн тулд
//   PUBLIC_API_URL     энэ API-ийн нийтийн хаяг (QPay callback-ийг энд илгээнэ)
//
// Төлбөрийг ҮРГЭЛЖ QPay-ээс payment/check-ээр баталгаажуулна; callback-ийн агуулгад итгэхгүй.

export type QpayMode = "mock" | "sandbox" | "live";
export type QpayLink = { name: string; description: string; logo: string; link: string };
export type QpayInvoice = { invoiceId: string; qrText: string; qrImage: string | null; shortUrl: string | null; links: QpayLink[] };

export class QpayConfigError extends Error {}

export const qpayMode = (env: Env): QpayMode | null => {
  const m = (env as { QPAY_MODE?: string }).QPAY_MODE;
  return m === "mock" || m === "sandbox" || m === "live" ? m : null;
};

const baseUrl = (env: Env, mode: QpayMode) =>
  (env as { QPAY_BASE_URL?: string }).QPAY_BASE_URL || (mode === "live" ? "https://merchant.qpay.mn" : "https://merchant-sandbox.qpay.mn");

type Secrets = { QPAY_USERNAME?: string; QPAY_PASSWORD?: string; QPAY_INVOICE_CODE?: string };
function creds(env: Env) {
  const e = env as unknown as Secrets;
  if (!e.QPAY_USERNAME || !e.QPAY_PASSWORD || !e.QPAY_INVOICE_CODE)
    throw new QpayConfigError("QPay тохируулаагүй байна (QPAY_USERNAME, QPAY_PASSWORD, QPAY_INVOICE_CODE)");
  return { username: e.QPAY_USERNAME, password: e.QPAY_PASSWORD, invoiceCode: e.QPAY_INVOICE_CODE };
}

// access token-ийг isolate дотор хадгална (дуусахаас 60 секундын өмнө шинэчилнэ)
let cached: { key: string; token: string; until: number } | null = null;

async function token(env: Env, mode: QpayMode): Promise<string> {
  const { username, password } = creds(env);
  const key = `${baseUrl(env, mode)}|${username}`;
  if (cached && cached.key === key && cached.until > Date.now()) return cached.token;
  const res = await fetch(`${baseUrl(env, mode)}/v2/auth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${username}:${password}`)}` },
  });
  if (!res.ok) throw new Error(`QPay нэвтрэлт амжилтгүй (${res.status})`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  // expires_in: QPay v2 нь unix хугацаа (секунд) буцаадаг; жижиг тоо бол үргэлжлэх хугацаа гэж үзнэ
  const until = (j.expires_in > 1e9 ? j.expires_in * 1000 : Date.now() + j.expires_in * 1000) - 60_000;
  cached = { key, token: j.access_token, until };
  return j.access_token;
}

async function call<T>(env: Env, mode: QpayMode, method: string, path: string, body?: unknown): Promise<T> {
  const send = async (t: string) =>
    fetch(`${baseUrl(env, mode)}${path}`, {
      method,
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let res = await send(await token(env, mode));
  if (res.status === 401) { cached = null; res = await send(await token(env, mode)); } // хугацаа дууссан токен
  if (!res.ok) throw new Error(`QPay хүсэлт амжилтгүй (${res.status})`);
  return (await res.json()) as T;
}

export async function createInvoice(
  env: Env,
  o: { senderInvoiceNo: string; amount: number; description: string; callbackUrl: string },
): Promise<QpayInvoice> {
  const mode = qpayMode(env);
  if (!mode) throw new QpayConfigError("Төлбөрийн систем тохируулаагүй байна (QPAY_MODE)");
  if (mode === "mock")
    return { invoiceId: `mock-${o.senderInvoiceNo}`, qrText: `MOCK-QPAY:${o.senderInvoiceNo}:${o.amount}`, qrImage: null, shortUrl: null, links: [] };
  const j = await call<{ invoice_id: string; qr_text: string; qr_image?: string; qPay_shortUrl?: string; urls?: QpayLink[] }>(
    env, mode, "POST", "/v2/invoice",
    {
      invoice_code: creds(env).invoiceCode,
      sender_invoice_no: o.senderInvoiceNo,
      invoice_receiver_code: "terminal",
      invoice_description: o.description.slice(0, 255),
      amount: o.amount,
      callback_url: o.callbackUrl,
    },
  );
  return { invoiceId: j.invoice_id, qrText: j.qr_text, qrImage: j.qr_image ?? null, shortUrl: j.qPay_shortUrl ?? null, links: j.urls ?? [] };
}

/** QPay-ээс шалгана: нэхэмжлэхийн дүнг бүрэн төлсөн бол payment_id-г буцаана, үгүй бол null. mock-д үргэлж null. */
export async function checkPaid(env: Env, invoiceId: string, amount: number): Promise<string | null> {
  const mode = qpayMode(env);
  if (!mode || mode === "mock") return null;
  const j = await call<{ count: number; paid_amount?: number; rows?: { payment_id: string; payment_status: string; payment_amount?: number | string }[] }>(
    env, mode, "POST", "/v2/payment/check",
    { object_type: "INVOICE", object_id: invoiceId, offset: { page_number: 1, page_limit: 100 } },
  );
  const paidRows = (j.rows ?? []).filter((r) => r.payment_status === "PAID");
  const paid = j.paid_amount ?? paidRows.reduce((s, r) => s + Number(r.payment_amount ?? 0), 0);
  return paidRows.length && paid >= amount ? paidRows[0]!.payment_id : null;
}

export async function cancelInvoice(env: Env, invoiceId: string): Promise<void> {
  const mode = qpayMode(env);
  if (!mode || mode === "mock") return;
  await call(env, mode, "DELETE", `/v2/invoice/${encodeURIComponent(invoiceId)}`).catch(() => {}); // аль хэдийн хаагдсан байж болно
}
