// T08.2 법선 기반 뒷면 제거 시험. 합성 장면(terrain·flat_boxes·buildings) × 고정 시점 8곳(fixtures/viewpoints/synthetic.json).
//
// 검증 방식(왜 (a) 가 아니라 (a') 인가):
//   계약의 (a) '참조 래스터에 그려진 점의 리프는 모두 남김' 은 순수 법선 컬링과 정면으로 충돌한다. 참조 래스터는 법선을 쓰지 않으므로
//   카메라를 등진 점도 (표면의 틈·점 원판 번짐·지면 아래 시점에서) 그려진다. 실측: flat_boxes 에서 시점마다 뒷면 법선이면서 그려진 점이
//   수백~2천 개, 그 점들이 든 '제거된 리프' 가 시점마다 1~8 개; terrain 은 지표 아래 시점에서 100 개 안팎.
//   그래서 backfaceCull 은 1단계(법선 원뿔) 후보 가운데 화면 영역이 앞쪽 점으로 확실히 덮인 리프만 버린다(2단계, index.mjs 머리말).
//   시험은 셋으로 나눈다(todo 가 불변식 단언을 숨기지 않도록 분리, todo 없음).
//   (a0) 1단계 기하 불변식(requireCover:false): 제거된 리프의 모든 점이 등진다(n·v < 0), 앞면으로 그려진 점의 리프는 제거 0.
//   (a1) 2단계 불변식(기본): 제거된 리프의 점은 참조 래스터(같은 점 지름)에서 한 픽셀도 이기지 않는다(그려진 점 0) — 거짓 제거 0 의 강한 꼴.
//   (a') 영상 검증: 점마다 머리등(시점 방향) 램버트로 칠한 영상(뒷면은 주변광만 → 어둡다)과 '제거 리프 점을 뺀' 같은 영상의
//        SSIM 하락 ≤ BACKFACE_MAX_SSIM_DROP(0.002). 24 시점 전부(예외 목록 없음).
//   뒷면 법선이면서 그려진 점의 리프 수는 진단 줄로 기록한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate as genTerrain, heightAt } from '../../../fixtures/scenes/terrain/index.mjs';
import { generate as genBoxes } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { generate as genBuildings } from '../../../fixtures/scenes/buildings/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { lambert } from '../../raster_ref/shade/index.mjs';
import { ssim } from '../../metrics/ssim/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { cameraCenter } from '../../lod/select/screen_error.mjs';
import { MAX_FALSE_REMOVALS, BACKFACE_MAX_SSIM_DROP } from '../../../contracts/cull/index.mjs';
import { buildDepthPyramid, occlusionCull } from '../occlusion/index.mjs';
import { leafNormalCones, backfaceCull, COVER_PYRAMID_SIZE } from './index.mjs';

