// 근평면 자르기(clip) 시험. 교점 수치는 손으로 계산해 박는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipPolyline } from './clip.mjs';

// 단순 카메라: R = 단위행렬, t = 0. X_c = X_w.
const ID_VIEW = { width: 100, height: 80, K: { fx: 100, fy: 100, cx: 50, cy: 40 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
// 북쪽을 보는 카메라: x_c = 동, y_c = −위, z_c = 북. 카메라 위치 ENU (0, −10, 5) → t = −R·pos = [0, 5, 10].
const NORTH_VIEW = { width: 640, height: 480, K: { fx: 200, fy: 200, cx: 320, cy: 240 }, R: [1, 0, 0, 0, 0, -1, 0, 1, 0], t: [0, 5, 10] };

function near(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
}
function pt(p, u, v, depth, msg) {
  near(p.u, u, 1e-9, `${msg} u`);
  near(p.v, v, 1e-9, `${msg} v`);
  near(p.depth, depth, 1e-12, `${msg} depth`);
}

test('clip: 선분이 근평면을 가로지르면 교점에서 자른다', () => {
  // A 깊이 −1, B 깊이 3, nearM 1 → s = (1−(−1))/(3−(−1)) = 0.5, P = (2, 1, 1).
  // P: u = 100·2/1 + 50 = 250, v = 100·1/1 + 40 = 140. B: u = 100·3/3 + 50 = 150, v = 40.
  const r = clipPolyline(ID_VIEW, [[1, 2, -1], [3, 0, 3]], 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].length, 2);
  pt(r[0][0], 250, 140, 1, '교점');
  assert.equal(r[0][0].depth, 1);
  pt(r[0][1], 150, 40, 3, 'B');
});

test('clip: 회전 카메라에서도 교점에서 자른다', () => {
  // A=(2,−12,5) → X_c=(2,0,−2), B=(2,−6,1) → X_c=(2,4,4). nearM 1 → s = 3/6 = 0.5, P_c = (2,2,1).
  // P: u = 200·2 + 320 = 720, v = 200·2 + 240 = 640. B: u = 200·2/4 + 320 = 420, v = 200·4/4 + 240 = 440.
  const r = clipPolyline(NORTH_VIEW, [[2, -12, 5], [2, -6, 1]], 1);
  // 거꾸로 B→A 로 지나가면 나가는 쪽 교점이 같다(아래).
  assert.equal(r.length, 1);
  pt(r[0][0], 720, 640, 1, '교점');
  pt(r[0][1], 420, 440, 4, 'B');
  const back = clipPolyline(NORTH_VIEW, [[2, -6, 1], [2, -12, 5]], 1);
  assert.equal(back.length, 1);
  pt(back[0][0], 420, 440, 4, 'B');
  pt(back[0][1], 720, 640, 1, '교점');
});

test('clip: 전부 뒤에 있으면 polyline 이 없다', () => {
  assert.deepEqual(clipPolyline(ID_VIEW, [[0, 0, -1], [5, 5, -3], [1, 1, 0.5], [0, 0, 0]], 1), []);
  assert.deepEqual(clipPolyline(NORTH_VIEW, [[0, -20, 0], [3, -15, 2]], 0.1), []);
});

test('clip: 전부 앞에 있으면 polyline 하나이고 점 수가 그대로다', () => {
  const r = clipPolyline(ID_VIEW, [[0, 0, 2], [2, 0, 2], [2, 4, 4], [-1, -1, 1]], 0.1);
  assert.equal(r.length, 1);
  assert.equal(r[0].length, 4);
  pt(r[0][0], 50, 40, 2, '0');
  pt(r[0][1], 150, 40, 2, '1');
  pt(r[0][2], 100, 140, 4, '2');
  pt(r[0][3], -50, -60, 1, '3(화면 밖도 자르지 않는다)');
});

test('clip: 들어왔다 나갔다 다시 들어오면 polyline 이 여러 개다', () => {
  // 깊이 2 → −2 → 2 → −2 → 2, nearM 1. 교점은 각 선분의 s = 0.25(나갈 때) 또는 0.75(들어올 때).
  const pts = [[0, 0, 2], [4, 0, -2], [8, 0, 2], [12, 0, -2], [16, 0, 2]];
  const r = clipPolyline(ID_VIEW, pts, 1);
  assert.equal(r.length, 3);
  // 첫 조각: (0,0,2) → s=0.25 → (1,0,1)
  pt(r[0][0], 50, 40, 2, 'a0');
  pt(r[0][1], 150, 40, 1, 'a1');
  // 둘째: s=0.75 → (7,0,1), (8,0,2), s=0.25 → (9,0,1)
  assert.equal(r[1].length, 3);
  pt(r[1][0], 750, 40, 1, 'b0');
  pt(r[1][1], 450, 40, 2, 'b1');
  pt(r[1][2], 950, 40, 1, 'b2');
  // 셋째: (15,0,1), (16,0,2)
  pt(r[2][0], 1550, 40, 1, 'c0');
  pt(r[2][1], 850, 40, 2, 'c1');
});

test('clip: dA 가 정확히 nearM 이면 교점 중복 점이 없다', () => {
  // (0,0,3) → (1,0,1) → (2,0,−1), nearM 1. 나가는 교점은 (1,0,1) 자신이다.
  const r = clipPolyline(ID_VIEW, [[0, 0, 3], [1, 0, 1], [2, 0, -1]], 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].length, 2);
  pt(r[0][0], 50, 40, 3, 'A');
  pt(r[0][1], 150, 40, 1, '경계');
});

