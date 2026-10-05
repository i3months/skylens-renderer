// 관제탑 지형 8시점 SSIM 시험(T15.1-A5). SPEC '8시점 SSIM ≥ 0.95'(contracts/controlview TERRAIN_SSIM_MIN).
// 기준 영상은 같은 DEM 의 LOD 0 메시를 ref_trace(독립 광선-삼각형 교차)로 그린 것이다. 래스터와 코드를 공유하지 않는다.
// 1부: ref_trace 자체 검증(해석값·무차별 대조) — 래스터와 무관하게 통과해야 한다.
// 2부: createTerrainLayer 대 기준 영상(래스터 정확성, LOD 1..3 SSIM, 빈 층, 부분 도착).
// 기준 수치는 아래 상수에 미리 박아 두었고 측정값에 맞춰 바꾸지 않는다.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { traceMesh } from './ref_trace.mjs';
import { EMPTY_DEPTH, EMPTY_INDEX } from '../../../contracts/raster/index.mjs';
import { TERRAIN_SSIM_MIN, TERRAIN_DEFAULTS } from '../../../contracts/controlview/terrain.mjs';
import { TERRAIN_LOD_MAX_ERROR_M } from '../../../contracts/tower_assets/index.mjs';
import { faceNormalEnu, shadeLambert } from './shade.mjs';

// ---- 미리 정한 기준 수치 ----
const SSIM_LOD0_MIN = 0.99; // LOD 0 을 layer 로 그린 것 대 기준(래스터 정확성)
const MASK_MISMATCH_MAX_RATIO = 0.001; // 빈/채움이 다른 화소 비율 상한(변 위 화소 표본 차이 허용)
const TRACE_TOTAL_MS_MAX = 20000; // 8시점 기준 영상 합계 시간 상한
const VIEWS = 8;

// ---- 공용 도우미 ----
function shadeFnDefault() {
  return (normal) => shadeLambert(normal, TERRAIN_DEFAULTS.lightDirEnu, TERRAIN_DEFAULTS.baseRgb, TERRAIN_DEFAULTS.ambient);
}

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
});

