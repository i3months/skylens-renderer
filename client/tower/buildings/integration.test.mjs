// 건물 층 통합 시험: 실제 서버 자산 파이프라인 출력(integration_bundle.mjs)으로 createBuildingsLayer 를 먹인다.
// 층 구현(index.mjs)이 아직 없으면 동적 import 가 실패해 시험이 명확히 실패한다(정상). 번들 조립 헬퍼 시험은 항상 통과해야 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DISPLAY_MODES, buildingHeightM } from '../../../contracts/tower_assets/index.mjs';
import { buildRealBundle, makeFootprints, BUILDING_COUNT } from './integration_bundle.mjs';

const SEED = 20260;
// 위에서 내려다보는 카메라(contracts/raster 규약, X_c = R·X_w + t, OpenCV 축).
// 카메라 위치 C=(96,60,200): x_c = 동, y_c = 남(아래), z_c = 아래(-z_w). R 행 = (1,0,0),(0,-1,0),(0,0,-1), t = -R·C.
const CAM_H = 200;
const FX = 560;
const CAM = Object.freeze({
  width: 640, height: 480,
  K: { fx: FX, fy: FX, cx: 320, cy: 240 },
  R: [1, 0, 0, 0, -1, 0, 0, 0, -1],
  t: [-96, 60, CAM_H],
});

/** 지붕 높이 roofZ 위의 세계 점 (x, y) 가 들어가는 화소 칸의 일차원 번호. */
function pixelOf(x, y, roofZ) {
  const d = CAM_H - roofZ;
  const u = (FX * (x - 96)) / d + 320, v = (FX * -(y - 60)) / d + 240;
  return Math.floor(v) * CAM.width + Math.floor(u);
}

const countBuilding = (r) => r.index.reduce((n, g) => n + (g >= 0 ? 1 : 0), 0);
const hash = (a) => { let h = 2166136261; for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619) >>> 0; return h; };
const maskOf = (r) => Uint8Array.from(r.index, (g) => (g >= 0 ? 1 : 0));

async function loadLayer(mode) {
  const { createBuildingsLayer } = await import('./index.mjs'); // 없으면 여기서 실패한다
  return createBuildingsLayer(mode ? { mode } : undefined);
}

// 묶음이 계약대로인지(validate.mjs 가 있으면 그것도, 없어도 길이·범위를 직접 검사).
async function checkContract(bundle) {
  assert.ok(Array.isArray(bundle.groups) && bundle.groups.length > 0);
  for (const g of bundle.groups) {
    const nv = g.mesh.positions.length / 3;
    assert.ok(g.mesh.positions instanceof Float32Array && g.mesh.positions.length % 3 === 0);
    assert.ok(g.mesh.indices instanceof Uint32Array && g.mesh.indices.length % 3 === 0 && g.mesh.indices.length > 0);
    for (const i of g.mesh.indices) assert.ok(i < nv);
    for (const v of g.mesh.positions) assert.ok(Number.isFinite(v));
    assert.ok(g.edgeLines instanceof Float32Array && g.edgeLines.length % 6 === 0);
    assert.ok(g.points instanceof Float32Array && g.points.length % 3 === 0 && g.points.length > 0);
    assert.equal(g.uv.length, nv * 2);
    assert.equal(g.wallMask.length, nv);
    for (const u of g.uv) assert.ok(u >= 0 && u <= 1);
    for (const m of g.wallMask) assert.ok(m === 0 || m === 1);
    assert.ok(Array.isArray(g.ids) && g.ids.length > 0);
  }
  if (bundle.image) assert.equal(bundle.image.rgb.length, bundle.image.width * bundle.image.height * 3);
  if (fs.existsSync(new URL('./validate.mjs', import.meta.url))) {
    const { validateBundle } = await import('./validate.mjs');
    validateBundle(bundle);
  }
}

// ---- 번들 조립 헬퍼 시험(층 구현과 무관, 지금 통과해야 한다) ----

