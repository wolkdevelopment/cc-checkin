/* QR codes for the check-in app, with no outside libraries.
   - encode(): byte mode, error correction level M, versions 1-25 (ISO/IEC 18004).
   - scanImage(): finds and reads a level-M QR code in a camera frame. It follows the approach
     of the ZXing project: adaptive black/white conversion, finder-pattern search with cross checks,
     an alignment pattern for perspective, then Reed-Solomon error correction.
   Works in the browser and in Node (for tests). */

const ECC_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28];
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21];
const LEVEL_M = 0; // the two format bits for level M
const MAX_VER = 25;

function rawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const na = Math.floor(ver / 7) + 2;
    r -= (25 * na - 10) * na - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
function dataCodewords(ver) { return Math.floor(rawModules(ver) / 8) - ECC_M[ver] * BLOCKS_M[ver]; }

/* ---------- GF(256) with x^8 + x^4 + x^3 + x^2 + 1 ---------- */
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(function () {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const ginv = a => EXP[255 - LOG[a]];

function rsDivisor(degree) {
  const res = new Array(degree).fill(0);
  res[degree - 1] = 1;
  let root = 1;
  for (let k = 0; k < degree; k++) {
    for (let j = 0; j < res.length; j++) {
      res[j] = gmul(res[j], root);
      if (j + 1 < res.length) res[j] ^= res[j + 1];
    }
    root = gmul(root, 2);
  }
  return res;
}
function rsRemainder(data, div) {
  const res = div.map(() => 0);
  for (const b of data) {
    const f = b ^ res.shift();
    res.push(0);
    div.forEach((c, i) => { res[i] ^= gmul(c, f); });
  }
  return res;
}

/* Polynomials over GF(256), highest degree first, no leading zeros (zero is [0]). */
function pNorm(c) { let i = 0; while (i < c.length - 1 && c[i] === 0) i++; return i ? c.slice(i) : c; }
const pDeg = p => p.length - 1;
const pZero = p => p.length === 1 && p[0] === 0;
const pCoef = (p, d) => p[p.length - 1 - d];
function pEval(p, a) {
  if (a === 0) return pCoef(p, 0);
  let r = 0;
  for (let i = 0; i < p.length; i++) r = gmul(r, a) ^ p[i];
  return r;
}
function pAdd(a, b) {
  if (pZero(a)) return b;
  if (pZero(b)) return a;
  let s = a, l = b;
  if (s.length > l.length) { s = b; l = a; }
  const out = l.slice(), d = l.length - s.length;
  for (let i = 0; i < s.length; i++) out[i + d] ^= s[i];
  return pNorm(out);
}
function pMul(a, b) {
  if (pZero(a) || pZero(b)) return [0];
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] ^= gmul(a[i], b[j]);
  return pNorm(out);
}
function pScale(a, s) { return s === 0 ? [0] : pNorm(a.map(c => gmul(c, s))); }
function pMulMono(a, degree, coef) {
  if (coef === 0) return [0];
  const out = new Array(a.length + degree).fill(0);
  for (let i = 0; i < a.length; i++) out[i] = gmul(a[i], coef);
  return pNorm(out);
}
function pMono(degree, coef) {
  if (coef === 0) return [0];
  const out = new Array(degree + 1).fill(0);
  out[0] = coef;
  return out;
}

/* Corrects up to ecLen/2 wrong codewords in one block (data then error correction).
   Returns the corrected block, or null if it can't be corrected. */
export function rsCorrect(block, ecLen) {
  const poly = pNorm(block.slice());
  const synd = new Array(ecLen);
  let clean = true;
  for (let i = 0; i < ecLen; i++) {
    const v = pEval(poly, EXP[i]);
    synd[ecLen - 1 - i] = v;
    if (v) clean = false;
  }
  if (clean) return block.slice();
  // Euclid's algorithm gives the error locator (sigma) and evaluator (omega).
  let a = pMono(ecLen, 1), b = pNorm(synd);
  if (pDeg(a) < pDeg(b)) { const t = a; a = b; b = t; }
  let rLast = a, r = b, tLast = [0], t = [1];
  while (2 * pDeg(r) >= ecLen) {
    const rLastLast = rLast, tLastLast = tLast;
    rLast = r; tLast = t;
    if (pZero(rLast)) return null;
    r = rLastLast;
    let q = [0];
    const dltInv = ginv(pCoef(rLast, pDeg(rLast)));
    while (pDeg(r) >= pDeg(rLast) && !pZero(r)) {
      const diff = pDeg(r) - pDeg(rLast), scale = gmul(pCoef(r, pDeg(r)), dltInv);
      q = pAdd(q, pMono(diff, scale));
      r = pAdd(r, pMulMono(rLast, diff, scale));
    }
    t = pAdd(pMul(q, tLast), tLastLast);
    if (pDeg(r) >= pDeg(rLast)) return null;
  }
  const s0 = pCoef(t, 0);
  if (s0 === 0) return null;
  const sigma = pScale(t, ginv(s0)), omega = pScale(r, ginv(s0));
  const nErr = pDeg(sigma), locs = [];
  if (nErr === 1) locs.push(pCoef(sigma, 1));
  else for (let i = 1; i < 256 && locs.length < nErr; i++) if (pEval(sigma, i) === 0) locs.push(ginv(i));
  if (locs.length !== nErr) return null;
  const out = block.slice();
  for (let i = 0; i < nErr; i++) {
    const xiInv = ginv(locs[i]);
    let denom = 1;
    for (let j = 0; j < nErr; j++) if (i !== j) denom = gmul(denom, 1 ^ gmul(locs[j], xiInv));
    const mag = gmul(pEval(omega, xiInv), ginv(denom));
    const pos = block.length - 1 - LOG[locs[i]];
    if (pos < 0) return null;
    out[pos] ^= mag;
  }
  const check = pNorm(out.slice());
  for (let i = 0; i < ecLen; i++) if (pEval(check, EXP[i]) !== 0) return null;
  return out;
}

/* ---------- the module layout shared by the encoder and the decoder ---------- */
function alignmentPositions(ver) {
  if (ver === 1) return [];
  const na = Math.floor(ver / 7) + 2, size = ver * 4 + 17;
  const step = Math.ceil((ver * 4 + 4) / (na * 2 - 2)) * 2;
  const pos = [6];
  for (let p = size - 7; pos.length < na; p -= step) pos.splice(1, 0, p);
  return pos;
}
function formatBitsFor(level, mask) {
  const d = (level << 3) | mask;
  let rem = d;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((d << 10) | rem) ^ 0x5412;
}
function versionBitsFor(ver) {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}
// Where the 15 format bits sit, bit 0 first, in both copies: [x, y].
function formatCoords(size) {
  const a = [], b = [];
  for (let i = 0; i <= 5; i++) a.push([8, i]);
  a.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) a.push([14 - i, 8]);
  for (let i = 0; i < 8; i++) b.push([size - 1 - i, 8]);
  for (let i = 8; i < 15; i++) b.push([8, size - 15 + i]);
  return [a, b];
}
// Where the 18 version bits sit (versions 7 and up), in both copies.
function versionCoords(size) {
  const a = [], b = [];
  for (let i = 0; i < 18; i++) {
    const p = size - 11 + (i % 3), q = Math.floor(i / 3);
    a.push([p, q]); b.push([q, p]);
  }
  return [a, b];
}
const LAYOUT = {};
function layout(ver) {
  if (LAYOUT[ver]) return LAYOUT[ver];
  const size = ver * 4 + 17, mod = [], fn = [];
  for (let y = 0; y < size; y++) { mod.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
  const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };
  for (let t = 0; t < size; t++) { set(6, t, t % 2 === 0); set(t, 6, t % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const pos = alignmentPositions(ver), last = pos.length - 1;
  pos.forEach((ay, i) => pos.forEach((ax, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const [fa, fb] = formatCoords(size);
  fa.concat(fb).forEach(([x, y]) => set(x, y, false));
  set(8, size - 8, true);
  if (ver >= 7) {
    const vb = versionBitsFor(ver), [va, vt] = versionCoords(size);
    for (let i = 0; i < 18; i++) { const dark = ((vb >>> i) & 1) !== 0; set(va[i][0], va[i][1], dark); set(vt[i][0], vt[i][1], dark); }
  }
  // The order data bits are placed in: right to left in column pairs, zigzagging up and down.
  const order = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!fn[y][x]) order.push(x, y);
      }
    }
  }
  return (LAYOUT[ver] = { size, mod, fn, order });
}
function maskHit(m, x, y) {
  switch (m) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return (x * y) % 2 + (x * y) % 3 === 0;
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
    default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
  }
}
function utf8Bytes(text) { return Array.from(new TextEncoder().encode(text)); }

