// T13.5 드론·마커 덧그리기 시험. 기준값은 손으로 계산한 숫자다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMarkers, unprojectToEnu } from './index.mjs';

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const identityView = () => ({ R: I.slice(), t: [0, 0, 0], K: { fx: 500, fy: 500, cx: 320, cy: 240 }, width: 640, height: 480, devicePixelRatio: 1 });

function near(a, b, tol, msg) {
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
}

test('항등 뷰: [0,0,10] → (320,240,10), [1,0,10] → u=370', () => {
  const out = projectMarkers(identityView(), [
    { id: 'a', enu: [0, 0, 10] },
    { id: 'b', enu: [1, 0, 10] },
    { id: 'c', enu: [0, -2, 5] },
  ]);
  assert.deepEqual(out[0], { id: 'a', u: 320, v: 240, depth: 10, visible: true });
  assert.deepEqual(out[1], { id: 'b', u: 370, v: 240, depth: 10, visible: true });
  // v = 500·(−2)/5 + 240 = 40
  assert.deepEqual(out[2], { id: 'c', u: 320, v: 40, depth: 5, visible: true });
});

test('z축 90° 회전 + 평행이동: 손 계산과 1e-9 이내', () => {
  // R = Rz(90°) = [[0,−1,0],[1,0,0],[0,0,1]], t = [1,2,3]
  // X_w = [2,5,7] → X_c = [−5+1, 2+2, 7+3] = [−4, 4, 10] → u = 500·(−4)/10+320 = 120, v = 500·4/10+240 = 440
  const view = { ...identityView(), R: [0, -1, 0, 1, 0, 0, 0, 0, 1], t: [1, 2, 3] };
  const [p] = projectMarkers(view, [{ id: 'd', enu: [2, 5, 7] }]);
  near(p.u, 120, 1e-9, 'u');
  near(p.v, 440, 1e-9, 'v');
  near(p.depth, 10, 1e-9, 'depth');
  assert.equal(p.visible, true);
});

