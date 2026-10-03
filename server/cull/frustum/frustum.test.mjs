import test from 'node:test';
import assert from 'node:assert/strict';
import { generate as terrain } from '../../../fixtures/scenes/terrain/index.mjs';
import { generate as buildings } from '../../../fixtures/scenes/buildings/index.mjs';
import { generate as flatBoxes } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { isDegenerateViewLocal, frustumCull } from './index.mjs';

// 카메라: 위치 eye, 목표 at, 세계 위 +y. 카메라 x 오른쪽, y 아래, z 앞 (X_c = R·(X_w − eye)).
function lookAt(eye, at, { W = 160, H = 120, f = 120 } = {}) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
  const fw = norm(sub(at, eye));
  const right = norm(cross(fw, [0, 1, 0]));
  const down = cross(fw, right);
  const R = [...right, ...down, ...fw];
  const t = [-(R[0] * eye[0] + R[1] * eye[1] + R[2] * eye[2]), -(R[3] * eye[0] + R[4] * eye[1] + R[5] * eye[2]), -(R[6] * eye[0] + R[7] * eye[1] + R[8] * eye[2])];
  return { width: W, height: H, K: { fx: f, fy: f, cx: W / 2, cy: H / 2 }, R, t };
}

// 고정 시점 8곳 (장면 범위 ±100 m 기준; 건물 장면은 ±1000 m 라 배율 s 를 곱한다)
function views(s) {
  const P = (x, y, z) => [x * s, y * s, z * s];
  return [
    [P(0, 60, -150), P(0, 10, 0)],      // 0 앞쪽 위에서 중앙
    [P(150, 40, 0), P(0, 10, 0)],       // 1 동쪽
    [P(0, 40, 150), P(0, 10, 0)],       // 2 남쪽
    [P(-150, 40, 0), P(0, 10, 0)],      // 3 서쪽
    [P(0, 250, 1), P(0, 0, 0)],         // 4 거의 수직 내려다보기
    [P(60, 30, -60), P(100, 10, 100)],  // 5 가장자리 쪽 시선
    [P(-80, 20, -80), P(-10, 10, 40)],  // 6 낮게 비스듬히
    [P(0, 20, 0), P(0, 20, 100)],       // 7 장면 안, 한쪽만 봄
  ].map(([e, a]) => lookAt(e, a));
}

const scenes = [
  ['terrain', terrain({ seed: 3, count: 20000 }), 1, 0.5],
  ['buildings', buildings({ seed: 5, count: 20000 }), 10, 4],
  ['flat_boxes', flatBoxes({ seed: 7, count: 20000 }), 1, 0.5],
];

// 거짓 제거 0 기준(숫자 고정): 보이는 점의 리프가 제거된 횟수 = 0
const MAX_FALSE = 0;
// 제거율 하한(느슨한 효과 확인): 시점 7(한쪽만 봄)에서 리프의 30% 이상 제거
const MIN_REMOVED_RATIO_V7 = 0.3;

for (const [name, scene, s, edge0] of scenes) {
  const cloud = scene.cloud ?? scene;
  const h = buildHierarchy(cloud, { edge0M: edge0, levelCount: 3, maxLeafPoints: 256 });
  const oc = h.octree;
  const leafOf = new Int32Array(cloud.count);
  for (let k = 0; k < oc.leafCount; k++) for (let q = oc.leafStart[k]; q < oc.leafStart[k + 1]; q++) leafOf[oc.order[q]] = k;

  test(`절두체 컬링: ${name} 8시점에서 보이는 점의 리프는 모두 남음(거짓 제거 ${MAX_FALSE})`, () => {
    const cams = views(s);
    const rows = [];
    cams.forEach((cam, v) => {
      const mask = frustumCull(h, cam);
      const res = renderPoints(cam, cloud, { pointSizeM: 0.3 * s });
      let drawn = 0, falseRemoved = 0;
      const seen = new Set();
      for (let i = 0; i < res.index.length; i++) { const p = res.index[i]; if (p >= 0) { drawn++; seen.add(leafOf[p]); } }
      for (const k of seen) if (mask[k] === 0) falseRemoved++;
      let kept = 0; for (const m of mask) kept += m;
      rows.push(`v${v}: 제거율 ${(100 * (1 - kept / oc.leafCount)).toFixed(1)}% (남음 ${kept}/${oc.leafCount}, 그려진 점 ${drawn}, 보이는 리프 ${seen.size})`);
      assert.equal(falseRemoved, MAX_FALSE, `${name} v${v} 거짓 제거`);
    });
    console.log(`[${name}]\n  ${rows.join('\n  ')}`);
  });

  test(`절두체 컬링: ${name} 시점 7(한쪽만 봄)에서 제거율 ${MIN_REMOVED_RATIO_V7 * 100}% 이상`, () => {
    const mask = frustumCull(h, views(s)[7]);
    let kept = 0; for (const m of mask) kept += m;
    assert.ok(1 - kept / oc.leafCount >= MIN_REMOVED_RATIO_V7, `제거율 ${1 - kept / oc.leafCount}`);
  });
}

