// Зарын үнэ — төлбөрийн дүнг ЗӨВХӨН сервер тооцно (клиентийн илгээсэн дүнд итгэхгүй).
// Агент: зар бүрт BASE_FEE (30 хоног) + сонгосон бол VIP / Онцгой (7 хоног). Админ: төлбөргүй.
// Вэбийн харуулах үнэ: listing-web lib/constants.ts (PLACEMENTS, POSTING_FEE) — өөрчилбөл хоёуланг нь.
import type { Placement } from "./db/schema.ts";

export const BASE_FEE = 10_000; // ₮, зар байршуулах (30 хоног)
export const PLACEMENT_PRICE: Record<Placement, number> = { free: 0, vip: 20_000, top: 40_000 };
const PLACEMENT_LABEL: Record<Placement, string> = { free: "", vip: "VIP зар (7 хоног)", top: "Онцгой зар (7 хоног)" };

export type PriceItem = { code: "base" | Placement; label: string; amount: number };

export function priceFor(placement: Placement): { items: PriceItem[]; total: number } {
  const items: PriceItem[] = [{ code: "base", label: "Зар байршуулах (30 хоног)", amount: BASE_FEE }];
  if (PLACEMENT_PRICE[placement]) items.push({ code: placement, label: PLACEMENT_LABEL[placement], amount: PLACEMENT_PRICE[placement] });
  return { items, total: items.reduce((s, i) => s + i.amount, 0) };
}