test('북쪽을 수평으로 보는 카메라(1920×1080, f=1500): 손 계산과 1e-9 이내', () => {
  // 카메라 x=동, y=−위, z=북 → R 행 = [1,0,0],[0,0,−1],[0,1,0]. 위치 pos=[10,20,30] → t = −R·pos = [−10, 30, −20]
  // X_w = [13,120,26] → X_c = [3, 4, 100] → u = 1500·3/100+960 = 1005, v = 1500·4/100+540 = 600
  const view = { R: [1, 0, 0, 0, 0, -1, 0, 1, 0], t: [-10, 30, -20], K: { fx: 1500, fy: 1500, cx: 960, cy: 540 }, width: 1920, height: 1080, devicePixelRatio: 2 };
  const [p] = projectMarkers(view, [{ id: 'drone', enu: [13, 120, 26] }]);
  near(p.u, 1005, 1e-9, 'u');
  near(p.v, 600, 1e-9, 'v');
  near(p.depth, 100, 1e-9, 'depth');
  assert.equal(p.visible, true);
  const back = unprojectToEnu(view, p.u, p.v, p.depth);
  near(back[0], 13, 1e-9, 'e');
  near(back[1], 120, 1e-9, 'n');
  near(back[2], 26, 1e-9, 'u');
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

test('왕복: 무작위 마커 200개 project → unproject 오차 ≤ 0.01 m', () => {
  const rnd = mulberry32(20261004);
  // 무작위 단위 쿼터니언 → 회전 행렬(세계→카메라)
  let q = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
  const qn = Math.hypot(...q);
  q = q.map((x) => x / qn);
  const [x, y, z, w] = q;
  const R = [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
  const pos = [rnd() * 2000 - 1000, rnd() * 2000 - 1000, 50 + rnd() * 200];
  const t = [0, 1, 2].map((i) => -(R[3 * i] * pos[0] + R[3 * i + 1] * pos[1] + R[3 * i + 2] * pos[2]));
  const view = { R, t, K: { fx: 1500, fy: 1500, cx: 960, cy: 540 }, width: 1920, height: 1080, devicePixelRatio: 1 };
  // 카메라 좌표에서 앞 5..500 m, 화면 안팎(±1.5 배 시야)으로 뽑고 세계 좌표 X_w = Rᵀ(X_c − t) 는 시험에서 따로 계산한다.
  const markers = [];
  const depths = [];
  for (let i = 0; i < 200; i += 1) {
    const d = 5 + rnd() * 495;
    const xc = [((rnd() * 3 - 1) * 1920 - 960) / 1500 * d, ((rnd() * 3 - 1) * 1080 - 540) / 1500 * d, d];
    const a = xc.map((c, k) => c - t[k]);
    markers.push({ id: `m${i}`, enu: [0, 1, 2].map((j) => R[j] * a[0] + R[3 + j] * a[1] + R[6 + j] * a[2]) });
    depths.push(d);
  }
  const out = projectMarkers(view, markers);
  assert.equal(out.length, 200);
  let maxErr = 0;
  out.forEach((p, i) => {
    assert.equal(p.id, `m${i}`);
    near(p.depth, depths[i], 1e-6, `depth ${i}`);
    const back = unprojectToEnu(view, p.u, p.v, p.depth);
    const e = Math.hypot(back[0] - markers[i].enu[0], back[1] - markers[i].enu[1], back[2] - markers[i].enu[2]);
    maxErr = Math.max(maxErr, e);
  });
  // 측정된 최대 오차는 약 7.0e-13 m(시드 20261004, 부동소수 반올림). 기준은 계약의 1 cm.
  assert.ok(maxErr <= 0.01, `최대 왕복 오차 ${maxErr} m`);
});

test('카메라 뒤·카메라 평면 마커는 visible false, u=v=0', () => {
  const out = projectMarkers(identityView(), [
    { id: 'back', enu: [1, 1, -10] },
    { id: 'plane', enu: [1, 1, 0] },
  ]);
  assert.deepEqual(out[0], { id: 'back', u: 0, v: 0, depth: -10, visible: false });
  assert.deepEqual(out[1], { id: 'plane', u: 0, v: 0, depth: 0, visible: false });
});

test('화면 밖 마커는 visible false 이고 u,v 는 투영값 그대로', () => {
  const out = projectMarkers(identityView(), [
    { id: 'right', enu: [10, 0, 10] }, // u = 500+320 = 820 ≥ 640
    { id: 'top', enu: [0, -10, 10] }, // v = −500+240 = −260 < 0
    { id: 'edgeW', enu: [6.4, 0, 10] }, // u = 320+320 = 640 → 경계 밖(u < width)
    { id: 'edge0', enu: [-6.4, -4.8, 10] }, // u = 0, v = 0 → 안
  ]);
  assert.deepEqual(out[0], { id: 'right', u: 820, v: 240, depth: 10, visible: false });
  assert.deepEqual(out[1], { id: 'top', u: 320, v: -260, depth: 10, visible: false });
  near(out[2].u, 640, 1e-9, 'edgeW u');
  assert.equal(out[2].visible, false);
  near(out[3].u, 0, 1e-9, 'edge0 u');
  near(out[3].v, 0, 1e-9, 'edge0 v');
  assert.equal(out[3].visible, true);
});

test('입력 불변·순서·개수 보존', () => {
  const view = identityView();
  const markers = [
    { id: 'z', enu: [0, 0, 10] },
    { id: 'a', enu: [0, 0, -1] },
    { id: 'z', enu: [1, 0, 10] },
  ];
  const vSnap = structuredClone(view);
  const mSnap = structuredClone(markers);
  const out = projectMarkers(view, markers);
  assert.deepEqual(out.map((p) => p.id), ['z', 'a', 'z']);
  assert.deepEqual(view, vSnap);
  assert.deepEqual(markers, mSnap);
  assert.deepEqual(projectMarkers(view, []), []);
  unprojectToEnu(view, 1, 2, 3);
  assert.deepEqual(view, vSnap);
});

test('잘못된 입력 거부', () => {
  const v = identityView();
  const ok = [{ id: 'a', enu: [0, 0, 1] }];
  assert.throws(() => projectMarkers(null, ok), TypeError);
  assert.throws(() => projectMarkers({ ...v, R: [1, 0, 0] }, ok), TypeError);
  assert.throws(() => projectMarkers({ ...v, R: [1, 0, 0, 0, 1, 0, 0, 0, NaN] }, ok), TypeError);
  assert.throws(() => projectMarkers({ ...v, t: [0, 0] }, ok), TypeError);
  assert.throws(() => projectMarkers({ ...v, K: null }, ok), TypeError);
  assert.throws(() => projectMarkers({ ...v, K: { ...v.K, fx: 0 } }, ok), RangeError);
  assert.throws(() => projectMarkers({ ...v, K: { ...v.K, fy: -1 } }, ok), RangeError);
  assert.throws(() => projectMarkers({ ...v, K: { ...v.K, cx: Infinity } }, ok), TypeError);
  assert.throws(() => projectMarkers({ ...v, width: 0 }, ok), RangeError);
  assert.throws(() => projectMarkers({ ...v, height: 1.5 }, ok), RangeError);
  assert.throws(() => projectMarkers({ ...v, R: [2, 0, 0, 0, 1, 0, 0, 0, 1] }, ok), RangeError);
  assert.throws(() => projectMarkers({ ...v, R: [-1, 0, 0, 0, 1, 0, 0, 0, 1] }, ok), RangeError); // 반사(det −1)
  assert.throws(() => projectMarkers(v, null), TypeError);
  assert.throws(() => projectMarkers(v, [{ id: 1, enu: [0, 0, 1] }]), TypeError);
  assert.throws(() => projectMarkers(v, [{ id: 'a', enu: [0, 0] }]), TypeError);
  assert.throws(() => projectMarkers(v, [{ id: 'a', enu: [0, 0, NaN] }]), TypeError);
  assert.throws(() => projectMarkers(v, [{ id: 'a', enu: [0, '0', 1] }]), TypeError);
  assert.throws(() => projectMarkers(v, [ok[0], null]), TypeError);
  assert.throws(() => unprojectToEnu(v, NaN, 0, 1), TypeError);
  assert.throws(() => unprojectToEnu(v, 0, 0, 0), RangeError);
  assert.throws(() => unprojectToEnu(v, 0, 0, -5), RangeError);
});