const W = 320, H = 180;
const POINT_SIZE_M = 0.75;
const VP = JSON.parse(readFileSync(new URL('../../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8')).viewpoints;
const camOf = (vp) => viewpointToCamera({ ...vp, width: W, height: H });
const hier = (cloud) => buildHierarchy(cloud, { edge0M: 0.5, levelCount: 3, maxLeafPoints: 2048 });

// ---------- 원뿔 단위 시험 (c) ----------
const cloudOf = (pos, nrm) => ({ format: 1, count: pos.length / 3, positions: Float32Array.from(pos), normals: Float32Array.from(nrm), colors: new Uint8Array(pos.length) });
function planeCloud(n, normalAt) {
  const pos = [], nrm = [];
  for (let i = 0; i < n; i++) { pos.push((i % 10), 0, Math.floor(i / 10)); nrm.push(...normalAt(i)); }
  return cloudOf(pos, nrm);
}
const bigLeaf = (c) => buildHierarchy(c, { edge0M: 1, levelCount: 1, maxLeafPoints: 100000 });

test('원뿔: 평평한 리프는 axis=(0,1,0), cosHalf ≈ 1', () => {
  const h = bigLeaf(planeCloud(100, () => [0, 1, 0]));
  const c = leafNormalCones(h);
  assert.equal(h.octree.leafCount, 1);
  assert.ok(Math.abs(c.axis[1] - 1) < 1e-6 && Math.abs(c.axis[0]) < 1e-6);
  assert.ok(c.cosHalf[0] > 0.9999 && c.cosHalf[0] <= 1, `cosHalf=${c.cosHalf[0]}`);
});

test('원뿔: 완만하게 기운 법선이면 cosHalf 는 최소 내적보다 작거나 같다(보수적)', () => {
  const t = 0.3; // 약 17°
  const nrm = (i) => (i % 2 ? [Math.sin(t), Math.cos(t), 0] : [-Math.sin(t), Math.cos(t), 0]);
  const c = leafNormalCones(bigLeaf(planeCloud(100, nrm)));
  assert.ok(c.cosHalf[0] <= Math.cos(t) && c.cosHalf[0] > Math.cos(t) - 1e-3, `cosHalf=${c.cosHalf[0]}`);
});

test('원뿔: 반대 법선이 섞이면 cosHalf ≤ 0 근처(−1 에 가깝다)', () => {
  const c = leafNormalCones(bigLeaf(planeCloud(100, (i) => (i % 2 ? [0, 1, 0] : [0, -1, 0]))));
  assert.ok(c.cosHalf[0] <= 0, `cosHalf=${c.cosHalf[0]}`);
  assert.ok(c.cosHalf[0] >= -1);
  assert.ok(Math.abs(Math.hypot(c.axis[0], c.axis[1], c.axis[2]) - 1) < 1e-6, '축은 단위 길이');
});

test('원뿔: 길이 0 법선이 하나라도 있으면 cosHalf = −1', () => {
  const c = leafNormalCones(bigLeaf(planeCloud(100, (i) => (i === 37 ? [0, 0, 0] : [0, 1, 0]))));
  assert.equal(c.cosHalf[0], -1);
  assert.ok(Math.abs(Math.hypot(c.axis[0], c.axis[1], c.axis[2]) - 1) < 1e-6);
});

test('원뿔: 모든 점 법선이 n·axis ≥ cosHalf 를 만족한다(terrain 전 리프)', () => {
  const { cloud } = genTerrain({ seed: 2, count: 50000 });
  const h = hier(cloud);
  const c = leafNormalCones(h);
  const { normals, leafStart } = h.levels[0];
  for (let k = 0; k < h.octree.leafCount; k++) {
    for (let s = leafStart[k]; s < leafStart[k + 1]; s++) {
      const d = normals[3 * s] * c.axis[3 * k] + normals[3 * s + 1] * c.axis[3 * k + 1] + normals[3 * s + 2] * c.axis[3 * k + 2];
      assert.ok(d >= c.cosHalf[k], `리프 ${k} 점 ${s}: ${d} < ${c.cosHalf[k]}`);
    }
  }
});

// ---------- 기하 성질 시험: 제거 ⇒ 상자 안 모든 점에서 원뿔 안 모든 법선이 등짐 ----------
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const identityCam = (C) => ({ width: 64, height: 64, K: { fx: 60, fy: 60, cx: 32, cy: 32 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [-C[0], -C[1], -C[2]] });

test('성질: 무작위 원뿔·상자·카메라에서 제거된 리프는 표본 점·표본 법선 어디서도 앞면이 아니다', () => {
  const rnd = lcg(12345);
  const h = bigLeaf(planeCloud(100, () => [0, 1, 0])); // 상자는 점 분포 [0,9]×[0,0]×[0,9] 근처
  const node = h.octree.leafIndex.findIndex((v) => v === 0);
  const mn = [0, 1, 2].map((a) => h.octree.boxMin[3 * node + a]);
  const mx = [0, 1, 2].map((a) => h.octree.boxMax[3 * node + a]);
  let removedCount = 0, trials = 0;
  for (let it = 0; it < 4000; it++) {
    const z = rnd() * 2 - 1, ph = rnd() * 2 * Math.PI, r = Math.sqrt(1 - z * z);
    const ax = [r * Math.cos(ph), z, r * Math.sin(ph)];
    const cosHalf = 0.2 + rnd() * 0.79;
    const C = [(rnd() - 0.5) * 80, (rnd() - 0.5) * 80, (rnd() - 0.5) * 80];
    // 1단계(순수 법선 판정)의 기하 성질. 2단계는 1단계 후보의 부분집합만 남기므로 이 성질을 그대로 물려받는다.
    const mask = backfaceCull(h, identityCam(C), { axis: Float32Array.from(ax), cosHalf: Float32Array.of(cosHalf) }, { requireCover: false });
    trials++;
    if (mask[0] === 1) continue;
    removedCount++;
    // 원뿔 가장자리 법선(축에서 정확히 γ 만큼 기운 것)과 상자 표본 점으로 확인
    const g = Math.acos(cosHalf);
    const u = Math.abs(ax[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1 = [ax[1] * u[2] - ax[2] * u[1], ax[2] * u[0] - ax[0] * u[2], ax[0] * u[1] - ax[1] * u[0]];
    const l1 = Math.hypot(...e1); for (let a = 0; a < 3; a++) e1[a] /= l1;
    const e2 = [ax[1] * e1[2] - ax[2] * e1[1], ax[2] * e1[0] - ax[0] * e1[2], ax[0] * e1[1] - ax[1] * e1[0]];
    for (let q = 0; q < 60; q++) {
      const p = [0, 1, 2].map((a) => mn[a] + rnd() * (mx[a] - mn[a]));
      const v = [C[0] - p[0], C[1] - p[1], C[2] - p[2]];
      const w = rnd() * 2 * Math.PI;
      const n = [0, 1, 2].map((a) => Math.cos(g) * ax[a] + Math.sin(g) * (Math.cos(w) * e1[a] + Math.sin(w) * e2[a]));
      assert.ok(n[0] * v[0] + n[1] * v[1] + n[2] * v[2] < 0, `제거됐는데 앞면 표본 존재 (it=${it})`);
    }
  }
  assert.ok(removedCount >= 300, `제거 사례가 너무 적어 시험이 약함: ${removedCount}/${trials}`);
});

// ---------- 1단계 경계 사례: f 가 0 근처일 때 ----------
// 판정식: 상자를 BOX_PAD 만큼 부풀린 8 꼭짓점 모두에서 f(p) = axis·(C−p) + s·|C−p| < −F_MARGIN 일 때만 후보(s = sinγ + 1e-6).
// 아래 값은 index.mjs 의 정의값(1e-3 m)을 일부러 그대로 적는다(모듈 상수를 가져오면 상수 변이가 시험 쪽 계산도 바꿔 버린다).
// 근거: 부풀린 상자 꼭짓점에서 f ≥ 0 이면 상자 경계(반올림 오차 이내)의 점이 카메라를 향할 수 있으므로 반드시 남긴다.
const SPEC_BOX_PAD = 1e-3, SPEC_F_MARGIN = 1e-3;
const TILT = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)]; // 세 축 모두 기울여 부풀림이 f 를 √3·1e-3 만큼 바꾸게 한다
function fMaxOverBox(h, axis, cosHalf, C, pad) {
  const node = h.octree.leafIndex.findIndex((v) => v === 0);
  const sg = Math.sqrt(Math.max(0, 1 - cosHalf * cosHalf)) + 1e-6;
  let m = -Infinity;
  for (let v = 0; v < 8; v++) {
    const p = [0, 1, 2].map((a) => ((v >> a) & 1 ? h.octree.boxMax[3 * node + a] + pad : h.octree.boxMin[3 * node + a] - pad));
    const d = [C[0] - p[0], C[1] - p[1], C[2] - p[2]];
    m = Math.max(m, axis[0] * d[0] + axis[1] * d[1] + axis[2] * d[2] + sg * Math.hypot(...d));
  }
  return m;
}
// 카메라를 상자 아래쪽 대각선(−TILT 방향) 위에서 움직여 부풀린 상자의 f 최댓값이 target 이 되는 자리를 이분법으로 찾는다.
function cameraForF(h, axis, cosHalf, target) {
  const node = h.octree.leafIndex.findIndex((v) => v === 0);
  const base = [0, 1, 2].map((a) => h.octree.boxMin[3 * node + a]);
  const at = (tt) => [base[0] - TILT[0] * tt, base[1] - TILT[1] * tt, base[2] - TILT[2] * tt];
  let lo = 0, hi = 20; // tt 가 클수록 f 가 작아진다(뒤로 멀어짐)
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (fMaxOverBox(h, axis, cosHalf, at(mid), SPEC_BOX_PAD) > target) lo = mid; else hi = mid; }
  return at(lo);
}

test('1단계 경계: 부풀린 상자의 f 최댓값이 0 근처 양수이거나 (−F_MARGIN, 0) 이면 남기고, 확실히 음수면 후보', () => {
  const h = bigLeaf(planeCloud(100, () => [0, 1, 0]));
  const cosHalf = Math.fround(0.999);
  const cones = { axis: Float32Array.from(TILT), cosHalf: Float32Array.of(cosHalf) };
  const pure = { requireCover: false };
  const axis = [...cones.axis];
  const cases = [
    // [target f(부풀린 상자), 기대 마스크, 설명]
    [2e-4, 1, 'f 가 0 근처 양수 → 남김'],
    [1.5e-3, 1, 'f 가 F_MARGIN 보다 큰 양수 → 남김'],
    [-5e-4, 1, 'f 가 음수지만 −F_MARGIN 보다 크다 → 남김'],
    [-3e-3, 0, 'f 가 확실히 음수 → 후보'],
  ];
  for (const [target, want, why] of cases) {
    const C = cameraForF(h, axis, cosHalf, target);
    const fPad = fMaxOverBox(h, axis, cosHalf, C, SPEC_BOX_PAD);
    assert.ok(Math.abs(fPad - target) < 1e-6, `${why}: 이분법이 목표 f 에 닿지 못함 (${fPad})`);
    if (target > -SPEC_F_MARGIN && target < 1e-3) {
      // 부풀림이 판정을 바꾸는 사례인지 확인(부풀리지 않으면 확실히 음수) — BOX_PAD 를 지키는 시험이 되도록
      assert.ok(fMaxOverBox(h, axis, cosHalf, C, 0) < -SPEC_F_MARGIN, `${why}: 부풀리지 않은 상자에서는 후보여야 시험이 의미 있음`);
    }
    assert.equal(backfaceCull(h, identityCam(C), cones, pure)[0], want, `${why} (f=${fPad.toExponential(3)})`);
  }
});

test('카메라가 리프 상자 안이면 제거하지 않는다(축이 어느 쪽이든)', () => {
  const h = bigLeaf(planeCloud(100, () => [0, 1, 0]));
  const cones = { axis: Float32Array.of(0, 1, 0), cosHalf: Float32Array.of(0.999) };
  for (const C of [[4, 0, 4], [0, 0, 0], [9, 0, 9]]) {
    assert.equal(backfaceCull(h, identityCam(C), cones)[0], 1);
    assert.equal(backfaceCull(h, identityCam(C), cones, { requireCover: false })[0], 1);
  }
});

test('카메라가 지면 아래(앞면 법선이 위)이고 평평한 리프면 1단계 후보, 위면 남김', () => {
  const h = bigLeaf(planeCloud(100, () => [0, 1, 0]));
  const cones = leafNormalCones(h);
  const pure = { requireCover: false };
  assert.equal(backfaceCull(h, identityCam([4, -5, 4]), cones, pure)[0], 0, '아래에서 본 위쪽 법선 평면');
  assert.equal(backfaceCull(h, identityCam([4, 5, 4]), cones, pure)[0], 1, '위에서 본 평면');
  assert.equal(backfaceCull(h, identityCam([4, -5, 4]), { axis: cones.axis, cosHalf: Float32Array.of(-1) }, pure)[0], 1, '전체 구 원뿔은 절대 제거 안 함');
  // 2단계: 앞을 가리는 점이 하나도 없으므로(리프 하나뿐) 등진 평면도 참조 래스터에 그려진다 → 남긴다.
  assert.equal(backfaceCull(h, identityCam([4, -5, 4]), cones, { pointSizeM: 0.3 })[0], 1, '덮는 앞면이 없으면 등져도 남김');
});

// 2단계 단위 시험: 위쪽 법선 평면 둘(y=0 '바닥' 과 y=−2 '아래층'). 카메라가 둘 사이 아래(y=−5)에서 위를 보면 둘 다 등진다.
// 앞면 가림막을 넣으려고, 카메라와 두 평면 사이(y=−3.5)에 아래 법선(카메라 쪽) 의 촘촘한 판을 둔다.
// 판이 두 평면의 화면 영역을 확실히 덮을 만큼 넓고 촘촘하면 두 평면 리프는 버려지고, 판을 빼면 하나도 버려지지 않는다.
function layered(withPlate) {
  const pos = [], nrm = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) { pos.push(i, 0, j); nrm.push(0, 1, 0); pos.push(i, -2, j); nrm.push(0, 1, 0); }
  if (withPlate) for (let i = -40; i <= 130; i++) for (let j = -40; j <= 130; j++) { pos.push(i * 0.1, -3.5, j * 0.1); nrm.push(0, -1, 0); }
  return buildHierarchy(cloudOf(pos, nrm), { edge0M: 0.5, levelCount: 1, maxLeafPoints: 64 });
}
const upCam = (C) => ({ width: 64, height: 64, K: { fx: 30, fy: 30, cx: 32, cy: 32 }, R: [1, 0, 0, 0, 0, -1, 0, 1, 0], t: [-C[0], C[2], -C[1]] });

