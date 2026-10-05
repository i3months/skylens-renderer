// 드레이프 층 apply 재구성 시험(F-403 ②③).
// (a) 새 apply(검사 없는 내부 경로)가 화소마다 pixelToEnu → store.lookup → sampleDrape → shadeRatio/applyRatio 를
//     직접 부르는 느린 참조와 color 바이트 동일한지 본다. 카메라: 연직(타일 경계에 화소 중심이 정확히 놓임)·비스듬·기운 시점.
//     sampleDrape 를 쓰는 참조는 mask 가 모두 > 0 인 타일만 쓴다(mask 0 칸 규칙은 F-402 로 바뀌는 중).
//     mask 0 칸이 있는 타일은 F-402 새 규칙을 이 파일 안에서 직접 구현한 참조와 비교한다.
// (b) 프레임 첫머리 검증: terrain 길이·baseRgb 는 타일이 없어도 즉시 RangeError. depth 의 NaN·Infinity 화소는 건너뛴다.
// (c) terrain 은 바뀌지 않고 depth·index 는 같은 배열 참조, color 만 새 배열.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDrapeLayer } from './index.mjs';
import { createDrapeStore } from './store.mjs';
import { pixelToEnu, pixelToEnuInto, prepareUnproject } from './unproject.mjs';
import { sampleDrape } from './sample.mjs';
import { sampleDrapeInto, prepareDrapeSampler, sampleDrapePrepared } from './sample_into.mjs';
import { shadeRatio, applyRatio, shadeRatioAt, applyRatioInto, shadeRatioTable, shadeLut } from './shade.mjs';
import { TERRAIN_DEFAULTS } from '../../../contracts/controlview/terrain.mjs';
import { mulberry32 } from '../terrain/fixtures.mjs';

// ---- 장면 ----

/** OpenCV 축 카메라: 위치 C 에서 target 을 본다. R 행 = [오른쪽; 아래; 앞], t = −R·C. */
function lookAt(width, height, f, C, target, up = [0, 0, 1]) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
  const fwd = norm(sub(target, C));
  const right = norm(cross(fwd, up));
  const down = cross(fwd, right);
  const R = [...right, ...down, ...fwd];
  const t = [0, 1, 2].map((r) => -(R[r * 3] * C[0] + R[r * 3 + 1] * C[1] + R[r * 3 + 2] * C[2]));
  return { width, height, K: { fx: f, fy: f, cx: width / 2, cy: height / 2 }, R, t };
}

/** 연직 카메라(R = diag(1, −1, −1)): 화소 중심의 ENU 가 정확한 수가 되도록 높이·초점을 고른다. */
function nadir(width, height, f, C) {
  const R = [1, 0, 0, 0, -1, 0, 0, 0, -1];
  return { width, height, K: { fx: f, fy: f, cx: width / 2, cy: height / 2 }, R, t: [-C[0], C[1], C[2]] };
}

/** 평면 z = 0 과 화소 중심 광선의 교점 깊이로 지형 결과를 만든다. 색은 무작위(빈 화소는 0). */
function terrainFor(camera, seed) {
  const { width, height, K, R, t } = camera;
  const n = width * height;
  const rnd = mulberry32(seed);
  const color = new Uint8Array(3 * n);
  const depth = new Float32Array(n);
  const index = new Int32Array(n).fill(-1);
  // C = −Rᵀ·t
  const Cz = -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const kx = (i + 0.5 - K.cx) / K.fx;
      const ky = (j + 0.5 - K.cy) / K.fy;
      const dz = R[2] * kx + R[5] * ky + R[8]; // (Rᵀ·k)_z
      const d = -Cz / dz;
      const p = j * width + i;
      if (!(d > 0) || !Number.isFinite(d) || d > 1e5) continue;
      depth[p] = d;
      index[p] = p;
      color[3 * p] = Math.floor(rnd() * 256);
      color[3 * p + 1] = Math.floor(rnd() * 256);
      color[3 * p + 2] = Math.floor(rnd() * 256);
    }
  }
  return { width, height, color, depth, index };
}

