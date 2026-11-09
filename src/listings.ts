// Зарын төрөл, баталгаажуулалт, Postgres мөр <-> объект хувиргалт.
// Worker-оос гадна (scripts/import-data.ts, Node) ч ашигладаг тул зөвхөн стандарт Web API хэрэглэнэ.
import { randomHex } from './crypto.ts';
export { randomHex };

export const CATEGORIES = ['apartment', 'house', 'land', 'office', 'shop', 'warehouse', 'garage', 'summer_house'];
export const DISTRICTS = ['Баянзүрх', 'Баянгол', 'Сүхбаатар', 'Чингэлтэй', 'Хан-Уул', 'Сонгинохайрхан', 'Налайх', 'Багануур', 'Багахангай'];
const PAY_TERMS = ['Бэлэн', 'Банкны зээл', 'Ипотек', 'Бартер'];
export const DAY = 864e5;

export type Img = { src: string; width: number; height: number };
export type Room = {
  id: string; name: string; source: string; sourcePhotos: unknown[]; panorama: Img; status: string; startYaw: number;
  hotspots: { yaw: number; pitch: number; targetRoomId: string; label: string }[];
};
export type Tour = { startRoomId: string; rooms: Room[] };
export type Listing = {
  id: string; ownerId?: string; ownerToken?: string; ownerPhone: string; sellerName: string; sellerType: string;
  category: string; dealType: string; title: string; price: number; pricePerM2?: number;
  rooms?: number; area?: number; floor?: number; buildingFloors?: number; yearInUse?: number;
  floorMaterial?: string; balconies?: number; windowType?: string; windowCount?: number; doorType?: string;
  garage: boolean; leasing: boolean; paymentTerms: string[];
  location: { city: string; district: string; khoroo?: string; address?: string; lat?: number; lng?: number };
  description: string; photos: Img[]; tour?: Tour;
  placement: string; placementUntil?: string;
  status: string; views: number; createdAt: string; expiresAt: string;
};

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/* ---------- public view ---------- */
export const promoRank = (l: Listing, t = Date.now()) =>
  (!l.placementUntil || Date.parse(l.placementUntil) < t) ? 0 : l.placement === 'top' ? 2 : l.placement === 'vip' ? 1 : 0;
export const hasTour = (l: Pick<Listing, 'tour'>) => !!(l.tour && Array.isArray(l.tour.rooms) && l.tour.rooms.some((r) => r.status === 'ready'));
export function pub(l: Listing) {
  const { ownerPhone, ownerToken, ownerId, ...rest } = l;
  return { ...rest, hasTour: hasTour(l), promo: promoRank(l) };
}

/* ---------- Postgres row mapping ---------- */
// Мөрөөс ирэх, баганад хадгалагддаг (өөрчлөгддөг) талбарууд. Бусад нь `data` (jsonb).
const COLUMN_FIELDS = ['id', 'status', 'views', 'createdAt', 'expiresAt', 'ownerId', 'ownerToken', 'ownerPhone'] as const;

export type ListingRow = {
  no: number; status: string; views: number; created_at: Date | string; expires_at: Date | string;
  owner_id: string | null; owner_token: string | null; owner_phone: string; data: Record<string, unknown>;
};

export function fromRow(r: ListingRow): Listing {
  const expiresAt = new Date(r.expires_at);
  return {
    ...(r.data as object),
    id: 'L' + r.no, views: r.views,
    // Хугацаа нь дууссан ч cron хараахан 'expired' болгоогүй зар
    status: r.status === 'active' && expiresAt.getTime() < Date.now() ? 'expired' : r.status,
    createdAt: new Date(r.created_at).toISOString(), expiresAt: expiresAt.toISOString(),
    ownerId: r.owner_id ?? undefined, ownerToken: r.owner_token ?? undefined, ownerPhone: r.owner_phone,
  } as Listing;
}

export const noFromId = (id: string) => { const m = /^L(\d{1,9})$/.exec(id); return m ? Number(m[1]) : null; };

// INSERT-д зориулсан багана => утга (no-гүй; import үед тусад нь өгнө)
export function toRow(l: Omit<Listing, 'id'> & { id?: string }) {
  const data: Record<string, unknown> = JSON.parse(JSON.stringify(l)); // undefined талбаруудыг хасна
  for (const k of COLUMN_FIELDS) delete data[k];
  const loc = l.location;
  return {
    status: l.status, deal_type: l.dealType, category: l.category, district: loc.district,
    price: l.price, price_per_m2: l.pricePerM2 ?? null, area: l.area ?? null, rooms: l.rooms ?? null,
    floor: l.floor ?? null, building_floors: l.buildingFloors ?? null, year_in_use: l.yearInUse ?? null,
    garage: !!l.garage, leasing: !!l.leasing, has_tour: hasTour(l),
    seller_type: l.sellerType, placement: l.placement || 'free',
    placement_until: l.placementUntil ?? null, created_at: l.createdAt, expires_at: l.expiresAt,
    views: l.views || 0, owner_id: l.ownerId ?? null, owner_token: l.ownerToken ?? null, owner_phone: l.ownerPhone,
    search_text: [l.title, l.description, loc.district, loc.khoroo, loc.address].map((s) => s ?? '').join(' ').toLowerCase(),
    data,
  };
}

/* ---------- validation ---------- */
const cleanStr = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const cleanNum = (v: unknown, min: number, max: number) => {
  const n = Number(v);
  return v !== '' && v != null && Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};
const cleanInt = (v: unknown, min: number, max: number) => { const n = cleanNum(v, min, max); return n === undefined ? undefined : Math.round(n); };
export { cleanStr };