/* ---------- encoder ---------- */
export function encode(text) {
  const bytes = utf8Bytes(text);
  let ver, cap;
  for (ver = 1; ver <= MAX_VER; ver++) {
    cap = dataCodewords(ver) * 8;
    if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= cap) break;
  }
  if (ver > MAX_VER) throw new Error("Too long for a QR code here");
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  bytes.forEach(b => put(b, 8));
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; data.push(v); }
  const nb = BLOCKS_M[ver], ecl = ECC_M[ver], raw = Math.floor(rawModules(ver) / 8);
  const nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb), div = rsDivisor(ecl), blocks = [];
  for (let b = 0, k = 0; b < nb; b++) {
    const dat = data.slice(k, k + shortLen - ecl + (b < nShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (b < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const cw = [];
  for (let c = 0; c < blocks[0].length; c++) for (let b = 0; b < nb; b++) if (c !== shortLen - ecl || b >= nShort) cw.push(blocks[b][c]);
  const L = layout(ver), size = L.size, mod = L.mod.map(r => r.slice());
  for (let i = 0, n = 0; i < L.order.length; i += 2, n++) {
    mod[L.order[i + 1]][L.order[i]] = n < cw.length * 8 ? ((cw[n >>> 3] >>> (7 - (n & 7))) & 1) === 1 : false;
  }
  const [fa, fb] = formatCoords(size);
  const applyMask = m => { for (let i = 0; i < L.order.length; i += 2) { const x = L.order[i], y = L.order[i + 1]; if (maskHit(m, x, y)) mod[y][x] = !mod[y][x]; } };
  const drawFormat = m => { const f = formatBitsFor(LEVEL_M, m); fa.forEach(([x, y], i) => { mod[y][x] = ((f >>> i) & 1) === 1; }); fb.forEach(([x, y], i) => { mod[y][x] = ((f >>> i) & 1) === 1; }); };
  let best = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const s = penalty(mod);
    if (s < bestScore) { bestScore = s; best = m; }
    applyMask(m);
  }
  applyMask(best); drawFormat(best);
  return { ver, size, modules: mod };
}
function penalty(mod) {
  const size = mod.length;
  let score = 0, dark = 0;
  for (let y = 0; y < size; y++) {
    for (let dir = 0; dir < 2; dir++) {
      let run = 1;
      for (let x = 1; x < size; x++) {
        const cur = dir === 0 ? mod[y][x] : mod[x][y], prev = dir === 0 ? mod[y][x - 1] : mod[x - 1][y];
        if (cur === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1;
      }
    }
  }
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = mod[y][x];
    if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) score += 3;
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (mod[y][x]) dark++;
  const total = size * size, k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return score + Math.max(0, k) * 10;
}
export function matrix(text) { return encode(text).modules; }

/* An SVG of the code with a 4-module quiet zone, drawn as one path. */
export function svg(text, label) {
  const m = matrix(text), size = m.length, full = size + 8;
  let d = "";
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (m[y][x]) d += "M" + (x + 4) + " " + (y + 4) + "h1v1h-1z";
  const safe = String(label || "QR code").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return '<svg class="qr" viewBox="0 0 ' + full + " " + full + '" role="img" aria-label="' + safe + '" shape-rendering="crispEdges"><rect width="' + full + '" height="' + full + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
}

/* ---------- decoder: from a grid of modules to text ---------- */
function popcount(x) { let c = 0; while (x) { x &= x - 1; c++; } return c; }
const FORMATS = Array.from({ length: 8 }, (_, m) => ({ mask: m, bits: formatBitsFor(LEVEL_M, m) }));
const VERSIONS = Array.from({ length: MAX_VER - 6 }, (_, i) => ({ v: i + 7, bits: versionBitsFor(i + 7) }));

function readFormat(grid, size) {
  let best = null;
  for (const coords of formatCoords(size)) {
    let bits = 0;
    coords.forEach(([x, y], i) => { if (grid[y][x]) bits |= 1 << i; });
    for (const f of FORMATS) {
      const d = popcount(bits ^ f.bits);
      if (!best || d < best.d) best = { d, mask: f.mask };
    }
  }
  return best && best.d <= 3 ? best.mask : -1;
}
function readVersion(grid, size) {
  let best = null;
  for (const coords of versionCoords(size)) {
    let bits = 0;
    coords.forEach(([x, y], i) => { if (grid[y][x]) bits |= 1 << i; });
    for (const v of VERSIONS) {
      const d = popcount(bits ^ v.bits);
      if (!best || d < best.d) best = { d, v: v.v };
    }
  }
  return best && best.d <= 3 ? best.v : -1;
}
const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
function parseSegments(bytes, ver) {
  let pos = 0;
  const total = bytes.length * 8;
  const read = n => {
    if (pos + n > total) throw new Error("short");
    let v = 0;
    for (let i = 0; i < n; i++, pos++) v = (v << 1) | ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1);
    return v;
  };
  const out = [];
  try {
    while (pos + 4 <= total) {
      const mode = read(4);
      if (mode === 0) break;
      if (mode === 4) {
        const n = read(ver < 10 ? 8 : 16);
        for (let i = 0; i < n; i++) out.push(read(8));
      } else if (mode === 2) {
        let n = read(ver < 10 ? 9 : 11);
        for (; n >= 2; n -= 2) { const v = read(11); out.push(ALNUM.charCodeAt(Math.floor(v / 45)), ALNUM.charCodeAt(v % 45)); }
        if (n === 1) out.push(ALNUM.charCodeAt(read(6)));
      } else if (mode === 1) {
        let n = read(ver < 10 ? 10 : 12);
        for (; n >= 3; n -= 3) String(read(10)).padStart(3, "0").split("").forEach(c => out.push(c.charCodeAt(0)));
        if (n === 2) String(read(7)).padStart(2, "0").split("").forEach(c => out.push(c.charCodeAt(0)));
        else if (n === 1) out.push(String(read(4)).charCodeAt(0));
      } else if (mode === 7) {
        const first = read(8);
        if ((first & 0x80) !== 0) read((first & 0x40) === 0 ? 8 : 16);
      } else return null;
    }
  } catch (e) {
    return null;
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(out));
}

/* Reads a grid of modules (true = dark). Returns the text, or null. */
export function decodeGrid(grid) {
  const size = grid.length;
  if (size < 21 || (size - 17) % 4 !== 0) return null;
  const ver = (size - 17) / 4;
  if (ver > MAX_VER) return null;
  const mask = readFormat(grid, size);
  if (mask < 0) return null;
  if (ver >= 7 && readVersion(grid, size) !== ver) return null;
  const L = layout(ver), raw = Math.floor(rawModules(ver) / 8), bytes = new Array(raw).fill(0);
  for (let i = 0, n = 0; i < L.order.length && n < raw * 8; i += 2, n++) {
    const x = L.order[i], y = L.order[i + 1];
    if (grid[y][x] !== maskHit(mask, x, y)) bytes[n >> 3] |= 0x80 >> (n & 7);
  }
  const nb = BLOCKS_M[ver], ecl = ECC_M[ver], nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const blocks = Array.from({ length: nb }, () => []);
  let k = 0;
  for (let c = 0; c <= shortLen; c++) for (let b = 0; b < nb; b++) if (c !== shortLen - ecl || b >= nShort) blocks[b][c] = bytes[k++];
  const data = [];
  for (let b = 0; b < nb; b++) {
    const dlen = shortLen - ecl + (b < nShort ? 0 : 1);
    const fixed = rsCorrect(blocks[b].slice(0, dlen).concat(blocks[b].slice(shortLen - ecl + 1)), ecl);
    if (!fixed) return null;
    for (let i = 0; i < dlen; i++) data.push(fixed[i]);
  }
  return parseSegments(data, ver);
}

/* ---------- decoder: from a camera frame to a grid ---------- */
function toGray(rgba, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return g;
}
// Black and white by local contrast, in 8x8 blocks, so glare and shadows don't wash out the code.
function binarize(gray, w, h) {
  const B = 8, bw = Math.ceil(w / B), bh = Math.ceil(h / B), black = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    const y0 = Math.min(by * B, h - B);
    for (let bx = 0; bx < bw; bx++) {
      const x0 = Math.min(bx * B, w - B);
      let sum = 0, min = 255, max = 0;
      for (let yy = 0; yy < B; yy++) {
        const row = (y0 + yy) * w + x0;
        for (let xx = 0; xx < B; xx++) { const v = gray[row + xx]; sum += v; if (v < min) min = v; if (v > max) max = v; }
      }
      let avg = sum / 64;
      if (max - min <= 24) {
        avg = min / 2;
        if (by > 0 && bx > 0) {
          const nb = (black[(by - 1) * bw + bx] + 2 * black[by * bw + bx - 1] + black[(by - 1) * bw + bx - 1]) / 4;
          if (min < nb) avg = nb;
        }
      }
      black[by * bw + bx] = avg;
    }
  }
  const out = new Uint8Array(w * h);
  for (let by = 0; by < bh; by++) {
    const cy = Math.min(Math.max(by, 2), bh - 3), y0 = Math.min(by * B, h - B);
    for (let bx = 0; bx < bw; bx++) {
      const cx = Math.min(Math.max(bx, 2), bw - 3), x0 = Math.min(bx * B, w - B);
      let s = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += black[(cy + dy) * bw + cx + dx];
      const t = s / 25;
      for (let yy = 0; yy < B; yy++) {
        const row = (y0 + yy) * w + x0;
        for (let xx = 0; xx < B; xx++) out[row + xx] = gray[row + xx] <= t ? 1 : 0;
      }
    }
  }
  return out;
}

