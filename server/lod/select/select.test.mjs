// T07.4 단계 선택 시험. 고정 시점 8곳(fixtures/viewpoints/synthetic.json, 장면 flat_boxes) 에서
// 참조 래스터라이저로 원본 렌더와 LOD 렌더를 비교해 시점마다 SSIM ≥ 0.95 를 단언한다(기준을 낮추지 않는다).
//
// 고정 파라미터와 근거(시험 리터럴):
//   N = 200000          flat_boxes 기본 점 수.
//   EDGE0_M = 0.5       단계 0 칸 한 변 = 원본 평균 점 간격 s0. flat_boxes 의 표면적 A ≈ 바닥 40000 m² + 벽면
//                       (시드 1: 57419 m², 시드 2·3: 59513·53641 m²) 이므로 s0 = √(A/N) ≈ 0.52~0.55 m.
//                       계약의 "단계 l 은 edge0M·2^l 칸당 1점" 이 원본에도 맞으려면 edge0M ≈ s0 여야 한다.
//                       더 작게(예 0.25) 두면 단계 1 칸(0.5 m)이 원본 간격과 같아 실제로는 거의 줄지 않으면서
//                       대표점·평균색 교체만 일어난다(아래 "조정 기록" 참조). s0 보다 조금 작은 0.5 로 내림(보수적).
//   THRESHOLD_PX = 0.5  τ. 표본화 정리(나이퀴스트): 칸이 화면에서 반 픽셀 이하이면 모든 픽셀이 적어도 한 칸을 통째로 품으므로
//                       대표점이 칸 안 어디에 있든 원본이 덮던 픽셀에 빈칸이 생기지 않는다. τ = 1 이면 칸 ≈ 픽셀이어서
//                       대표점 위치에 따라 픽셀이 비거나 두 점이 겹친다(구멍).
//   POINT_SIZE_M = 0.75 원본·LOD 모두 같은 고정값. 원본 간격 s0 ≈ 0.53 m 의 대각(√2·s0 ≈ 0.75)을 덮는 지름이라 가까운 시점에서도
//                       원본 표면에 구멍이 적다. 단계에 따라 키우지 않는 이유: τ ≤ 0.5 px 이면 고른 단계의 칸이 화면에서
//                       반 픽셀 이하라 최소 1 픽셀 원판으로 이미 덮인다. 키우면 LOD 쪽만 번져 원본과 다른 렌더 설정이 되어
//                       비교가 불공정해진다(같은 래스터라이저·같은 설정으로 점 집합만 다르게 둔다).
//   해상도 320×180     1280×720 은 시점당 원본 렌더+SSIM 이 수 초라 느리다. K 는 viewpointToCamera 가 같은 fov 로 다시 계산한다
//                       (fx ≈ 193 px). 해상도를 줄이면 f 가 작아져 같은 τ 에서 더 거친 단계를 고르므로 LOD 쪽에 불리한 조건이다.
//   LEVEL_COUNT = 6, MAX_LEAF = 2048.
//
// 조정 기록(시점 8곳 SSIM, 같은 고정 점 크기 0.6 m 기준 탐색):
//   edge0M 0.25, τ 1    : top_down 0.637, aerial_overview 0.887, tower_high 0.924 등 미달(구멍 + 평균색).
//   edge0M 0.25, τ 0.5  : top_down 0.923 만 미달. 단계 1(0.5 m) 이 원본 간격과 같아 점은 1/3 만 줄고 픽셀 승자·색만 바뀜.
//   edge0M 0.5,  τ 1    : top_down 0.645 미달.   edge0M 0.35, τ 0.75 : top_down 0.811 미달.
//   단계별로 원판을 키워도(√2·edgeM) τ 1 에서 top_down 0.717 로 미달 → 원인은 구멍보다 텍스처(0.5 m 잡음 칸)의 앨리어싱.
//   → 이론값 edge0M = s0(0.5), τ = 0.5 를 채택. 이때 고정 시점 8곳은 모두 거리표의 단계 0 구간(d < f·2·edge0M/τ ≈ 386 m)
//     이라 점 감소는 시야 밖 리프 제외에서 온다. 단계 ≥1 이 실제로 쓰이는 것은 "멀어지면 점 수 감소" 시험이 확인한다.
//
// 주의(F-096): 위 '시점 8곳' 시험에서는 거친 단계(level ≥ 1)가 쓰이지 않는다 → 단계 선택은 이 시험들에서 '해당 없음'
//   (미달이 아님). 선택이 전부 단계 0 이면 렌더가 원본과 같아 SSIM 이 1.0 으로 단계 선택을 시험하지 못한다.
//   거친 단계가 쓰이는 조건의 SSIM 은 아래 '거친 단계 시점' 시험(aerial_overview 를 3·4·6 배 멀리, 같은 320×180)과
//   select_coarse.test.mjs(terrain 시드 1~4)가 단언한다. 거친 단계가 쓰였는지는 구조(단계≥1 리프 존재, 점 비율 상한)로 단언하고
//   단계 수치는 좁게 박지 않는다. 단계 선택을 0 으로 고정한 가짜 변이는 음성 시험이 실패로 잡는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { renderPoints } from '../../raster_ref/zbuffer/index.mjs';
import { ssim } from '../../metrics/ssim/index.mjs';
import { NOT_DRAWN, edgeOfLevel } from '../../../contracts/lod/index.mjs';
import { buildHierarchy as buildHierarchyOrig } from '../hierarchy/index.mjs';
import { buildHierarchy, selectLevels, materialize } from './index.mjs';