test('2단계: 등진 리프는 앞면 점으로 확실히 덮일 때만 버린다(덮개 없으면 0개, 있으면 등진 리프 일부 이상)', () => {
  const C = [4.5, -5, 4.5];
  for (const withPlate of [false, true]) {
    const h = layered(withPlate);
    const cones = leafNormalCones(h);
    const cam = upCam(C);
    const pure = backfaceCull(h, cam, cones, { requireCover: false, pointSizeM: 0.3 });
    const cov = backfaceCull(h, cam, cones, { pointSizeM: 0.3 });
    // 점 지름을 주지 않으면 덮임을 확인할 수 없으므로 아무것도 버리지 않는다(판이 있어도).
    assert.ok(backfaceCull(h, cam, cones).every((x) => x === 1), `pointSizeM 없음 → 제거 0 (판 ${withPlate})`);
    assert.ok(backfaceCull(h, cam, cones, {}).every((x) => x === 1), `opts 에 pointSizeM 없음 → 제거 0 (판 ${withPlate})`);
    let nPure = 0, nCov = 0;
    for (let k = 0; k < pure.length; k++) {
      if (!pure[k]) nPure++;
      if (!cov[k]) { nCov++; assert.equal(pure[k], 0, `2단계 제거 ${k} 는 1단계 후보여야 함`); }
    }
    assert.ok(nPure > 0, `1단계 후보가 있어야 시험이 의미 있음 (판 ${withPlate})`);
    if (!withPlate) assert.equal(nCov, 0, '덮개가 없으면 아무것도 버리지 않음');
    else assert.ok(nCov > 0, `덮개가 있으면 버려야 함: ${nCov}/${nPure}`);
    // 버린 리프의 점은 참조 래스터에서 그려지지 않는다
    const r = renderPoints(cam, h.cloud, { pointSizeM: 0.3 });
    const lo = leafOfPoint(h);
    for (const p of r.index) if (p >= 0) assert.equal(cov[lo[p]], 1, `그려진 점 ${p} 의 리프가 버려짐`);
  }
});