function finderCandidates(bits, w, h) {
  const centers = [];
  const dark = (x, y) => bits[y * w + x] === 1;
  const sum5 = s => s[0] + s[1] + s[2] + s[3] + s[4];
  function cross(s) {
    for (let i = 0; i < 5; i++) if (s[i] === 0) return false;
    const total = sum5(s);
    if (total < 7) return false;
    const m = total / 7, v = m / 2;
    return Math.abs(m - s[0]) < v && Math.abs(m - s[1]) < v && Math.abs(3 * m - s[2]) < 3 * v && Math.abs(m - s[3]) < v && Math.abs(m - s[4]) < v;
  }
  function crossDiag(s) {
    for (let i = 0; i < 5; i++) if (s[i] === 0) return false;
    const total = sum5(s);
    if (total < 7) return false;
    const m = total / 7, v = m / 1.333;
    return Math.abs(m - s[0]) < v && Math.abs(m - s[1]) < v && Math.abs(3 * m - s[2]) < 3 * v && Math.abs(m - s[3]) < v && Math.abs(m - s[4]) < v;
  }
  const fromEnd = (s, end) => end - s[4] - s[3] - s[2] / 2;
  function checkVertical(startY, cx, maxCount, orig) {
    const s = [0, 0, 0, 0, 0];
    let y = startY;
    while (y >= 0 && dark(cx, y)) { s[2]++; y--; }
    if (y < 0) return NaN;
    while (y >= 0 && !dark(cx, y) && s[1] <= maxCount) { s[1]++; y--; }
    if (y < 0 || s[1] > maxCount) return NaN;
    while (y >= 0 && dark(cx, y) && s[0] <= maxCount) { s[0]++; y--; }
    if (s[0] > maxCount) return NaN;
    y = startY + 1;
    while (y < h && dark(cx, y)) { s[2]++; y++; }
    if (y === h) return NaN;
    while (y < h && !dark(cx, y) && s[3] < maxCount) { s[3]++; y++; }
    if (y === h || s[3] >= maxCount) return NaN;
    while (y < h && dark(cx, y) && s[4] < maxCount) { s[4]++; y++; }
    if (s[4] >= maxCount) return NaN;
    if (5 * Math.abs(sum5(s) - orig) >= 2 * orig) return NaN;
    return cross(s) ? fromEnd(s, y) : NaN;
  }
  function checkHorizontal(startX, cy, maxCount, orig) {
    const s = [0, 0, 0, 0, 0];
    let x = startX;
    while (x >= 0 && dark(x, cy)) { s[2]++; x--; }
    if (x < 0) return NaN;
    while (x >= 0 && !dark(x, cy) && s[1] <= maxCount) { s[1]++; x--; }
    if (x < 0 || s[1] > maxCount) return NaN;
    while (x >= 0 && dark(x, cy) && s[0] <= maxCount) { s[0]++; x--; }
    if (s[0] > maxCount) return NaN;
    x = startX + 1;
    while (x < w && dark(x, cy)) { s[2]++; x++; }
    if (x === w) return NaN;
    while (x < w && !dark(x, cy) && s[3] < maxCount) { s[3]++; x++; }
    if (x === w || s[3] >= maxCount) return NaN;
    while (x < w && dark(x, cy) && s[4] < maxCount) { s[4]++; x++; }
    if (s[4] >= maxCount) return NaN;
    if (5 * Math.abs(sum5(s) - orig) >= 2 * orig) return NaN;
    return cross(s) ? fromEnd(s, x) : NaN;
  }
  function checkDiagonal(cy, cx) {
    const s = [0, 0, 0, 0, 0];
    let i = 0;
    while (cy >= i && cx >= i && dark(cx - i, cy - i)) { s[2]++; i++; }
    if (s[2] === 0) return false;
    while (cy >= i && cx >= i && !dark(cx - i, cy - i)) { s[1]++; i++; }
    if (s[1] === 0) return false;
    while (cy >= i && cx >= i && dark(cx - i, cy - i)) { s[0]++; i++; }
    if (s[0] === 0) return false;
    i = 1;
    while (cy + i < h && cx + i < w && dark(cx + i, cy + i)) { s[2]++; i++; }
    while (cy + i < h && cx + i < w && !dark(cx + i, cy + i)) { s[3]++; i++; }
    if (s[3] === 0) return false;
    while (cy + i < h && cx + i < w && dark(cx + i, cy + i)) { s[4]++; i++; }
    if (s[4] === 0) return false;
    return crossDiag(s);
  }
  function handle(s, y, xEnd) {
    const total = sum5(s);
    let cx = fromEnd(s, xEnd);
    const cy = checkVertical(y, Math.floor(cx), s[2], total);
    if (isNaN(cy)) return false;
    cx = checkHorizontal(Math.floor(cx), Math.floor(cy), s[2], total);
    if (isNaN(cx) || !checkDiagonal(Math.floor(cy), Math.floor(cx))) return false;
    const size = total / 7;
    for (const c of centers) {
      if (Math.abs(cy - c.y) <= size && Math.abs(cx - c.x) <= size) {
        const diff = Math.abs(size - c.size);
        if (diff <= 1 || diff <= c.size) {
          const n = c.count + 1;
          c.x = (c.count * c.x + cx) / n; c.y = (c.count * c.y + cy) / n; c.size = (c.count * c.size + size) / n; c.count = n;
          return true;
        }
      }
    }
    centers.push({ x: cx, y: cy, size, count: 1 });
    return true;
  }
  for (let y = 0; y < h; y++) {
    const s = [0, 0, 0, 0, 0];
    let state = 0;
    for (let x = 0; x < w; x++) {
      if (dark(x, y)) {
        if (state & 1) state++;
        s[state]++;
      } else if (!(state & 1)) {
        if (state === 4) {
          if (cross(s) && handle(s, y, x)) { s.fill(0); state = 0; }
          else { s[0] = s[2]; s[1] = s[3]; s[2] = s[4]; s[3] = 1; s[4] = 0; state = 3; }
        } else { state++; s[state]++; }
      } else s[state]++;
    }
    if (cross(s)) handle(s, y, w);
  }
  return centers;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function triples(centers) {
  let c = centers.filter(p => p.count >= 2);
  if (c.length < 3) c = centers.slice();
  if (c.length < 3) return [];
  c.sort((a, b) => b.count - a.count);
  c = c.slice(0, 12);
  const out = [];
  for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) for (let k = j + 1; k < c.length; k++) {
    const a = c[i], b = c[j], d = c[k];
    // Row-run sizes swing a lot with tilt and rotation, so this only rules out the absurd;
    // error correction rejects any wrong guess later.
    const smax = Math.max(a.size, b.size, d.size), smin = Math.min(a.size, b.size, d.size);
    if (smax > smin * 3) continue;
    const ab = dist(a, b), ad = dist(a, d), bd = dist(b, d);
    let tl, p, q, hyp, l1, l2;
    if (bd >= ab && bd >= ad) { tl = a; p = b; q = d; hyp = bd; l1 = ab; l2 = ad; }
    else if (ad >= ab && ad >= bd) { tl = b; p = a; q = d; hyp = ad; l1 = ab; l2 = bd; }
    else { tl = d; p = a; q = b; hyp = ab; l1 = ad; l2 = bd; }
    const avg = (a.size + b.size + d.size) / 3;
    if (Math.min(l1, l2) < smin * 8) continue; // finder centers are at least 14 modules apart
    const side = Math.abs(l1 - l2) / Math.max(l1, l2);
    const angle = Math.abs(hyp * hyp - (l1 * l1 + l2 * l2)) / (hyp * hyp);
    if (side > 0.5 || angle > 0.5) continue;
    let tr = p, bl = q;
    if ((tr.x - tl.x) * (bl.y - tl.y) - (tr.y - tl.y) * (bl.x - tl.x) < 0) { tr = q; bl = p; }
    out.push({ tl, tr, bl, size: avg, score: side + angle + 0.5 * (smax - smin) / smax });
  }
  out.sort((x, y) => x.score - y.score);
  return out.slice(0, 8);
}