const N = 200000;
const EDGE0_M = 0.5;
const THRESHOLD_PX = 0.5;
const POINT_SIZE_M = 0.75;
const W = 320;
const H = 180;
const LEVEL_COUNT = 6;
const MAX_LEAF = 2048;
const SSIM_MIN = 0.95;

const VP = JSON.parse(readFileSync(new URL('../../../fixtures/viewpoints/synthetic.json', import.meta.url), 'utf8')).viewpoints;

let cached;
function scene() {
  if (!cached) {
    const { cloud } = generate({ seed: 1, count: N });
    cached = { cloud, h: buildHierarchy(cloud, { edge0M: EDGE0_M, levelCount: LEVEL_COUNT, maxLeafPoints: MAX_LEAF }) };
  }
  return cached;
}
const camOf = (vp) => viewpointToCamera({ ...vp, width: W, height: H });

// 리프 k 의 노드 번호
function leafNodes(oc) {
  const out = new Int32Array(oc.leafCount);
  for (let node = 0; node < oc.nodeCount; node++) if (oc.leafIndex[node] >= 0) out[oc.leafIndex[node]] = node;
  return out;
}

test('buildHierarchy 는 hierarchy 모듈의 것을 그대로 다시 내보낸다', () => {
  assert.equal(buildHierarchy, buildHierarchyOrig);
});

test('시점 8곳 수와 장면', () => {
  assert.equal(VP.length, 8);
});

const table = [];
for (const vp of VP) {
  test(`SSIM ≥ ${SSIM_MIN}: 시점 ${vp.id} ${vp.name}`, (t) => {
    const { cloud, h } = scene();
    const cam = camOf(vp);
    const sel = selectLevels(h, cam, { thresholdPx: THRESHOLD_PX });
    const lod = materialize(h, sel);
    assert.equal(lod.count, sel.pointCount);
    const a = renderPoints(cam, cloud, { pointSizeM: POINT_SIZE_M });
    const b = renderPoints(cam, lod, { pointSizeM: POINT_SIZE_M });
    const s = ssim(a.color, b.color, W, H, 3);
    const ratio = lod.count / cloud.count;
    const used = new Array(LEVEL_COUNT).fill(0);
    let notDrawn = 0;
    for (const l of sel.leafLevel) if (l === NOT_DRAWN) notDrawn++; else used[l]++;
    const line = `시점 ${vp.id} ${vp.name}: SSIM ${s.toFixed(4)}, 점 비율 ${ratio.toFixed(3)} (${lod.count}/${cloud.count}), 리프 단계 분포 ${used.join('/')}, 안 그림 ${notDrawn}`;
    t.diagnostic(line);
    table.push(line);
    assert.ok(s >= SSIM_MIN, line);
    assert.ok(ratio <= 1);
  });
}

