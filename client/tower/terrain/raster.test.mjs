// T15.1-A2 삼각형 래스터 시험. 알려진 장면의 기준 수치를 시험 안에 직접 박는다.
// 카메라는 contracts/raster 규약(R=I, t=0 이면 X_c = X_w). 투영 u = fx·x/z + cx, v = fy·y/z + cy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyResult } from '../../../contracts/raster/index.mjs';
import { rasterizeTriangles } from './raster.mjs';
import { traceMesh } from './ref_trace.mjs';

const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
// 100×100, fx=fy=100, 주점 (50,50): z=10 에서 u = 10·x + 50, v = 10·y + 50.
const cam100 = () => ({ width: 100, height: 100, K: { fx: 100, fy: 100, cx: 50, cy: 50 }, R: [...I], t: [0, 0, 0] });

// 삼각형 묶음을 mesh 로 만든다. tris = [[ [x,y,z],[x,y,z],[x,y,z] ], ...], tiles = 삼각형별 타일 번호.
function makeMesh(tris, tiles) {
  const positions = new Float32Array(tris.length * 9);
  const indices = new Uint32Array(tris.length * 3);
  const tileOfTriangle = new Int32Array(tris.length);
  for (let i = 0; i < tris.length; i += 1) {
    for (let v = 0; v < 3; v += 1) {
      positions[9 * i + 3 * v] = tris[i][v][0];
      positions[9 * i + 3 * v + 1] = tris[i][v][1];
      positions[9 * i + 3 * v + 2] = tris[i][v][2];
    }
    indices[3 * i] = 3 * i;
    indices[3 * i + 1] = 3 * i + 1;
    indices[3 * i + 2] = 3 * i + 2;
    tileOfTriangle[i] = tiles ? tiles[i] : i;
  }
  return { positions, indices, tileOfTriangle };
}

function countFilled(out) {
  let n = 0;
  for (let i = 0; i < out.index.length; i += 1) if (out.index[i] !== -1) n += 1;
  return n;
}

// ① 정면 삼각형 하나: 꼭짓점이 정수 화소 (20,20)·(60,20)·(20,61) 가 되게 z=10 에 둔다.
//    수직·수평 변은 x.5 표본과 겹치지 않고, 빗변 41u+40v=3260 도 어떤 화소 중심도 지나지 않는다(합이 .5).
//    포함 영역 u≥20, v≥20, 41u+40v≤3260 의 화소 중심 수는 손으로 센 820 개. 깊이는 모두 10.
test('A2_single_front_triangle_coverage_and_depth', () => {
  // 화소 (20,20): x=(20-50)/10=-3, (60,20): x=1, (20,61): y=(61-50)/10=1.1
  const mesh = makeMesh([[[-3, -3, 10], [1, -3, 10], [-3, 1.1, 10]]], [7]);
  const out = emptyResult(100, 100);
  rasterizeTriangles(cam100(), mesh, () => [10, 20, 30], out);
  assert.equal(countFilled(out), 820, '덮인 화소 수');
  for (let i = 0; i < out.index.length; i += 1) {
    if (out.index[i] !== -1) {
      assert.equal(out.index[i], 7, '타일 번호');
      assert.ok(Math.abs(out.depth[i] - 10) < 1e-4, '깊이 10');
      assert.equal(out.color[3 * i], 10);
      assert.equal(out.color[3 * i + 1], 20);
      assert.equal(out.color[3 * i + 2], 30);
    }
  }
});

// ② 사각형 (20,20)-(60,50) 을 대각선 (20,20)-(60,50) 으로 두 삼각형으로 나눈다.
//    사각형 내부 화소 중심 수 = (가로 40)·(세로 30) = 1200. 대각선은 어떤 화소 중심도 지나지 않는다
//    (6·px+39 는 홀수라 8·py 와 같을 수 없음). 두 삼각형의 덮인 화소 합 = 1200, 합집합 = 1200 → 구멍·겹침 0.
test('A2_shared_edge_no_gap_no_overlap', () => {
  // 화소 (20,20)->x=-3,y=-3 / (60,20)->x=1,y=-3 / (60,50)->x=1,y=0 / (20,50)->x=-3,y=0.
  const A = [-3, -3, 10]; const B = [1, -3, 10]; const C = [1, 0, 10]; const D = [-3, 0, 10];
  const triA = makeMesh([[A, B, C]], [0]);
  const triB = makeMesh([[A, C, D]], [1]);
  const both = makeMesh([[A, B, C], [A, C, D]], [0, 1]);

  const outA = emptyResult(100, 100); rasterizeTriangles(cam100(), triA, () => [1, 1, 1], outA);
  const outB = emptyResult(100, 100); rasterizeTriangles(cam100(), triB, () => [2, 2, 2], outB);
  const outBoth = emptyResult(100, 100); rasterizeTriangles(cam100(), both, () => [3, 3, 3], outBoth);

  const nA = countFilled(outA); const nB = countFilled(outB);
  assert.equal(nA + nB, 1200, '두 삼각형 화소 합 = 사각형 넓이');
  assert.equal(countFilled(outBoth), 1200, '합집합 = 사각형 넓이(구멍 없음)');
});