// 합성 계층: 상자 4개를 직접 둔 최소 계층(리프 = 노드)
function boxHierarchy(boxes) {
  const n = boxes.length;
  const boxMin = new Float32Array(3 * n), boxMax = new Float32Array(3 * n);
  boxes.forEach(([a, b], i) => { boxMin.set(a, 3 * i); boxMax.set(b, 3 * i); });
  const leafStart = new Uint32Array(n + 1);
  for (let i = 0; i <= n; i++) leafStart[i] = i;
  return {
    octree: { nodeCount: n, leafCount: n, leafIndex: Int32Array.from({ length: n }, (_, i) => i), boxMin, boxMax },
    levels: [{ leafStart }],
  };
}

test('확실히 시야 밖인 상자는 8시점 모두에서 0, 시선 앞 상자는 1', () => {
  // 모든 시점은 원점 근처를 본다. 상자 A: 시점별로 카메라 뒤 / 좌우 밖이 되도록 시점마다 만든다.
  for (const [v, cam] of views(1).entries()) {
    const e = cam.R; // 카메라 축 (세계 좌표): 오른쪽 = R 행0, 아래 = 행1, 앞 = 행2
    const eye = [-(e[0] * cam.t[0] + e[3] * cam.t[1] + e[6] * cam.t[2]), -(e[1] * cam.t[0] + e[4] * cam.t[1] + e[7] * cam.t[2]), -(e[2] * cam.t[0] + e[5] * cam.t[1] + e[8] * cam.t[2])];
    const at = (d, r = 0, dn = 0) => [0, 1, 2].map((a) => eye[a] + d * e[6 + a] + r * e[a] + dn * e[3 + a]);
    const box = (c, h = 1) => [c.map((x) => x - h), c.map((x) => x + h)];
    const h = boxHierarchy([
      box(at(50)),            // 0 정면 앞: 보임
      box(at(-50)),           // 1 카메라 뒤
      box(at(50, 400)),       // 2 오른쪽 밖(수평 반각 약 34도; 400/50 은 훨씬 밖)
      box(at(50, -400)),      // 3 왼쪽 밖
      box(at(50, 0, -400)),   // 4 위쪽 밖
      box(at(50, 0, 400)),    // 5 아래쪽 밖
    ]);
    const m = frustumCull(h, cam);
    assert.deepEqual([...m], [1, 0, 0, 0, 0, 0], `시점 ${v}`);
  }
});

test('빈 리프는 상자가 시야 안이어도 0', () => {
  const cam = lookAt([0, 0, 0], [0, 0, 1]);
  const h = boxHierarchy([[[-1, -1, 10], [1, 1, 12]], [[-1, -1, 10], [1, 1, 12]]]);
  h.levels[0].leafStart = Uint32Array.from([0, 0, 1]);
  assert.deepEqual([...frustumCull(h, cam)], [0, 1]);
});

test('퇴화 시점(NaN·0 초점거리·비회전 R)은 던지지 않고 전부 0', () => {
  const h = boxHierarchy([[[-1, -1, 10], [1, 1, 12]], [[-5, -5, 20], [5, 5, 30]]]);
  const ok = lookAt([0, 0, 0], [0, 0, 1]);
  assert.deepEqual([...frustumCull(h, ok)], [1, 1]);
  const bad = [
    { ...ok, t: [NaN, 0, 0] },
    { ...ok, R: [Infinity, 0, 0, 0, 1, 0, 0, 0, 1] },
    { ...ok, K: { ...ok.K, fx: 0 } },
    { ...ok, width: 0 },
    { ...ok, R: [2, 0, 0, 0, 2, 0, 0, 0, 2] },
    { ...ok, K: { ...ok.K, cx: NaN } },
  ];
  for (const c of bad) {
    assert.equal(isDegenerateViewLocal(c), true);
    assert.deepEqual([...frustumCull(h, c)], [0, 0]);
  }
  assert.equal(isDegenerateViewLocal(ok), false);
});

test('지면 아래 카메라는 퇴화가 아니라 정상 처리', () => {
  const cam = lookAt([0, -50, 0], [0, 0, 100]);
  const h = boxHierarchy([[[-1, 0, 100], [1, 2, 102]]]);
  assert.equal(isDegenerateViewLocal(cam), false);
  assert.deepEqual([...frustumCull(h, cam)], [1]);
});

test('입력 오류는 cull: 오류', () => {
  const cam = lookAt([0, 0, 0], [0, 0, 1]);
  assert.throws(() => frustumCull(null, cam), /^Error: cull:/);
  assert.throws(() => frustumCull({}, cam), /^Error: cull:/);
  const h = boxHierarchy([[[0, 0, 5], [1, 1, 6]]]);
  h.levels[0].leafStart = new Uint32Array(5);
  assert.throws(() => frustumCull(h, cam), /^Error: cull:/);
});