// 구조 단언: 단계 ≥ 1 인 리프가 있고 고른 점 수가 원본의 maxRatio 이하. 단계 0 강제 변이는 이를 통과하지 못한다.
function assertCoarseUsed(h, sel, total, maxRatio, label) {
  let coarseLeaves = 0;
  for (const l of sel.leafLevel) if (l !== NOT_DRAWN && l >= 1) coarseLeaves++;
  assert.ok(coarseLeaves > 0, `${label}: 단계 ≥ 1 리프 없음`);
  assert.ok(sel.pointCount / total <= maxRatio, `${label}: 점 비율 ${(sel.pointCount / total).toFixed(3)} > ${maxRatio}`);
}
// 단계 선택을 0 으로 고정한 가짜 선택(시야 밖 판정은 유지)
function forceLevel0(h, sel) {
  const leafLevel = Uint8Array.from(sel.leafLevel, (l) => (l === NOT_DRAWN ? NOT_DRAWN : 0));
  let pointCount = 0;
  for (let k = 0; k < leafLevel.length; k++) if (leafLevel[k] !== NOT_DRAWN) pointCount += h.levels[0].leafStart[k + 1] - h.levels[0].leafStart[k];
  return { leafLevel, pointCount };
}

// 거친 단계가 실제로 쓰이는 시점: 멀리 간 aerial_overview. 시점 8곳과 달리 SSIM 이 단계 선택을 시험한다.
for (const f of [3, 4, 6]) {
  test(`거친 단계 시점: aerial_overview ×${f} 에서 단계≥1 사용, 점 비율 ≤ 0.5, SSIM ≥ ${SSIM_MIN}`, (t) => {
    const { cloud, h } = scene();
    const vp = VP.find((v) => v.name === 'aerial_overview');
    const eye = vp.eye.map((e, a) => vp.target[a] + f * (e - vp.target[a]));
    const cam = camOf({ ...vp, eye });
    const sel = selectLevels(h, cam, { thresholdPx: THRESHOLD_PX });
    assertCoarseUsed(h, sel, cloud.count, 0.5, `×${f}`);
    const lod = materialize(h, sel);
    const s = ssim(renderPoints(cam, cloud, { pointSizeM: POINT_SIZE_M }).color, renderPoints(cam, lod, { pointSizeM: POINT_SIZE_M }).color, W, H, 3);
    t.diagnostic(`×${f}: SSIM ${s.toFixed(4)}, 점 비율 ${(lod.count / cloud.count).toFixed(3)}`);
    assert.ok(s >= SSIM_MIN, `×${f}: SSIM ${s}`);
    // 음성: 단계 0 강제 변이는 구조 단언에서 실패한다(렌더는 원본과 같아 SSIM 으로는 못 잡음).
    assert.throws(() => assertCoarseUsed(h, forceLevel0(h, sel), cloud.count, 0.5, `×${f} 변이`), /단계 ≥ 1 리프 없음/);
  });
}

test('음성: 공식 시점 8곳은 단계 0 이라 구조 단언(단계≥1 리프)이 성립하지 않는다(해당 없음 확인)', () => {
  const { cloud, h } = scene();
  for (const vp of VP) {
    const sel = selectLevels(h, camOf(vp), { thresholdPx: THRESHOLD_PX });
    assert.throws(() => assertCoarseUsed(h, sel, cloud.count, 0.5, vp.name), /단계 ≥ 1 리프 없음/);
  }
});

test('시야 밖 리프는 NOT_DRAWN 이고 그 점은 화면에 하나도 투영되지 않는다', () => {
  const { cloud, h } = scene();
  const oc = h.octree;
  let culled = 0;
  for (const vp of VP) {
    const cam = camOf(vp);
    const sel = selectLevels(h, cam, { thresholdPx: THRESHOLD_PX });
    const { R, t, K } = cam;
    for (let k = 0; k < oc.leafCount; k++) {
      if (sel.leafLevel[k] !== NOT_DRAWN) continue;
      culled++;
      for (let s = oc.leafStart[k]; s < oc.leafStart[k + 1]; s++) {
        const i = oc.order[s];
        const X = cloud.positions[3 * i], Y = cloud.positions[3 * i + 1], Z = cloud.positions[3 * i + 2];
        const z = R[6] * X + R[7] * Y + R[8] * Z + t[2];
        if (!(z > 0)) continue;
        const u = (K.fx * (R[0] * X + R[1] * Y + R[2] * Z + t[0])) / z + K.cx;
        const v = (K.fy * (R[3] * X + R[4] * Y + R[5] * Z + t[1])) / z + K.cy;
        assert.ok(u < 0 || u > W || v < 0 || v > H, `시점 ${vp.id} 리프 ${k} 의 점 ${i} 가 화면 안 (${u}, ${v})`);
      }
    }
  }
  assert.ok(culled > 0, '고정 시점에서 시야 밖 리프가 하나도 없음');
});