/** 드레이프 타일. maskZero 가 참이면 칸 일부의 mask 를 0 으로 둔다. */
function makeTile(tx, ty, width, height, seed, maskZero = false) {
  const rnd = mulberry32(seed);
  const n = width * height;
  const rgb = new Uint8Array(3 * n);
  for (let k = 0; k < rgb.length; k++) rgb[k] = Math.floor(rnd() * 256);
  const mask = new Uint8Array(n);
  for (let k = 0; k < n; k++) mask[k] = maskZero && rnd() < 0.3 ? 0 : 1 + Math.floor(rnd() * 255);
  return { tx, ty, mip: 0, width, height, rgb, coverage: { mask } };
}

/** 타일 묶음: [-128, 128]² 의 16 칸 중 (0, -1) 은 빼고(빈 구역), 크기는 칸마다 다르게(정사각 아님 포함). */
function makeTiles(maskZero = false) {
  const sizes = [[16, 16], [32, 8], [7, 13], [64, 64], [1, 1], [5, 3]];
  const tiles = [];
  let s = 0;
  for (let ty = -2; ty <= 1; ty++) {
    for (let tx = -2; tx <= 1; tx++) {
      if (tx === 0 && ty === -1) continue;
      const [w, h] = sizes[s % sizes.length];
      tiles.push(makeTile(tx, ty, w, h, 100 + s, maskZero));
      s++;
    }
  }
  return tiles;
}

// ---- 참조(느린 경로) ----

/** F-402 새 규칙을 이 파일 안에서 직접 구현한 표본(배열 반환, sample.mjs 와 코드 공유 없음). */
function sampleNewRule(tile, x, y) {
  const S = 64;
  const minX = tile.tx * S, maxX = (tile.tx + 1) * S, minY = tile.ty * S, maxY = (tile.ty + 1) * S;
  if (x < minX || x > maxX || y < minY || y > maxY) return null;
  const { width, height, rgb } = tile;
  const mask = tile.coverage.mask;
  const clamp = (a, lo, hi) => Math.min(hi, Math.max(lo, a));
  const ci = clamp(Math.floor((x - minX) / (S / width)), 0, width - 1);
  const cj = clamp(Math.floor((maxY - y) / (S / height)), 0, height - 1);
  if (!(mask[cj * width + ci] > 0)) return null;
  const u = (x - minX) / (S / width) - 0.5;
  const v = (maxY - y) / (S / height) - 0.5;
  const i0 = Math.floor(u), j0 = Math.floor(v);
  const fx = u - i0, fy = v - j0;
  const ii = [clamp(i0, 0, width - 1), clamp(i0 + 1, 0, width - 1)];
  const jj = [clamp(j0, 0, height - 1), clamp(j0 + 1, 0, height - 1)];
  const wx = [1 - fx, fx], wy = [1 - fy, fy];
  let r = 0, g = 0, b = 0, w = 0;
  for (let a = 0; a < 2; a++) {
    for (let c = 0; c < 2; c++) {
      const o = jj[a] * width + ii[c];
      if (!(mask[o] > 0)) continue;
      const k = wy[a] * wx[c];
      r += rgb[o * 3] * k; g += rgb[o * 3 + 1] * k; b += rgb[o * 3 + 2] * k; w += k;
    }
  }
  if (!(w > 0)) return null;
  const q = (s) => Math.min(255, Math.max(0, Math.round(s / w)));
  return [q(r), q(g), q(b)];
}

/** 화소마다 공개 함수를 그대로 부르는 참조 apply(color 만 돌려준다). */
function referenceColor(camera, terrain, tiles, { shade, baseRgb = TERRAIN_DEFAULTS.baseRgb, sample = sampleDrape }) {
  const store = createDrapeStore();
  store.accept(0, tiles);
  const { width, height } = camera;
  const color = terrain.color.slice();
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const p = j * width + i;
      const d = terrain.depth[p];
      if (!(Number.isFinite(d) && d > 0)) continue;
      const { x, y } = pixelToEnu(camera, i, j, d);
      const tile = store.lookup(x, y);
      if (!tile) continue;
      const rgb = sample(tile, x, y);
      if (!rgb) continue;
      const c = shade
        ? applyRatio(rgb, shadeRatio([terrain.color[3 * p], terrain.color[3 * p + 1], terrain.color[3 * p + 2]], baseRgb))
        : rgb;
      color[3 * p] = c[0]; color[3 * p + 1] = c[1]; color[3 * p + 2] = c[2];
    }
  }
  return color;
}

