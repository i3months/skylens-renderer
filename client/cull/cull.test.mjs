import test from 'node:test';
import assert from 'node:assert/strict';
import { clientFrustumCull, leafBoxesOf, isDegenerateViewClient } from './index.mjs';
import { boxMayBeVisibleSplat } from '../../server/lod/select/view_check.mjs'; // 비교 대상(테스트에서만 서버 import)
import { buildHierarchy } from '../../server/lod/hierarchy/index.mjs';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 합성 장면: 점 위치를 만드는 함수 → 점군
function cloudOf(gen, n, off = [0, 0, 0]) {
  const positions = new Float32Array(3 * n), normals = new Float32Array(3 * n), colors = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) {
    const p = gen(i);
    for (let d = 0; d < 3; d++) positions[3 * i + d] = p[d] + off[d];
    normals[3 * i + 2] = 1;
  }
  return { format: 1, count: n, positions, normals, colors };
}
function scenes(off = [0, 0, 0]) {
  const r1 = rng(1), r2 = rng(2), r3 = rng(3);
  return {
    terrain: cloudOf(() => { const x = r1() * 200, y = r1() * 200; return [x, y, 5 * Math.sin(x / 20) + 3 * Math.cos(y / 15)]; }, 6000, off),
    cluster: cloudOf(() => [r2() * 40 + (r2() < 0.5 ? 0 : 150), r2() * 40, r2() * 30], 6000, off),
    shell: cloudOf(() => { const a = r3() * 6.2832, b = Math.acos(2 * r3() - 1); return [80 + 70 * Math.sin(b) * Math.cos(a), 80 + 70 * Math.sin(b) * Math.sin(a), 70 * Math.cos(b)]; }, 6000, off),
  };
}
const build = (c) => buildHierarchy(c, { edge0M: 0.5, levelCount: 3, maxLeafPoints: 200 });

// 카메라: 위치 eye 에서 target 을 보는 OpenCV 규약(+z 앞, y 아래)
function lookAt(eye, target, W = 640, H = 480, f = 500, roll = 0) {
  let z = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const zl = Math.hypot(...z); z = z.map((v) => v / zl);
  let up = [0, 0, 1];
  if (Math.abs(z[2]) > 0.999) up = [0, 1, 0];
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  let x = cr(z, up); const xl = Math.hypot(...x); x = x.map((v) => v / xl);
  let y = cr(z, x);
  if (roll) { const c = Math.cos(roll), s = Math.sin(roll); const x2 = x.map((v, i) => c * v + s * y[i]); y = y.map((v, i) => c * v - s * x[i]); x = x2; }
  const R = [...x, ...y, ...z];
  const t = [0, 1, 2].map((i) => -(R[3 * i] * eye[0] + R[3 * i + 1] * eye[1] + R[3 * i + 2] * eye[2]));
  return { width: W, height: H, K: { fx: f, fy: f, cx: W / 2, cy: H / 2 }, R, t };
}
const fixedViews = (o = [0, 0, 0]) => [
  [[-50, -50, 60], [100, 100, 0]], [[100, -200, 30], [100, 100, 10]], [[300, 100, 100], [0, 100, 0]], [[100, 100, 500], [100, 100, 0]],
  [[100, 100, -50], [100, 100, 50]], [[0, 0, 2], [200, 200, 2]], [[80, 80, 0], [200, 80, 0]], [[400, 400, 50], [0, 0, 0]],
].map(([e, t], i) => lookAt(e.map((v, d) => v + o[d]), t.map((v, d) => v + o[d]), 640, 480, 500, i * 0.3));

