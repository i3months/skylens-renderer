// 관제탑 지형 8시점 SSIM 시험(T15.1-A5). SPEC S9 의 합성 근사로, contracts/controlview TERRAIN_SSIM_MIN(0.95) 를 합성 장면으로 잰다.
// SPEC S9 와 다른 점(결정 0046): ① 해상도 160×90, ② 원본 시점 중 3곳(street_level·low_close_box·edge_far)의 눈 높이를 17 m 로 올림,
//   ③ 기준 영상 = 같은 DEM 의 LOD 0 메시를 ref_trace(독립 광선-삼각형 교차)로 그린 것(SPEC 의 원본 점군 렌더가 아님).
// 음영 모델: 층 래스터와 기준 영상 모두 화소별 정점 법선 보간 램버트(결정 0046 선택지 D). 래스터와 코드를 공유하지 않는다.
// 1부: ref_trace 자체 검증(해석값·무차별 대조) — 래스터와 무관하게 통과해야 한다.
// 2부: createTerrainLayer 대 기준 영상. 합성 DEM 시드 1..12 × 높이 잡음 {0, 0.015} 의 24 장면 × LOD 1..3 × 8시점 최소값으로 판정한다.
//   0.95 에 못 미치는 조건이 생기면 KNOWN_SHORTFALL 에 수치·하한과 함께 따로 단언한다(기준은 낮추지 않는다). 지금은 비어 있다.
// 미리 정한 값(측정에 맞춰 바꾸지 않음): SSIM 하한 0.95(계약)·0.99, 해상도 160×90, 시드 범위 1..12, 잡음 {0, 0.015}.
// 측정 후에 정해 넣은 값(측정 결과를 보고 조인 값): KNOWN_SHORTFALL 퇴행 하한, LOD3_EQ_LOD2_SCENES(측정으로 얻은 장면 목록),
//   NEAR_VTX_MIN·NEAR_FACE_MAX·FACE_SHADING_NOISY_MAX(측정값에서 여유를 두고 잡은 경계).
// MASK_MISMATCH_MAX_RATIO 0 은 측정값이 아니라 근거로 정했다: 층 래스터와 기준 추적이 같은 변 규칙(화소 중심 포함 판정)을 쓰는 결정적 계산이라
//   빈/채움 판정이 어긋날 이유가 없다(참고 측정도 0).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { traceMesh, createTracer } from './ref_trace.mjs';
import { EMPTY_DEPTH, EMPTY_INDEX, emptyResult } from '../../../contracts/raster/index.mjs';
import { TERRAIN_SSIM_MIN, TERRAIN_DEFAULTS } from '../../../contracts/controlview/terrain.mjs';
import { terrainLodMaxErrorM } from '../../../contracts/tower_assets/index.mjs';
import { faceNormalEnu, shadeLambert } from './shade.mjs';
import { lambert as serverLambert } from '../../../server/raster_ref/shade/index.mjs';
import { buildLayerMesh } from './mesh.mjs';
import { rasterizeTriangles } from './raster.mjs';

// ---- 미리 정한 기준 수치 ----
const SSIM_LOD0_MIN = 0.99; // LOD 0 을 layer 로 그린 것 대 기준(래스터 정확성)
const MASK_MISMATCH_MAX_RATIO = 0; // 빈/채움이 다른 화소 비율 상한. 근거: 변 규칙 결정성(위 8행 주석). 참고 측정: LOD 0 24 장면 8시점·부분 메시 8시점 모두 0
// LOD 3 타일 메시가 LOD 2 와 똑같은(정점·삼각형 동일) 장면 수. 근거: 결정 0046 의 LOD 3 오차 상한이 [0,0.5,1,1] 이라 LOD 2 와 LOD 3 이 같은 상한(1 m)이고,
//   그 상한에서 간격이 같게 정해지는 DEM 은 두 단계가 같은 메시가 된다. 곧 이 장면들의 LOD 3 SSIM 은 LOD 2 와 같아 LOD 3 을 따로 검증하지 못한다. 측정 후 고정한 값: 개수가 아니라 장면 목록('시드/잡음')이다 —
//   상한(terrainLodMaxErrorM)이 바뀌면 목록이 달라져 (2a) 가 실패한다.
//   결정 0057(T15.10d): 상한이 min(절대표, 0.25·cellM) 이 되어 이 장면(2 m 셀)의 LOD1~3 상한이 0.5 m 다. LOD2·3 이 같은 상한이라
//   시드 1·2 잡음 0 을 뺀 22 장면이 LOD3 = LOD2 다(이전 [0,0.5,1,1] 에서는 시드 5..10·12 의 두 잡음 = 14 장면). 24 장면 LOD1~3 최소 0.9818(시드 10 잡음 0.015).
const LOD3_EQ_LOD2_SCENES = Object.freeze([
  '3/0', '4/0', '5/0', '6/0', '7/0', '8/0', '9/0', '10/0', '11/0', '12/0',
  '1/0.015', '2/0.015', '3/0.015', '4/0.015', '5/0.015', '6/0.015', '7/0.015', '8/0.015', '9/0.015', '10/0.015', '11/0.015', '12/0.015',
]);
const TRACE_TOTAL_MS_MAX = 20000; // 한 장면 8시점 기준 영상 합계 시간 상한
const VIEWS = 8;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const NOISES = [0, 0.015]; // 높이 잡음 비율(진폭 10 m 의 ±1.5 % = ±0.15 m, fixtures 기본값)
// 알려진 미달: 0.95 에 못 미치는 조건 'seed/noise/lod' → 퇴행 하한. 지금은 비어 있다.
// 이전(2026-10-05): 시드 5·6·7·9·10 의 LOD 3(오차 상한 2 m, 간격 16 m)이 잡음 0 → 0.9299 0.9233 0.8464 0.9419 0.9479,
//   잡음 0.015 → 0.9246 0.9152 0.8407 0.9331 0.9382 로 미달이었다. 원인은 높이 오차 상한 2 m 가 법선(기울기) 오차를 묶지 않는 것.
//   T15.1c: LOD 3 높이 오차 상한을 1 m 로 조여(contracts TERRAIN_LOD_MAX_ERROR_M, 결정 0046 — 시험 결과를 보고 고른 값) 그 DEM 들의 LOD 3 간격이
//   8 m 로 줄었고 24 장면 LOD 1~3 최소가 0.9645(시드 7 잡음 0.015)다. 아래 (2b) 는 목록이 실제와 정확히 같음(곧 미달 없음)을 단언한다.
//   결정 0057 이후(2 m 셀 상한 0.5 m) 최소 0.9818(시드 10 잡음 0.015 LOD 2·3).
const KNOWN_SHORTFALL = Object.freeze({});
// 변이 확인: 층·기준을 모두 면 음영으로 그리면 잡음 장면 LOD 1~3 이 0.95 를 크게 밑돈다(측정 0.88 안팎). (2c) 의 상한.
const FACE_SHADING_NOISY_MAX = 0.93;
const NEAR_VTX_MIN = 0.99; // (2c) 층 색이 정점 법선 추적 색의 ±2 이내인 화소 비율 하한(측정 1.0000)
const NEAR_FACE_MAX = 0.5; // (2c) 층 색이 면 음영 색과 완전 일치하는 화소 비율 상한(측정 0.131)

