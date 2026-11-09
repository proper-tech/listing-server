// GET /api/listings — шүүлт, эрэмбэлэлт, хуудаслалтыг SQL рүү хөрвүүлнэ.
import { DAY, fromRow, pub, type ListingRow } from './listings.ts';

const num = (v: string | undefined | null) => {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Идэвхтэй сурталчилгаа: top=2, vip=1, бусад/хугацаа дууссан=0
const PROMO = `(CASE WHEN placement_until IS NOT NULL AND placement_until >= ?1
  THEN (CASE placement WHEN 'top' THEN 2 WHEN 'vip' THEN 1 ELSE 0 END) ELSE 0 END)`;

const SORTS: Record<string, string> = {
  new: 'created_at DESC',
  cheap: 'price ASC',
  expensive: 'price DESC',
  ppm2: 'price_per_m2 IS NULL, price_per_m2 ASC',
  area: 'COALESCE(area, 0) DESC',
};

export async function search(db: D1Database, q: URLSearchParams) {
  const t = Date.now();
  const where: string[] = [`status = 'active' AND expires_at >= ?1`];
  const args: unknown[] = [t]; // ?1 = одоо
  const arg = (v: unknown) => { args.push(v); return `?${args.length}`; };
  const g = (k: string) => q.get(k);

  if (g('deal')) where.push(`deal_type = ${arg(g('deal'))}`);
  if (g('cat')) where.push(`category = ${arg(g('cat'))}`);
  if (g('district')) where.push(`district = ${arg(g('district'))}`);
  if (g('placement')) where.push(`placement = ${arg(g('placement'))} AND ${PROMO} > 0`);

  const range = (minK: string, maxK: string, col: string) => {
    const lo = num(g(minK)), hi = num(g(maxK));
    if (lo !== null) where.push(`${col} IS NOT NULL AND ${col} >= ${arg(lo)}`);
    if (hi !== null) where.push(`${col} IS NOT NULL AND ${col} <= ${arg(hi)}`);
  };
  range('priceMin', 'priceMax', 'price');
  range('ppmMin', 'ppmMax', 'price_per_m2');
  range('areaMin', 'areaMax', 'area');
  range('floorMin', 'floorMax', 'floor');
  range('bfMin', 'bfMax', 'building_floors');
  range('yearMin', 'yearMax', 'year_in_use');

  if (g('rooms')) {
    const set = g('rooms')!.split(',').map(Number).filter(Boolean).slice(0, 10);
    if (set.length) where.push(`rooms IS NOT NULL AND (${set.map((r) => (r >= 5 ? 'rooms >= 5' : `rooms = ${arg(r)}`)).join(' OR ')})`);
    else where.push('0');
  }
  if (g('notFirst') === '1') where.push('floor > 1');
  if (g('notLast') === '1') where.push('floor IS NOT NULL AND floor != 0 AND building_floors IS NOT NULL AND building_floors != 0 AND floor < building_floors');
  if (g('leasing') === '1') where.push('leasing = 1');
  if (g('tour') === '1') where.push('has_tour = 1');
  if (g('garage') === '1') where.push('garage = 1');
  const posted = num(g('posted'));
  if (posted) where.push(`created_at >= ${arg(t - posted * DAY)}`);
  if (g('seller') === 'owner') where.push(`seller_type = 'owner'`);
  if (g('seller') === 'agent') where.push(`seller_type != 'owner'`);
  if (g('q')) {
    // SQLite-ийн lower() кирилл үсэг хувиргахгүй тул search_text-ийг JS-ээр жижигрүүлж хадгалсан
    const words = g('q')!.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10);
    for (const w of words) where.push(`instr(search_text, ${arg(w)}) > 0`);
  }

  const sorter = SORTS[g('sort') || ''] || SORTS.new;
  const plain = g('plain') === '1';
  const order = `${plain ? '' : `${PROMO} DESC, `}${sorter}, no ASC`;
  const per = Math.max(1, Math.min(60, num(g('per')) || 24));
  const page = Math.max(1, Math.floor(num(g('page')) || 1));
  const w = where.join(' AND ');

  const [countRes, rowsRes] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM listings WHERE ${w}`).bind(...args),
    db.prepare(`SELECT * FROM listings WHERE ${w} ORDER BY ${order} LIMIT ${per} OFFSET ${(page - 1) * per}`).bind(...args),
  ]);
  const total = (countRes.results[0] as { n: number }).n;
  return { total, page, per, items: (rowsRes.results as ListingRow[]).map((r) => pub(fromRow(r))) };
}