// ③ 앞뒤 가림: 겹치는 두 삼각형(가까운 z=5, 먼 z=20). 그리는 순서를 바꿔도 결과가 같다.
test('A2_occlusion_order_independent', () => {
  // 둘 다 화소 (30,30)-(70,30)-(30,70) 영역을 덮되 깊이만 다르게.
  const nearT = (z) => [[(30 - 50) / 100 * z, (30 - 50) / 100 * z, z], [(70 - 50) / 100 * z, (30 - 50) / 100 * z, z], [(30 - 50) / 100 * z, (70 - 50) / 100 * z, z]];
  const close = nearT(5); const far = nearT(20);
  const shade = (tri) => (tri === 0 ? [111, 0, 0] : [0, 222, 0]);

  const m1 = makeMesh([close, far], [0, 1]);
  const m2 = makeMesh([far, close], [1, 0]);
  const shade2 = (tri) => (tri === 0 ? [0, 222, 0] : [111, 0, 0]); // m2 는 순서가 반대이므로 색도 맞바꿈

  const out1 = emptyResult(100, 100); rasterizeTriangles(cam100(), m1, shade, out1);
  const out2 = emptyResult(100, 100); rasterizeTriangles(cam100(), m2, shade2, out2);

  // 두 그림이 완전히 같아야 한다(가까운 삼각형이 항상 이김). 단 index 는 타일 번호라 m1=0, m2 에서도 0(close) 이어야 함.
  assert.ok(countFilled(out1) > 0, '그려진 화소 있음');
  for (let i = 0; i < out1.index.length; i += 1) {
    assert.equal(out1.index[i], out2.index[i], `화소 ${i} index`);
    assert.equal(out1.depth[i], out2.depth[i], `화소 ${i} depth`);
    assert.equal(out1.color[3 * i], out2.color[3 * i]);
    assert.equal(out1.color[3 * i + 1], out2.color[3 * i + 1]);
    assert.equal(out1.color[3 * i + 2], out2.color[3 * i + 2]);
    if (out1.index[i] !== -1) assert.equal(out1.depth[i], 5, '가까운 깊이 5 가 남음');
  }
});

// ④ 근평면에 걸친 삼각형: 일부가 카메라 뒤(z<0)여도 던지지 않고 잘려 그려진다. 완전히 뒤면 0 화소.
test('A2_near_plane_clipping', () => {
  const straddle = makeMesh([[[-3, -3, 10], [3, -3, 10], [0, 3, -5]]], [0]); // 한 꼭짓점이 카메라 뒤
  const out = emptyResult(100, 100);
  assert.doesNotThrow(() => rasterizeTriangles(cam100(), straddle, () => [9, 9, 9], out));
  assert.ok(countFilled(out) > 0, '잘린 삼각형이 그려짐');
  for (let i = 0; i < out.index.length; i += 1) {
    if (out.index[i] !== -1) assert.ok(out.depth[i] > 0 && Number.isFinite(out.depth[i]), '깊이는 양의 유한');
  }

  const behind = makeMesh([[[-3, -3, -10], [3, -3, -5], [-3, 3, -8]]], [0]); // 전부 카메라 뒤
  const out2 = emptyResult(100, 100);
  rasterizeTriangles(cam100(), behind, () => [9, 9, 9], out2);
  assert.equal(countFilled(out2), 0, '완전히 뒤면 0 화소');
});