// 서버 규칙(공용 boxMayBeVisibleSplat)을 리프마다 쓴 마스크. pointSizeM 이 undefined 면 좌·우·위·아래 제거 없음.
function serverMask(boxes, cam, pointSizeM) {
  const n = boxes.boxMin.length / 3, out = new Uint8Array(n);
  for (let k = 0; k < n; k++) out[k] = boxMayBeVisibleSplat(cam, boxes.boxMin.subarray(3 * k, 3 * k + 3), boxes.boxMax.subarray(3 * k, 3 * k + 3), pointSizeM) ? 1 : 0;
  return out;
}
function randomCams(seed, cnt, o = [0, 0, 0]) {
  const r = rng(seed), cams = [];
  for (let i = 0; i < cnt; i++) {
    const e = [r() * 500 - 150, r() * 500 - 150, r() * 200 - 30].map((v, d) => v + o[d]);
    const tg = [r() * 200, r() * 200, r() * 30].map((v, d) => v + o[d]);
    cams.push(lookAt(e, tg, 320 + Math.floor(r() * 800), 240 + Math.floor(r() * 600), 200 + r() * 1200, (r() - 0.5) * 3));
  }
  return cams;
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

function compareAll(off, pointSizeM) {
  let cmp = 0, bad = 0, kept = 0, removed = 0;
  const opts = pointSizeM === undefined ? undefined : { pointSizeM };
  for (const [name, cloud] of Object.entries(scenes(off))) {
    const boxes = leafBoxesOf(build(cloud).octree);
    for (const cam of [...fixedViews(off), ...randomCams(42, 200, off)]) {
      const a = clientFrustumCull(boxes, cam, opts), b = serverMask(boxes, cam, pointSizeM);
      cmp++; if (!same(a, b)) bad++;
      for (const v of a) v ? kept++ : removed++;
    }
  }
  return { cmp, bad, kept, removed };
}

// pointSizeM: 0(원판 중심만), 0.5 m, 없음(좌·우·위·아래 제거 없음) 세 경우 모두 서버 규칙과 같아야 한다.
for (const size of [0, 0.5, undefined]) {
  test(`합성 장면 3종 × 고정 시점 8 + 무작위 200 (pointSizeM ${size}): 서버 마스크와 불일치 0`, () => {
    const r = compareAll([0, 0, 0], size);
    assert.equal(r.cmp, 3 * 208);
    assert.equal(r.bad, 0);
    assert.ok(r.kept > 0 && r.removed > 0, `둘 다 나와야 시험이 의미 있음 kept=${r.kept} removed=${r.removed}`);
  });

  test(`큰 좌표(1e6 m)에서도 서버 마스크와 불일치 0 (pointSizeM ${size})`, () => {
    const r = compareAll([1e6, -1e6, 1e6], size);
    assert.equal(r.bad, 0);
    assert.ok(r.kept > 0 && r.removed > 0);
  });
}

test('조각 목록 일치: 마스크에서 뽑은 리프 번호 목록이 서버와 같음', () => {
  const boxes = leafBoxesOf(build(scenes().terrain).octree);
  const cam = fixedViews()[0];
  const list = (m) => [...m].flatMap((v, i) => (v ? [i] : []));
  assert.deepEqual(list(clientFrustumCull(boxes, cam, { pointSizeM: 0.5 })), list(serverMask(boxes, cam, 0.5)));
});

test('작은 상자 손계산: 앞·뒤·옆·경계 등호', () => {
  const cam = { width: 100, height: 100, K: { fx: 100, fy: 100, cx: 50, cy: 50 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  const box = (a, b) => ({ boxMin: new Float32Array(a), boxMax: new Float32Array(b) });
  const b = { boxMin: new Float32Array([-1, -1, 10, -1, -1, -10, -1, -1, -5, 100, -1, 10, 50, -1, 100]), boxMax: new Float32Array([1, 1, 12, 1, 1, -5, 1, 1, 0, 200, 1, 12, 60, 1, 100.0]) };
  const s0 = { pointSizeM: 0 }; // 원판 여유 0 = 원판 중심만 보는 규칙
  // 0: 정면 앞 → 1, 1: 뒤 → 0, 2: z=0 에 걸쳐 z 최댓값 0(앞 없음) → 0, 3: 오른쪽 한참 밖(x≥100,z≤12) → 0, 4: x=50..60,z=100: 오른쪽 경계 x=50 등호 → 1
  assert.deepEqual([...clientFrustumCull(b, cam, s0)], [1, 0, 0, 0, 1]);
  // pointSizeM 없음: 좌·우·위·아래 제거 없음 → 3 도 남고 뒤(1·2)만 제거
  assert.deepEqual([...clientFrustumCull(b, cam)], [1, 0, 0, 1, 1]);
  assert.deepEqual([...clientFrustumCull(box([0, 0, 0], [0, 0, 0]), cam, s0)], [0]);
  // 왼쪽 경계 등호: x ∈ [−60, −50], z = 100 → 꼭짓점 x=−50 에서 fx·x+cx·z = 0 → 남김(1); x ≤ −51 이면 제거(0)
  assert.deepEqual([...clientFrustumCull(box([-60, 0, 100], [-50, 0, 100]), cam, s0)], [1]);
  assert.deepEqual([...clientFrustumCull(box([-60, 0, 100], [-51, 0, 100]), cam, s0)], [0]);
  // 원판 여유: pointSizeM 0.2 → m = fx·0.2/2 = 10. x_max = −50.1: −5010 + 5000 + 10 = 0 → 남김, x_max = −50.2 → −10 → 제거
  const s2 = { pointSizeM: 0.2 };
  assert.deepEqual([...clientFrustumCull(box([-60, 0, 100], [-50.1, 0, 100]), cam, s2)], [1]);
  assert.deepEqual([...clientFrustumCull(box([-60, 0, 100], [-50.2, 0, 100]), cam, s2)], [0]);
});

test('퇴화 시점: 전부 0, 던지지 않음', () => {
  const boxes = leafBoxesOf(build(scenes().terrain).octree);
  const good = fixedViews()[0];
  const n = boxes.boxMin.length / 3;
  assert.ok(n > 1);
  assert.ok(clientFrustumCull(boxes, good).some((v) => v === 1));
  const bads = [
    { ...good, t: [NaN, 0, 0] }, { ...good, t: [Infinity, 0, 0] }, { ...good, R: [NaN, ...good.R.slice(1)] },
    { ...good, width: 0 }, { ...good, height: -1 }, { ...good, K: { ...good.K, fx: 0 } }, { ...good, K: { ...good.K, fy: -3 } },
    { ...good, K: { ...good.K, cx: NaN } }, { ...good, R: good.R.map((v) => v * 2) }, { ...good, R: [1, 0, 0, 0, 1, 0, 0, 0, -1] },
  ];
  // 구조 오류(null·undefined·{}·R 누락)는 퇴화가 아니라 'cull:' 오류(F-132).
  const { R: _R, ...noR } = good;
  for (const cam of [null, undefined, {}, noR]) assert.throws(() => clientFrustumCull(boxes, cam, { pointSizeM: 0.5 }), /^Error: cull:/);
  for (const cam of bads) {
    assert.equal(isDegenerateViewClient(cam), true);
    const m = clientFrustumCull(boxes, cam, { pointSizeM: 0.5 });
    assert.equal(m.length, n);
    assert.equal(m.reduce((a, v) => a + v, 0), 0);
  }
  assert.equal(isDegenerateViewClient(good), false);
});

test('입력 오류는 cull: 접두 오류', () => {
  const cam = fixedViews()[0];
  assert.throws(() => clientFrustumCull(null, cam), /^Error: cull:/);
  assert.throws(() => clientFrustumCull({ boxMin: new Float32Array(3), boxMax: new Float32Array(6) }, cam), /^Error: cull:/);
  assert.throws(() => clientFrustumCull({ boxMin: [0, 0, 0], boxMax: [1, 1, 1] }, cam), /^Error: cull:/);
  const ok = { boxMin: new Float32Array(3), boxMax: new Float32Array(3) };
  for (const bad of [-0.01, NaN, Infinity, '0.05']) assert.throws(() => clientFrustumCull(ok, cam, { pointSizeM: bad }), /^Error: cull:/);
  assert.throws(() => clientFrustumCull(ok, cam, 0.05), /^Error: cull:/);
  assert.throws(() => leafBoxesOf({ leafCount: 2, leafIndex: new Int32Array([0, -1]), boxMin: new Float32Array(6), boxMax: new Float32Array(6) }), /^Error: cull:/);
});

test('leafBoxesOf: 리프 번호 순으로 해당 노드 상자를 담음', () => {
  const oct = build(scenes().cluster).octree;
  const lb = leafBoxesOf(oct);
  assert.equal(lb.boxMin.length, 3 * oct.leafCount);
  for (let node = 0; node < oct.leafIndex.length; node++) {
    const k = oct.leafIndex[node];
    if (k < 0) continue;
    assert.deepEqual([...lb.boxMin.subarray(3 * k, 3 * k + 3)], [...oct.boxMin.subarray(3 * node, 3 * node + 3)]);
    assert.deepEqual([...lb.boxMax.subarray(3 * k, 3 * k + 3)], [...oct.boxMax.subarray(3 * node, 3 * node + 3)]);
  }
});
