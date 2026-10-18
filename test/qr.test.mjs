/* The QR encoder and camera decoder. Synthetic frames: rotated, tilted, scaled, blurred and noisy
   codes, plus frames with no code, which must never produce a reading. */
import test from "node:test";
import assert from "node:assert/strict";
import { encode, decodeGrid, scanImage, rsCorrect } from "../site/js/qr.js";

function rng(seed) { let x = seed; return () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; }

test("every length round-trips through the module grid", () => {
  for (let len = 1; len <= 300; len += 3) {
    const s = Array.from({ length: len }, (_, i) => "AZaz09-_.é"[(i * 7 + len) % 10]).join("");
    assert.equal(decodeGrid(encode(s).modules), s, "length " + len);
  }
});

test("Reed-Solomon fixes up to half the error-correction codewords", () => {
  const r = rng(3);
  for (let t = 0; t < 200; t++) {
    const text = "CC1.k7f3qx." + t + ".Zm9vYmFyYmF6cXV4cXV1eA";
    const grid = encode(text).modules.map(row => row.slice());
    // Flip a cluster of modules in the data area (a smudge); error correction should absorb it.
    const size = grid.length, cx = 10 + Math.floor(r() * (size - 20)), cy = 10 + Math.floor(r() * (size - 20));
    for (let y = cy; y < cy + 2; y++) for (let x = cx; x < cx + 2; x++) grid[y][x] = !grid[y][x];
    assert.equal(decodeGrid(grid), text);
  }
  assert.equal(rsCorrect([1, 2, 3], 2), null);
});

// Draw a code into a gray frame through a perspective warp, with blur and noise.
function frame(text, r, { W = 640, H = 480, blur = true } = {}) {
  const m = encode(text).modules, n = m.length + 8;
  const qw = 140 + r() * 220, th = (r() - 0.5) * 2 * Math.PI, cx = W / 2 + (r() - 0.5) * 120, cy = H / 2 + (r() - 0.5) * 80;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
    const x = (u * qw) / 2, y = (v * qw) / 2;
    return [cx + x * Math.cos(th) - y * Math.sin(th) + (r() - 0.5) * 0.16 * qw, cy + x * Math.sin(th) + y * Math.cos(th) + (r() - 0.5) * 0.16 * qw];
  });
  const inv = homography(corners, [[0, 0], [n, 0], [n, n], [0, n]]);
  const g = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let acc = 0;
    for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const [u, v] = inv(x + dx, y + dy);
      const mx = Math.floor(u) - 4, my = Math.floor(v) - 4;
      const inside = u >= 0 && v >= 0 && u < n && v < n;
      acc += !inside ? 90 + 60 * Math.sin(x / 37) * Math.cos(y / 23) : mx >= 0 && my >= 0 && mx < m.length && my < m.length && m[my][mx] ? 25 : 235;
    }
    g[y * W + x] = acc / 4;
  }
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = g[y * W + x];
    if (blur && x > 0 && y > 0 && x < W - 1 && y < H - 1) v = (v * 4 + g[y * W + x - 1] + g[y * W + x + 1] + g[(y - 1) * W + x] + g[(y + 1) * W + x]) / 8;
    v += (r() - 0.5) * 24;
    const i = (y * W + x) * 4;
    out[i] = out[i + 1] = out[i + 2] = v; out[i + 3] = 255;
  }
  return out;
}
function homography(src, dst) {
  const M = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i], [x, y] = dst[i];
    M.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x], [0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 8; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k < 9; k++) M[r][k] -= f * M[c][k]; }
  }
  const H = M.map((row, i) => row[8] / row[i]);
  return (u, v) => { const d = H[6] * u + H[7] * v + 1; return [(H[0] * u + H[1] * v + H[2]) / d, (H[3] * u + H[4] * v + H[5]) / d]; };
}

test("reads credentials from rotated, tilted, blurred, noisy frames", () => {
  const r = rng(11);
  let ok = 0;
  const n = 40;
  for (let i = 0; i < n; i++) {
    const text = "CC1." + Math.floor(r() * 1e9).toString(36) + "." + (1 + (i % 3)) + ".AbCdEfGhIjKlMnOpQrStUv";
    const got = scanImage(frame(text, r), 640, 480);
    if (got === text) ok++;
    else assert.equal(got, null, "a wrong reading is never acceptable");
  }
  assert.ok(ok >= n * 0.9, ok + " of " + n + " read");
});

test("frames without a code give no reading", () => {
  const r = rng(5);
  for (let i = 0; i < 20; i++) {
    const W = 320, H = 240, out = new Uint8ClampedArray(W * H * 4);
    for (let p = 0; p < W * H; p++) {
      const x = p % W, y = Math.floor(p / W);
      const v = 128 + 80 * Math.sin(x / (3 + i)) * Math.cos(y / (5 + i)) + (r() - 0.5) * 60;
      out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = v; out[p * 4 + 3] = 255;
    }
    assert.equal(scanImage(out, W, H), null);
  }
});