test('pointSizeM 을 주지 않으면 덮임을 확인할 수 없으므로 2단계 후보를 전부 남긴다(지름 0.05 m 로 덮이는 장면에서도)', () => {
  // layered(true) 를 1/10 로 줄인 장면: 판 점 간격 0.01 m 라 지름 0.05 m 원판이면 두 평면을 덮는다.
  const pos = [], nrm = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) { pos.push(i * 0.1, 0, j * 0.1); nrm.push(0, 1, 0); pos.push(i * 0.1, -0.2, j * 0.1); nrm.push(0, 1, 0); }
  for (let i = -40; i <= 130; i++) for (let j = -40; j <= 130; j++) { pos.push(i * 0.01, -0.35, j * 0.01); nrm.push(0, -1, 0); }
  const h = buildHierarchy(cloudOf(pos, nrm), { edge0M: 0.05, levelCount: 1, maxLeafPoints: 64 });
  const cones = leafNormalCones(h);
  const cam = upCam([0.45, -0.5, 0.45]);
  const removed = (m) => m.reduce((a, x) => a + (1 - x), 0);
  assert.ok(removed(backfaceCull(h, cam, cones, { pointSizeM: 0.05 })) > 0, '지름 0.05 를 주면 덮여서 버려야 시험이 의미 있음');
  assert.equal(removed(backfaceCull(h, cam, cones)), 0, 'opts 없음 → 제거 0');
  assert.equal(removed(backfaceCull(h, cam, cones, { marginDeg: 0 })), 0, 'pointSizeM 없음 → 제거 0');
  assert.ok(removed(backfaceCull(h, cam, cones, { requireCover: false })) > 0, '1단계만 쓰면 지름이 필요 없다');
});

