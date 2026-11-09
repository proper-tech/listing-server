'use strict';
// Анхны жишээ өгөгдөл: процедураар зурсан өрөөний 360° панорама, энгийн зураг,
// мөн "Mode B" холбогчийг турших 12 ширхэг давхцсан зураг үүсгэнэ.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- PNG encoder (no dependencies) ---------- */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgb) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * stride + 1, y * w * 3, (y + 1) * w * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- tiny procedural renderer ---------- */
const hash = (n) => { const s = Math.sin(n * 12.9898) * 43758.5453; return s - Math.floor(s); };
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

function floorColor(R, x, z) {
  if (x * x / 1.44 + (z + 1) * (z + 1) / 0.81 < 1 && R.rug) { // oval rug
    const d = x * x / 1.44 + (z + 1) * (z + 1) / 0.81;
    return d > 0.82 ? mul(R.rug, 0.75) : (Math.floor((x + 5) / 0.25) % 2 ? R.rug : mul(R.rug, 0.92));
  }
  if (R.floor === 'tile') {
    const fx = ((x + 50) / 0.6) % 1, fz = ((z + 50) / 0.6) % 1;
    if (fx < 0.02 || fz < 0.02) return [150, 150, 150];
    const t = hash(Math.floor((x + 50) / 0.6) * 31 + Math.floor((z + 50) / 0.6)) * 0.06;
    return mul([222, 220, 214], 0.97 + t);
  }
  const base = R.floor === 'laminate' ? [196, 160, 118] : [168, 116, 72];
  const row = Math.floor((z + 50) / 0.15);
  const off = hash(row) * 1.2;
  const col = Math.floor((x + 50 + off) / 1.2);
  const fz = ((z + 50) / 0.15) % 1, fx = ((x + 50 + off) / 1.2) % 1;
  const tone = 0.86 + hash(row * 131 + col) * 0.24;
  const grain = 1 + 0.04 * Math.sin((x + off) * 40 + row);
  const seam = fz < 0.05 || fx < 0.006 ? 0.72 : 1;
  return mul(base, tone * grain * seam);
}

function ceilColor(R, x, z) {
  const r = Math.hypot(x, z);
  if (r < 0.22) return [255, 252, 232];
  if (r < 0.26) return [200, 200, 196];
  return mul([246, 245, 241], 1 - 0.04 * Math.max(0, 1 - r));
}

function featureColor(f, u, y, base) {
  const fu = (u - f.u0) / (f.u1 - f.u0), fy = (y - f.y0) / (f.y1 - f.y0);
  const edge = Math.min(u - f.u0, f.u1 - u, y - f.y0, f.y1 - y);
  switch (f.kind) {
    case 'window': {
      if (edge < 0.06 || Math.abs(fu - 0.5) < 0.012) return [244, 244, 240];
      const skyline = 0.18 + 0.12 * Math.abs(Math.sin(u * 5.3)) + (Math.floor(u * 3) % 3) * 0.06;
      if (fy < skyline) return mix([120, 128, 140], [150, 156, 166], hash(Math.floor(u * 9)) );
      return mix([215, 232, 248], [120, 175, 232], fy);
    }
    case 'door': {
      if (edge < 0.05) return [90, 66, 46];
      const inner = Math.min(Math.abs(fy - 0.27), Math.abs(fy - 0.73));
      const panel = (Math.abs(fu - 0.5) > 0.32 || inner < 0.012) ? 0.88 : 1;
      if (Math.abs(fu - 0.85) < 0.04 && Math.abs(y - 1.0) < 0.03) return [200, 190, 150];
      return mul(f.color || [142, 96, 60], panel);
    }
    case 'painting': {
      if (edge < 0.05) return [60, 50, 42];
      const c = f.color || [70, 120, 150];
      const band = Math.floor(fy * 4 + Math.sin(fu * 6) * 0.6);
      return mix(c, [235, 210, 160], (band % 3) / 3);
    }
    case 'tv': return edge < 0.03 ? [20, 20, 22] : mix([30, 34, 44], [60, 74, 96], fy);
    case 'cabinet': {
      const cell = ((u - f.u0) / 0.6) % 1;
      if (cell < 0.015 || edge < 0.02) return mul(f.color, 0.7);
      if (Math.abs(cell - 0.5) < 0.02 && fy > 0.7 && fy < 0.85) return [180, 180, 185];
      return f.color;
    }
    case 'counter': return [64, 64, 70];
    case 'headboard': {
      const tuft = (Math.floor(fu * 6) + Math.floor(fy * 3)) % 2 ? 1 : 0.94;
      return mul(f.color, tuft);
    }
    case 'wardrobe': {
      const cell = (fu * 3) % 1;
      if (cell < 0.01 || edge < 0.02) return mul(f.color, 0.7);
      return f.color;
    }
    case 'shelf': {
      const rowY = (fy * 4) % 1;
      if (rowY < 0.08) return [120, 86, 58];
      const book = Math.floor(u * 22);
      return mix([170, 60, 50], [50, 90, 150], hash(book)) .map((v) => v * (rowY > 0.75 ? 0.5 : 1));
    }
    default: return base;
  }
}