// ======================= 2부: 층 대 기준 영상 =======================
describe('지형 층 8시점 SSIM', () => {
  let mods, dem, cams, refMesh, refs, lodTiles, traceMs, tileOrder;

  before(async () => {
    const fx = await import('./fixtures.mjs');
    const idx = await import('./index.mjs');
    const lod = await import('../../../server/terrain/mesh_lod/index.mjs');
    const ssimMod = await import('../../../server/metrics/ssim/index.mjs');
    mods = { ...fx, ...idx, ...lod, ssim: ssimMod.ssim };
    // 장면은 높이 잡음 0(부드러운 언덕). 잡음 ±0.15 m 장면은 면 단위 음영에서 LOD 1~3 이 0.88~0.95 로 0.95 에 못 미친다(연구 노트 t15-1b, 결정 0046):
    // 잡음이 LOD 오차 상한(0.5 m) 안이라 단순화가 잡음 질감을 지우는 것이 원인이며 기준을 낮추지 않고 장면 조건으로 분리해 기록한다.
    dem = fx.makeHillDem({ noiseRatio: 0 });
    cams = fx.towerViewpoints();
    assert.equal(cams.length, VIEWS);
    tileOrder = [];
    for (let ty = -2; ty < 2; ty++) for (let tx = -2; tx < 2; tx++) tileOrder.push([tx, ty]);
    lodTiles = [0, 1, 2, 3].map((l) => tileOrder.map(([tx, ty]) => lod.buildTerrainTile(dem, tx, ty, l)));
    refMesh = concatMeshes(lodTiles[0].map((tl) => lod.terrainTileToMesh(tl)));
    const t0 = Date.now();
    refs = cams.map((c) => traceMesh(c, refMesh, shadeFnDefault()));
    traceMs = Date.now() - t0;
  });

  const fmt = (arr) => arr.map((v) => v.toFixed(4)).join(' ');

  test('기준 영상: 8시점 합계 시간과 비어 있지 않음', () => {
    assert.ok(refMesh.indices.length / 3 >= 20000, `삼각형 ${refMesh.indices.length / 3}`);
    assert.ok(traceMs < TRACE_TOTAL_MS_MAX, `기준 영상 8시점 ${traceMs} ms (상한 ${TRACE_TOTAL_MS_MAX})`);
    refs.forEach((r, v) => {
      const filled = maskOf(r).reduce((a, b) => a + b, 0);
      assert.ok(filled > 0.05 * r.width * r.height, `시점 ${v}(${cams[v].name}) 기준 영상 채움 ${filled}`);
    });
    console.log(`[ssim_views] 기준 영상 8시점 ${traceMs} ms, 삼각형 ${refMesh.indices.length / 3}`);
  });

  test('(1) LOD 0 타일을 layer 로 그린 영상 대 기준: SSIM >= 0.99, 빈 화소가 같다', () => {
    const layer = mods.createTerrainLayer();
    assert.equal(layer.accept(0, lodTiles[0]), 'first');
    const ss = [], mm = [];
    cams.forEach((c, v) => {
      const out = layer.render(c);
      ss.push(mods.ssim(out.color, refs[v].color, out.width, out.height, 3));
      const a = maskOf(out), b = maskOf(refs[v]);
      let diff = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
      mm.push(diff / a.length);
    });
    console.log(`[ssim_views] LOD0 SSIM: ${fmt(ss)} | 빈/채움 불일치 비율: ${mm.map((x) => x.toFixed(5)).join(' ')}`);
    ss.forEach((s, v) => assert.ok(s >= SSIM_LOD0_MIN, `시점 ${v}(${cams[v].name}) SSIM ${s.toFixed(4)} < ${SSIM_LOD0_MIN}  전체: ${fmt(ss)}`));
    mm.forEach((r, v) => assert.ok(r <= MASK_MISMATCH_MAX_RATIO, `시점 ${v}(${cams[v].name}) 빈 화소 불일치 ${r} > ${MASK_MISMATCH_MAX_RATIO}`));
  });

  for (const lod of [1, 2, 3]) {
    test(`(2) LOD ${lod} 타일(오차 상한 ${TERRAIN_LOD_MAX_ERROR_M[lod]} m)을 layer 로 그린 영상 대 LOD 0 기준: SSIM >= ${TERRAIN_SSIM_MIN}`, () => {
      const layer = mods.createTerrainLayer();
      layer.accept(lod, lodTiles[lod]);
      const ss = cams.map((c, v) => {
        const out = layer.render(c);
        return mods.ssim(out.color, refs[v].color, out.width, out.height, 3);
      });
      console.log(`[ssim_views] LOD${lod} SSIM: ${fmt(ss)}`);
      ss.forEach((s, v) => assert.ok(s >= TERRAIN_SSIM_MIN, `LOD ${lod} 시점 ${v}(${cams[v].name}) SSIM ${s.toFixed(4)} < ${TERRAIN_SSIM_MIN}  전체: ${fmt(ss)}`));
    });
  }

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
    const arrived = lodTiles[0].filter((tl) => !missing.has(`${tl.tx},${tl.ty}`));
    assert.equal(arrived.length, 12);
    const layer = mods.createTerrainLayer();
    layer.accept(0, arrived);
    assert.equal(layer.state().tileCount, 12);
    // 같은 12개로 독립 기준 영상(부분 메시)을 그린다
    const partMesh = concatMeshes(arrived.map((tl) => mods.terrainTileToMesh(tl)));
    let emptyWhereFullFilled = 0;
    const rep = [];
    cams.forEach((c, v) => {
      const out = layer.render(c);
      const part = traceMesh(c, partMesh, shadeFnDefault());
      let diff = 0;
      for (let i = 0; i < out.index.length; i++) {
        const k = out.index[i];
        if (k !== EMPTY_INDEX) {
          assert.ok(k >= 0 && k < 12, `시점 ${v} 화소 ${i} 번호 ${k} 가 도착한 타일 밖`);
          const tl = arrived[k];
          assert.ok(!missing.has(`${tl.tx},${tl.ty}`), `시점 ${v} 화소 ${i}: 없는 타일을 그림`);
        }
        if ((k === EMPTY_INDEX) !== (part.index[i] === EMPTY_INDEX)) diff++;
        if (k === EMPTY_INDEX && refs[v].index[i] !== EMPTY_INDEX) emptyWhereFullFilled++;
      }
      rep.push(diff / out.index.length);
      assert.ok(diff / out.index.length <= MASK_MISMATCH_MAX_RATIO, `시점 ${v}(${c.name}) 부분 메시 기준과 채움 불일치 ${diff}`);
    });
    console.log(`[ssim_views] 부분 도착 채움 불일치 비율: ${rep.map((x) => x.toFixed(5)).join(' ')}, 전체에서는 칠해지나 부분에서는 빈 화소 합 ${emptyWhereFullFilled}`);
    assert.ok(emptyWhereFullFilled > 0, '없는 타일 위 화소가 시험에 한 번도 나타나지 않음(시험이 의미 없음)');
  });
});