function countDiff(a, b) {
  let n = 0;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) n++;
  return n;
}

const CAMERAS = [
  // 연직: 화소 중심 ENU = 2·(i − 64), 2·(64 − j) → x, y = ±64, 0 경계에 화소 중심이 정확히 놓인다.
  ['nadir-boundary', nadir(129, 129, 16, [0, 0, 32])],
  ['nadir-offset', nadir(160, 90, 80, [-13.3, 21.7, 150])],
  ['oblique', lookAt(160, 90, 120, [-150, -140, 40], [10, 5, 0])],
  ['oblique-steep', lookAt(120, 100, 90, [60, 90, 120], [-20, -30, 0])],
  ['oblique-horizon', lookAt(200, 80, 150, [0, -120, 8], [0, 200, 0])],
];

// ---- (a) 참조와 바이트 동일 ----

for (const [name, camera] of CAMERAS) {
  for (const shade of [true, false]) {
    test(`apply == 참조(${name}, shade=${shade}, mask 모두 > 0)`, () => {
      const terrain = terrainFor(camera, 7);
      const tiles = makeTiles(false);
      const layer = createDrapeLayer({ shade });
      layer.accept(0, tiles);
      const out = layer.apply(camera, terrain);
      const ref = referenceColor(camera, terrain, tiles, { shade });
      assert.equal(countDiff(out.color, ref), 0);
      // 시험이 헛돌지 않도록: 실제로 드레이프된 화소가 있어야 한다.
      assert.ok(countDiff(out.color, terrain.color) > 0, '드레이프된 화소가 없다');
    });
  }
  test(`apply == 새 규칙 참조(${name}, mask 0 칸 포함)`, () => {
    const terrain = terrainFor(camera, 11);
    const tiles = makeTiles(true);
    const layer = createDrapeLayer();
    layer.accept(0, tiles);
    const out = layer.apply(camera, terrain);
    const ref = referenceColor(camera, terrain, tiles, { shade: true, sample: sampleNewRule });
    assert.equal(countDiff(out.color, ref), 0);
  });
}

test('apply == 참조: 사용자 baseRgb(평균 0 포함)', () => {
  const camera = CAMERAS[2][1];
  const terrain = terrainFor(camera, 3);
  const tiles = makeTiles(false);
  for (const baseRgb of [[90, 200, 10], [0, 0, 0], [255, 255, 255]]) {
    const layer = createDrapeLayer();
    layer.accept(0, tiles);
    const out = layer.apply(camera, terrain, { baseRgb });
    assert.equal(countDiff(out.color, referenceColor(camera, terrain, tiles, { shade: true, baseRgb })), 0, String(baseRgb));
  }
});

test('연직 경계 장면: 화소 중심이 타일 경계(x 또는 y = −64, 0, 64)에 놓인다', () => {
  const camera = CAMERAS[0][1];
  const xs = [];
  for (const i of [32, 64, 96]) xs.push(pixelToEnu(camera, i, 10, 32).x);
  assert.deepEqual(xs, [-64, 0, 64]);
});

// ---- 내부 경로 단위 동치 ----

test('pixelToEnuInto 는 pixelToEnu 와 비트 동일', () => {
  const rnd = mulberry32(5);
  const out = new Float64Array(3);
  for (const [, camera] of CAMERAS) {
    const coef = prepareUnproject(camera);
    for (let k = 0; k < 2000; k++) {
      const i = Math.floor(rnd() * camera.width);
      const j = Math.floor(rnd() * camera.height);
      const d = 0.01 + rnd() * 500;
      const e = pixelToEnu(camera, i, j, d);
      pixelToEnuInto(coef, i, j, d, out);
      assert.ok(Object.is(out[0], e.x) && Object.is(out[1], e.y) && Object.is(out[2], e.z));
    }
  }
});