function wallColor(R, face, u, y) {
  let c = R.wall;
  if (R.stripes) c = mul(c, Math.floor((u + 20) / 0.14) % 2 ? 0.965 : 1);
  if (y < 0.09) c = [236, 234, 228];
  for (const f of R.features) {
    if (f.face === face && u >= f.u0 && u <= f.u1 && y >= f.y0 && y <= f.y1) c = featureColor(f, u, y, c);
  }
  return c;
}

function shadeRoom(R, dx, dy, dz) {
  const oy = R.camH;
  let t = Infinity, face = '';
  if (dx > 1e-9) { const k = (R.W / 2) / dx; if (k < t) { t = k; face = '+x'; } }
  else if (dx < -1e-9) { const k = (-R.W / 2) / dx; if (k < t) { t = k; face = '-x'; } }
  if (dz > 1e-9) { const k = (R.D / 2) / dz; if (k < t) { t = k; face = '+z'; } }
  else if (dz < -1e-9) { const k = (-R.D / 2) / dz; if (k < t) { t = k; face = '-z'; } }
  if (dy > 1e-9) { const k = (R.H - oy) / dy; if (k < t) { t = k; face = 'ceil'; } }
  else if (dy < -1e-9) { const k = -oy / dy; if (k < t) { t = k; face = 'floor'; } }
  const x = dx * t, y = oy + dy * t, z = dz * t;
  let c, e;
  const ex = R.W / 2 - Math.abs(x), ez = R.D / 2 - Math.abs(z), ey = Math.min(y, R.H - y);
  if (face === 'floor') { c = floorColor(R, x, z); e = Math.min(ex, ez); }
  else if (face === 'ceil') { c = ceilColor(R, x, z); e = Math.min(ex, ez); }
  else if (face[1] === 'x') { c = wallColor(R, face, z, y); e = Math.min(ez, ey); }
  else { c = wallColor(R, face, x, y); e = Math.min(ex, ey); }
  const ao = 0.74 + 0.26 * Math.min(1, e / 0.7);
  const light = 1.04 - Math.min(0.24, t * 0.035);
  return mul(c, ao * light);
}

function shadeOutdoor(O, dx, dy, dz) {
  const yaw = Math.atan2(dx, -dz);
  const pitch = Math.asin(Math.max(-1, Math.min(1, dy)));
  const mount = 0.035 + 0.025 * Math.sin(yaw * 3 + 1) + 0.015 * Math.sin(yaw * 7) + 0.008 * Math.sin(yaw * 17);
  if (pitch > 0) {
    if (pitch < mount) return mix([96, 120, 98], [130, 150, 150], pitch / mount);
    const cloud = Math.max(0, Math.sin(yaw * 4 + pitch * 9) * Math.sin(yaw * 9 - pitch * 5)) * (pitch < 0.6 ? 1 : 0);
    return mix(mix([200, 222, 240], [80, 140, 215], Math.min(1, pitch / 0.9)), [250, 250, 252], cloud * 0.7);
  }
  const t = -O.camH / Math.min(-1e-6, dy);
  const x = dx * t, z = dz * t;
  const dist = Math.hypot(x, z);
  // wooden fence (хашаа) ring at radius O.fence
  if (O.fence) {
    const tf = O.fence / Math.max(1e-6, Math.hypot(dx, dz));
    const yf = O.camH + dy * tf;
    if (yf > 0 && yf < 1.9 && dist > O.fence) {
      const ang = Math.atan2(dx, -dz);
      const board = (ang * O.fence / 0.18) % 1;
      const k = Math.abs(board) < 0.08 ? 0.7 : 1;
      return mul([150, 112, 76], k * (0.85 + 0.15 * (yf / 1.9)));
    }
  }
  const g = 0.85 + 0.15 * hash(Math.floor(x * 3) * 17 + Math.floor(z * 3));
  const path = Math.abs(x) < 0.7 && z < 0 ? 1 : 0;
  const base = path ? [170, 150, 120] : [118, 146, 84];
  return mul(mix(base, [150, 160, 130], Math.min(1, dist / 80)), g);
}