test('helper: 외곽선 40동, 겹치지 않음, 층 수 섞임, floors 없는 동 포함, 결정적', () => {
  const a = makeFootprints(SEED), b = makeFootprints(SEED);
  assert.equal(a.length, 40);
  assert.equal(BUILDING_COUNT, 40);
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map((f) => f.id)).size, 40);
  const bbox = (f) => ({ x0: Math.min(...f.ring.map((p) => p[0])), x1: Math.max(...f.ring.map((p) => p[0])), y0: Math.min(...f.ring.map((p) => p[1])), y1: Math.max(...f.ring.map((p) => p[1])) });
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
    const p = bbox(a[i]), q = bbox(a[j]);
    assert.ok(p.x1 < q.x0 || q.x1 < p.x0 || p.y1 < q.y0 || q.y1 < p.y0, `${i} 와 ${j} 가 겹침`);
  }
  assert.equal(a[0].floors, 3);
  assert.ok(!Number.isFinite(a[1].floors));
  assert.ok(new Set(a.map((f) => f.floors)).size >= 4);
  assert.notDeepEqual(makeFootprints(SEED + 1).map((f) => f.ring), a.map((f) => f.ring));
});

test('helper: 실제 파이프라인 번들이 계약 길이·범위를 지키고 결정적이다', async () => {
  const b1 = buildRealBundle(SEED), b2 = buildRealBundle(SEED);
  await checkContract(b1);
  assert.equal(b1.groups.length, 40); // 가까운 곳은 병합 없음
  assert.ok(b1.image);
  assert.equal(hash(b1.groups[0].mesh.positions), hash(b2.groups[0].mesh.positions));
  assert.equal(hash(b1.groups[7].points), hash(b2.groups[7].points));
  const noImg = buildRealBundle(SEED, { withImage: false });
  await checkContract(noImg);
  assert.equal(noImg.image, null);
  assert.ok(noImg.groups.every((g) => g.wallMask.every((m) => m === 1)));
});

test('helper: ids 는 병합 상자까지 포함해 입력 id 전부를 한 번씩 보존한다', async () => {
  const want = makeFootprints(SEED).map((f) => f.id).sort((x, y) => x - y);
  for (const dist of [0, 499, 800, 3000]) {
    const b = buildRealBundle(SEED, { cameraDistM: dist });
    await checkContract(b);
    const got = b.groups.flatMap((g) => g.ids).sort((x, y) => x - y);
    assert.deepEqual(got, want, `cameraDistM=${dist}`);
  }
  assert.ok(buildRealBundle(SEED, { cameraDistM: 3000 }).groups.length <= 40);
});

test('helper: 지붕 높이가 층 수 규칙(floors×3, 없으면 6 m)을 따른다', () => {
  const fps = makeFootprints(SEED);
  const b = buildRealBundle(SEED);
  for (let i = 0; i < fps.length; i++) {
    const zs = b.groups[i].mesh.positions.filter((_, k) => k % 3 === 2);
    assert.equal(Math.max(...zs), buildingHeightM(fps[i].floors));
  }
  assert.equal(buildingHeightM(3), 9);
  assert.equal(buildingHeightM(undefined), 6);
});

// ---- 층 통합 시험(index.mjs 필요) ----

test('(a) 실제 번들이 계약 검증을 통과하고 accept 가 받는다', async () => {
  const bundle = buildRealBundle(SEED);
  await checkContract(bundle);
  const layer = await loadLayer();
  assert.equal(layer.accept(3, bundle), 'first');
  assert.equal(layer.accept(3, bundle), 'replace');
  assert.equal(layer.accept(0, bundle), 'skip');
});

test('(b) 건물 수 보존: state().buildingCount = 입력 동 수 (병합 상자 번들도)', async () => {
  for (const dist of [0, 3000]) {
    const layer = await loadLayer();
    const bundle = buildRealBundle(SEED, { cameraDistM: dist });
    layer.accept(2, bundle);
    const s = layer.state();
    assert.equal(s.buildingCount, 40, `cameraDistM=${dist}`);
    assert.equal(s.groupCount, bundle.groups.length);
    assert.equal(s.level, 2);
  }
});