test('clip: dB 가 정확히 nearM 이면 교점 중복 점이 없다', () => {
  // (0,0,−1) → (1,0,1) → (2,0,3), nearM 1. 들어오는 교점은 (1,0,1) 자신이다.
  const r = clipPolyline(ID_VIEW, [[0, 0, -1], [1, 0, 1], [2, 0, 3]], 1);
  assert.equal(r.length, 1);
  assert.equal(r[0].length, 2);
  pt(r[0][0], 150, 40, 1, '경계');
  pt(r[0][1], 200 / 3 + 50, 40, 3, 'C'); // u = 100·2/3 + 50
});

test('clip: 근평면에 한 점만 닿고 나가면 점 1개짜리 구간이라 버린다', () => {
  assert.deepEqual(clipPolyline(ID_VIEW, [[0, 0, -1], [0, 0, 1], [0, 0, -1]], 1), []);
});

test('clip: dA == dB 이면 0 나누기 없이 통째로 남기거나 버린다', () => {
  const on = clipPolyline(ID_VIEW, [[0, 0, 1], [1, 0, 1]], 1);
  assert.equal(on.length, 1);
  pt(on[0][0], 50, 40, 1, '0');
  pt(on[0][1], 150, 40, 1, '1');
  assert.deepEqual(clipPolyline(ID_VIEW, [[0, 0, -2], [5, 0, -2]], 1), []);
  const front = clipPolyline(ID_VIEW, [[0, 0, 4], [4, 0, 4]], 1);
  assert.equal(front.length, 1);
  pt(front[0][1], 150, 40, 4, '평행 앞');
});

test('clip: 점 0개·1개 입력은 polyline 이 없다', () => {
  assert.deepEqual(clipPolyline(ID_VIEW, [], 1), []);
  assert.deepEqual(clipPolyline(ID_VIEW, [[0, 0, 5]], 1), []);
  assert.deepEqual(clipPolyline(ID_VIEW, [[0, 0, -5]], 1), []);
});

test('clip: 투영이 넘치는 점에서 polyline 을 끊고 던지지 않는다', () => {
  // (1e308,0,1): u = 100·1e308 = 무한. 그 점을 빼고 앞뒤로 나눈다.
  const pts = [[0, 0, 2], [0, 0, 3], [1e308, 0, 1], [0, 0, 4], [4, 0, 4]];
  const r = clipPolyline(ID_VIEW, pts, 0.5);
  assert.equal(r.length, 2);
  pt(r[0][0], 50, 40, 2, 'a0');
  pt(r[0][1], 50, 40, 3, 'a1');
  pt(r[1][0], 50, 40, 4, 'b0');
  pt(r[1][1], 150, 40, 4, 'b1');
  for (const line of r) for (const p of line) assert.ok(Number.isFinite(p.u) && Number.isFinite(p.v));
  // 넘침 뒤에 1점만 남으면 그 조각은 버린다.
  const r2 = clipPolyline(ID_VIEW, [[0, 0, 2], [1e308, 0, 1], [0, 0, 4]], 0.5);
  assert.deepEqual(r2, []);
});

test('clip: 입력을 고치지 않는다', () => {
  const pts = [[1, 2, -1], [3, 0, 3], [0, 0, -4]];
  const view = structuredClone(NORTH_VIEW);
  const ptsCopy = structuredClone(pts);
  const viewCopy = structuredClone(view);
  clipPolyline(view, pts, 1);
  assert.deepEqual(pts, ptsCopy);
  assert.deepEqual(view, viewCopy);
});