function renderEquirect(shade, w, h) {
  const buf = Buffer.alloc(w * h * 3);
  for (let py = 0; py < h; py++) {
    const pitch = Math.PI / 2 - ((py + 0.5) / h) * Math.PI;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    for (let px = 0; px < w; px++) {
      const yaw = ((px + 0.5) / w) * 2 * Math.PI - Math.PI;
      const c = shade(cp * Math.sin(yaw), sp, -cp * Math.cos(yaw));
      const i = (py * w + px) * 3;
      buf[i] = Math.max(0, Math.min(255, c[0]));
      buf[i + 1] = Math.max(0, Math.min(255, c[1]));
      buf[i + 2] = Math.max(0, Math.min(255, c[2]));
    }
  }
  return buf;
}

function renderPerspective(shade, w, h, yawDeg, pitchDeg, fovDeg) {
  const buf = Buffer.alloc(w * h * 3);
  const f = (w / 2) / Math.tan((fovDeg * Math.PI) / 360);
  const yaw = (yawDeg * Math.PI) / 180, pitch = (pitchDeg * Math.PI) / 180;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cpt = Math.cos(pitch), spt = Math.sin(pitch);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let lx = (px + 0.5 - w / 2) / f, ly = -(py + 0.5 - h / 2) / f, lz = -1;
      // pitch (around x)
      const ly2 = ly * cpt - lz * spt, lz2 = ly * spt + lz * cpt;
      ly = ly2; lz = lz2;
      // yaw (around y)
      const wx = lx * cy - lz * sy, wz = lx * sy + lz * cy;
      const n = Math.hypot(wx, ly, wz);
      const c = shade(wx / n, ly / n, wz / n);
      const i = (py * w + px) * 3;
      buf[i] = Math.max(0, Math.min(255, c[0]));
      buf[i + 1] = Math.max(0, Math.min(255, c[1]));
      buf[i + 2] = Math.max(0, Math.min(255, c[2]));
    }
  }
  return buf;
}

/* ---------- rooms ---------- */
function makeRooms(s) {
  const living = {
    W: 5, D: 6, H: 2.8, camH: 1.4, wall: s.wall, floor: s.floor, stripes: s.stripes, rug: s.rug,
    features: [
      { face: '-z', kind: 'window', u0: -1.1, u1: 1.1, y0: 0.8, y1: 2.35 },
      { face: '+x', kind: 'door', u0: -0.45, u1: 0.45, y0: 0, y1: 2.1, color: s.door },
      { face: '-x', kind: 'door', u0: -0.45, u1: 0.45, y0: 0, y1: 2.1, color: s.door },
      { face: '+z', kind: 'tv', u0: -0.85, u1: 0.85, y0: 1.0, y1: 1.95 },
      { face: '+z', kind: 'shelf', u0: 1.2, u1: 2.2, y0: 0.1, y1: 2.0 },
      { face: '-x', kind: 'painting', u0: -2.4, u1: -1.2, y0: 1.3, y1: 2.0, color: s.art },
      { face: '+x', kind: 'painting', u0: 1.0, u1: 2.0, y0: 1.2, y1: 1.9, color: s.art2 },
    ],
  };
  const kitchen = {
    W: 3.6, D: 4, H: 2.7, camH: 1.4, wall: s.wall, floor: 'tile', stripes: false, rug: null,
    features: [
      { face: '-z', kind: 'window', u0: -0.7, u1: 0.7, y0: 1.0, y1: 2.2 },
      { face: '-x', kind: 'door', u0: -0.45, u1: 0.45, y0: 0, y1: 2.1, color: s.door },
      { face: '+z', kind: 'cabinet', u0: -1.8, u1: 1.8, y0: 0.09, y1: 0.86, color: s.cab },
      { face: '+z', kind: 'counter', u0: -1.8, u1: 1.8, y0: 0.86, y1: 0.92 },
      { face: '+z', kind: 'cabinet', u0: -1.8, u1: 1.8, y0: 1.5, y1: 2.2, color: s.cab },
      { face: '+x', kind: 'cabinet', u0: -2.0, u1: 0.6, y0: 0.09, y1: 0.86, color: s.cab },
      { face: '+x', kind: 'counter', u0: -2.0, u1: 0.6, y0: 0.86, y1: 0.92 },
      { face: '+x', kind: 'painting', u0: 1.0, u1: 1.6, y0: 1.3, y1: 1.8, color: s.art2 },
    ],
  };
  const bedroom = {
    W: 4, D: 4.2, H: 2.8, camH: 1.4, wall: s.wall2 || s.wall, floor: s.floor, stripes: !s.stripes, rug: s.rug2,
    features: [
      { face: '-z', kind: 'window', u0: -0.9, u1: 0.9, y0: 0.85, y1: 2.3 },
      { face: '+x', kind: 'door', u0: -0.45, u1: 0.45, y0: 0, y1: 2.1, color: s.door },
      { face: '+z', kind: 'headboard', u0: -0.95, u1: 0.95, y0: 0.09, y1: 1.15, color: s.fabric },
      { face: '+z', kind: 'painting', u0: -0.6, u1: 0.6, y0: 1.45, y1: 2.0, color: s.art },
      { face: '-x', kind: 'wardrobe', u0: -1.7, u1: 0.4, y0: 0.09, y1: 2.3, color: s.cab },
    ],
  };
  return { living, kitchen, bedroom };
}