// ---- 공용 도우미 ----
function shadeFnDefault() {
  // 기준 영상 쪽 음영은 서버 램버트(server/raster_ref/shade)를 쓴다. 클라이언트 shade.mjs·래스터 코드와 공유하지 않는다.
  return (normal) => serverLambert(normal, TERRAIN_DEFAULTS.lightDirEnu, TERRAIN_DEFAULTS.baseRgb, { ambient: TERRAIN_DEFAULTS.ambient });
}
const VTX = { normals: 'vertex' };

/** 아래를 수직으로 내려다보는 카메라(높이 h, 위치 (cx,cy)). 영상 오른쪽 = 동, 아래쪽 = 남. */
function nadirCamera(w, hgt, f, camX, camY, camZ) {
  return { width: w, height: hgt, K: { fx: f, fy: f, cx: w / 2, cy: hgt / 2 }, R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [-camX, camY, camZ] };
}
// R·C + t = 0 이어야 한다: R·(cx,cy,cz) = (cx, -cy, -cz) → t = (-cx, cy, cz)

/** 화소 (x,y) 중심의 nadir 월드 좌표(평면 z=planeZ). */
function nadirWorld(cam, camX, camY, camZ, planeZ, x, y) {
  const d = camZ - planeZ;
  return [camX + ((x + 0.5 - cam.K.cx) / cam.K.fx) * d, camY - ((y + 0.5 - cam.K.cy) / cam.K.fy) * d, d];
}

function maskOf(r) {
  const m = new Uint8Array(r.width * r.height);
  for (let i = 0; i < m.length; i++) m[i] = r.index[i] === EMPTY_INDEX ? 0 : 1;
  return m;
}

/** 여러 타일 메시를 이어 붙인다(client mesh.mjs 를 쓰지 않는 시험 쪽 독립 구현). tileOfTriangle = 타일 목록 순서. */
function concatMeshes(meshes) {
  let nv = 0, nt = 0;
  for (const m of meshes) { nv += m.positions.length; nt += m.indices.length; }
  const positions = new Float32Array(nv), indices = new Uint32Array(nt), tileOfTriangle = new Int32Array(nt / 3);
  let vo = 0, io = 0, to = 0;
  meshes.forEach((m, n) => {
    positions.set(m.positions, vo);
    for (let k = 0; k < m.indices.length; k++) indices[io + k] = m.indices[k] + vo / 3;
    tileOfTriangle.fill(n, to, to + m.indices.length / 3);
    vo += m.positions.length; io += m.indices.length; to += m.indices.length / 3;
  });
  return { positions, indices, tileOfTriangle };
}