test('clip: nearM 이 양의 유한 수가 아니면 던진다', () => {
  assert.throws(() => clipPolyline(ID_VIEW, [], '1'), TypeError);
  assert.throws(() => clipPolyline(ID_VIEW, [], 0), RangeError);
  assert.throws(() => clipPolyline(ID_VIEW, [], -1), RangeError);
  assert.throws(() => clipPolyline(ID_VIEW, [], Infinity), RangeError);
  assert.throws(() => clipPolyline(ID_VIEW, null, 1), TypeError);
});

// ── 퍼즈 ──
// 시드 고정 PRNG(mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// 단위 사원수 → 회전행렬(행 우선).
function quatToR(w, x, y, z) {
  const n = Math.hypot(w, x, y, z);
  w /= n; x /= n; y /= n; z /= n;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

function cam(view, p) {
  const { R, t } = view;
  return [0, 1, 2].map((i) => R[i * 3] * p[0] + R[i * 3 + 1] * p[1] + R[i * 3 + 2] * p[2] + t[i]);
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// 원 선분의 깊이 ≥ nearM 부분 길이(카메라 공간). 깊이는 선분 위에서 선형이다.
function frontLen(view, A, B, nearM) {
  const a = cam(view, A), b = cam(view, B);
  const L = dist(a, b);
  const dA = a[2], dB = b[2];
  if (dA === dB) return dA >= nearM ? L : 0;
  const s = (nearM - dA) / (dB - dA);
  let lo = 0, hi = 1;
  if (dB > dA) lo = Math.max(0, s); else hi = Math.min(1, s);
  return hi > lo ? L * (hi - lo) : 0;
}

// 결과 점을 K 로 되돌려 카메라 공간 길이를 잰다.
function resultLen(view, polylines) {
  const { fx, fy, cx, cy } = view.K;
  let L = 0;
  for (const line of polylines) {
    const c = line.map((p) => [(p.u - cx) * p.depth / fx, (p.v - cy) * p.depth / fy, p.depth]);
    for (let i = 1; i < c.length; i++) L += dist(c[i - 1], c[i]);
  }
  return L;
}

function fuzz(view, seed) {
  const r = rng(seed);
  const nearM = 0.1 + r() * 2;
  const rand = () => [(r() - 0.5) * 40, (r() - 0.5) * 40, (r() - 0.5) * 40];
  let expectAll = 0;
  const chain = [];
  for (let k = 0; k < 1000; k++) {
    const A = rand(), B = rand();
    const res = clipPolyline(view, [A, B], nearM);
    assert.ok(res.length <= 1, '선분 하나는 polyline 이 많아야 하나');
    for (const line of res) {
      assert.ok(line.length >= 2);
      for (const p of line) assert.ok(p.depth >= nearM - 1e-9, `depth ${p.depth} < ${nearM}`);
    }
    const e = frontLen(view, A, B, nearM);
    near(resultLen(view, res), e, 1e-9 * (1 + e) * 100, `선분 ${k} 길이`);
    chain.push(A);
    if (k > 0) expectAll += frontLen(view, chain[k - 1], A, nearM);
  }
  // 1000 점짜리 이어진 선도 같은 길이 규칙을 지킨다.
  const res = clipPolyline(view, chain, nearM);
  for (const line of res) for (const p of line) assert.ok(p.depth >= nearM - 1e-9);
  near(resultLen(view, res), expectAll, 1e-9 * (1 + expectAll) * 100, '이어진 선 길이');
}

test('clip: 퍼즈 — 단위행렬 카메라에서 깊이 ≥ nearM, 앞쪽 길이 보존', () => {
  fuzz(ID_VIEW, 12345);
  fuzz({ ...ID_VIEW, t: [3, -2, 1.5] }, 777);
});

test('clip: 퍼즈 — 임의 회전 카메라에서 깊이 ≥ nearM, 앞쪽 길이 보존', () => {
  const r = rng(2026);
  for (let i = 0; i < 5; i++) {
    const R = quatToR(r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5);
    const view = { width: 640, height: 480, K: { fx: 300 + r() * 500, fy: 300 + r() * 500, cx: 320, cy: 240 }, R, t: [(r() - 0.5) * 10, (r() - 0.5) * 10, (r() - 0.5) * 10] };
    fuzz(view, 1000 + i);
  }
});
