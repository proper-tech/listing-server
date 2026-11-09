// GET /api/listings — шүүлт, эрэмбэлэлт, хуудаслалтыг Postgres SQL рүү хөрвүүлнэ.
import type { Sql } from './db.ts';
import { DAY, fromRow, pub, type ListingRow } from './listings.ts';

const num = (v: string | undefined | null) => {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Идэвхтэй сурталчилгаа: top=2, vip=1, бусад/хугацаа дууссан=0 ($1 = одоо)
export const PROMO = `(CASE WHEN placement_until IS NOT NULL AND placement_until >= $1::timestamptz
  THEN (CASE placement WHEN 'top' THEN 2 WHEN 'vip' THEN 1 ELSE 0 END) ELSE 0 END)`;

const SORTS: Record<string, string> = {
  new: 'created_at DESC',
  cheap: 'price ASC',
  expensive: 'price DESC',
  ppm2: 'price_per_m2 IS NULL, price_per_m2 ASC',
  area: 'COALESCE(area, 0) DESC',
};

export async function search(sql: Sql, q: URLSearchParams) {
  const t = Date.now();
  const where: string[] = [`status = 'active' AND expires_at >= $1::timestamptz`];
  const args: unknown[] = [new Date(t).toISOString()]; // $1 = одоо
  const arg = (v: unknown, cast = '') => { args.push(v); return `$${args.length}${cast}`; };
  const g = (k: string) => q.get(k);

  if (g('deal')) where.push(`deal_type = ${arg(g('deal'))}`);
  if (g('cat')) where.push(`category = ${arg(g('cat'))}`);
  if (g('district')) where.push(`district = ${arg(g('district'))}`);
  if (g('placement')) where.push(`placement = ${arg(g('placement'))} AND ${PROMO} > 0`);

  const range = (minK: string, maxK: string, col: string) => {
    const lo = num(g(minK)), hi = num(g(maxK));
    if (lo !== null) where.push(`${col} >= ${arg(lo, '::float8')}`);
    if (hi !== null) where.push(`${col} <= ${arg(hi, '::float8')}`);
  };
  range('priceMin', 'priceMax', 'price');
  range('ppmMin', 'ppmMax', 'price_per_m2');
  range('areaMin', 'areaMax', 'area');
  range('floorMin', 'floorMax', 'floor');
  range('bfMin', 'bfMax', 'building_floors');
  range('yearMin', 'yearMax', 'year_in_use');

  if (g('rooms')) {
    const set = g('rooms')!.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 10);
    if (set.length) where.push(`(${set.map((r) => (r >= 5 ? 'rooms >= 5' : `rooms = ${arg(r, '::int')}`)).join(' OR ')})`);
    else where.push('false');
  }
  if (g('notFirst') === '1') where.push('floor > 1');
  if (g('notLast') === '1') where.push('floor IS NOT NULL AND floor <> 0 AND building_floors IS NOT NULL AND building_floors <> 0 AND floor < building_floors');
  if (g('leasing') === '1') where.push('leasing');
  if (g('tour') === '1') where.push('has_tour');
  if (g('garage') === '1') where.push('garage');
  const posted = num(g('posted'));
  if (posted) where.push(`created_at >= ${arg(new Date(t - posted * DAY).toISOString(), '::timestamptz')}`);
  if (g('seller') === 'owner') where.push(`seller_type = 'owner'`);
  if (g('seller') === 'agent') where.push(`seller_type <> 'owner'`);
  if (g('q')) {
    // search_text-ийг JS-ээр жижигрүүлж хадгалсан тул DB-ийн locale-оос үл хамааран кирилл зөв ажиллана
    const words = g('q')!.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10);
    for (const w of words) where.push(`position(${arg(w, '::text')} in search_text) > 0`);
  }

  const sorter = SORTS[g('sort') || ''] || SORTS.new;
  const plain = g('plain') === '1';
  const order = `${plain ? '' : `${PROMO} DESC, `}${sorter}, no ASC`;
  const per = Math.max(1, Math.min(60, num(g('per')) || 24));
  const page = Math.max(1, Math.floor(num(g('page')) || 1));
  const w = where.join(' AND ');

  // One round trip: the window count gives the total next to the page's rows.
  const rows = await sql.unsafe<(ListingRow & { total_count: number })[]>(
    `SELECT *, COUNT(*) OVER ()::int AS total_count FROM listings WHERE ${w} ORDER BY ${order} LIMIT ${per} OFFSET ${(page - 1) * per}`,
    args as any[]);
  // a page past the end has no rows to carry the total, so count separately (rare)
  const total = rows.length ? rows[0].total_count
    : (await sql.unsafe<{ n: number }[]>(`SELECT COUNT(*)::int AS n FROM listings WHERE ${w}`, args as any[]))[0].n;
  return { total, page, per, items: rows.map(({ total_count, ...r }) => pub(fromRow(r as ListingRow))) };
}