// ======================= 1부: ref_trace 자체 검증 =======================
describe('ref_trace 자체 검증', () => {
  test('수평 단일 삼각형: 덮는 화소·깊이·번호가 해석값과 같다', () => {
    const cam = nadirCamera(64, 48, 40, 0, 0, 10);
    // 삼각형(z=2): (-3,-2) (4,-1) (0,3) — 반시계(위에서 볼 때)
    const A = [-3, -2], B = [4, -1], C = [0, 3];
    const mesh = { positions: new Float32Array([A[0], A[1], 2, B[0], B[1], 2, C[0], C[1], 2]), indices: new Uint32Array([0, 1, 2]) };
    const out = traceMesh(cam, mesh, () => [10, 20, 30]);
    const edge = (p, q, x, y) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
    let inside = 0, checked = 0;
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 64; x++) {
        const [wx, wy, d] = nadirWorld(cam, 0, 0, 10, 2, x, y);
        const e = [edge(A, B, wx, wy), edge(B, C, wx, wy), edge(C, A, wx, wy)];
        const minAbs = Math.min(...e.map(Math.abs));
        if (minAbs < 0.05) continue; // 변 근처 화소는 판정에서 뺀다
        checked++;
        const isIn = e.every((v) => v > 0);
        const i = y * 64 + x;
        if (isIn) {
          inside++;
          assert.equal(out.index[i], 0, `(${x},${y}) 번호`);
          assert.ok(Math.abs(out.depth[i] - d) < 1e-4, `(${x},${y}) 깊이 ${out.depth[i]} 대 ${d}`);
          assert.deepEqual([out.color[3 * i], out.color[3 * i + 1], out.color[3 * i + 2]], [10, 20, 30]);
        } else {
          assert.equal(out.index[i], EMPTY_INDEX, `(${x},${y}) 바깥은 빈 화소`);
          assert.equal(out.depth[i], EMPTY_DEPTH);
          assert.deepEqual([out.color[3 * i], out.color[3 * i + 1], out.color[3 * i + 2]], [0, 0, 0]);
        }
      }
    }
    assert.ok(inside > 100 && checked > inside, `삼각형 안 화소 ${inside}, 검사 ${checked}`);
  });

  test('양면: 감는 방향을 뒤집어도 같은 화소를 덮고 깊이가 같다', () => {
    const cam = nadirCamera(32, 24, 30, 0, 0, 8);
    const pos = new Float32Array([-2, -1.5, 1, 3, -1, 1, 0.5, 2.5, 1]);
    const a = traceMesh(cam, { positions: pos, indices: new Uint32Array([0, 1, 2]) }, (n) => [Math.round(100 + 50 * n[2]), 0, 0]);
    const b = traceMesh(cam, { positions: pos, indices: new Uint32Array([0, 2, 1]) }, (n) => [Math.round(100 + 50 * n[2]), 0, 0]);
    assert.deepEqual(maskOf(a), maskOf(b));
    assert.deepEqual(a.depth, b.depth);
    // 법선 부호는 감는 방향을 따른다(위에서 반시계 → nz>0, 뒤집으면 nz<0)
    const i = a.index.findIndex((v) => v === 0);
    assert.equal(a.color[3 * i], 150);
    assert.equal(b.color[3 * i], 50);
  });

  test('기울어진 평면: 깊이가 광선-평면 해석값이다', () => {
    // 평면 z = 3 + 0.2·x 를 두 삼각형(사각형 [-20,20]²)으로 만든다. 카메라는 (0,-30,25) 에서 원점 쪽을 본다.
    const eye = [0, -30, 25];
    const fwd = [0, 30, -22]; const fl = Math.hypot(...fwd); const f = fwd.map((v) => v / fl);
    const right = [1, 0, 0];
    const down = [f[1] * right[2] - f[2] * right[1], f[2] * right[0] - f[0] * right[2], f[0] * right[1] - f[1] * right[0]]; // f × right
    const R = [...right, ...down, ...f];
    const t = [-(R[0] * eye[0] + R[1] * eye[1] + R[2] * eye[2]), -(R[3] * eye[0] + R[4] * eye[1] + R[5] * eye[2]), -(R[6] * eye[0] + R[7] * eye[1] + R[8] * eye[2])];
    const cam = { width: 80, height: 60, K: { fx: 70, fy: 70, cx: 40, cy: 30 }, R, t };
    const zOf = (x) => 3 + 0.2 * x;
    const mesh = {
      positions: new Float32Array([-20, -20, zOf(-20), 20, -20, zOf(20), 20, 20, zOf(20), -20, 20, zOf(-20)]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    };
    const out = traceMesh(cam, mesh, () => [1, 2, 3]);
    let hit = 0;
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 80; x++) {
        const xn = (x + 0.5 - 40) / 70, yn = (y + 0.5 - 30) / 70;
        // 월드 방향 d = Rᵀ(xn,yn,1)
        const d = [R[0] * xn + R[3] * yn + R[6], R[1] * xn + R[4] * yn + R[7], R[2] * xn + R[5] * yn + R[8]];
        // 평면: n·X = c, n=(−0.2,0,1), c=3
        const den = -0.2 * d[0] + d[2];
        const s = (3 - (-0.2 * eye[0] + eye[2])) / den;
        const px = eye[0] + s * d[0], py = eye[1] + s * d[1];
        const i = y * 80 + x;
        if (den === 0 || s <= 0 || Math.abs(px) > 19.9 || Math.abs(py) > 19.9) {
          if (s <= 0 || Math.abs(px) > 20.1 || Math.abs(py) > 20.1) assert.equal(out.index[i], EMPTY_INDEX, `(${x},${y}) 빈 화소여야 함`);
          continue;
        }
        hit++;
        assert.ok(out.index[i] === 0 || out.index[i] === 1, `(${x},${y}) 맞아야 함`);
        assert.ok(Math.abs(out.depth[i] - s) < 1e-3, `(${x},${y}) 깊이 ${out.depth[i]} 대 ${s}`);
      }
    }
    assert.ok(hit > 500, `맞은 화소 ${hit}`);
  });

  test('가림: 가까운 삼각형이 이기고 같은 거리면 번호가 작은 쪽이 이긴다', () => {
    const cam = nadirCamera(16, 16, 20, 0, 0, 10);
    const quad = (z) => [-5, -5, z, 5, -5, z, 5, 5, z, -5, 5, z];
    // 번호 0,1: z=1(먼 쪽), 번호 2,3: z=4(가까운 쪽), 번호 4,5: z=4 와 같은 거리
    const positions = new Float32Array([...quad(1), ...quad(4), ...quad(4)]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11]);
    const out = traceMesh(cam, { positions, indices }, () => [5, 5, 5]);
    const c = 8 * 16 + 8;
    assert.ok(out.index[c] === 2 || out.index[c] === 3, `가까운 면이 이겨야 함: ${out.index[c]}`);
    assert.ok(Math.abs(out.depth[c] - 6) < 1e-4);
  });

  test('tileOfTriangle 이 있으면 index 는 그 값이고 빈 메시는 전부 빈 화소다', () => {
    const cam = nadirCamera(16, 16, 20, 0, 0, 10);
    const mesh = { positions: new Float32Array([-5, -5, 0, 5, -5, 0, 0, 5, 0]), indices: new Uint32Array([0, 1, 2]), tileOfTriangle: new Int32Array([7]) };
    const out = traceMesh(cam, mesh, () => [9, 9, 9]);
    assert.equal(out.index[8 * 16 + 8], 7);
    const empty = traceMesh(cam, { positions: new Float32Array(0), indices: new Uint32Array(0) }, () => [9, 9, 9]);
    assert.ok(empty.index.every((v) => v === EMPTY_INDEX) && empty.depth.every((v) => v === 0) && empty.color.every((v) => v === 0));
  });

  test('균일 격자 가속은 무차별 대조(평면 교차 + 부호 판정)와 화소마다 같다', () => {
    // 결정적 난수로 만든 삼각형 뭉치. 두 구현은 알고리즘이 다르다(여기는 평면 교차 후 같은 쪽 판정).
    let s = 12345;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    const nTri = 400;
    const pos = new Float32Array(nTri * 9);
    for (let k = 0; k < nTri; k++) {
      const cx = (rnd() - 0.5) * 60, cy = (rnd() - 0.5) * 60, cz = rnd() * 12;
      for (let v = 0; v < 3; v++) {
        pos[k * 9 + v * 3] = cx + (rnd() - 0.5) * 8;
        pos[k * 9 + v * 3 + 1] = cy + (rnd() - 0.5) * 8;
        pos[k * 9 + v * 3 + 2] = cz + (rnd() - 0.5) * 3;
      }
    }
    const idx = new Uint32Array(nTri * 3).map((_, i) => i);
    // 비스듬한 카메라: (0,-45,30) 에서 (0,0,4) 를 본다.
    const eye = [0, -45, 30], tgt = [0, 0, 4];
    const f0 = [tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]]; const fl = Math.hypot(...f0); const f = f0.map((v) => v / fl);
    const right = [1, 0, 0];
    const down = [f[1] * right[2] - f[2] * right[1], f[2] * right[0] - f[0] * right[2], f[0] * right[1] - f[1] * right[0]];
    const R = [...right, ...down, ...f];
    const t = [0, 1, 2].map((r) => -(R[3 * r] * eye[0] + R[3 * r + 1] * eye[1] + R[3 * r + 2] * eye[2]));
    const cam = { width: 96, height: 64, K: { fx: 90, fy: 90, cx: 48, cy: 32 }, R, t };
    const out = traceMesh(cam, { positions: pos, indices: idx }, () => [1, 1, 1]);

    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let mismatch = 0, hits = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 96; x++) {
        const xn = (x + 0.5 - 48) / 90, yn = (y + 0.5 - 32) / 90;
        const d = [R[0] * xn + R[3] * yn + R[6], R[1] * xn + R[4] * yn + R[7], R[2] * xn + R[5] * yn + R[8]];
        let best = Infinity, bestK = -1, nearEdge = false;
        for (let k = 0; k < nTri; k++) {
          const P = [0, 1, 2].map((v) => [pos[k * 9 + v * 3], pos[k * 9 + v * 3 + 1], pos[k * 9 + v * 3 + 2]]);
          const n = cross(sub(P[1], P[0]), sub(P[2], P[0]));
          const den = dot(n, d);
          if (Math.abs(den) < 1e-12) continue;
          const sRay = dot(n, sub(P[0], eye)) / den;
          if (sRay < 0.01) continue;
          const X = [eye[0] + sRay * d[0], eye[1] + sRay * d[1], eye[2] + sRay * d[2]];
          const sides = [0, 1, 2].map((v) => dot(cross(sub(P[(v + 1) % 3], P[v]), sub(X, P[v])), n) / dot(n, n));
          const sg = Math.min(...sides);
          if (sg < -1e-6) continue;
          if (sg < 1e-6) nearEdge = true; // 변 위: 판정이 모호하므로 이 화소는 비교에서 뺀다
          if (sRay < best) { best = sRay; bestK = k; }
        }
        if (nearEdge) continue;
        const i = y * 96 + x;
        if (bestK < 0) { if (out.index[i] !== EMPTY_INDEX) mismatch++; continue; }
        hits++;
        if (out.index[i] !== bestK || Math.abs(out.depth[i] - best) > 1e-3) mismatch++;
      }
    }
    assert.ok(hits > 1000, `맞은 화소 ${hits}`);
    assert.equal(mismatch, 0, `무차별 대조와 다른 화소 ${mismatch}`);
  });
  test('정점 법선 모드: 평면 메시는 면 모드와 화소마다 같다', () => {
    const cam = nadirCamera(48, 40, 35, 0, 0, 12);
    // 기울어진 평면 z = 1 + 0.3x − 0.1y 를 3×3 격자 8 삼각형으로
    const pos = [], ind = [];
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) { const x = -6 + 6 * i, y = -6 + 6 * j; pos.push(x, y, 1 + 0.3 * x - 0.1 * y); }
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const a = j * 3 + i; ind.push(a, a + 1, a + 4, a, a + 4, a + 3); }
    const mesh = { positions: new Float32Array(pos), indices: new Uint32Array(ind) };
    const a = traceMesh(cam, mesh, shadeFnDefault());
    const b = traceMesh(cam, mesh, shadeFnDefault(), VTX);
    assert.ok(maskOf(a).some((v) => v === 1));
    assert.deepEqual(b.color, a.color);
    assert.deepEqual(b.index, a.index);
    assert.throws(() => traceMesh(cam, mesh, shadeFnDefault(), { normals: 'smooth' }), RangeError);
  });

  test('정점 법선 모드: 곡면에서 넘겨주는 법선이 해석 법선에 면 모드보다 가깝다', () => {
    // z = 0.03·(x²+y²), 격자 간격 2 m. 해석 법선 ∝ (−0.06x, −0.06y, 1).
    const n = 13, step = 2, pos = [], ind = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const x = (i - 6) * step, y = (j - 6) * step; pos.push(x, y, 0.03 * (x * x + y * y)); }
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = j * n + i; ind.push(a, a + 1, a + n + 1, a, a + n + 1, a + n); }
    const mesh = { positions: new Float32Array(pos), indices: new Uint32Array(ind) };
    const cam = nadirCamera(60, 60, 50, 0.3, 0.2, 30);
    const errOf = (opts) => {
      const got = new Map();
      const out = traceMesh(cam, mesh, (nrm, tri) => { got.set(got.size, nrm); return [got.size % 256, 0, 0]; }, opts);
      // 화소마다 shadeFn 호출 순서 = 행 우선 맞은 화소 순서
      let k = 0, maxErr = 0, sumErr = 0, cnt = 0;
      for (let y = 0; y < 60; y++) {
        for (let x = 0; x < 60; x++) {
          const i = y * 60 + x;
          if (out.index[i] === EMPTY_INDEX) continue;
          const nrm = got.get(k++);
          const d = out.depth[i];
          const wx = 0.3 + ((x + 0.5 - 30) / 50) * d, wy = 0.2 - ((y + 0.5 - 30) / 50) * d;
          if (Math.abs(wx) > 10 || Math.abs(wy) > 10) continue;
          const a = [-0.06 * wx, -0.06 * wy, 1]; const al = Math.hypot(...a);
          const c = (nrm[0] * a[0] + nrm[1] * a[1] + nrm[2] * a[2]) / al;
          const e = Math.acos(Math.min(1, c));
          maxErr = Math.max(maxErr, e); sumErr += e; cnt++;
        }
      }
      return { maxErr, mean: sumErr / cnt, cnt };
    };
    const f = errOf(undefined), v = errOf(VTX);
    assert.ok(v.cnt > 1000, `검사 화소 ${v.cnt}`);
    assert.ok(v.maxErr < 0.02, `정점 법선 최대 각 오차 ${v.maxErr}`);
    assert.ok(v.mean < f.mean / 2, `정점 ${v.mean} 대 면 ${f.mean}`);
  });

  test('정점 법선 모드: 위치가 같은 정점은 법선을 공유한다(타일 경계)', () => {
    // 두 타일처럼 정점을 따로 둔 지붕: 왼쪽 면 z = x, 오른쪽 면 z = −x (x=0 이 용마루). 용마루 화소의 법선은 (0,0,1).
    const L = [-4, -4, -4, 0, -4, 0, 0, 4, 0, -4, 4, -4]; // (−4,−4) (0,−4) (0,4) (−4,4)
    const Rr = [0, -4, 0, 4, -4, -4, 4, 4, -4, 0, 4, 0];
    const mesh = { positions: new Float32Array([...L, ...Rr]), indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]) };
    const cam = nadirCamera(41, 41, 40, 0, 0.05, 10);
    // 가운데 열(x=20)은 x≈0 → 용마루 위 화소. 그 법선은 위쪽이어야 한다.
    const out = traceMesh(cam, mesh, (nrm) => [Math.round(127 + 127 * nrm[0]), Math.round(127 + 127 * nrm[1]), Math.round(127 + 127 * nrm[2])], VTX);
    const i = 20 * 41 + 20;
    assert.notEqual(out.index[i], EMPTY_INDEX);
    assert.ok(Math.abs(out.color[3 * i] - 127) <= 3 && out.color[3 * i + 2] >= 252, `용마루 법선 색 ${out.color.slice(3 * i, 3 * i + 3)}`);
    // 묶지 않으면(면 모드) 용마루 화소는 한쪽 면 법선 (∓0.71, 0, 0.71) 이다.
    const face = traceMesh(cam, mesh, (nrm) => [Math.round(127 + 127 * nrm[0]), 0, 0]);
    assert.ok(Math.abs(face.color[3 * i] - 127) > 80, `면 모드 용마루 ${face.color[3 * i]}`);
  });
});