// ---------- 입력 오류·퇴화 시점 ----------
test('입력 오류는 cull: 로 시작한다', () => {
  const h = bigLeaf(planeCloud(10, () => [0, 1, 0]));
  const cones = leafNormalCones(h);
  const cam = identityCam([0, 5, 0]);
  const bad = (f) => assert.throws(f, /^Error: cull:/);
  bad(() => leafNormalCones(null));
  bad(() => leafNormalCones({}));
  bad(() => backfaceCull(null, cam, cones));
  bad(() => backfaceCull(h, cam, null));
  bad(() => backfaceCull(h, cam, { axis: new Float32Array(6), cosHalf: new Float32Array(2) }));
  bad(() => backfaceCull(h, cam, { axis: [0, 1, 0], cosHalf: [1] }));
  bad(() => backfaceCull(h, cam, cones, { pointSizeM: 0 }));
  bad(() => backfaceCull(h, cam, cones, { pointSizeM: NaN }));
  bad(() => backfaceCull(h, cam, cones, { requireCover: 1 }));
  bad(() => backfaceCull(h, cam, cones, { pointSizeM: null }));
  bad(() => backfaceCull(h, cam, cones, { pointSizeM: '0.75' }));
});

test('퇴화 시점: NaN·Infinity·해상도 0·R 비회전이면 던지지 않고 전부 0', () => {
  const h = bigLeaf(planeCloud(10, () => [0, 1, 0]));
  const cones = leafNormalCones(h);
  const base = identityCam([0, 5, 0]);
  const cams = [
    { ...base, t: [NaN, 0, 0] },
    { ...base, t: [Infinity, 0, 0] },
    { ...base, R: [NaN, 0, 0, 0, 1, 0, 0, 0, 1] },
    { ...base, R: [2, 0, 0, 0, 1, 0, 0, 0, 1] },
    { ...base, width: 0 },
    { ...base, K: { ...base.K, fx: 0 } },
    { ...base, K: { ...base.K, fy: NaN } },
  ];
  for (const c of cams) {
    let m;
    assert.doesNotThrow(() => { m = backfaceCull(h, c, cones); });
    assert.equal(m.length, h.octree.leafCount);
    assert.ok(m.every((x) => x === 0), '퇴화 시점은 빈 마스크');
  }
});