function cleanImg(o: any): Img | null {
  if (!o || typeof o.src !== 'string' || !/^\/uploads\/[\w\-/]+\.(jpg|jpeg|png|webp)$/.test(o.src) || o.src.includes('..')) return null;
  return { src: o.src, width: cleanNum(o.width, 1, 20000) || 0, height: cleanNum(o.height, 1, 20000) || 0 };
}

function cleanTour(t: any): Tour | undefined {
  if (!t || !Array.isArray(t.rooms)) return undefined;
  const rooms = (t.rooms as any[]).slice(0, 30).map((r): Room | null => {
    const panorama = cleanImg(r && r.panorama);
    if (!panorama) return null;
    return {
      id: cleanStr(r.id, 40) || randomHex(4),
      name: cleanStr(r.name, 60) || 'Өрөө',
      source: ['upload360', 'stitched', 'ai', 'splat'].includes(r.source) ? r.source : 'upload360',
      sourcePhotos: [], panorama, status: 'ready',
      startYaw: cleanNum(r.startYaw, -360, 360) || 0,
      hotspots: (Array.isArray(r.hotspots) ? r.hotspots : []).slice(0, 20).map((h: any) => ({
        yaw: cleanNum(h.yaw, -360, 360) || 0, pitch: cleanNum(h.pitch, -90, 90) || 0,
        targetRoomId: cleanStr(h.targetRoomId, 40), label: cleanStr(h.label, 60),
      })),
    };
  }).filter((r): r is Room => !!r);
  if (!rooms.length) return undefined;
  const ids = new Set(rooms.map((r) => r.id));
  rooms.forEach((r) => { r.hotspots = r.hotspots.filter((h) => ids.has(h.targetRoomId) && h.targetRoomId !== r.id); });
  return { startRoomId: ids.has(t.startRoomId) ? t.startRoomId : rooms[0].id, rooms };
}

export type Poster = { id: string; name: string; phone: string; role: 'admin' | 'agent' };

/** Validates a new ad from the post wizard. Only logged-in admins and agents can post. */
export function buildListing(b: any, user: Poster): Omit<Listing, 'id'> {
  const errors: string[] = [];
  const category = CATEGORIES.includes(b.category) ? b.category : null;
  if (!category) errors.push('Ангилал сонгоно уу');
  const dealType = b.dealType === 'rent' ? 'rent' : 'sale';
  const title = cleanStr(b.title, 120);
  if (title.length < 5) errors.push('Гарчиг хамгийн багадаа 5 тэмдэгт');
  const price = cleanNum(b.price, 1, 1e13);
  if (!price) errors.push('Үнэ оруулна уу');
  const area = cleanNum(b.area, 0.5, 1e7);
  if (!area) errors.push('Талбай оруулна уу');
  const loc = b.location || {};
  const district = DISTRICTS.includes(loc.district) ? loc.district : null;
  if (!district) errors.push('Дүүрэг сонгоно уу');
  const lat = cleanNum(loc.lat, 41, 52.5), lng = cleanNum(loc.lng, 87, 120);
  if (lat === undefined || lng === undefined) errors.push('Газрын зураг дээр байршлаа тэмдэглэнэ үү');
  // name and phone default to the account's; the wizard may override them per ad
  const sellerName = cleanStr(b.sellerName, 60) || user.name;
  if (!sellerName) errors.push('Нэрээ оруулна уу');
  const ownerPhone = cleanStr(b.sellerPhone, 20).replace(/\D/g, '') || user.phone || '';
  if (!/^\d{8}$/.test(ownerPhone)) errors.push('Утасны дугаар 8 оронтой байна');
  const photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, 20).map(cleanImg).filter((p: Img | null): p is Img => !!p);
  if (errors.length) throw new HttpError(400, errors.join('. '));
  const placement = ['vip', 'top'].includes(b.placement) ? b.placement : 'free';
  const t = Date.now();
  return {
    ownerId: user.id, ownerPhone, sellerName,
    // agents always post as agents; an admin may label the seller type
    sellerType: user.role === 'agent' ? 'agent' : ['owner', 'agent', 'company'].includes(b.sellerType) ? b.sellerType : 'agent',
    category: category!, dealType, title, price: price!, pricePerM2: Math.round(price! / area!),
    rooms: cleanInt(b.rooms, 0, 100), area, floor: cleanInt(b.floor, -5, 200), buildingFloors: cleanInt(b.buildingFloors, 1, 200),
    yearInUse: cleanInt(b.yearInUse, 1900, 2100), floorMaterial: cleanStr(b.floorMaterial, 40) || undefined,
    balconies: cleanInt(b.balconies, 0, 20), windowType: cleanStr(b.windowType, 40) || undefined,
    windowCount: cleanInt(b.windowCount, 0, 200), doorType: cleanStr(b.doorType, 40) || undefined,
    garage: !!b.garage, leasing: !!b.leasing,
    paymentTerms: (Array.isArray(b.paymentTerms) ? b.paymentTerms : []).filter((p: string) => PAY_TERMS.includes(p)),
    location: { city: 'Улаанбаатар', district: district!, khoroo: cleanStr(loc.khoroo, 40), address: cleanStr(loc.address, 160), lat, lng },
    description: cleanStr(b.description, 5000), photos, tour: cleanTour(b.tour),
    placement, placementUntil: placement === 'free' ? undefined : new Date(t + 7 * DAY).toISOString(),
    // agents' ads wait for admin approval; the admin's own ads go live directly
    status: user.role === 'admin' ? 'active' : 'pending',
    views: 0, createdAt: new Date(t).toISOString(), expiresAt: new Date(t + 30 * DAY).toISOString(),
  };
}