test('장면을 등지면 모든 리프가 NOT_DRAWN, 점 수 0', () => {
  const { h } = scene();
  const vp = { eye: [0, 50, 300], target: [0, 50, 600], up: [0, 1, 0], width: W, height: H, fov_y_deg: 50 };
  const sel = selectLevels(h, viewpointToCamera(vp), { thresholdPx: THRESHOLD_PX });
  assert.ok(sel.leafLevel.every((l) => l === NOT_DRAWN));
  assert.equal(sel.pointCount, 0);
  assert.equal(materialize(h, sel).count, 0);
});

test('시점을 멀리 하면 점 수가 줄고 더 거친 단계가 쓰인다', () => {
  const { h } = scene();
  const vp = VP.find((v) => v.name === 'aerial_overview');
  let prev = Infinity, prevMax = -1;
  const counts = [];
  for (const f of [1, 2, 4, 8, 16]) {
    const eye = vp.eye.map((e, a) => vp.target[a] + f * (e - vp.target[a]));
    const sel = selectLevels(h, camOf({ ...vp, eye }), { thresholdPx: THRESHOLD_PX });
    let maxL = 0;
    for (const l of sel.leafLevel) if (l !== NOT_DRAWN && l > maxL) maxL = l;
    counts.push(sel.pointCount);
    assert.ok(sel.pointCount <= prev, `배율 ${f}: ${sel.pointCount} > ${prev}`);
    assert.ok(maxL >= prevMax);
    prev = sel.pointCount; prevMax = maxL;
  }
  assert.ok(counts[counts.length - 1] < counts[0] / 10, `점 수 ${counts.join(' → ')}`);
  assert.ok(prevMax >= 3);
});

// 작은 손 계산 장면: z=0 평면의 41×41 격자(간격 0.05 m), 카메라는 +z 를 보며 원점이 깊이 D 에 오도록 t = (0,0,D).
function gridCloud() {
  const pts = [];
  for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) pts.push(-1 + 0.05 * i, -1 + 0.05 * j, 0);
  const n = pts.length / 3;
  const normals = new Float32Array(3 * n);
  const colors = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) { normals[3 * i + 2] = 1; colors[3 * i] = (i * 7) % 256; colors[3 * i + 1] = (i * 13) % 256; colors[3 * i + 2] = 100; }
  return { format: 1, count: n, positions: Float32Array.from(pts), normals, colors };
}
const axisCam = (D, fx = 100) => ({ width: 200, height: 200, K: { fx, fy: fx, cx: 100, cy: 100 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, D] });

test('단계는 f·edgeM(l)/d ≤ τ 인 가장 큰 l (d = 상자와 카메라 중심의 최소 거리), 최대 levelCount−1', () => {
  const g = gridCloud();
  const L = 4, e0 = 0.05, fx = 100, tau = 1;
  const h = buildHierarchy(g, { edge0M: e0, levelCount: L, maxLeafPoints: 4096 });
  assert.equal(h.octree.leafCount, 1);
  const zMin = h.octree.boxMin[2];
  for (const D of [1.5, 3, 6, 9, 11, 21, 50, 1000]) {
    const d = D + zMin; // 카메라 중심 (0,0,−D), 상자는 z ∈ [zMin, zMax] 이고 x,y 는 카메라 축을 품는다
    let expect = 0;
    for (let l = 0; l < L; l++) if ((fx * edgeOfLevel(e0, l)) / d <= tau) expect = l;
    const sel = selectLevels(h, axisCam(D, fx), { thresholdPx: tau });
    assert.equal(sel.leafLevel[0], expect, `D=${D}`);
    assert.equal(sel.pointCount, h.levels[expect].count);
  }
  assert.equal(selectLevels(h, axisCam(1000, fx), { thresholdPx: tau }).leafLevel[0], L - 1);
  // 카메라가 상자 안이면 원본 단계 0
  assert.equal(selectLevels(h, axisCam(0.5, fx), { thresholdPx: tau }).leafLevel[0], 0);
});