function findAlignment(bits, w, h, ex, ey, size, allowance) {
  const r = Math.round(allowance * size);
  const x0 = Math.max(0, Math.round(ex - r)), x1 = Math.min(w - 1, Math.round(ex + r));
  const y0 = Math.max(0, Math.round(ey - r)), y1 = Math.min(h - 1, Math.round(ey + r));
  if (x1 - x0 < size * 3 || y1 - y0 < size * 3) return null;
  const dark = (x, y) => bits[y * w + x] === 1;
  const seen = [];
  const cross = s => { const v = size / 2; return Math.abs(size - s[0]) < v && Math.abs(size - s[1]) < v && Math.abs(size - s[2]) < v; };
  function checkVertical(startY, cx, maxCount, orig) {
    const s = [0, 0, 0];
    let y = startY;
    while (y >= 0 && dark(cx, y) && s[1] <= maxCount) { s[1]++; y--; }
    if (y < 0 || s[1] > maxCount) return NaN;
    while (y >= 0 && !dark(cx, y) && s[0] <= maxCount) { s[0]++; y--; }
    if (s[0] > maxCount) return NaN;
    y = startY + 1;
    while (y < h && dark(cx, y) && s[1] <= maxCount) { s[1]++; y++; }
    if (y === h || s[1] > maxCount) return NaN;
    while (y < h && !dark(cx, y) && s[2] <= maxCount) { s[2]++; y++; }
    if (s[2] > maxCount) return NaN;
    const total = s[0] + s[1] + s[2];
    if (5 * Math.abs(total - orig) >= 2 * orig) return NaN;
    return cross(s) ? y - s[2] - s[1] / 2 : NaN;
  }
  function handle(s, y, xEnd) {
    const total = s[0] + s[1] + s[2], cx = xEnd - s[2] - s[1] / 2;
    const cy = checkVertical(y, Math.floor(cx), 2 * s[1], total);
    if (isNaN(cy)) return null;
    const est = total / 3;
    for (const c of seen) {
      if (Math.abs(cy - c.y) <= est && Math.abs(cx - c.x) <= est && (Math.abs(est - c.size) <= 1 || Math.abs(est - c.size) <= c.size)) {
        return { x: (c.x + cx) / 2, y: (c.y + cy) / 2 };
      }
    }
    seen.push({ x: cx, y: cy, size: est });
    return null;
  }
  const mid = Math.round((y0 + y1) / 2), rows = y1 - y0 + 1;
  for (let k = 0; k < rows; k++) {
    const y = mid + ((k & 1) === 0 ? (k + 1) >> 1 : -((k + 1) >> 1));
    if (y < y0 || y > y1) continue;
    const s = [0, 0, 0];
    let x = x0, state = 0;
    while (x <= x1 && !dark(x, y)) x++;
    for (; x <= x1; x++) {
      if (dark(x, y)) {
        if (state === 1) s[1]++;
        else if (state === 2) {
          if (cross(s)) { const c = handle(s, y, x); if (c) return c; }
          s[0] = s[2]; s[1] = 1; s[2] = 0; state = 1;
        } else { state++; s[state]++; }
      } else {
        if (state === 1) state++;
        s[state]++;
      }
    }
    if (cross(s)) { const c = handle(s, y, x1 + 1); if (c) return c; }
  }
  return seen.length ? { x: seen[0].x, y: seen[0].y } : null;
}