// ---------- 합성 장면 × 시점 8곳 ----------
// terrain 은 높이 1~29 m 의 언덕이라 flat_boxes 용 시점(지면 y=0 기준)의 낮은 눈높이가 지표 '아래'에 놓인다. 지표 아래에서 위로 향한
// 법선의 면을 보면 윗면이 전부 뒷면이라, 뒷면 제거가 장면을 지우는 것이 맞고(영상 비교가 무의미) 별도 시험으로 다룬다.
// 그래서 terrain 시점은 눈 높이를 지표 위 1.7 m 이상으로 올려 쓴다(TERRAIN_EYE_M).
const TERRAIN_EYE_M = 1.7;
const terrain = genTerrain({ seed: 1, count: 200000 });
const terrainParams = terrain.truth.heightAt.params;
const liftEye = (vp) => ({ ...vp, eye: [vp.eye[0], Math.max(vp.eye[1], heightAt(terrainParams, vp.eye[0], vp.eye[2]) + TERRAIN_EYE_M), vp.eye[2]] });
const SCENES = [
  ['terrain', () => terrain.cloud, { lift: true, minRemovedDefault: { street_level: 1, low_close_box: 1 } }],
  ['flat_boxes', () => genBoxes({ seed: 1, count: 200000 }).cloud, { minRemovedDefault: { low_close_box: 1 } }],
  // buildings 는 법선이 전부 위(+y)인 지붕·지면 점뿐이다(벽 없음). 눈높이가 지붕보다 낮은 시점은 '아래에서 올려다본' 영상이라 그려진 점이 전부 뒷면이다.
  // 1단계(순수 법선)는 이 시점들에서 장면 절반을 지우므로 2단계(덮임)가 그대로 남기는지가 SSIM 단언으로 확인된다(예외 목록 없음).
  // minRemovedStreet 는 1단계가 실제로 일을 하는지 보는 하한이다.
  ['buildings', () => genBuildings({ seed: 1, count: 20000 }).cloud, { minRemovedStreet: 10 }],
];
const SSIM_DROP_MAX = BACKFACE_MAX_SSIM_DROP; // 0.002, 사후 조정 없음
// minRemovedDefault: 기본 마스크(2단계 포함)의 제거 하한. 측정 전에 1 로 정했다. 근거: 이 시점들은 등진 면(상자 뒷면, 언덕 뒷사면)이
// 앞면 점 뒤에 있는 구도라 덮임 판정이 하나라도 버려야 2단계가 일을 한다는 뜻이고, 1 보다 큰 값은 측정 없이 정할 근거가 없다.
// buildings 는 벽이 없어(법선 전부 +y) 낮은 시점에서 등진 지붕을 가릴 앞면 점이 없으므로 구조적으로 0 이라 하한을 걸지 않는다.
// '덮임 판정이 항상 안 덮임' 변이(아무것도 버리지 않음)를 장면 시험에서 잡는 것이 목적이다.
const LOW_VIEWS = ['street_level', 'low_close_box', 'edge_far'];

function leafOfPoint(h) {
  const out = new Int32Array(h.cloud.count);
  const { indices, leafStart } = h.levels[0];
  for (let k = 0; k < h.octree.leafCount; k++) for (let s = leafStart[k]; s < leafStart[k + 1]; s++) out[indices[s]] = k;
  return out;
}

// 점마다 머리등 램버트(광원 = 점→카메라 방향, 주변광 0.3). 뒷면은 주변광만 남아 어둡다.
function headlightColors(cloud, C) {
  const colors = new Uint8Array(3 * cloud.count);
  for (let i = 0; i < cloud.count; i++) {
    const l = [C[0] - cloud.positions[3 * i], C[1] - cloud.positions[3 * i + 1], C[2] - cloud.positions[3 * i + 2]];
    if (!(Math.hypot(...l) > 0)) { colors.set(cloud.colors.subarray(3 * i, 3 * i + 3), 3 * i); continue; }
    const n = [cloud.normals[3 * i], cloud.normals[3 * i + 1], cloud.normals[3 * i + 2]];
    const rgb = Math.hypot(...n) > 0 ? lambert(n, l, [cloud.colors[3 * i], cloud.colors[3 * i + 1], cloud.colors[3 * i + 2]]) : [cloud.colors[3 * i], cloud.colors[3 * i + 1], cloud.colors[3 * i + 2]];
    colors.set(rgb, 3 * i);
  }
  return colors;
}
function subsetCloud(cloud, colors, keep) {
  let n = 0;
  for (let i = 0; i < cloud.count; i++) if (keep(i)) n++;
  const positions = new Float32Array(3 * n), normals = new Float32Array(3 * n), col = new Uint8Array(3 * n);
  for (let i = 0, o = 0; i < cloud.count; i++) {
    if (!keep(i)) continue;
    positions.set(cloud.positions.subarray(3 * i, 3 * i + 3), 3 * o);
    normals.set(cloud.normals.subarray(3 * i, 3 * i + 3), 3 * o);
    col.set(colors.subarray(3 * i, 3 * i + 3), 3 * o);
    o++;
  }
  return { format: 1, count: n, positions, normals, colors: col };
}