test('(c) 세 옵션 모두 건물 화소 > 0, 옵션 사이 화소 모양이 다르고 전환은 상태만 바꾼다', async () => {
  const layer = await loadLayer();
  const bundle = buildRealBundle(SEED);
  layer.accept(3, bundle);
  const res = {};
  for (const m of DISPLAY_MODES) {
    layer.setMode(m);
    assert.equal(layer.mode(), m);
    res[m] = layer.render(CAM);
    assert.equal(res[m].width, CAM.width);
    assert.equal(res[m].height, CAM.height);
    assert.ok(countBuilding(res[m]) > 0, `${m} 화소 0`);
    for (let p = 0; p < res[m].index.length; p++) {
      const g = res[m].index[p];
      assert.ok(g === -1 ? res[m].depth[p] === 0 : g < bundle.groups.length && res[m].depth[p] > 0);
    }
    assert.equal(layer.state().buildingCount, 40);
  }
  // points 는 점 하나 = 한 화소라 면 옵션보다 훨씬 성기다.
  assert.ok(countBuilding(res.points) < countBuilding(res.black));
  assert.notEqual(hash(maskOf(res.points)), hash(maskOf(res.black)));
  // black 과 aerial 은 같은 면을 그리되(지붕) 색이 다르다(영상 색 vs 검정 면).
  assert.notEqual(hash(res.black.color), hash(res.aerial.color));
  assert.notEqual(hash(res.points.color), hash(res.black.color));
  assert.notEqual(hash(res.points.color), hash(res.aerial.color));
});

test('(d) 높이 규칙이 지붕 깊이에 반영된다(floors 3 → 카메라 높이 − 9, 없음 → − 6)', async () => {
  const layer = await loadLayer('black');
  layer.accept(3, buildRealBundle(SEED));
  const fps = makeFootprints(SEED);
  const r = layer.render(CAM);
  // 0번 = 3층, 1번 = floors 없음. 나머지 동도 규칙대로.
  const expectH = (f) => (Number.isFinite(f.floors) && f.floors > 0 ? f.floors * 3 : 6);
  assert.equal(expectH(fps[0]), 9);
  assert.equal(expectH(fps[1]), 6);
  for (let i = 0; i < fps.length; i++) {
    const h = expectH(fps[i]);
    const px = pixelOf(fps[i].probe[0], fps[i].probe[1], h);
    assert.ok(r.index[px] >= 0, `동 ${i} 지붕 화소가 비어 있음`);
    assert.ok(Math.abs(r.depth[px] - (CAM_H - h)) < 1e-3, `동 ${i}: 깊이 ${r.depth[px]} 기대 ${CAM_H - h}`);
  }
  assert.ok(Math.abs(r.depth[pixelOf(fps[0].probe[0], fps[0].probe[1], 9)] - 191) < 1e-3);
  assert.ok(Math.abs(r.depth[pixelOf(fps[1].probe[0], fps[1].probe[1], 6)] - 194) < 1e-3);
  // aerial 옵션도 같은 지붕 깊이.
  layer.setMode('aerial');
  const a = layer.render(CAM);
  const px0 = pixelOf(fps[0].probe[0], fps[0].probe[1], 9);
  assert.ok(Math.abs(a.depth[px0] - 191) < 1e-3);
});

test('(e) 도착하지 않은 곳은 빈 화소(accept 전 render 는 전부 depth 0, index −1)', async () => {
  for (const m of DISPLAY_MODES) {
    const layer = await loadLayer(m);
    assert.equal(layer.state().level, -1);
    assert.equal(layer.state().buildingCount, 0);
    const r = layer.render(CAM);
    assert.ok(r.depth.every((d) => d === 0), `${m}: depth`);
    assert.ok(r.index.every((g) => g === -1), `${m}: index`);
    assert.ok(r.color.every((c) => c === 0), `${m}: color`);
  }
  // 묶음 밖(격자 바깥 하늘) 화소도 비어 있다.
  const layer = await loadLayer('black');
  layer.accept(3, buildRealBundle(SEED));
  const r = layer.render(CAM);
  assert.equal(r.index[0], -1);
  assert.equal(r.depth[0], 0);
});