// ⑤ 기울어진 평면: 모든 덮인 화소의 깊이가 평면·광선 교차의 해석값과 1e-4 이내(원근 보정).
test('A2_tilted_plane_depth_matches_analytic', () => {
  const Vw = [[-4, -4, 8], [4, -4, 14], [-4, 4, 11]];
  const mesh = makeMesh([Vw], [0]);
  const cam = cam100();
  const out = emptyResult(100, 100);
  rasterizeTriangles(cam, mesh, () => [50, 60, 70], out);
  assert.ok(countFilled(out) > 0, '그려진 화소 있음');

  // 카메라 공간 평면(여기선 월드=카메라) n·X = d. n = (B-A)×(C-A), d = n·A.
  const A = Vw[0]; const B = Vw[1]; const C = Vw[2];
  const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
  const e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
  const nx = e1[1] * e2[2] - e1[2] * e2[1];
  const ny = e1[2] * e2[0] - e1[0] * e2[2];
  const nz = e1[0] * e2[1] - e1[1] * e2[0];
  const d = nx * A[0] + ny * A[1] + nz * A[2];
  const { fx, fy, cx, cy } = cam.K;

  for (let py = 0; py < 100; py += 1) {
    for (let px = 0; px < 100; px += 1) {
      const pix = py * 100 + px;
      if (out.index[pix] === -1) continue;
      const u = px + 0.5; const v = py + 0.5;
      // 광선 X_c = z·((u-cx)/fx, (v-cy)/fy, 1). 평면에 대입 → z = d / (n·방향).
      const z = d / (nx * (u - cx) / fx + ny * (v - cy) / fy + nz);
      assert.ok(Math.abs(out.depth[pix] - z) < 1e-4, `화소(${px},${py}) 깊이 ${out.depth[pix]} vs 해석 ${z}`);
    }
  }
});

// ⑥ 화면 밖·퇴화·비유한 입력.
test('A2_offscreen_degenerate_nonfinite', () => {
  // 화면 완전히 밖(왼쪽 멀리): 0 화소, 던지지 않음.
  const off = makeMesh([[[-100, -100, 10], [-80, -100, 10], [-100, -80, 10]]], [0]);
  const o1 = emptyResult(100, 100);
  assert.doesNotThrow(() => rasterizeTriangles(cam100(), off, () => [1, 2, 3], o1));
  assert.equal(countFilled(o1), 0, '화면 밖은 0 화소');

  // 경계에 걸친 삼각형: 화면 안쪽만 그려지고(>0) 화면 밖으로 쓰지 않는다(index 길이 그대로).
  const partial = makeMesh([[[-10, -3, 10], [1, -3, 10], [-3, 1, 10]]], [0]); // 왼쪽으로 삐져나감
  const o2 = emptyResult(100, 100);
  rasterizeTriangles(cam100(), partial, () => [1, 2, 3], o2);
  // 화면 안(x≥0)만 그려지고, 삼각형이 닿지 않는 오른쪽 아래는 비어 있다. 출력 배열 길이는 그대로.
  assert.equal(o2.index.length, 100 * 100);
  assert.equal(countFilled(o2), 1466, '경계로 잘려 화면 안쪽만 그려짐');
  assert.equal(o2.index[0], -1, '삼각형 밖 화소는 비어 있음');
  assert.equal(o2.index[30 * 100 + 0], 0, '왼쪽 화면 경계 화소(0,30)는 그려짐');

  // 퇴화(세 점 일직선, 면적 0): 0 화소, 던지지 않음.
  const degen = makeMesh([[[-3, -3, 10], [0, 0, 10], [3, 3, 10]]], [0]);
  const o3 = emptyResult(100, 100);
  assert.doesNotThrow(() => rasterizeTriangles(cam100(), degen, () => [1, 2, 3], o3));
  assert.equal(countFilled(o3), 0, '퇴화 삼각형은 0 화소');

  // 비유한 정점: TypeError.
  const nan = makeMesh([[[-3, -3, 10], [1, NaN, 10], [-3, 1, 10]]], [0]);
  assert.throws(() => rasterizeTriangles(cam100(), nan, () => [1, 2, 3], emptyResult(100, 100)), TypeError);
  const inf = makeMesh([[[-3, -3, 10], [1, -3, 10], [-3, 1, Infinity]]], [0]);
  assert.throws(() => rasterizeTriangles(cam100(), inf, () => [1, 2, 3], emptyResult(100, 100)), TypeError);
});