const backDot = (cloud, C, i) => (C[0] - cloud.positions[3 * i]) * cloud.normals[3 * i] + (C[1] - cloud.positions[3 * i + 1]) * cloud.normals[3 * i + 1] + (C[2] - cloud.positions[3 * i + 2]) * cloud.normals[3 * i + 2];

for (const [name, make, opt] of SCENES) {
  let cache;
  const get = () => {
    if (!cache) {
      const cloud = make();
      const h = hier(cloud);
      cache = { cloud, h, cones: leafNormalCones(h), leafOf: leafOfPoint(h) };
    }
    return cache;
  };
  const viewCache = new Map();
  // 시점마다 한 번: 1단계 마스크(pure), 기본 마스크(2단계 포함, 렌더와 같은 점 지름), 참조 렌더
  const view = (vp) => {
    if (!viewCache.has(vp.name)) {
      const { cloud, h, cones } = get();
      const cam = camOf(opt.lift ? liftEye(vp) : vp);
      viewCache.set(vp.name, {
        cam,
        C: cameraCenter(cam),
        pure: backfaceCull(h, cam, cones, { requireCover: false }),
        mask: backfaceCull(h, cam, cones, { pointSizeM: POINT_SIZE_M }),
        r: renderPoints(cam, cloud, { pointSizeM: POINT_SIZE_M }),
      });
    }
    return viewCache.get(vp.name);
  };
  const countRemoved = (m) => m.reduce((a, x) => a + (x === 0 ? 1 : 0), 0);

  for (const vp of VP) {
    // ① 불변식(todo 없음): 1단계 기하 불변식 + 2단계 '버린 리프의 점은 참조 래스터에서 그려지지 않음'.
    test(`${name}: 시점 ${vp.id} ${vp.name} 불변식 — 제거 리프에 앞면 점 0, 앞면으로 그려진 점의 리프 제거 0, 기본 마스크의 제거 리프는 그려진 점 0`, (t) => {
      const { cloud, h, leafOf } = get();
      const { C, pure, mask, r } = view(vp);
      const L = h.octree.leafCount;
      // 2단계는 1단계 후보의 부분집합만 버린다
      for (let k = 0; k < L; k++) if (mask[k] === 0) assert.equal(pure[k], 0, `${name} ${vp.name}: 리프 ${k} 는 1단계 후보가 아닌데 제거됨`);
      // 1단계: 제거된 리프의 점은 하나도 앞면이 아니다(점 단위 기하 불변식, 래스터와 무관)
      for (let i = 0; i < cloud.count; i++) {
        if (pure[leafOf[i]] === 1) continue;
        const d = backDot(cloud, C, i);
        assert.ok(d < 0, `${name} ${vp.name}: 제거 리프에 앞면 점 ${i} (n·v=${d})`);
      }
      const seen = new Set();
      const falsePure = new Set(), drawnRemoved = new Set(), backDrawnLeaves = new Set(), backDrawnPure = new Set();
      for (const p of r.index) {
        if (p < 0 || seen.has(p)) continue;
        seen.add(p);
        const k = leafOf[p];
        if (backDot(cloud, C, p) < 0) { backDrawnLeaves.add(k); if (!pure[k]) backDrawnPure.add(k); } else if (!pure[k]) falsePure.add(k);
        if (!mask[k]) drawnRemoved.add(k);
      }
      const removedPure = countRemoved(pure), removed = countRemoved(mask);
      const line = `${name} ${vp.name}: 1단계 제거 ${removedPure}/${L}, 기본(2단계) 제거 ${removed}/${L}, 뒷면으로 그려진 점의 리프 ${backDrawnLeaves.size}개 중 1단계 제거 ${backDrawnPure.size}개, 기본 마스크로 그려진 점이 있는 제거 리프 ${drawnRemoved.size}개`;
      t.diagnostic(line);
      assert.ok(falsePure.size <= MAX_FALSE_REMOVALS, `1단계 거짓 제거 ${falsePure.size}: ${line}`);
      assert.ok(drawnRemoved.size <= MAX_FALSE_REMOVALS, `기본 마스크 거짓 제거 ${drawnRemoved.size}: ${line}`);
      if (LOW_VIEWS.includes(vp.name) && opt.minRemovedStreet) {
        // 지표 아래·옆 시점의 1단계 제거율 하한(측정 전에 정한 느슨한 값: 법선 판정이 실제로 일을 하는지만 본다)
        assert.ok(removedPure >= opt.minRemovedStreet, `1단계 제거가 너무 적음: ${line}`);
      }
      const minDefault = opt.minRemovedDefault?.[vp.name];
      if (minDefault !== undefined) assert.ok(removed >= minDefault, `기본 마스크 제거가 하한 ${minDefault} 미만: ${line}`);
      // 가림막 제한(후보 사각형과 겹치는 앞쪽 리프만 투영)은 전체 가림막으로 만든 피라미드와 결과가 같아야 한다.
      const full = new Uint8Array(L).fill(1);
      if (removedPure > 0) {
        const pyr = buildDepthPyramid(h, view(vp).cam, { size: COVER_PYRAMID_SIZE, pointSizeM: POINT_SIZE_M, occluderLevel: 0, occluderMask: pure });
        const hid = occlusionCull(h, view(vp).cam, pyr);
        for (let k = 0; k < L; k++) if (pure[k] === 0 && hid[k] === 0) full[k] = 0;
      }
      assert.deepEqual([...mask], [...full], `${name} ${vp.name}: 가림막 제한 결과가 전체 가림막 결과와 다름`);
    });
    // ② 완료 기준(todo 없음): 기본 마스크의 SSIM 하락 ≤ 0.002.
    test(`${name}: 시점 ${vp.id} ${vp.name} SSIM 하락 ≤ ${SSIM_DROP_MAX} (기본 마스크, 점 지름 ${POINT_SIZE_M} m)`, (t) => {
      const { cloud, h, leafOf } = get();
      const { cam, C, mask } = view(vp);
      const L = h.octree.leafCount;
      const removed = countRemoved(mask);
      const col = headlightColors(cloud, C);
      const imgA = renderPoints(cam, { ...cloud, colors: col }, { pointSizeM: POINT_SIZE_M });
      const kept = subsetCloud(cloud, col, (i) => mask[leafOf[i]] === 1);
      const imgB = renderPoints(cam, kept, { pointSizeM: POINT_SIZE_M });
      const s = ssim(imgA.color, imgB.color, W, H, 3);
      const line = `${name} ${vp.name}: 제거 ${removed}/${L} (${(100 * removed / L).toFixed(1)}%), 점 ${cloud.count - kept.count}/${cloud.count} 제거, SSIM 하락 ${(1 - s).toExponential(2)}`;
      t.diagnostic(line);
      assert.ok(1 - s <= SSIM_DROP_MAX, line);
    });
  }
}