test('materialize: 선택 단계의 대표점(위치=입력, 법선·색=단계 대표값), 새 점 없음', () => {
  const g = gridCloud();
  const h = buildHierarchy(g, { edge0M: 0.05, levelCount: 4, maxLeafPoints: 200 });
  const oc = h.octree;
  assert.ok(oc.leafCount > 1);
  const leafLevel = new Uint8Array(oc.leafCount);
  let pointCount = 0;
  for (let k = 0; k < oc.leafCount; k++) {
    leafLevel[k] = k % 5 === 4 ? NOT_DRAWN : k % 4;
    if (leafLevel[k] !== NOT_DRAWN) pointCount += h.levels[leafLevel[k]].leafStart[k + 1] - h.levels[leafLevel[k]].leafStart[k];
  }
  const out = materialize(h, { leafLevel, pointCount });
  assert.equal(out.format, 1);
  assert.equal(out.count, pointCount);
  assert.equal(out.positions.length, 3 * pointCount);
  let o = 0;
  for (let k = 0; k < oc.leafCount; k++) {
    if (leafLevel[k] === NOT_DRAWN) continue;
    const lv = h.levels[leafLevel[k]];
    for (let s = lv.leafStart[k]; s < lv.leafStart[k + 1]; s++, o++) {
      const i = lv.indices[s];
      for (let a = 0; a < 3; a++) {
        assert.equal(out.positions[3 * o + a], g.positions[3 * i + a]);
        assert.equal(out.normals[3 * o + a], lv.normals[3 * s + a]);
        assert.equal(out.colors[3 * o + a], lv.colors[3 * s + a]);
      }
    }
  }
  assert.equal(o, pointCount);
  // 전부 단계 0 이면 원본과 같은 점 집합
  const all0 = materialize(h, { leafLevel: new Uint8Array(oc.leafCount), pointCount: g.count });
  const key = (c, i) => `${c.positions[3 * i]},${c.positions[3 * i + 1]},${c.colors[3 * i]},${c.colors[3 * i + 1]}`;
  const A = Array.from({ length: g.count }, (_, i) => key(g, i)).sort();
  const B = Array.from({ length: all0.count }, (_, i) => key(all0, i)).sort();
  assert.deepEqual(B, A);
});

test("입력 검증은 'lod:' 오류", () => {
  const g = gridCloud();
  const h = buildHierarchy(g, { edge0M: 0.05, levelCount: 3, maxLeafPoints: 4096 });
  const cam = axisCam(5);
  for (const bad of [undefined, {}, { thresholdPx: 0 }, { thresholdPx: -1 }, { thresholdPx: NaN }, { thresholdPx: Infinity }, { thresholdPx: '1' }]) {
    assert.throws(() => selectLevels(h, cam, bad), /^Error: lod:/);
  }
  assert.throws(() => selectLevels(null, cam, { thresholdPx: 1 }), /^Error: lod:/);
  assert.throws(() => selectLevels({ ...h, levels: [] }, cam, { thresholdPx: 1 }), /^Error: lod:/);
  assert.throws(() => selectLevels({ ...h, cloud: { ...g, count: 1 } }, cam, { thresholdPx: 1 }), /^Error: lod:/);
  assert.throws(() => selectLevels(h, null, { thresholdPx: 1 }), /^Error: lod:/);
  assert.throws(() => selectLevels(h, { ...cam, R: [2, 0, 0, 0, 1, 0, 0, 0, 1] }, { thresholdPx: 1 }), /^Error: lod:/);
  assert.throws(() => selectLevels(h, { ...cam, K: { ...cam.K, fx: 0 } }, { thresholdPx: 1 }), /^Error: lod:/);
  const sel = selectLevels(h, cam, { thresholdPx: 1 });
  assert.throws(() => materialize(h, null), /^Error: lod:/);
  assert.throws(() => materialize(h, { leafLevel: new Uint8Array(h.octree.leafCount + 1), pointCount: 0 }), /^Error: lod:/);
  assert.throws(() => materialize(h, { leafLevel: Uint8Array.from([7]), pointCount: 0 }), /^Error: lod:/);
  assert.throws(() => materialize(h, { ...sel, pointCount: sel.pointCount + 1 }), /^Error: lod:/);
  assert.throws(() => buildHierarchy(g, { edge0M: 0, levelCount: 3 }), /^Error: lod:/);
});

test.after(() => {
  if (table.length) console.log(`# 시점별 SSIM·점 비율 (${W}×${H}, N=${N}, edge0M=${EDGE0_M}, τ=${THRESHOLD_PX}, pointSizeM=${POINT_SIZE_M})\n# ${table.join('\n# ')}`);
});