/* Finds the bottom-right alignment pattern by matching its whole 5x5 shape (dark center, light ring,
   dark ring) along the code's own axes. Data modules often contain the 1:1:1 runs a row scan looks
   for, so checking the full shape is what keeps it from locking onto the wrong spot. */
function alignByTemplate(bits, w, h, tl, tr, bl, dim, ex, ey) {
  const n = dim - 7;
  const ux = (tr.x - tl.x) / n, uyx = (tr.y - tl.y) / n, vx = (bl.x - tl.x) / n, vy = (bl.y - tl.y) / n;
  const msz = (Math.hypot(ux, uyx) + Math.hypot(vx, vy)) / 2;
  const score = (px, py, k) => {
    let s = 0;
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
      const x = Math.floor(px + k * (i * ux + j * vx)), y = Math.floor(py + k * (i * uyx + j * vy));
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if ((bits[y * w + x] === 1) === (Math.max(Math.abs(i), Math.abs(j)) !== 1)) s++;
    }
    return s;
  };
  let best = null;
  for (const radius of [5, 10]) {
    const R = radius * msz, step = Math.max(1, msz / 3);
    for (let dy = -R; dy <= R; dy += step) for (let dx = -R; dx <= R; dx += step) {
      for (const k of [1, 0.88, 1.12]) {
        const s = score(ex + dx, ey + dy, k), r = Math.hypot(dx, dy);
        if (!best || s > best.s || (s === best.s && r < best.r)) best = { s, x: ex + dx, y: ey + dy, k, r };
      }
    }
    if (best.s >= 24) break;
  }
  if (best.s < 22) return null;
  // Center of the spots that match best, at pixel steps around the winner.
  let sx = 0, sy = 0, cnt = 0, top = 0;
  const R2 = msz * 0.8;
  for (let dy = -R2; dy <= R2; dy += 1) for (let dx = -R2; dx <= R2; dx += 1) {
    const s = score(best.x + dx, best.y + dy, best.k);
    if (s > top) { top = s; sx = sy = cnt = 0; }
    if (s === top) { sx += best.x + dx; sy += best.y + dy; cnt++; }
  }
  return { x: sx / cnt, y: sy / cnt };
}