test('terrain 지표 아래 시점(원래 street_level 눈높이 1.7 m): 위쪽 법선 면이 전부 뒷면이라 1단계는 많이 제거하고 앞면 점은 하나도 제거하지 않으며, 기본 마스크는 그려진 점이 있는 리프를 버리지 않는다', (t) => {
  const cloud = terrain.cloud;
  const h = hier(cloud);
  const cones = leafNormalCones(h);
  const vp = VP.find((v) => v.name === 'street_level');
  assert.ok(vp.eye[1] < heightAt(terrainParams, vp.eye[0], vp.eye[2]), '이 시점은 지표 아래여야 함');
  const cam = camOf(vp);
  const C = cameraCenter(cam);
  const m = backfaceCull(h, cam, cones, { requireCover: false });
  const mc = backfaceCull(h, cam, cones, { pointSizeM: POINT_SIZE_M });
  const leafOf = leafOfPoint(h);
  let removed = 0, removedCover = 0;
  for (const x of m) if (!x) removed++;
  for (const x of mc) if (!x) removedCover++;
  t.diagnostic(`terrain 지표 아래: 1단계 제거 ${removed}/${m.length}, 기본 제거 ${removedCover}/${m.length}`);
  assert.ok(removed >= 100, `제거 ${removed}`);
  for (let i = 0; i < cloud.count; i++) {
    if (m[leafOf[i]] === 1) continue;
    assert.ok(backDot(cloud, C, i) < 0, `앞면 점 ${i} 제거됨`);
  }
  const r = renderPoints(cam, cloud, { pointSizeM: POINT_SIZE_M });
  for (const p of r.index) if (p >= 0) assert.equal(mc[leafOf[p]], 1, `그려진 점 ${p} 의 리프가 기본 마스크에서 버려짐`);
});

test('항공 시점(지표 위)에서는 terrain 의 평평한 리프를 하나도 버리지 않는다', () => {
  const h = hier(terrain.cloud);
  const cones = leafNormalCones(h);
  for (const name of ['aerial_overview', 'aerial_oblique_ne', 'top_down']) {
    const vp = VP.find((v) => v.name === name);
    for (const o of [{ requireCover: false }, { pointSizeM: POINT_SIZE_M }]) {
      const m = backfaceCull(h, camOf(vp), cones, o);
      assert.equal(m.reduce((a, b) => a + (1 - b), 0), 0, name);
    }
  }
});