test('sampleDrapeInto 는 mask 모두 > 0 이면 sampleDrape 와 같고, mask 0 칸이 있으면 새 규칙 참조와 같다', () => {
  const rnd = mulberry32(9);
  const buf = new Uint8Array(4).fill(77);
  for (const maskZero of [false, true]) {
    for (const tile of makeTiles(maskZero)) {
      for (let k = 0; k < 500; k++) {
        // 타일 바깥 약간까지 포함, 경계값도 섞는다.
        let x = tile.tx * 64 - 2 + rnd() * 68;
        let y = tile.ty * 64 - 2 + rnd() * 68;
        if (k % 25 === 0) x = tile.tx * 64;
        if (k % 25 === 1) y = (tile.ty + 1) * 64;
        const exp = maskZero ? sampleNewRule(tile, x, y) : sampleDrape(tile, x, y);
        buf.fill(77);
        const ok = sampleDrapeInto(tile, x, y, buf, 1);
        if (exp === null) {
          assert.equal(ok, false);
          assert.deepEqual([...buf], [77, 77, 77, 77]);
        } else {
          assert.equal(ok, true);
          assert.deepEqual([...buf.subarray(1)], exp);
          assert.equal(buf[0], 77);
        }
      }
    }
  }
});

test('shadeRatioAt·applyRatioInto 는 shadeRatio·applyRatio 와 같다', () => {
  const rnd = mulberry32(13);
  const color = new Uint8Array(6);
  const dst = new Uint8Array(3);
  for (let k = 0; k < 5000; k++) {
    for (let c = 0; c < 6; c++) color[c] = Math.floor(rnd() * 256);
    const base = k % 50 === 0 ? [0, 0, 0] : [rnd() * 255, rnd() * 255, rnd() * 255];
    const rr = shadeRatio([color[3], color[4], color[5]], base);
    const ra = shadeRatioAt(color, 3, base);
    assert.ok(Object.is(rr, ra));
    applyRatioInto(color, 0, ra, dst, 0);
    assert.deepEqual([...dst], applyRatio([color[0], color[1], color[2]], rr));
  }
});

test('shadeRatioTable·shadeLut 는 shadeRatio·applyRatio 와 같다(모든 채널 합·색 값)', () => {
  for (const base of [TERRAIN_DEFAULTS.baseRgb, [0, 0, 0], [255, 255, 255], [1, 0, 0], [12.5, 200.25, 3]]) {
    const table = shadeRatioTable(base);
    const lut = shadeLut(base);
    for (let sum = 0; sum <= 765; sum++) {
      const c0 = Math.min(255, sum), c1 = Math.min(255, sum - c0), c2 = sum - c0 - c1;
      const ratio = shadeRatio([c0, c1, c2], base);
      assert.ok(Object.is(table[sum], ratio), `${String(base)} ${sum}`);
      for (let c = 0; c < 256; c++) {
        if (lut[sum * 256 + c] !== applyRatio([c, c, c], ratio)[0]) assert.fail(`${String(base)} ${sum} ${c}`);
      }
    }
  }
});

test('sampleDrapePrepared 는 sampleDrapeInto 와 같다(2 의 거듭제곱 크기·아닌 크기)', () => {
  const rnd = mulberry32(17);
  const a = new Uint8Array(3), b = new Uint8Array(3);
  for (const maskZero of [false, true]) {
    for (const tile of [...makeTiles(maskZero), makeTile(3, -4, 128, 256, 5, maskZero), makeTile(-7, 2, 100, 48, 6, maskZero)]) {
      const sp = prepareDrapeSampler(tile);
      for (let k = 0; k < 2000; k++) {
        const x = tile.tx * 64 - 1 + rnd() * 66;
        const y = tile.ty * 64 - 1 + rnd() * 66;
        a.fill(0); b.fill(0);
        assert.equal(sampleDrapePrepared(sp, x, y, a, 0), sampleDrapeInto(tile, x, y, b, 0));
        assert.deepEqual(a, b);
      }
    }
  }
});

test('같은 층에서 baseRgb 를 바꿔 가며 불러도 매번 참조와 같다(음영 표 다시 만들기)', () => {
  const camera = CAMERAS[3][1];
  const terrain = terrainFor(camera, 41);
  const tiles = makeTiles(false);
  const layer = createDrapeLayer();
  layer.accept(0, tiles);
  for (const baseRgb of [[90, 200, 10], [90, 200, 10], [90, 200, 11], undefined, [0, 0, 0]]) {
    const out = layer.apply(camera, terrain, baseRgb ? { baseRgb } : undefined);
    const ref = referenceColor(camera, terrain, tiles, { shade: true, baseRgb: baseRgb ?? TERRAIN_DEFAULTS.baseRgb });
    assert.equal(countDiff(out.color, ref), 0, String(baseRgb));
  }
});