// The perspective transform that sends four points to four others.
function homography(src, dst) {
  const M = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i], [x, y] = dst[i];
    M.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    M.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-10) return null;
    const t = M[c]; M[c] = M[p]; M[p] = t;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k < 9; k++) M[r][k] -= f * M[c][k];
    }
  }
  const H = M.map((row, i) => row[8] / row[i]);
  return (u, v) => { const d = H[6] * u + H[7] * v + 1; return [(H[0] * u + H[1] * v + H[2]) / d, (H[3] * u + H[4] * v + H[5]) / d]; };
}
function sample(bits, w, h, map, dim) {
  const grid = [];
  for (let y = 0; y < dim; y++) {
    const row = new Array(dim);
    for (let x = 0; x < dim; x++) {
      const p = map(x + 0.5, y + 0.5);
      let ix = Math.floor(p[0]), iy = Math.floor(p[1]);
      if (!(ix >= -2 && iy >= -2 && ix <= w + 1 && iy <= h + 1)) return null;
      ix = Math.min(w - 1, Math.max(0, ix)); iy = Math.min(h - 1, Math.max(0, iy));
      row[x] = bits[iy * w + ix] === 1;
    }
    grid.push(row);
  }
  return grid;
}
const transpose = g => g.map((row, y) => row.map((_, x) => g[x][y]));

