// 드레이프 mask 0 시험(F-402): mask 0 화소 칸 안은 이웃 위성 색으로 메우지 않고 null(지형 색 그대로).
// 기준값은 숫자로 박았다. 옛 규칙(재정규화로만 판정)을 흉내 낸 함수가 같은 입력에서 null 이 아님을 보여 변이를 잡는다는 증거로 둔다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleDrape } from './sample.mjs';
import { createDrapeLayer } from './index.mjs';
import { DRAPE_ALIGN_MAX_PX } from '../../../contracts/controlview/drape.mjs';
import { ALIGN_TOLERANCE_PX } from '../../../contracts/tower_assets/index.mjs';

function makeTile(w, h, rgbFn, maskFn) {
  const rgb = new Uint8Array(w * h * 3);
  const mask = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const o = j * w + i;
    const c = rgbFn(i, j);
    rgb[o * 3] = c[0]; rgb[o * 3 + 1] = c[1]; rgb[o * 3 + 2] = c[2];
    mask[o] = maskFn(i, j);
  }
  return { tx: 0, ty: 0, mip: 0, width: w, height: h, rgb, coverage: { complete: false, fraction: 1 - 1 / (w * h), mask, bounds: { minX: 0, minY: 0, maxX: 64, maxY: 64 } } };
}

// 옛 규칙: 칸 검사 없이 mask>0 이웃만 가중해 재정규화(4 이웃이 모두 0 일 때만 null).
function oldSample(tile, x, y) {
  const { width, height, rgb } = tile;
  const mask = tile.coverage.mask;
  const u = x / (64 / width) - 0.5, v = (64 - y) / (64 / height) - 0.5;
  const i0 = Math.floor(u), j0 = Math.floor(v), fx = u - i0, fy = v - j0;
  const ci = (i) => Math.min(width - 1, Math.max(0, i));
  const cj = (j) => Math.min(height - 1, Math.max(0, j));
  let r = 0, g = 0, b = 0, w = 0;
  for (const [dj, wy] of [[0, 1 - fy], [1, fy]]) for (const [di, wx] of [[0, 1 - fx], [1, fx]]) {
    const o = cj(j0 + dj) * width + ci(i0 + di);
    if (!(mask[o] > 0)) continue;
    const k = wy * wx;
    r += rgb[o * 3] * k; g += rgb[o * 3 + 1] * k; b += rgb[o * 3 + 2] * k; w += k;
  }
  return w > 0 ? [Math.round(r / w), Math.round(g / w), Math.round(b / w)] : null;
}

test('(a) 8x8 타일 (3,3) 화소 칸 안 20x20 격자 400 표본이 모두 null, 칸 밖은 [200,200,200]', () => {
  // 화소 8 m. 화소 (3,3) 칸: x∈[24,32), y: maxY−y∈[24,32) 이므로 y∈(32,40].
  const t = makeTile(8, 8, (i, j) => (i === 3 && j === 3 ? [0, 0, 0] : [200, 200, 200]), (i, j) => (i === 3 && j === 3 ? 0 : 1));
  let n = 0, oldNonNull = 0;
  for (let a = 0; a < 20; a++) for (let b = 0; b < 20; b++) {
    const x = 24 + (a + 0.5) * 0.4;
    const y = 32 + (b + 0.5) * 0.4;
    assert.equal(sampleDrape(t, x, y), null, `(${x}, ${y})`);
    if (oldSample(t, x, y) !== null) oldNonNull++;
    n++;
  }
  assert.equal(n, 400);
  // (d) 변이 시험: 옛 규칙은 같은 400 표본을 이웃 색으로 채운다(null 이 아니다).
  assert.equal(oldNonNull, 400);
  // 칸 바로 밖
  for (const [x, y] of [[23.99, 36], [32, 36], [28, 32], [28, 40.01], [16, 48], [40, 24]]) {
    assert.deepEqual(sampleDrape(t, x, y), [200, 200, 200], `(${x}, ${y})`);
  }
});

test('(b) 4x4 타일 mask 0 열 안은 모두 null', () => {
  // 화소 16 m. x=8.1·12·15.9 는 모두 열 i=0(x∈[0,16)) 안이고, 그 열을 mask 0 으로 둔다.
  const t = makeTile(4, 4, (i) => [100 + 10 * i, 50, 50], (i) => (i === 0 ? 0 : 255));
  for (const y of [4, 20, 40, 60]) for (const x of [8.1, 12, 15.9]) assert.equal(sampleDrape(t, x, y), null, `(${x}, ${y})`);
  assert.notEqual(oldSample(t, 12, 20), null);
});

test('(c) 드레이프 층: mask 0 칸의 화면 화소는 지형 색 그대로, 나머지는 위성 색', () => {
  const N = 64, H = 100;
  // 연직 카메라: 영상 오른쪽 = 동, 아래 = 남. 지면 1 m/px, 중심 ENU (32, 32) -> 화소 (i, j) 중심 x = i+0.5, y = 64−(j+0.5).
  const f = H / 1;
  const cam = { width: N, height: N, K: { fx: f, fy: f, cx: N / 2, cy: N / 2 }, R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [-32, 32, H] };
  const terrain = { width: N, height: N, color: new Uint8Array(N * N * 3), depth: new Float32Array(N * N).fill(H), index: new Int32Array(N * N) };
  for (let p = 0; p < N * N; p++) { terrain.color[p * 3] = 50; terrain.color[p * 3 + 1] = 60; terrain.color[p * 3 + 2] = 70; }
  // 8x8 타일(화소 8 m): (3,3) 칸 = x∈[24,32), y∈(32,40] = 화면 i∈[24,32), j∈[24,32).
  const tile = makeTile(8, 8, (i, j) => (i === 3 && j === 3 ? [0, 0, 0] : [200, 150, 100]), (i, j) => (i === 3 && j === 3 ? 0 : 255));
  const layer = createDrapeLayer({ shade: false });
  assert.equal(layer.accept(0, [tile]), 'first');
  const before = terrain.color.slice();
  const out = layer.apply(cam, terrain);
  assert.deepEqual(terrain.color, before);
  let masked = 0, sat = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const p = (j * N + i) * 3;
    const got = [out.color[p], out.color[p + 1], out.color[p + 2]];
    if (i >= 24 && i < 32 && j >= 24 && j < 32) { assert.deepEqual(got, [50, 60, 70], `(${i}, ${j})`); masked++; }
    else { assert.deepEqual(got, [200, 150, 100], `(${i}, ${j})`); sat++; }
  }
  assert.equal(masked, 64);
  assert.equal(sat, N * N - 64);
});

test('정합 허용 상수는 tower_assets 의 ALIGN_TOLERANCE_PX 와 같은 값', () => {
  assert.equal(DRAPE_ALIGN_MAX_PX, ALIGN_TOLERANCE_PX);
});