// ⑦ 성능: 640×360, 삼각형 5만 개를 1초 이내에 그린다.
test('A2_performance_640x360_50k', () => {
  const W = 640; const H = 360; const N = 50000;
  const positions = new Float32Array(N * 9);
  const indices = new Uint32Array(N * 3);
  const tileOfTriangle = new Int32Array(N);
  // 결정적 유사난수로 화면 전역에 작은 삼각형을 흩뿌린다(z 10~30).
  let s = 123456789 >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const { fx, fy, cx, cy } = { fx: 400, fy: 400, cx: 320, cy: 180 };
  for (let i = 0; i < N; i += 1) {
    const z = 10 + rnd() * 20;
    const u = rnd() * W; const vv = rnd() * H;
    // 화면 (u,v) 근처에서 몇 화소 크기의 삼각형. 화면 좌표 → 월드: x=(u-cx)/fx·z.
    for (let vtx = 0; vtx < 3; vtx += 1) {
      const du = u + (rnd() - 0.5) * 8;
      const dv = vv + (rnd() - 0.5) * 8;
      positions[9 * i + 3 * vtx] = (du - cx) / fx * z;
      positions[9 * i + 3 * vtx + 1] = (dv - cy) / fy * z;
      positions[9 * i + 3 * vtx + 2] = z;
    }
    indices[3 * i] = 3 * i; indices[3 * i + 1] = 3 * i + 1; indices[3 * i + 2] = 3 * i + 2;
    tileOfTriangle[i] = i & 1023;
  }
  const mesh = { positions, indices, tileOfTriangle };
  const cam = { width: W, height: H, K: { fx, fy, cx, cy }, R: [...I], t: [0, 0, 0] };
  const out = emptyResult(W, H);
  const shade = () => [100, 150, 200];

  const t0 = performance.now();
  rasterizeTriangles(cam, mesh, shade, out);
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `5만 삼각형 ${ms.toFixed(1)}ms (1000ms 이내)`);
});

// ⑧ 같은 깊이는 먼저 그린 삼각형 유지(계약 terrain.mjs): 깊이 버퍼는 Float32 이므로 double z 가 아니라 fround(z) 로 비교해야 한다.
//    기울어진 삼각형을 같은 모양으로 두 번 그리면 화소마다 z 가 같으므로 두 번째(타일 1)는 아무것도 덮어쓰지 못한다.
test('A2_equal_depth_keeps_earlier_triangle', () => {
  const T = [[-4, -4, 8], [4, -4, 14], [-4, 4, 11]];
  const mesh = makeMesh([T, T], [0, 1]);
  const out = emptyResult(100, 100);
  rasterizeTriangles(cam100(), mesh, () => [5, 5, 5], out);
  const n = countFilled(out);
  assert.ok(n > 1000, `그려진 화소 ${n}`);
  let zeros = 0;
  for (let i = 0; i < out.index.length; i += 1) {
    assert.notEqual(out.index[i], 1, `화소 ${i}: 같은 깊이가 먼저 그린 삼각형을 덮어씀`);
    if (out.index[i] === 0) zeros += 1;
  }
  assert.equal(zeros, n, '덮인 화소는 전부 타일 0');
});

// 픽셀 중심 시험용 카메라: fx=fy=64, 주점 (50,50), z=64 에서 u = x + 50, v = y + 50 이 정확(1/64 가 2의 거듭제곱).
const cam64 = () => ({ width: 100, height: 100, K: { fx: 64, fy: 64, cx: 50, cy: 50 }, R: [...I], t: [0, 0, 0] });
// 화소 중심 좌표 (u,v) → 월드 (x,y,64)
const P = (u, v) => [u - 50, v - 50, 64];
function pixelSet(out) {
  const s = new Set();
  for (let i = 0; i < out.index.length; i += 1) if (out.index[i] !== -1) s.add(i);
  return s;
}
function renderOne(tri, camera = cam64()) {
  const out = emptyResult(100, 100);
  rasterizeTriangles(camera, makeMesh([tri], [0]), () => [1, 1, 1], out);
  return out;
}