/* Module size measured along the line from one finder center toward another (black, white, black
   runs both ways), as ZXing does. Row-based run lengths overstate it when the code is rotated. */
function runBWB(bits, w, h, fromX, fromY, toX, toY) {
  const steep = Math.abs(toY - fromY) > Math.abs(toX - fromX);
  if (steep) { let t = fromX; fromX = fromY; fromY = t; t = toX; toX = toY; toY = t; }
  const dx = Math.abs(toX - fromX), dy = Math.abs(toY - fromY), xstep = fromX < toX ? 1 : -1, ystep = fromY < toY ? 1 : -1;
  let error = -dx / 2, state = 0;
  const xLimit = toX + xstep;
  for (let x = fromX, y = fromY; x !== xLimit; x += xstep) {
    const rx = steep ? y : x, ry = steep ? x : y;
    if (rx < 0 || ry < 0 || rx >= w || ry >= h) break;
    if ((state === 1) === (bits[ry * w + rx] === 1)) {
      if (state === 2) return Math.hypot(x - fromX, y - fromY);
      state++;
    }
    error += dy;
    if (error > 0) { if (y === toY) break; y += ystep; error -= dx; }
  }
  return state === 2 ? Math.hypot(toX + xstep - fromX, toY - fromY) : NaN;
}
function runBWBBothWays(bits, w, h, fromX, fromY, toX, toY) {
  let result = runBWB(bits, w, h, fromX, fromY, toX, toY);
  let scale = 1, otherX = fromX - (toX - fromX);
  if (otherX < 0) { scale = fromX / (fromX - otherX); otherX = 0; }
  else if (otherX >= w) { scale = (w - 1 - fromX) / (otherX - fromX); otherX = w - 1; }
  let otherY = Math.floor(fromY - (toY - fromY) * scale);
  scale = 1;
  if (otherY < 0) { scale = fromY / (fromY - otherY); otherY = 0; }
  else if (otherY >= h) { scale = (h - 1 - fromY) / (otherY - fromY); otherY = h - 1; }
  otherX = Math.floor(fromX + (otherX - fromX) * scale);
  result += runBWB(bits, w, h, fromX, fromY, otherX, otherY);
  return result - 1;
}
function moduleSizeOneWay(bits, w, h, a, b) {
  const e1 = runBWBBothWays(bits, w, h, Math.floor(a.x), Math.floor(a.y), Math.floor(b.x), Math.floor(b.y));
  const e2 = runBWBBothWays(bits, w, h, Math.floor(b.x), Math.floor(b.y), Math.floor(a.x), Math.floor(a.y));
  if (isNaN(e1)) return e2 / 7;
  if (isNaN(e2)) return e1 / 7;
  return (e1 + e2) / 14;
}
function moduleSize(bits, w, h, t) {
  const a = moduleSizeOneWay(bits, w, h, t.tl, t.tr), b = moduleSizeOneWay(bits, w, h, t.tl, t.bl);
  if (isNaN(a)) return isNaN(b) ? t.size : b;
  if (isNaN(b)) return a;
  return (a + b) / 2;
}