const SCHEMES = {
  a: { wall: [236, 226, 210], wall2: [226, 218, 230], floor: 'parquet', stripes: false, rug: [150, 60, 55], rug2: [200, 190, 170], door: [142, 96, 60], art: [60, 110, 150], art2: [180, 90, 60], cab: [240, 238, 232], fabric: [110, 120, 150] },
  b: { wall: [214, 224, 230], wall2: [232, 228, 220], floor: 'laminate', stripes: true, rug: [70, 90, 120], rug2: [160, 170, 150], door: [235, 232, 225], art: [190, 120, 60], art2: [60, 140, 120], cab: [60, 70, 84], fabric: [180, 150, 120] },
  c: { wall: [242, 238, 230], wall2: [214, 230, 214], floor: 'parquet', stripes: false, rug: [60, 120, 90], rug2: [210, 180, 150], door: [110, 76, 50], art: [140, 60, 110], art2: [70, 120, 70], cab: [190, 150, 100], fabric: [90, 130, 100] },
};

function writePNG(file, w, h, buf) { fs.writeFileSync(file, encodePNG(w, h, buf)); }

function generateImages(uploadDir) {
  const dir = path.join(uploadDir, 'demo');
  const cap = path.join(uploadDir, 'demo-capture');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(cap, { recursive: true });
  const PW = 2048, PH = 1024, IW = 960, IH = 640;
  for (const [key, s] of Object.entries(SCHEMES)) {
    const rooms = makeRooms(s);
    for (const [name, R] of Object.entries(rooms)) {
      const shade = (x, y, z) => shadeRoom(R, x, y, z);
      writePNG(path.join(dir, `${key}-${name}.png`), PW, PH, renderEquirect(shade, PW, PH));
    }
    const sh = (R) => (x, y, z) => shadeRoom(R, x, y, z);
    writePNG(path.join(dir, `${key}-photo1.png`), IW, IH, renderPerspective(sh(rooms.living), IW, IH, -20, -8, 75));
    writePNG(path.join(dir, `${key}-photo2.png`), IW, IH, renderPerspective(sh(rooms.living), IW, IH, 160, -8, 75));
    writePNG(path.join(dir, `${key}-photo3.png`), IW, IH, renderPerspective(sh(rooms.kitchen), IW, IH, 150, -10, 80));
    writePNG(path.join(dir, `${key}-photo4.png`), IW, IH, renderPerspective(sh(rooms.bedroom), IW, IH, 160, -8, 80));
  }
  const yard = { camH: 1.6, fence: 18 };
  const steppe = { camH: 1.6, fence: 0 };
  writePNG(path.join(dir, 'yard.png'), PW, PH, renderEquirect((x, y, z) => shadeOutdoor(yard, x, y, z), PW, PH));
  writePNG(path.join(dir, 'land.png'), PW, PH, renderEquirect((x, y, z) => shadeOutdoor(steppe, x, y, z), PW, PH));
  writePNG(path.join(dir, 'yard-photo.png'), IW, IH, renderPerspective((x, y, z) => shadeOutdoor(yard, x, y, z), IW, IH, 30, 2, 70));
  writePNG(path.join(dir, 'land-photo.png'), IW, IH, renderPerspective((x, y, z) => shadeOutdoor(steppe, x, y, z), IW, IH, 0, 3, 70));
  // Mode B test set: 12 photos turning right in 30° steps, 65° lens → ~54% overlap
  const R = makeRooms(SCHEMES.a).living;
  for (let i = 0; i < 12; i++) {
    writePNG(path.join(cap, `IMG_${String(i + 1).padStart(2, '0')}.png`), 1080, 720,
      renderPerspective((x, y, z) => shadeRoom(R, x, y, z), 1080, 720, i * 30, 0, 65));
  }
}

