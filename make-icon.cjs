// Build a multi-resolution codex-gui.ico (PNG-compressed entries, Vista+ format).
// No image libraries: a tiny RGBA rasterizer plus the ICO container.
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');

const SIZES = [16, 32, 48, 64, 128, 256];

// ---------- drawing helpers ----------
function makeCanvas(size) {
  return { size, px: new Float64Array(size * size * 4) }; // straight RGBA 0..255
}
function setPx(c, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size || a <= 0) return;
  const i = (y * c.size + x) * 4;
  const sa = a / 255;
  const da = c.px[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  c.px[i]     = (r * sa + c.px[i]     * da * (1 - sa)) / oa;
  c.px[i + 1] = (g * sa + c.px[i + 1] * da * (1 - sa)) / oa;
  c.px[i + 2] = (b * sa + c.px[i + 2] * da * (1 - sa)) / oa;
  c.px[i + 3] = oa * 255;
}
function lerp(a, b, t) { return a + (b - a) * t; }

/** Signed distance to a rounded rectangle centred at (cx,cy). */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance from point to a thick line segment. */
function sdSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function cover(d, aa) { return Math.max(0, Math.min(1, 0.5 - d / aa)); }

// ---------- the icon ----------
// Rounded blue-violet tile with a </> glyph and a prompt caret.
function drawIcon(size) {
  const c = makeCanvas(size);
  const S = size;
  const aa = 1.25 * (S / 64);          // antialias width scales with resolution
  const cx = S / 2, cy = S / 2;
  const pad = S * 0.045;
  const hw = S / 2 - pad, hh = S / 2 - pad;
  const radius = S * 0.22;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5, py = y + 0.5;

      // ---- tile background: vertical gradient ----
      const d = sdRoundRect(px, py, cx, cy, hw, hh, radius);
      const a = cover(d, aa);
      if (a <= 0) continue;
      const t = py / S;
      const r = lerp(0x2f, 0x1f, t);
      const g = lerp(0x81, 0x4b, t);
      const b = lerp(0xf7, 0xa8, t);
      setPx(c, x, y, r, g, b, a * 255);

      // ---- subtle top highlight ----
      const dTop = sdRoundRect(px, py, cx, cy, hw, hh, radius);
      if (dTop < 0 && py < S * 0.5) {
        const k = (1 - py / (S * 0.5)) * 0.16;
        setPx(c, x, y, 255, 255, 255, k * 255 * a);
      }
    }
  }

  // ---- glyph: < / > drawn as thick strokes ----
  const gcol = { r: 0xff, g: 0xff, b: 0xff };
  const stroke = S * 0.075;
  const lx1 = S * 0.27, ly1 = S * 0.36, lx2 = S * 0.17, ly2 = S * 0.50, lx3 = S * 0.27, ly3 = S * 0.64;
  const rx1 = S * 0.73, ry1 = S * 0.36, rx2 = S * 0.83, ry2 = S * 0.50, rx3 = S * 0.73, ry3 = S * 0.64;
  const sx1 = S * 0.45, sy1 = S * 0.70, sx2 = S * 0.55, sy2 = S * 0.30;   // the slash

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5, py = y + 0.5;
      let dist = Math.min(
        sdSegment(px, py, lx1, ly1, lx2, ly2),
        sdSegment(px, py, lx2, ly2, lx3, ly3),
        sdSegment(px, py, rx1, ry1, rx2, ry2),
        sdSegment(px, py, rx2, ry2, rx3, ry3),
        sdSegment(px, py, sx1, sy1, sx2, sy2)
      );
      const cov = cover(dist - stroke / 2, aa);
      if (cov > 0) setPx(c, x, y, gcol.r, gcol.g, gcol.b, cov * 235);
    }
  }
  return c;
}

// ---------- PNG encoder ----------
function crc32(buf) {
  let c, table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(canvas) {
  const { size, px } = canvas;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      raw[o++] = Math.round(px[i]);
      raw[o++] = Math.round(px[i + 1]);
      raw[o++] = Math.round(px[i + 2]);
      raw[o++] = Math.round(px[i + 3]);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- ICO container ----------
function buildICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dirSize = 16 * entries.length;
  let offset = 6 + dirSize;
  const dir = [];
  const blobs = [];
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size;     // 0 means 256
    d[1] = e.size >= 256 ? 0 : e.size;
    d[2] = 0; d[3] = 0;
    d.writeUInt16LE(1, 4);                 // colour planes
    d.writeUInt16LE(32, 6);                // bits per pixel
    d.writeUInt32LE(e.png.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.png.length;
    dir.push(d);
    blobs.push(e.png);
  }
  return Buffer.concat([header, ...dir, ...blobs]);
}

// ---------- run ----------
const entries = SIZES.map((size) => {
  const png = encodePNG(drawIcon(size));
  console.log('  ' + String(size).padStart(3) + 'px -> ' + png.length + ' bytes');
  return { size, png };
});
const ico = buildICO(entries);
const out = path.join(__dirname, 'codex-gui.ico');
fs.writeFileSync(out, ico);
console.log('\nwrote ' + out + '  (' + ico.length + ' bytes, ' + entries.length + ' sizes)');