// ---- (b) 프레임 첫머리 검증 ----

test('terrain 길이가 틀리면 타일이 없어도 RangeError', () => {
  const camera = nadir(4, 3, 4, [0, 0, 10]);
  const good = () => ({ width: 4, height: 3, color: new Uint8Array(36), depth: new Float32Array(12), index: new Int32Array(12) });
  const layer = createDrapeLayer();
  assert.equal(layer.state().tileCount, 0);
  assert.doesNotThrow(() => layer.apply(camera, good()));
  assert.throws(() => layer.apply(camera, { ...good(), depth: new Float32Array(3) }), RangeError);
  assert.throws(() => layer.apply(camera, { ...good(), color: new Uint8Array(12) }), RangeError);
  assert.throws(() => layer.apply(camera, { ...good(), color: new Array(36).fill(0) }), RangeError);
  assert.throws(() => layer.apply(camera, { ...good(), index: new Int32Array(11) }), RangeError);
  assert.throws(() => layer.apply(camera, { ...good(), width: 5 }), RangeError);
  assert.throws(() => layer.apply(camera, null), RangeError);
  // 타일이 있어도 같다.
  const withTiles = createDrapeLayer();
  withTiles.accept(0, makeTiles());
  assert.throws(() => withTiles.apply(camera, { ...good(), depth: new Float32Array(3) }), RangeError);
});

test('baseRgb 가 틀리면 타일이 없어도(shade 끔이어도) RangeError', () => {
  const camera = nadir(4, 3, 4, [0, 0, 10]);
  const terrain = { width: 4, height: 3, color: new Uint8Array(36), depth: new Float32Array(12), index: new Int32Array(12) };
  for (const shade of [true, false]) {
    const layer = createDrapeLayer({ shade });
    for (const baseRgb of [[1, 2], [NaN, 0, 0], [0, Infinity, 0], [1, 2, 3, 4], [0, 0, 256], [0, -1, 0], 'abc']) {
      assert.throws(() => layer.apply(camera, terrain, { baseRgb }), RangeError, `${shade} ${String(baseRgb)}`);
    }
  }
});

test('depth 에 NaN·Infinity 화소가 섞여도 던지지 않고 나머지 화소는 드레이프된다', () => {
  const camera = CAMERAS[1][1];
  const terrain = terrainFor(camera, 21);
  const bad = [5, 17, 1000, 7000];
  terrain.depth[bad[0]] = NaN;
  terrain.depth[bad[1]] = Infinity;
  terrain.depth[bad[2]] = -Infinity;
  terrain.depth[bad[3]] = NaN;
  const tiles = makeTiles(false);
  const layer = createDrapeLayer();
  layer.accept(0, tiles);
  let out;
  assert.doesNotThrow(() => { out = layer.apply(camera, terrain); });
  assert.equal(countDiff(out.color, referenceColor(camera, terrain, tiles, { shade: true })), 0);
  for (const p of bad) assert.deepEqual([...out.color.subarray(3 * p, 3 * p + 3)], [...terrain.color.subarray(3 * p, 3 * p + 3)]);
  assert.ok(countDiff(out.color, terrain.color) > camera.width * camera.height, '나머지 화소가 드레이프되지 않았다');
});

// ---- (c) 출력 형태 ----

test('terrain 은 바뀌지 않고 depth·index 는 같은 배열, color 는 새 배열', () => {
  const camera = CAMERAS[2][1];
  const terrain = terrainFor(camera, 31);
  const snap = { color: terrain.color.slice(), depth: terrain.depth.slice(), index: terrain.index.slice() };
  for (const filled of [false, true]) {
    const layer = createDrapeLayer();
    if (filled) layer.accept(0, makeTiles());
    const out = layer.apply(camera, terrain);
    assert.equal(out.width, camera.width);
    assert.equal(out.height, camera.height);
    assert.equal(out.depth, terrain.depth);
    assert.equal(out.index, terrain.index);
    assert.notEqual(out.color, terrain.color);
    assert.ok(out.color instanceof Uint8Array);
    assert.deepEqual(terrain.color, snap.color);
    assert.deepEqual(terrain.depth, snap.depth);
    assert.deepEqual(terrain.index, snap.index);
    if (!filled) assert.deepEqual(out.color, snap.color);
  }
});