/* ---------- listings ---------- */
const CENTERS = {
  'Баянзүрх': [47.918, 106.975], 'Баянгол': [47.912, 106.862], 'Сүхбаатар': [47.925, 106.918],
  'Чингэлтэй': [47.935, 106.905], 'Хан-Уул': [47.885, 106.905], 'Сонгинохайрхан': [47.918, 106.800],
  'Налайх': [47.770, 107.255], 'Багануур': [47.790, 108.370], 'Багахангай': [47.330, 107.470],
};

function pano(src) { return { src, width: 2048, height: 1024 }; }
function photo(src) { return { src, width: 960, height: 640 }; }
function aptTour(k) {
  return {
    startRoomId: 'r1',
    rooms: [
      { id: 'r1', name: 'Зочны өрөө', source: 'upload360', sourcePhotos: [], panorama: pano(`/uploads/demo/${k}-living.png`), status: 'ready', startYaw: 0,
        hotspots: [{ yaw: 90, pitch: -8, targetRoomId: 'r2', label: 'Гал тогоо' }, { yaw: -90, pitch: -8, targetRoomId: 'r3', label: 'Унтлагын өрөө' }], floorPlanPosition: [50, 62] },
      { id: 'r2', name: 'Гал тогоо', source: 'stitched', sourcePhotos: [], panorama: pano(`/uploads/demo/${k}-kitchen.png`), status: 'ready', startYaw: 0,
        hotspots: [{ yaw: -90, pitch: -11, targetRoomId: 'r1', label: 'Зочны өрөө' }], floorPlanPosition: [84, 34] },
      { id: 'r3', name: 'Унтлагын өрөө', source: 'stitched', sourcePhotos: [], panorama: pano(`/uploads/demo/${k}-bedroom.png`), status: 'ready', startYaw: 0,
        hotspots: [{ yaw: 90, pitch: -10, targetRoomId: 'r1', label: 'Зочны өрөө' }], floorPlanPosition: [16, 34] },
    ],
  };
}
function photos(k) { return [1, 2, 3, 4].map((i) => photo(`/uploads/demo/${k}-photo${i}.png`)); }