// ⑨ top-left 규칙: 꼭짓점이 화소 중심(x.5)이라 공유 변(수평·수직·대각)이 표본점을 지난다.
//    정사각형 (10.5,10.5)-(30.5,30.5) 의 포함 영역은 top·left 변 위 표본만 가지므로 화소 x,y ∈ [10,29] → 400개.
//    대각선 위 중심 20개(10..29)는 정확히 한 삼각형에만 속해야 한다: 190 + 210 = 400.
test('A2_top_left_rule_shared_edges_on_pixel_centers', () => {
  const a = P(10.5, 10.5), b = P(30.5, 10.5), c = P(30.5, 30.5), d = P(10.5, 30.5);
  for (const [name, A, B] of [
    ['같은 감김', [a, b, c], [a, c, d]],
    ['B 감김 반대', [a, b, c], [a, d, c]],
    ['A 감김 반대', [a, c, b], [a, c, d]],
  ]) {
    const oA = renderOne(A); const oB = renderOne(B);
    const sA = pixelSet(oA); const sB = pixelSet(oB);
    // 꼭짓점 순환 순서를 바꿔도(수평 변이 가장자리 함수 0·1·2 번 어디에 오든) 같은 화소 집합이어야 한다.
    for (const tri of [A, B]) {
      const base = pixelSet(renderOne(tri));
      for (const rot of [[1, 2, 0], [2, 0, 1]]) {
        const got = pixelSet(renderOne(rot.map((k) => tri[k])));
        assert.deepEqual([...got].sort((x, y) => x - y), [...base].sort((x, y) => x - y), `${name}: 꼭짓점 순환 ${rot}`);
      }
    }
    let overlap = 0;
    for (const p of sA) if (sB.has(p)) overlap += 1;
    assert.equal(overlap, 0, `${name}: 이중으로 덮인 화소`);
    assert.equal(sA.size + sB.size, 400, `${name}: nA+nB = 합집합`);
    assert.equal(sA.size, 210, `${name}: A 화소 수(대각선 20개 포함)`);
    assert.equal(sB.size, 190, `${name}: B 화소 수`);
    const all = new Set([...sA, ...sB]);
    for (let y = 10; y < 30; y += 1) for (let x = 10; x < 30; x += 1) assert.ok(all.has(y * 100 + x), `${name}: 구멍 (${x},${y})`);
    const both = emptyResult(100, 100);
    rasterizeTriangles(cam64(), makeMesh([A, B], [0, 1]), () => [1, 1, 1], both);
    assert.equal(countFilled(both), 400, `${name}: 함께 그려도 400`);
  }
  const oA = renderOne([a, b, c]);
  assert.notEqual(oA.index[10 * 100 + 15], -1, 'top 변 위 표본 포함');
  assert.equal(oA.index[15 * 100 + 30], -1, '오른쪽 변 위 표본 제외');
  assert.notEqual(oA.index[15 * 100 + 15], -1, '대각선 위 표본은 A 에 포함');
  assert.equal(oA.index[15 * 100 + 20], 0, 'A 내부');
  const oB = renderOne([a, c, d]);
  assert.notEqual(oB.index[20 * 100 + 10], -1, 'left 변 위 표본 포함');
  assert.equal(oB.index[30 * 100 + 15], -1, 'bottom 변 위 표본 제외');
  assert.equal(oB.index[15 * 100 + 15], -1, '대각선 위 표본은 B 에서 제외');
});

// ⑩ 근평면 절단 보간: 절단점의 x·y 는 변을 따라 tI=(near−z0)/(z1−z0) 로 선형 보간된다.
//    독립 광선 추적기(ref_trace)와 화소 단위로 비교한다(둘 다 z ≥ near 만 본다). 단일 삼각형이라 경계 화소 말고는 일치해야 한다.
//    ㉠ 꼭짓점 하나가 뒤(절단 결과 4각형) ㉡ 꼭짓점 둘이 뒤(절단 결과 3각형).
test('A2_near_plane_clip_interpolation_matches_reference', () => {
  const cases = [
    { name: '한 꼭짓점 뒤', tri: [[-3, -3, 10], [3, -3, 10], [0, 3, -5]], count: 7619, maxMismatch: 2 },
    { name: '두 꼭짓점 뒤', tri: [[-2, -1, 6], [4, -2, -3], [-5, 3, -2]], count: 1286, maxMismatch: 0 },
  ];
  for (const { name, tri, count, maxMismatch } of cases) {
    const mesh = makeMesh([tri], [0]);
    const out = emptyResult(100, 100);
    rasterizeTriangles(cam100(), mesh, () => [1, 1, 1], out);
    const ref = traceMesh(cam100(), mesh, () => [1, 1, 1]);
    assert.equal(countFilled(out), count, `${name}: 덮인 화소 수`);
    let mismatch = 0;
    for (let i = 0; i < out.index.length; i += 1) {
      if (out.index[i] !== ref.index[i]) mismatch += 1;
      else if (out.index[i] !== -1) assert.ok(Math.abs(out.depth[i] - ref.depth[i]) < 1e-3, `${name}: 화소 ${i} 깊이`);
    }
    assert.ok(mismatch <= maxMismatch, `${name}: 참조와 다른 화소 ${mismatch}`);
  }
});