function readTriple(bits, w, h, t) {
  const { tl, tr, bl } = t;
  const size = moduleSize(bits, w, h, t);
  if (!(size >= 1)) return null;
  const est = (Math.round(dist(tl, tr) / size) + Math.round(dist(tl, bl) / size)) / 2 + 7;
  const dims = [];
  for (let v = 1; v <= MAX_VER; v++) dims.push(v * 4 + 17);
  dims.sort((a, b) => Math.abs(a - est) - Math.abs(b - est));
  for (const dim of dims.slice(0, 3)) {
    if (Math.abs(dim - est) > Math.max(6, est * 0.2)) continue;
    const brx = tr.x - tl.x + bl.x, bry = tr.y - tl.y + bl.y;
    const maps = [];
    if (dim > 21) {
      const corr = 1 - 3 / (dim - 7);
      const ex = tl.x + corr * (brx - tl.x), ey = tl.y + corr * (bry - tl.y);
      const viaAp = ap => homography([[3.5, 3.5], [dim - 3.5, 3.5], [dim - 6.5, dim - 6.5], [3.5, dim - 3.5]], [[tl.x, tl.y], [tr.x, tr.y], [ap.x, ap.y], [bl.x, bl.y]]);
      const ap = alignByTemplate(bits, w, h, tl, tr, bl, dim, ex, ey);
      if (ap) { const m = viaAp(ap); if (m) maps.push(m); }
      for (const allow of [4, 8, 16]) {
        const ap2 = findAlignment(bits, w, h, ex, ey, size, allow);
        if (ap2) {
          if (!ap || Math.hypot(ap2.x - ap.x, ap2.y - ap.y) > size) { const m = viaAp(ap2); if (m) maps.push(m); }
          break;
        }
      }
    }
    const flat = homography([[3.5, 3.5], [dim - 3.5, 3.5], [dim - 3.5, dim - 3.5], [3.5, dim - 3.5]], [[tl.x, tl.y], [tr.x, tr.y], [brx, bry], [bl.x, bl.y]]);
    if (flat) maps.push(flat);
    for (const map of maps) {
      const grid = sample(bits, w, h, map, dim);
      if (!grid) continue;
      const text = decodeGrid(grid);
      if (text != null) return text;
      const mirrored = decodeGrid(transpose(grid));
      if (mirrored != null) return mirrored;
    }
  }
  return null;
}

/* Finds and reads a QR code in an RGBA image (a canvas ImageData's data). Returns the text, or null. */
export function scanImage(rgba, w, h) {
  if (w < 40 || h < 40) return null;
  const gray = toGray(rgba, w, h);
  // First as is; then softened a little, which calms screen moire and JPEG noise.
  for (const g of [gray, null]) {
    const bits = binarize(g || smooth(gray, w, h), w, h);
    for (const t of triples(finderCandidates(bits, w, h))) {
      const text = readTriple(bits, w, h, t);
      if (text != null) return text;
    }
  }
  return null;
}
function smooth(gray, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : y, y1 = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : x, x1 = x < w - 1 ? x + 1 : x;
      out[y * w + x] = (gray[y0 * w + x0] + gray[y0 * w + x] + gray[y0 * w + x1] + gray[y * w + x0] + gray[y * w + x] + gray[y * w + x1] + gray[y1 * w + x0] + gray[y1 * w + x] + gray[y1 * w + x1]) / 9;
    }
  }
  return out;
}

// For tests: the steps of scanImage, one by one.
export const _internals = { toGray, binarize, finderCandidates, triples, readTriple, findAlignment, homography, sample, layout };