function seedListings() {
  const H = 3600e3, D = 24 * H, t = Date.now();
  const base = (o) => {
    const [lat, lng] = CENTERS[o.district];
    const createdAt = new Date(t - (o.ago || 0)).toISOString();
    const promoted = o.placement && o.placement !== 'free';
    return {
      id: o.id, ownerToken: 'demo-' + o.id, ownerPhone: o.phone, sellerName: o.seller, sellerType: o.sellerType || 'owner',
      category: o.category, dealType: o.deal || 'sale', title: o.title, price: o.price,
      pricePerM2: o.area ? Math.round(o.price / o.area) : undefined,
      rooms: o.rooms, area: o.area, floor: o.floor, buildingFloors: o.bf, yearInUse: o.year,
      floorMaterial: o.floorMaterial, balconies: o.balconies, windowType: o.windowType, windowCount: o.windowCount,
      doorType: o.doorType, garage: !!o.garage, leasing: !!o.leasing, paymentTerms: o.pay || ['Бэлэн'],
      location: { city: 'Улаанбаатар', district: o.district, khoroo: o.khoroo || '', address: o.address || '',
        lat: lat + (hash(o.price) - 0.5) * 0.02, lng: lng + (hash(o.area || 7) - 0.5) * 0.03 },
      description: o.desc, photos: o.photos || [], tour: o.tour, placement: o.placement || 'free',
      placementUntil: promoted ? new Date(t + 6 * D).toISOString() : undefined,
      status: o.status || 'active', views: o.views || Math.round(40 + hash(o.price) * 900),
      createdAt, expiresAt: new Date(t - (o.ago || 0) + 30 * D).toISOString(),
    };
  };
  const list = [
    { id: 'L100001', category: 'apartment', district: 'Хан-Уул', khoroo: '11-р хороо', title: 'Хан-Уул, 3 өрөө, 85м², шинэ байр', price: 320e6, rooms: 3, area: 85, floor: 7, bf: 16, year: 2021, floorMaterial: 'Паркет', balconies: 1, windowType: 'Вакуум', windowCount: 4, doorType: 'Бүргэд', garage: true, leasing: true, pay: ['Бэлэн', 'Банкны зээл', 'Ипотек'], placement: 'top', ago: 2 * H, seller: 'Батболд', phone: '99000001', tour: aptTour('a'), photos: photos('a'), desc: 'Шинэ байрны 7 давхарт, нарны гэрэл сайтай 3 өрөө байр. Дулаан зогсоол, тоглоомын талбайтай. Сургууль, цэцэрлэг ойрхон.' },
    { id: 'L100002', category: 'apartment', district: 'Сүхбаатар', khoroo: '1-р хороо', title: 'Төвд 2 өрөө байр, засвартай', price: 245e6, rooms: 2, area: 56, floor: 4, bf: 9, year: 2012, floorMaterial: 'Ламинат', balconies: 1, windowType: 'Вакуум', windowCount: 3, doorType: 'Төмөр', pay: ['Бэлэн', 'Ипотек'], placement: 'vip', ago: 5 * H, seller: 'Сараа', phone: '99000002', tour: aptTour('b'), photos: photos('b'), desc: 'Улсын их дэлгүүрийн ар талд. Бүрэн засвартай, тавилгатай зарна. Шууд орж амьдрах боломжтой.' },
    { id: 'L100003', category: 'apartment', district: 'Баянзүрх', khoroo: '26-р хороо', title: '1 өрөө байр, 13-р хороолол', price: 135e6, rooms: 1, area: 38, floor: 2, bf: 5, year: 1985, floorMaterial: 'Паркет', balconies: 1, windowType: 'Мод', windowCount: 2, doorType: 'Төмөр', pay: ['Бэлэн', 'Бартер'], ago: 20 * H, seller: 'Дорж', phone: '99000003', photos: photos('c').slice(0, 2), desc: 'Хуучин байр, дулаан. Автобусны буудал ойрхон.' },
    { id: 'L100004', category: 'apartment', district: 'Баянгол', khoroo: '3-р хороо', title: '4 өрөө тансаг байр, 120м²', price: 480e6, rooms: 4, area: 120, floor: 10, bf: 12, year: 2019, floorMaterial: 'Паркет', balconies: 2, windowType: 'Вакуум', windowCount: 6, doorType: 'Бүргэд', garage: true, leasing: true, pay: ['Бэлэн', 'Банкны зээл'], placement: 'vip', ago: 1.2 * D, seller: 'Гэр Агент ХХК', sellerType: 'agent', phone: '99000004', tour: aptTour('c'), photos: photos('c'), desc: 'Хотын үзэмжтэй, 2 тагттай. Агентаар дамжуулан зарж байна.' },
    { id: 'L100005', deal: 'rent', category: 'apartment', district: 'Чингэлтэй', khoroo: '4-р хороо', title: '2 өрөө байр түрээслүүлнэ, тавилгатай', price: 2.2e6, rooms: 2, area: 60, floor: 6, bf: 12, year: 2015, floorMaterial: 'Ламинат', balconies: 1, windowType: 'Вакуум', windowCount: 3, doorType: 'Бүргэд', pay: ['Бэлэн'], ago: 8 * H, seller: 'Оюун', phone: '99000005', tour: aptTour('b'), photos: photos('b').slice(0, 3), desc: 'Урт хугацаагаар түрээслүүлнэ. Угаалгын машин, хөргөгчтэй.' },
    { id: 'L100006', deal: 'rent', category: 'apartment', district: 'Хан-Уул', khoroo: '15-р хороо', title: 'Зайсанд 3 өрөө түрээс', price: 3.5e6, rooms: 3, area: 90, floor: 9, bf: 14, year: 2020, floorMaterial: 'Паркет', balconies: 1, windowType: 'Вакуум', windowCount: 4, doorType: 'Бүргэд', garage: true, pay: ['Бэлэн'], placement: 'top', ago: 3 * H, seller: 'Гэр Агент ХХК', sellerType: 'agent', phone: '99000004', tour: aptTour('a'), photos: photos('a').slice(1), desc: 'Богд уулын үзэмжтэй. Гараж түрээсэнд багтсан.' },
    { id: 'L100007', category: 'house', district: 'Сонгинохайрхан', khoroo: '20-р хороо', title: 'Хашаа байшин, 0.07 га газартай', price: 280e6, rooms: 5, area: 140, bf: 2, year: 2016, floorMaterial: 'Модон', windowType: 'Вакуум', windowCount: 8, doorType: 'Төмөр', garage: true, pay: ['Бэлэн', 'Банкны зээл'], ago: 2 * D, seller: 'Ганбаатар', phone: '99000007', tour: { startRoomId: 'y', rooms: [{ id: 'y', name: 'Хашаа', source: 'upload360', sourcePhotos: [], panorama: pano('/uploads/demo/yard.png'), status: 'ready', startYaw: 0, hotspots: [] }] }, photos: [photo('/uploads/demo/yard-photo.png'), ...photos('c').slice(0, 2)], desc: '2 давхар амины орон сууц, гаражтай. Төвийн шугамд холбогдсон.' },
    { id: 'L100008', category: 'land', district: 'Налайх', title: 'Налайхад 700м² газар, гэрчилгээтэй', price: 45e6, area: 700, pay: ['Бэлэн', 'Бартер'], ago: 3 * D, seller: 'Энхээ', phone: '99000008', tour: { startRoomId: 'l', rooms: [{ id: 'l', name: 'Газар', source: 'upload360', sourcePhotos: [], panorama: pano('/uploads/demo/land.png'), status: 'ready', startYaw: 0, hotspots: [] }] }, photos: [photo('/uploads/demo/land-photo.png')], desc: 'Зам дагуу, цахилгаан ойрхон. Хувийн өмчлөлийн гэрчилгээтэй.' },
    { id: 'L100009', category: 'office', district: 'Сүхбаатар', khoroo: '8-р хороо', title: 'Оффис зарна, 150м², бизнес төвд', price: 900e6, rooms: 4, area: 150, floor: 5, bf: 17, year: 2014, floorMaterial: 'Плита', windowType: 'Вакуум', windowCount: 8, doorType: 'Бүргэд', leasing: true, pay: ['Бэлэн', 'Банкны зээл'], placement: 'vip', ago: 26 * H, seller: 'Гэр Агент ХХК', sellerType: 'agent', phone: '99000004', photos: photos('b'), desc: 'Хурлын өрөө, 3 тусгай өрөөтэй. Зогсоолтой.' },
    { id: 'L100010', deal: 'rent', category: 'office', district: 'Чингэлтэй', title: 'Оффис түрээслүүлнэ 80м²', price: 4e6, rooms: 2, area: 80, floor: 3, bf: 10, year: 2010, floorMaterial: 'Плита', pay: ['Бэлэн'], ago: 4 * D, seller: 'Төмөр', phone: '99000010', photos: photos('b').slice(2), desc: 'Төв замын хажууд, хүн ихтэй байршил.' },
    { id: 'L100011', deal: 'rent', category: 'shop', district: 'Баянгол', title: 'Худалдааны талбай, 1 давхарт 45м²', price: 2.8e6, area: 45, floor: 1, bf: 9, year: 2008, pay: ['Бэлэн'], ago: 12 * H, seller: 'Нараа', phone: '99000011', photos: photos('c').slice(1, 3), desc: 'Гудамж руу харсан тусдаа орцтой. Дэлгүүр, кофе шопод тохиромжтой.' },
    { id: 'L100012', category: 'warehouse', district: 'Сонгинохайрхан', title: 'Агуулах 600м², ачааны машин орох', price: 1.2e9, area: 600, year: 2011, pay: ['Бэлэн', 'Банкны зээл'], ago: 6 * D, seller: 'Логистик Хаус', sellerType: 'agent', phone: '99000012', photos: [photo('/uploads/demo/land-photo.png')], desc: 'Халаалттай агуулах, оффисын хэсэгтэй.' },
    { id: 'L100013', category: 'garage', district: 'Баянзүрх', title: 'Дулаан гараж зарна, 18м²', price: 25e6, area: 18, pay: ['Бэлэн'], ago: 30 * H, seller: 'Баяраа', phone: '99000013', photos: [photo('/uploads/demo/yard-photo.png')], desc: 'Байрны доорх дулаан зогсоол.' },
    { id: 'L100014', category: 'summer_house', district: 'Хан-Уул', title: 'Зуслангийн байшин, 4 өрөө', price: 350e6, rooms: 4, area: 90, year: 2018, floorMaterial: 'Модон', windowType: 'Вакуум', pay: ['Бэлэн', 'Банкны зээл'], ago: 2.5 * D, seller: 'Цэцгээ', phone: '99000014',
      tour: { startRoomId: 'y', rooms: [
        { id: 'y', name: 'Хашаа', source: 'upload360', sourcePhotos: [], panorama: pano('/uploads/demo/yard.png'), status: 'ready', startYaw: 0, hotspots: [{ yaw: 0, pitch: -6, targetRoomId: 'r', label: 'Байшин руу' }] },
        { id: 'r', name: 'Зочны өрөө', source: 'stitched', sourcePhotos: [], panorama: pano('/uploads/demo/c-living.png'), status: 'ready', startYaw: 0, hotspots: [{ yaw: 90, pitch: -8, targetRoomId: 'y', label: 'Хашаа руу' }] },
      ] }, photos: [photo('/uploads/demo/yard-photo.png'), photo('/uploads/demo/c-photo1.png')], desc: 'Туул голын ойролцоо, жилийн дөрвөн улиралд амьдрах боломжтой.' },
    { id: 'L100015', category: 'apartment', district: 'Хан-Уул', khoroo: '18-р хороо', title: '2 өрөө, 62м², хотхонд', price: 260e6, rooms: 2, area: 62, floor: 1, bf: 12, year: 2017, floorMaterial: 'Ламинат', balconies: 0, windowType: 'Вакуум', windowCount: 3, doorType: 'Бүргэд', pay: ['Бэлэн', 'Ипотек'], ago: 5 * D, seller: 'Мөнх', phone: '99000015', photos: photos('a').slice(2), desc: 'Хотхон дотор, хамгаалалттай.' },
    { id: 'L100016', category: 'apartment', district: 'Сүхбаатар', khoroo: '6-р хороо', title: '3 өрөө 98м², Их тойруу', price: 410e6, rooms: 3, area: 98, floor: 8, bf: 8, year: 2009, floorMaterial: 'Паркет', balconies: 1, windowType: 'Вакуум', windowCount: 5, doorType: 'Бүргэд', leasing: true, pay: ['Бэлэн', 'Банкны зээл', 'Ипотек'], ago: 1.5 * D, seller: 'Гэр Агент ХХК', sellerType: 'agent', phone: '99000004', tour: aptTour('c'), photos: photos('c'), desc: 'Сүүлийн давхар, том тагттай.' },
    { id: 'L100017', category: 'apartment', district: 'Баянгол', title: '2 өрөө байр (батлагдахыг хүлээж буй жишээ)', price: 199e6, rooms: 2, area: 48, floor: 3, bf: 5, year: 1990, pay: ['Бэлэн'], ago: 1 * H, seller: 'Шинэ хэрэглэгч', phone: '99000017', status: 'pending', photos: photos('b').slice(0, 1), desc: 'Админы баталгаажуулалтыг турших зар.' },
  ];
  return list.map(base);
}

/** Demo images are files on disk, demo listings are rows in Postgres (inserted by server.js). */
const demoImagesPresent = (uploadDir) => fs.existsSync(path.join(uploadDir, 'demo', 'a-living.png')) && fs.existsSync(path.join(uploadDir, 'demo-capture', 'IMG_12.png'));

/** Writes demo images to uploadDir and the demo listings to a JSON file (old format, used by import scripts). */
function seed({ dbFile, uploadDir }) {
  const t0 = Date.now();
  generateImages(uploadDir);
  const listings = seedListings();
  fs.writeFileSync(dbFile, JSON.stringify({ nextNo: 100018, listings, reports: [] }));
  console.log(`Жишээ өгөгдөл бэлэн (${listings.length} зар, ${((Date.now() - t0) / 1000).toFixed(1)} сек).`);
}

module.exports = { seed, generateImages, seedListings, demoImagesPresent };