// ======================= 2부: 층 대 기준 영상 =======================
describe('지형 층 8시점 SSIM(시드 1..12 × 잡음 {0, 0.015})', () => {
  let mods, cams, scenes, main;

  // 장면 하나: DEM → LOD 0..3 타일 → 기준 영상(LOD 0, 정점 법선) → 층 LOD 0..3 SSIM.
  function runScene(seed, noise) {
    const dem = mods.makeHillDem({ seed, noiseRatio: noise });
    const tileOrder = [];
    for (let ty = -2; ty < 2; ty++) for (let tx = -2; tx < 2; tx++) tileOrder.push([tx, ty]);
    const lodTiles = [0, 1, 2, 3].map((l) => tileOrder.map(([tx, ty]) => mods.buildTerrainTile(dem, tx, ty, l)));
    const refMesh = concatMeshes(lodTiles[0].map((tl) => mods.terrainTileToMesh(tl)));
    // LOD 2·LOD 3 이 같은 타일 메시인지(삼각형 수와 정점·색인 값 모두 같은지) 기록한다.
    const m2 = concatMeshes(lodTiles[2].map((tl) => mods.terrainTileToMesh(tl)));
    const m3 = concatMeshes(lodTiles[3].map((tl) => mods.terrainTileToMesh(tl)));
    const tri2 = m2.indices.length / 3, tri3 = m3.indices.length / 3;
    const lod3EqLod2 = tri2 === tri3 && m2.positions.length === m3.positions.length
      && m2.positions.every((v, i) => v === m3.positions[i]) && m2.indices.every((v, i) => v === m3.indices[i]);
    const t0 = Date.now();
    const tracer = createTracer(refMesh, VTX);
    const refs = cams.map((c) => tracer(c, shadeFnDefault()));
    const traceMs = Date.now() - t0;
    const ss = [], filled = [], mask = [];
    for (const l of [0, 1, 2, 3]) {
      const layer = mods.createTerrainLayer();
      assert.equal(layer.accept(l, lodTiles[l]), 'first');
      const sv = [], fv = [];
      cams.forEach((c, v) => {
        const out = layer.render(c);
        const d = mods.ssimDetailed(out.color, refs[v].color, out.width, out.height, 3);
        sv.push(d.ssim); fv.push(d.ssimFilled);
        if (l === 0) {
          const a = maskOf(out), b = maskOf(refs[v]);
          let diff = 0;
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
          mask.push(diff / a.length);
        }
      });
      ss.push(sv); filled.push(fv);
    }
    return { seed, noise, tri2, tri3, lod3EqLod2, lodTiles, refs, refMesh, traceMs, ss, filled, mask, triCount: refMesh.indices.length / 3 };
  }

  before(async () => {
    const fx = await import('./fixtures.mjs');
    const idx = await import('./index.mjs');
    const lod = await import('../../../server/terrain/mesh_lod/index.mjs');
    const ssimMod = await import('../../../server/metrics/ssim/index.mjs');
    mods = { ...fx, ...idx, ...lod, ssim: ssimMod.ssim, ssimDetailed: ssimMod.ssimDetailed };
    cams = fx.towerViewpoints();
    assert.equal(cams.length, VIEWS);
    scenes = [];
    const t0 = Date.now();
    for (const noise of NOISES) for (const seed of SEEDS) scenes.push(runScene(seed, noise));
    main = scenes.find((s) => s.seed === 1 && s.noise === 0.015); // 부분 도착·변이 시험용 주 장면(잡음 있음)
    const rows = scenes.map((s) => `  시드 ${String(s.seed).padStart(2)} 잡음 ${s.noise.toFixed(3)}: LOD0..3 최소 ${s.ss.map((v) => Math.min(...v).toFixed(4)).join(' ')}`
      + ` | 채움 창만 ${s.filled.map((v) => Math.min(...v).toFixed(4)).join(' ')}`);
    console.log(`[ssim_views] 24 장면 × 8시점 최소 SSIM (합계 ${Date.now() - t0} ms)\n${rows.join('\n')}`);
    const eq = scenes.filter((s) => s.lod3EqLod2);
    console.log(`[ssim_views] LOD3=LOD2 장면 ${eq.length} / ${scenes.length}: ${eq.map((s) => `${s.seed}/${s.noise}`).join(' ')}\n  장면별 삼각형(LOD2→LOD3): ${scenes.map((s) => `${s.seed}/${s.noise}:${s.tri2}→${s.tri3}`).join(' ')}`);
  });

  const fmt = (arr) => arr.map((v) => v.toFixed(4)).join(' ');
  const key = (s, l) => `${s.seed}/${s.noise}/${l}`;

  test('기준 영상: 장면마다 8시점 합계 시간과 비어 있지 않음', () => {
    for (const s of scenes) {
      assert.ok(s.triCount >= 20000, `삼각형 ${s.triCount}`);
      assert.ok(s.traceMs < TRACE_TOTAL_MS_MAX, `시드 ${s.seed} 잡음 ${s.noise} 기준 영상 8시점 ${s.traceMs} ms (상한 ${TRACE_TOTAL_MS_MAX})`);
      s.refs.forEach((r, v) => {
        const fill = maskOf(r).reduce((a, b) => a + b, 0);
        assert.ok(fill > 0.05 * r.width * r.height, `시드 ${s.seed} 시점 ${v}(${cams[v].name}) 기준 영상 채움 ${fill}`);
      });
    }
    console.log(`[ssim_views] 기준 영상 8시점 최대 ${Math.max(...scenes.map((s) => s.traceMs))} ms, 삼각형 ${scenes[0].triCount}`);
  });

  test('(1) LOD 0 타일을 layer 로 그린 영상 대 기준: 24 장면 모두 SSIM >= 0.99, 빈 화소가 같다', () => {
    const bad = [];
    for (const s of scenes) {
      if (!(Math.min(...s.ss[0]) >= SSIM_LOD0_MIN)) bad.push(`시드 ${s.seed} 잡음 ${s.noise}: ${fmt(s.ss[0])}`);
      s.mask.forEach((r, i) => assert.ok(r <= MASK_MISMATCH_MAX_RATIO, `시드 ${s.seed} 잡음 ${s.noise} 시점 ${i} 빈 화소 불일치 ${r} > ${MASK_MISMATCH_MAX_RATIO}`));
    }
    assert.deepEqual(bad, [], `LOD 0 에서 ${SSIM_LOD0_MIN} 미달`);
  });

  for (const l of [1, 2, 3]) {
    test(`(2) LOD ${l}(오차 상한 ${terrainLodMaxErrorM(l, 2)} m, 2 m 셀) 대 LOD 0 기준: 알려진 미달을 뺀 모든 장면·8시점 최소 SSIM >= ${TERRAIN_SSIM_MIN}`, () => {
      const bad = [];
      for (const s of scenes) {
        if (Object.hasOwn(KNOWN_SHORTFALL, key(s, l))) continue;
        const m = Math.min(...s.ss[l]);
        if (!(m >= TERRAIN_SSIM_MIN)) bad.push(`시드 ${s.seed} 잡음 ${s.noise}: ${fmt(s.ss[l])}`);
      }
      assert.deepEqual(bad, [], `LOD ${l} 에서 ${TERRAIN_SSIM_MIN} 미달`);
    });
  }

  test('(2b) 알려진 미달: 목록이 실제 미달과 정확히 같고, 각 조건은 퇴행 하한 이상이다', () => {
    const actual = [];
    for (const s of scenes) {
      for (const l of [1, 2, 3]) if (Math.min(...s.ss[l]) < TERRAIN_SSIM_MIN) actual.push(key(s, l));
    }
    assert.deepEqual(actual.sort(), Object.keys(KNOWN_SHORTFALL).sort(), '미달 조건이 바뀌었다 — 나아졌으면 목록에서 빼고, 새로 생겼으면 원인을 찾는다');
    const rep = [];
    for (const [k, floor] of Object.entries(KNOWN_SHORTFALL)) {
      const [seed, noise, l] = k.split('/').map(Number);
      const s = scenes.find((x) => x.seed === seed && x.noise === noise);
      const m = Math.min(...s.ss[l]);
      rep.push(`${k}=${m.toFixed(4)}(하한 ${floor})`);
      assert.ok(m >= floor, `알려진 미달 ${k} 가 하한 아래로 퇴행: ${m.toFixed(4)} < ${floor}`);
    }
    console.log(`[ssim_views] 알려진 미달 ${rep.length}건: ${rep.join(' ')}`);
  });

  test('(2a) LOD3=LOD2 장면 목록: LOD 3 이 LOD 2 와 같은 메시인 장면이 측정한 목록(시드/잡음)과 같다', () => {
    const eq = scenes.filter((s) => s.lod3EqLod2);
    // 같은 메시면 삼각형 수도 같고, 다르면 LOD 3 이 더 성기다(삼각형 수가 늘지 않는다).
    for (const s of scenes) assert.ok(s.tri3 <= s.tri2, `시드 ${s.seed} 잡음 ${s.noise}: LOD3 삼각형 ${s.tri3} > LOD2 ${s.tri2}`);
    assert.deepEqual(eq.map((s) => `${s.seed}/${s.noise}`).sort(), [...LOD3_EQ_LOD2_SCENES].sort(), `LOD3=LOD2 장면 ${eq.length} (기대 ${LOD3_EQ_LOD2_SCENES.length}): 장면 목록이 측정과 다르다`);
    console.log(`[ssim_views] LOD3=LOD2 장면 ${eq.length}`);
  });

  test('(2c) 민감도 확인: 면 음영 재현은 (1)·(2) 기준 아래로 떨어지고, 층은 보간 음영을 실제로 쓴다', () => {
    // 주의: (a)(b) 는 면 음영을 이 시험이 직접 재현한 수치라 제품 변이와 무관하게 같다. 제품 쪽 변이는 맨 끝 단언이 잡는다.
    // 이 시험은 위 (1)·(2) 의 기준 수치가 정점 법선 보간에 민감함을 보인다. 두 갈래다.
    //  (a) 층만 면 음영(기준은 정점 법선): LOD 0 이 SSIM_LOD0_MIN 아래 → (1) 실패.
    //  (b) 층·기준 모두 면 음영(옛 모델): LOD 1~3 이 0.95 를 크게 밑돎 → (2) 실패.
    // 사본에서 직접 확인(2026-10-05, 저장소 전체를 임시 디렉터리에 복사해 이 파일만 실행):
    //  - raster.mjs 의 화소별 음영 분기를 끔(smooth = false 고정): (1) 이 24 장면 중 13 장면(잡음 장면 12 전부 + 시드 7 잡음 0)에서 실패,
    //    (2) 도 LOD 1 1·LOD 2 8·LOD 3 4 장면 추가 실패, (2d) 최대 색 차 7 로 실패.
    //  - 위에 더해 ref_trace.mjs 도 면 법선으로 되돌림(옛 모델 양쪽): (1) 은 통과하나 (2) LOD 1 이 잡음 장면 12 전부(장면별 최소 0.878~0.894)에서 실패,
    //    1부 정점 법선 시험 2건도 실패.
    //  - 보간 없이 삼각형 첫 꼭짓점 법선만 씀(raster): (1) 13 장면 실패, (2d) 실패.
    // 여기서는 같은 효과를 rasterizeTriangles normals:'face' 와 traceMesh 기본(면)으로 재현한다.
    const shade = (m) => (tri) => shadeLambert(faceNormalEnu(m.positions, m.indices, tri), TERRAIN_DEFAULTS.lightDirEnu, TERRAIN_DEFAULTS.baseRgb, TERRAIN_DEFAULTS.ambient);
    const renderFace = (l, v) => {
      const m = buildLayerMesh(main.lodTiles[l]);
      const out = emptyResult(cams[v].width, cams[v].height);
      rasterizeTriangles(cams[v], m, shade(m), out, { normals: 'face' });
      return out;
    };
    // (a)
    const a0 = Math.min(...cams.map((c, v) => mods.ssim(renderFace(0, v).color, main.refs[v].color, c.width, c.height, 3)));
    // (b)
    const faceRefs = cams.map((c) => traceMesh(c, main.refMesh, shadeFnDefault()));
    const mins = [1, 2, 3].map((l) => Math.min(...cams.map((c, v) => mods.ssim(renderFace(l, v).color, faceRefs[v].color, c.width, c.height, 3))));
    console.log(`[ssim_views] 변이(시드 1 잡음 0.015): (a) 층만 면 음영 LOD0 최소 ${a0.toFixed(4)} | (b) 양쪽 면 음영 LOD1..3 최소 ${fmt(mins)}`);
    assert.ok(a0 < SSIM_LOD0_MIN, `(a) 층만 면 음영인데 LOD0 ${a0.toFixed(4)} >= ${SSIM_LOD0_MIN}`);
    mins.forEach((m, i) => assert.ok(m < FACE_SHADING_NOISY_MAX, `(b) LOD ${i + 1} 면 음영인데 ${m.toFixed(4)} >= ${FACE_SHADING_NOISY_MAX}`));
    // 제품 변이 확인: 층(layer.render)이 보간 음영을 실제로 쓰는지 본다. 변이 A(화소별 음영 분기 끔)에서는 층 영상이 면 음영 영상과 같아져 실패한다.
    const layer = mods.createTerrainLayer();
    layer.accept(1, main.lodTiles[1]);
    const m1 = buildLayerMesh(main.lodTiles[1]);
    const out = emptyResult(cams[0].width, cams[0].height);
    rasterizeTriangles(cams[0], m1, shade(m1), out);
    const lay = layer.render(cams[0]);
    // 주의: 같은 제품 코드(rasterizeTriangles)끼리 층 경로와 직접 호출 경로가 같은 색을 내는지(경로 동일성)만 확인한다. 정답 대조가 아니다(정답 대조는 아래 추적 기준).
    assert.deepEqual(lay.color, out.color);
    // 해석적 기대: 같은 메시를 독립 광선 추적(server 램버트, 정점 법선)으로 그린 색과 층 색이 화소별로 거의 같고, 면 음영 색과는 눈에 띄게 다르다.
    const vtxRef = traceMesh(cams[0], buildLayerMesh(main.lodTiles[1]), shadeFnDefault(), VTX);
    const faceImg = renderFace(1, 0);
    let n = 0, nearVtx = 0, nearFace = 0;
    for (let i = 0; i < lay.index.length; i++) {
      if (lay.index[i] === EMPTY_INDEX || vtxRef.index[i] === EMPTY_INDEX) continue;
      n++;
      const d = (o) => Math.max(Math.abs(lay.color[3 * i] - o.color[3 * i]), Math.abs(lay.color[3 * i + 1] - o.color[3 * i + 1]), Math.abs(lay.color[3 * i + 2] - o.color[3 * i + 2]));
      if (d(vtxRef) <= 2) nearVtx++;
      if (d(faceImg) === 0) nearFace++;
    }
    console.log(`[ssim_views] (2c) 층 대 정점 법선 추적 ±2 이내 ${(nearVtx / n).toFixed(4)}, 층 대 면 음영 완전 일치 ${(nearFace / n).toFixed(4)} (화소 ${n})`);
    assert.ok(nearVtx / n >= NEAR_VTX_MIN, `층이 정점 법선 보간 색과 다름: ${nearVtx / n}`);
    assert.ok(nearFace / n <= NEAR_FACE_MAX, `층이 면 음영과 거의 같음(보간 꺼짐): ${nearFace / n}`);
  });

  test('(2d) 근평면 절단이 있는 가까운 시점: 층 래스터와 기준 영상의 화소별 색 차가 작다(원근 보정 법선 보간)', () => {
    // 눈을 지형 바로 위(약 1 m)에 두고 비스듬히 본다 → 카메라 뒤로 걸친 삼각형이 근평면에서 잘린다.
    const tiles = main.lodTiles[0];
    const m = buildLayerMesh(tiles);
    const eye = [3.2, -1.7, 0];
    let ez = -Infinity; // 눈 아래 지형 높이(가까운 정점 최댓값) + 1 m
    for (let k = 0; k < m.positions.length; k += 3) if (Math.hypot(m.positions[k] - eye[0], m.positions[k + 1] - eye[1]) < 3) ez = Math.max(ez, m.positions[k + 2]);
    eye[2] = ez + 1;
    const f0 = [0.8, 0.5, -0.25]; const fl = Math.hypot(...f0); const fw = f0.map((v) => v / fl);
    const r0 = [fw[1], -fw[0], 0]; const rl = Math.hypot(...r0); const right = r0.map((v) => v / rl);
    const down = [fw[1] * right[2] - fw[2] * right[1], fw[2] * right[0] - fw[0] * right[2], fw[0] * right[1] - fw[1] * right[0]];
    const R = [...right, ...down, ...fw];
    const t = [0, 1, 2].map((r) => -(R[3 * r] * eye[0] + R[3 * r + 1] * eye[1] + R[3 * r + 2] * eye[2]));
    const cam = { width: 160, height: 90, K: { fx: 80, fy: 80, cx: 80, cy: 45 }, R, t };
    // 근평면에 걸친 삼각형이 실제로 있는지
    let straddle = 0;
    for (let tri = 0; tri < m.indices.length / 3; tri++) {
      let behind = 0;
      for (let k = 0; k < 3; k++) {
        const p = 3 * m.indices[3 * tri + k];
        const z = R[6] * m.positions[p] + R[7] * m.positions[p + 1] + R[8] * m.positions[p + 2] + t[2];
        if (z < TERRAIN_DEFAULTS.nearM) behind++;
      }
      if (behind === 1 || behind === 2) straddle++;
    }
    assert.ok(straddle > 0, '근평면에 걸친 삼각형이 없다(시험이 의미 없음)');
    const layer = mods.createTerrainLayer();
    layer.accept(0, tiles);
    const out = layer.render(cam);
    const ref = traceMesh(cam, concatMeshes(tiles.map((tl) => mods.terrainTileToMesh(tl))), shadeFnDefault(), VTX);
    let both = 0, maxD = 0, over1 = 0;
    for (let i = 0; i < out.index.length; i++) {
      if (out.index[i] === EMPTY_INDEX || ref.index[i] === EMPTY_INDEX) continue;
      both++;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(out.color[3 * i + c] - ref.color[3 * i + c]);
        if (d > maxD) maxD = d;
        if (d > 1) over1++;
      }
    }
    console.log(`[ssim_views] 근평면 시점: 걸친 삼각형 ${straddle}, 공통 채움 ${both}, 최대 색 차 ${maxD}, 차>1 채널 ${over1}`);
    assert.ok(both > 0.5 * out.index.length, `공통 채움 ${both}`);
    assert.ok(maxD <= 2, `최대 색 차 ${maxD}`);
  });

  test('(3) 빈 layer 는 전부 빈 화소다(메우지 않는다)', () => {
    const layer = mods.createTerrainLayer();
    assert.equal(layer.state().level, -1);
    for (const c of cams) {
      const out = layer.render(c);
      assert.ok(out.index.every((v) => v === EMPTY_INDEX), '번호가 전부 -1');
      assert.ok(out.depth.every((v) => v === EMPTY_DEPTH), '깊이가 전부 0');
      assert.ok(out.color.every((v) => v === 0), '색이 전부 0');
    }
  });

  test('(4) 타일 4×4 중 12개만 도착: 도착한 타일 위만 칠하고 없는 타일 위는 EMPTY_INDEX', () => {
    // 없는 타일 4개: 격자 안에서 흩어진 위치
    const missing = new Set(['-2,-2', '1,-1', '-1,0', '0,1']);
    const arrived = main.lodTiles[0].filter((tl) => !missing.has(`${tl.tx},${tl.ty}`));
    assert.equal(arrived.length, 12);
    const layer = mods.createTerrainLayer();
    layer.accept(0, arrived);
    assert.equal(layer.state().tileCount, 12);
    // 같은 12개로 독립 기준 영상(부분 메시)을 그린다
    const partTracer = createTracer(concatMeshes(arrived.map((tl) => mods.terrainTileToMesh(tl))), VTX);
    let emptyWhereFullFilled = 0;
    const rep = [];
    cams.forEach((c, v) => {
      const out = layer.render(c);
      const part = partTracer(c, shadeFnDefault());
      let diff = 0;
      for (let i = 0; i < out.index.length; i++) {
        const k = out.index[i];
        if (k !== EMPTY_INDEX) {
          assert.ok(k >= 0 && k < 12, `시점 ${v} 화소 ${i} 번호 ${k} 가 도착한 타일 밖`);
          const tl = arrived[k];
          assert.ok(!missing.has(`${tl.tx},${tl.ty}`), `시점 ${v} 화소 ${i}: 없는 타일을 그림`);
        }
        if ((k === EMPTY_INDEX) !== (part.index[i] === EMPTY_INDEX)) diff++;
        if (k === EMPTY_INDEX && main.refs[v].index[i] !== EMPTY_INDEX) emptyWhereFullFilled++;
      }
      rep.push(diff / out.index.length);
      assert.ok(diff / out.index.length <= MASK_MISMATCH_MAX_RATIO, `시점 ${v}(${c.name}) 부분 메시 기준과 채움 불일치 ${diff}`);
    });
    console.log(`[ssim_views] 부분 도착 채움 불일치 비율: ${rep.map((x) => x.toFixed(5)).join(' ')}, 전체에서는 칠해지나 부분에서는 빈 화소 합 ${emptyWhereFullFilled}`);
    assert.ok(emptyWhereFullFilled > 0, '없는 타일 위 화소가 시험에 한 번도 나타나지 않음(시험이 의미 없음)');
  });
});
