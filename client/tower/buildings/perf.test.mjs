// 건물 층 면·선·점 래스터(raster_flat·raster_tex·lines·points)와 index.mjs 조립의 성능·작업량 시험. 3000개 건물 묶음을 세 카메라(위에서 내려다봄 + 비스듬 2종)로 세 옵션 각각 렌더(RUNS=5회 중앙값).
// 회귀 감시의 중심은 결정적 단언이다: 모드별 래스터 호출 수(정확값)·처리 화소 수(±0.1%)·덮인 화소 수(±0.1%)·aerial 색 수, 그리고 깊이 시험과 무관한 면 작업량(그린 삼각형 수·가장자리 판정 통과 화소 수, 정확값). 래스터를 여러 번 부르거나 rasterizeGroupsCore 의 묶음 순회를 반복하는 변이는 시간이 아니라 이 숫자로 잡는다.
// 시간 문턱은 CPU 래스터가 크게 느려지는 회귀만 보는 거친 상한이며 모드마다 따로 둔다(측정 규칙과 근거는 RENDER_THRESHOLD_MS 위). S1 판정이 아니다. 실기기 fps 는 T17 [local] 에서 잰다.
// 이 파일의 실측값은 모두 [cloud](클라우드 VM 4코어) 값이다. 이 시험의 범위는 건물 층 전체 렌더(래스터 4종 + 층 조립)이며 지형·항공기 층은 보지 않는다.
// 재사용 out 단언: 이전 렌더 잔여가 가득한 out 을 넘겨도 덮인 화소 수가 새 out 렌더와 같아야 한다(index.mjs 의 out 초기화 삭제 변이를 잡는다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_INDEX } from '../../../contracts/raster/index.mjs';
import { makeAerialImage } from './test_support/fixtures.mjs';

const W = 1280, H = 720;
const RUNS = 5;
const GROUP_COUNT = 6; // 합성 장면을 나눌 묶음 수(3000개 건물을 500개씩)
// 합성 항공영상 범위(ENU m): 건물 격자(약 ±1400 m) 전체를 덮는다.
const AERIAL_BOUNDS_M = { minX: -1500, minY: -1500, maxX: 1500, maxY: 1500 };
// 모드별 렌더 문턱(ms). 한 문턱을 공용하면 points(실측 1 ms 안팎)가 수십 배 느려져도 통과하므로 모드마다 둔다.
// 측정 규칙(측정 전에 정함, F-505): 문턱은 래스터 호출 수·화소 수 단언이 못 보는 큰 회귀용 거친 상한이다. 원본을 8 프로세스 동시(×5 라운드 40회)와 16 프로세스 동시(×3 라운드 48회)로 돌려 모드별 최대를 재고,
// 문턱 = 그 최대의 약 1.5배 이상으로 올림한다. 래스터 4회 반복 변이를 시간으로 가르려고 문턱을 내리지 않는다(그건 결정적 단언의 몫이고, 부하에서 원본 최대가 변이 최소와 겹쳐 시간으로는 못 가른다).
// 측정 조건: render(camera, out) 에 미리 할당한 out 을 넘겨 출력 버퍼 할당 비용을 뺀다(out 초기화 fill 은 남는다). 스레드 CPU 시간, 카메라 3개 중 최대. VM 4코어.
// [cloud] 실측(F-505, 원본): 순차 최대 black 51.9·aerial 68.3·points 1.2 ms. 8 프로세스 동시 40회 최대 black 74.7·aerial 102.2·points 1.8 ms, 16 프로세스 동시 48회 최대 black 77.8·aerial 100.7·points 1.6 ms. 전부 통과.
// 그래서 black 120(최대의 1.5배)·aerial 160(1.57배)·points 3 ms(1.67배). 이전 F-503 의 aerial 90 → 120 은 부하 최대 94.9 ms 기준이었고 이번 부하 최대가 102.2 ms 라 100 아래로 되돌릴 근거가 없다.
// 한계: 이 문턱은 래스터가 약 1.5~2배 이상 느려져야 실패한다. 래스터를 4회 부르는 식의 회귀는 호출 수·화소 수 단언이 정확히 잡는다.
// points: 1280×720 에서는 출력 버퍼 초기화 같은 고정 비용이 커서 가로세로 1/4 카메라(같은 시야각)로 재고, 1회가 threadCpuUsage 눈금(이 VM 약 4 ms)보다 짧아 POINTS_REPS 회를 한 쌍으로 재서 호출당 값을 낸다.
const POINTS_REPS = 100; // points 는 1회가 눈금보다 짧아 100회를 한 쌍으로 잰다(해상도 약 0.04 ms)
const RENDER_THRESHOLD_MS = { black: 120, points: 3, aerial: 160 };
// 비CPU 멈춤 감시(Atomics.wait·sleep·I/O 대기처럼 CPU 시간이 못 보는 지연). 측정 규칙(측정 전에 정함, F-505): 호출당 (벽시계 − CPU) 를 RUNS=5회 재어 최솟값을 문턱과 비교한다.
// 다른 프로세스에 CPU 를 빼앗겨 생기는 대기는 5회 모두에서 같이 커질 수 없다고 보고 최솟값을 쓴다(한 번의 순간 지연에 실패하지 않는다). 문턱은 부하 원본 최댓값 위, 호출당 400 ms 대기 변이 아래의 거친 상한이다.
// [cloud] 실측(F-505, 원본): 16 프로세스 동시 48회에서 최솟값의 최대 200.5 ms. Atomics.wait 400 ms 변이는 호출마다 대기하므로 최솟값 ≥ 400 ms.
// 한계: 문턱 350 ms 미만의 멈춤(예: 100 ms 대기)은 못 잡는다. 그 이하는 실기기 fps(T17 [local])가 맡는다.
const WALL_STALL_MS = 350;
// 모드·카메라(위/남동/북서)별 덮인 화소 수의 측정값. 래스터는 결정적이라 3회 실행이 같았고(묶음 1개·6개 모두), 측정값과 ±0.1% 안이어야 한다.
const EXPECTED_COVERED = {
  black: [261789, 398769, 415587],
  points: [1348, 4268, 3995],
  aerial: [251783, 383930, 400922],
};
const COVERED_TOLERANCE = 0.001;
// 모드별 render 한 번의 래스터 함수 호출 수(정확값)와 카메라별 처리 화소 수(±0.1%). stats() 의 rasterCalls·rasterPixels 로 읽는다.
// 출처: 이 합성 장면(3000 건물, 묶음 6개, 1280×720, 카메라 3개)을 원본 커밋 4b46e9c8 에서 모드·카메라마다 1회 렌더해 잰 값이다(래스터가 결정적이라 반복해도 같다. 반복 수 1).
// points 식: 점 수 = 건물당 표본점 20 × 그려진(컬링 통과) 건물 수. 카메라별 그려진 묶음 2/6/6개 = 건물 1000/3000/3000 → 20000/60000/60000.
// black = 면(flat) + 선(lines) 2회, aerial = 질감 1회, points = 점 1회. 화소 수: flat·tex 는 깊이 시험 통과(onPixel 호출), lines 는 plot 시도, points 는 검사한 점 수.
const EXPECTED_RASTER_CALLS = { black: 2, points: 1, aerial: 1 };
const EXPECTED_RASTER_PIXELS = {
  black: [448077, 663998, 686759],
  points: [20000, 60000, 60000],
  aerial: [408823, 587575, 610462],
};
// 면 작업량(정확값, 깊이 시험과 무관). 위와 같은 출처(e0dcb1b 에서 측정, 래스터 논리는 4b46e9c8 과 같다. 모드·카메라마다 1회 렌더)이고 stats() 의 workTris·workCovered 로 읽는다.
// workTris = 근평면 절단 뒤 그린 부채꼴 삼각형 수, workCovered = w0·w1·w2 판정을 통과한 화소 수(깊이 비교 전). black(면)과 aerial(질감)은 같은 면을 같은 순서로 그리므로 값이 같고, points 는 면을 그리지 않아 0 이다.
// 묶음 순회를 2회·4회 반복하면 깊이 시험이 두 번째부터 막아 처리 화소 수는 그대로지만 이 값은 정확히 2배·4배가 되어 실패한다.
const EXPECTED_WORK = {
  black: { tris: [1210, 3407, 3194], covered: [503568, 785820, 825812] },
  points: { tris: [0, 0, 0], covered: [0, 0, 0] },
  aerial: { tris: [1210, 3407, 3194], covered: [503568, 785820, 825812] },
};
// aerial 카메라별 서로 다른 색 수 하한: 원본 결과(19230/51954/48890)의 약 90%. 1×1 단색 영상이면 몇 가지뿐이다.
const MIN_AERIAL_COLORS = [17300, 46700, 44000];
const MODE_SWITCH_THRESHOLD_MS = 1;
const MODE_SWITCH_CALLS = 1000;

// 스레드 CPU 시간(threadCpuUsage, 없으면 프로세스 cpuUsage)으로 잰다: 전체 npm test 처럼 다른 프로세스가 CPU 를 빼앗아 생기는 대기는 포함하지 않는다(reuse_cull.test.mjs 와 같은 방식).
// 문턱 근거는 위 RENDER_THRESHOLD_MS 주석. CPU 일이 크게 늘어나는 변이는 CPU 시간에도 그대로 잡힌다.
// 한계: CPU 시간은 비CPU 지연을 보지 못한다. 그런 지연은 위 WALL_STALL_MS 주석의 (벽시계 − CPU) 최솟값 감시가 문턱 350 ms 이상일 때만 잡는다.
// 결정적 단언(래스터 호출 수·처리 화소 수·덮인 화소 수 ±0.1%·aerial 색 수 하한·묶음 수·건물 수)은 시간과 별개로 병행한다.
function cpuMs() { const u = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage(); return (u.user + u.system) / 1000; }

/** 중앙값 계산 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 행렬 곱셈: 3×3 회전 행렬 × 3차원 벡터 */
function mulMatrix3x3Vec3(R, v) {
  return [
    R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
    R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
    R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
  ];
}

/** 합성 건물 묶음 생성: 3000개 건물, 격자 배치, 각 건물 정점 8개·삼각형 12개·모서리 선 12개·표본점 20개 */
function createSyntheticBundle() {
  const buildingCount = 3000;
  const gridSize = Math.ceil(Math.sqrt(buildingCount));
  const spacing = 50; // 건물 간 거리(m)

  const ids = [];
  const positions = [];
  const indices = [];
  const edgeLines = [];
  const points = [];

  let vertexOffset = 0;

  for (let id = 0; id < buildingCount; id++) {
    ids.push(id);

    // 격자 위치 계산
    const gx = id % gridSize;
    const gy = Math.floor(id / gridSize);
    const cx = (gx - gridSize / 2) * spacing;
    const cy = (gy - gridSize / 2) * spacing;
    const cz = 0;

    // 박스 크기
    const w = 20, h = 30, d = 20;
    const hh = h / 2;

    // 8개 정점 (정사각형 프리즘)
    const verts = [
      [cx - w / 2, cy - d / 2, cz], [cx + w / 2, cy - d / 2, cz],
      [cx + w / 2, cy + d / 2, cz], [cx - w / 2, cy + d / 2, cz],
      [cx - w / 2, cy - d / 2, cz + h], [cx + w / 2, cy - d / 2, cz + h],
      [cx + w / 2, cy + d / 2, cz + h], [cx - w / 2, cy + d / 2, cz + h],
    ];

    for (const v of verts) {
      positions.push(v[0], v[1], v[2]);
    }

    // 12개 삼각형 (정육면체 면)
    // 바닥(2개), 천장(2개), 앞(2개), 뒤(2개), 좌(2개), 우(2개)
    const tris = [
      [0, 1, 2], [0, 2, 3], // 바닥
      [4, 6, 5], [4, 7, 6], // 천장
      [0, 5, 1], [0, 4, 5], // 앞
      [2, 7, 3], [2, 6, 7], // 뒤
      [0, 3, 7], [0, 7, 4], // 좌
      [1, 5, 6], [1, 6, 2], // 우
    ];

    for (const tri of tris) {
      indices.push(
        vertexOffset + tri[0],
        vertexOffset + tri[1],
        vertexOffset + tri[2]
      );
    }

    // 12개 모서리 선 (각 모서리 좌표 쌍, 6 float씩)
    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 0], // 바닥
      [4, 5], [5, 6], [6, 7], [7, 4], // 천장
      [0, 4], [1, 5], [2, 6], [3, 7], // 수직
    ];

    for (const [v0, v1] of edges) {
      const p0 = verts[v0];
      const p1 = verts[v1];
      edgeLines.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2]);
    }

    // 20개 표본점 (박스 표면 샘플)
    const samplePoints = [];

    // 바닥과 천장 각 4개
    const dx = w / 3, dy = d / 3;
    for (let dx_m = -1; dx_m <= 1; dx_m += 2) {
      for (let dy_m = -1; dy_m <= 1; dy_m += 2) {
        samplePoints.push([cx + dx_m * dx, cy + dy_m * dy, cz]); // 바닥
        samplePoints.push([cx + dx_m * dx, cy + dy_m * dy, cz + h]); // 천장
      }
    }

    // 벽면 12개
    for (let i = 0; i < 3; i++) {
      const x = cx - w / 2 + i * w / 2;
      samplePoints.push([x, cy - d / 2, cz + h / 2]); // 앞벽
      samplePoints.push([x, cy + d / 2, cz + h / 2]); // 뒷벽
    }
    for (let i = 0; i < 3; i++) {
      const y = cy - d / 2 + i * d / 2;
      samplePoints.push([cx - w / 2, y, cz + h / 2]); // 좌벽
      samplePoints.push([cx + w / 2, y, cz + h / 2]); // 우벽
    }

    for (const p of samplePoints) {
      points.push(p[0], p[1], p[2]);
    }

    vertexOffset += 8;
  }

  // uv 와 wallMask 생성: uv 는 서버 규약대로 지상 좌표를 영상 범위에 대응(u 동쪽, v 남쪽으로 증가).
  // 지붕(정점 4~7)만 wallMask 0 이라 영상을 표본하고, 하층(정점 0~3)이 낀 벽 삼각형은 면 색이다.
  const vertexCount = buildingCount * 8;
  const uv = new Float32Array(vertexCount * 2);
  const wallMask = new Uint8Array(vertexCount);
  const bnd = AERIAL_BOUNDS_M;
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[3 * i], y = positions[3 * i + 1];
    uv[2 * i] = (x - bnd.minX) / (bnd.maxX - bnd.minX);
    uv[2 * i + 1] = (bnd.maxY - y) / (bnd.maxY - bnd.minY);
    wallMask[i] = i % 8 < 4 ? 1 : 0;
  }

  // 여러 묶음(GROUP_COUNT개)으로 나눈다: 묶음마다 건물 구간을 맡고, 인덱스는 묶음 안 정점 번호로 다시 센다.
  const per = buildingCount / GROUP_COUNT;
  const groups = [];
  for (let g = 0; g < GROUP_COUNT; g++) {
    const b0 = g * per, b1 = b0 + per;
    groups.push({
      ids: ids.slice(b0, b1),
      mesh: {
        positions: new Float32Array(positions.slice(b0 * 24, b1 * 24)),
        indices: new Uint32Array(indices.slice(b0 * 36, b1 * 36).map((v) => v - b0 * 8)),
      },
      edgeLines: new Float32Array(edgeLines.slice(b0 * 72, b1 * 72)),
      uv: uv.slice(b0 * 16, b1 * 16),
      wallMask: wallMask.slice(b0 * 8, b1 * 8),
      points: new Float32Array(points.slice(b0 * 60, b1 * 60)),
    });
  }

  return { groups, image: makeAerialImage({ width: 256, height: 256, bounds: AERIAL_BOUNDS_M }) };
}

/** 시점(eye)에서 목표(target)를 보는 카메라. OpenCV 축(x 오른쪽, y 아래, z 앞), X_c = R·X_w + t. */
function lookAt(eye, target) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; };
  const fwd = norm(sub(target, eye));
  const up = Math.abs(fwd[2]) > 0.999 ? [0, 1, 0] : [0, 0, 1];
  const right = norm(cross(fwd, up));
  const down = cross(fwd, right);
  const R = [...right, ...down, ...fwd];
  const t = [0, 1, 2].map((i) => -(R[3 * i] * eye[0] + R[3 * i + 1] * eye[1] + R[3 * i + 2] * eye[2]));
  return { width: W, height: H, K: { fx: 1000, fy: 1000, cx: W / 2, cy: H / 2 }, R, t };
}

/** 세 카메라 각도 생성: 위에서 내려다봄, 남동 비스듬(약 40도), 북서 비스듬(약 35도) */
function makeCameras() {
  return [
    lookAt([0, 0, 500], [0, 0, 0]),
    lookAt([300, -300, 600], [0, 0, 0]),
    lookAt([-300, 300, 550], [0, 0, 0]),
  ];
}

/** 렌더 결과에서 덮인 화소 수(index 가 EMPTY_INDEX 가 아닌 화소) */
function coveredPixels(result) {
  let n = 0;
  for (let i = 0; i < result.index.length; i++) if (result.index[i] !== EMPTY_INDEX) n++;
  return n;
}

/** 덮인 화소의 서로 다른 색 수(rgb 24비트 묶음 기준) */
function distinctCoveredColors(result) {
  const seen = new Set();
  const { index, color } = result;
  for (let i = 0; i < index.length; i++) {
    if (index[i] === EMPTY_INDEX) continue;
    seen.add((color[3 * i] << 16) | (color[3 * i + 1] << 8) | color[3 * i + 2]);
  }
  return seen.size;
}

/** 카메라와 같은 크기의 RenderResult 를 미리 할당한다(render 의 out 인자). 호출마다 출력 버퍼를 새로 할당하는 고정 비용을 시간에서 뺀다. */
function makeOut(camera) {
  const n = camera.width * camera.height;
  return { width: camera.width, height: camera.height, color: new Uint8Array(3 * n), depth: new Float32Array(n), index: new Int32Array(n) };
}

/** RUNS회 호출해서 CPU 시간 중앙값 얻기. 비CPU 멈춤 감시는 호출당 (벽시계 − CPU) 의 RUNS회 최솟값을 WALL_STALL_MS 와 비교한다(규칙은 위 주석). */
function medianMs(fn, reps = 1) {
  const times = [];
  const idle = [];
  fn(); // 워밍업
  for (let r = 0; r < RUNS; r++) {
    const w0 = performance.now();
    const t0 = cpuMs();
    for (let k = 0; k < reps; k++) fn(); // reps 회를 한 쌍으로 재고 나눈다(눈금 약 4 ms 보다 짧은 연산용)
    const cpu = (cpuMs() - t0) / reps;
    times.push(cpu);
    idle.push(Math.max(0, (performance.now() - w0) / reps - cpu)); // 두 시계 눈금 차로 음수가 나올 수 있어 0 으로 하한
  }
  const minIdle = Math.min(...idle);
  console.log(`  (벽시계 − CPU) 최솟값 ${minIdle.toFixed(1)} ms`);
  assert.ok(minIdle <= WALL_STALL_MS, `호출당 (벽시계 − CPU) 최솟값 ${minIdle.toFixed(0)} ms > ${WALL_STALL_MS} ms (비CPU 멈춤 의심)`);
  return median(times);
}

test('buildings layer: 재사용 out 에 이전 렌더 잔여가 있어도 덮인 화소 수가 새 out 렌더와 같다', async () => {
  const { createBuildingsLayer } = await import('./index.mjs');
  const layer = createBuildingsLayer({ mode: 'black' });
  assert.equal(layer.accept(0, createSyntheticBundle()), 'first');
  const camera = makeCameras()[1];
  for (const mode of ['black', 'points', 'aerial']) {
    layer.setMode(mode);
    const want = EXPECTED_COVERED[mode][1];
    const fresh = layer.render(camera);
    // 잔여: 모든 화소가 "가장 가까운 깊이로 이미 덮임". 초기화(fill)가 없으면 아무것도 새로 그려지지 않고 잔여 index 가 그대로 남는다.
    const out = makeOut(camera);
    out.color.fill(255); out.depth.fill(1e-3); out.index.fill(7);
    const res = layer.render(camera, out);
    assert.equal(res, out);
    const covered = coveredPixels(res);
    assert.ok(Math.abs(covered - want) <= want * COVERED_TOLERANCE, `${mode}: 재사용 out 덮인 화소 ${covered} 가 측정값 ${want} 의 ±0.1% 밖(out 초기화 누락 의심)`);
    assert.equal(covered, coveredPixels(fresh), `${mode}: 재사용 out 과 새 out 의 덮인 화소 수가 다름`);
    // 덮이지 않은 화소는 비어 있어야 한다(잔여 색·깊이가 남지 않음).
    let dirty = 0;
    for (let i = 0; i < res.index.length; i++) if (res.index[i] === EMPTY_INDEX && (res.color[3 * i] !== 0 || res.depth[i] !== fresh.depth[i])) dirty++;
    assert.equal(dirty, 0, `${mode}: 덮이지 않은 화소 ${dirty}개에 잔여 색·깊이가 남음`);
  }
});

test('buildings layer 성능: 렌더 모드별 문턱, setMode ≤ 1ms (평균)', async () => {
  const { createBuildingsLayer } = await import('./index.mjs');
  const layer = createBuildingsLayer({ mode: 'black' });

  const bundle = createSyntheticBundle();
  const cameras = makeCameras();

  // 묶음 받기
  const result = layer.accept(0, bundle);
  assert.equal(result, 'first', `첫 accept 반환값 ${result}`);

  // 테스트 모드
  const modes = ['black', 'points', 'aerial'];
  const renderTimes = {};

  for (const mode of modes) {
    layer.setMode(mode);

    // 세 카메라로 렌더
    const modeTimes = [];
    for (const [ci, camera] of cameras.entries()) {
      const res = layer.render(camera);
      const covered = coveredPixels(res);
      console.log(`  ${mode} 카메라 ${ci}: 덮인 화소 ${covered}`);
      const want = EXPECTED_COVERED[mode][ci];
      assert.ok(Math.abs(covered - want) <= want * COVERED_TOLERANCE, `${mode} 카메라 ${ci}: 덮인 화소 ${covered} 가 측정값 ${want} 의 ±0.1% 밖`);
      const st = layer.stats();
      console.log(`  ${mode} 카메라 ${ci}: 래스터 호출 ${st.rasterCalls}, 처리 화소 ${st.rasterPixels}, 작업 삼각형 ${st.workTris}, 작업 화소 ${st.workCovered}, 묶음 ${st.groupsDrawn}`);
      assert.equal(st.rasterCalls, EXPECTED_RASTER_CALLS[mode], `${mode} 카메라 ${ci}: 래스터 호출 수 ${st.rasterCalls}`);
      const wantPx = EXPECTED_RASTER_PIXELS[mode][ci];
      assert.ok(Math.abs(st.rasterPixels - wantPx) <= wantPx * COVERED_TOLERANCE, `${mode} 카메라 ${ci}: 처리 화소 ${st.rasterPixels} 가 측정값 ${wantPx} 의 ±0.1% 밖`);
      assert.equal(st.workTris, EXPECTED_WORK[mode].tris[ci], `${mode} 카메라 ${ci}: 작업 삼각형 ${st.workTris}`);
      assert.equal(st.workCovered, EXPECTED_WORK[mode].covered[ci], `${mode} 카메라 ${ci}: 작업 화소 ${st.workCovered}`);
      if (mode === 'points') assert.equal(st.rasterPixels, 20 * (st.groupsDrawn * (3000 / GROUP_COUNT)), `points 카메라 ${ci}: 점 수 ${st.rasterPixels} 가 20 × 그려진 건물 수와 다름`);
      if (mode === 'aerial') {
        // 영상을 표본하는 것은 지붕(wallMask 0)이다. 실제로 표본했다면 지붕 화소 색이 다양해야 한다(1×1 단색 영상이면 몇 가지뿐).
        const colors = distinctCoveredColors(res);
        console.log(`  aerial 카메라 ${ci}: 서로 다른 색 ${colors}`);
        assert.ok(colors >= MIN_AERIAL_COLORS[ci], `aerial 카메라 ${ci}: 서로 다른 색 ${colors} < 하한 ${MIN_AERIAL_COLORS[ci]}`);
      }
      // points 는 고정 비용(출력 버퍼)을 줄이려 1/4 크기 카메라로 잰다(위 문턱 주석 참조). 덮인 화소 수 단언은 위에서 전체 크기로 이미 했다.
      const tcam = mode === 'points' ? { width: W / 4, height: H / 4, K: { fx: camera.K.fx / 4, fy: camera.K.fy / 4, cx: camera.K.cx / 4, cy: camera.K.cy / 4 }, R: camera.R, t: camera.t } : camera;
      const out = makeOut(tcam);
      const medianT = medianMs(() => {
        layer.render(tcam, out);
      }, mode === 'points' ? POINTS_REPS : 1);
      modeTimes.push(medianT);
    }

    renderTimes[mode] = {
      times: modeTimes,
      max: Math.max(...modeTimes),
    };

    console.log(`  ${mode}: 카메라별 중앙값 ${modeTimes.map(t => t.toFixed(1)).join(' / ')} ms, 최대 ${renderTimes[mode].max.toFixed(1)} ms`);
    assert.ok(renderTimes[mode].max <= RENDER_THRESHOLD_MS[mode], `${mode} ${renderTimes[mode].max.toFixed(1)} ms > ${RENDER_THRESHOLD_MS[mode]} ms`);
  }

  // setMode 성능: 1000회 전체를 cpuMs 한 쌍으로 잰다. 호출당 µs 라 호출마다 재면 눈금(약 4 ms) 계단 표본이 된다.
  const tSwitch0 = cpuMs();
  for (let i = 0; i < MODE_SWITCH_CALLS; i++) {
    layer.setMode(modes[i % modes.length]);
  }
  const totalModeSwitch = cpuMs() - tSwitch0;
  const avgModeSwitch = totalModeSwitch / MODE_SWITCH_CALLS;

  console.log(`  setMode 평균: ${avgModeSwitch.toFixed(3)} ms (${MODE_SWITCH_CALLS} 호출, 합계 ${totalModeSwitch.toFixed(1)} ms)`);
  assert.ok(avgModeSwitch <= MODE_SWITCH_THRESHOLD_MS, `setMode 평균 ${avgModeSwitch.toFixed(3)} ms > ${MODE_SWITCH_THRESHOLD_MS} ms`);

  // 상태 확인
  const state = layer.state();
  console.log(`상태: level=${state.level}, groupCount=${state.groupCount}, buildingCount=${state.buildingCount}, mode=${state.mode}`);
  assert.equal(state.level, 0);
  assert.equal(state.groupCount, GROUP_COUNT);
  assert.equal(state.buildingCount, 3000);
});

test('buildings layer: 선 래스터가 던져도 stats 는 이번 카메라 값이다', async () => {
  const { createBuildingsLayer } = await import('./index.mjs');
  const lineRgb = [10, 20, 30];
  const layer = createBuildingsLayer({ mode: 'black', lineRgb }); // 생성 때 한 번 검사하고 render 마다 다시 검사한다
  assert.equal(layer.accept(0, createSyntheticBundle()), 'first');
  const cams = makeCameras();
  layer.render(cams[0]); // 위에서 내려다봄: 묶음 2개만 통과
  assert.equal(layer.stats().groupsDrawn, 2);
  // 던짐 주입: 선 색이 잘못되면 lines 가 RangeError 를 던진다(면 래스터는 이미 끝난 뒤).
  lineRgb[0] = 999;
  assert.throws(() => layer.render(cams[1]), RangeError);
  const st = layer.stats();
  assert.equal(st.groupsTotal, GROUP_COUNT, `groupsTotal ${st.groupsTotal}`);
  assert.equal(st.groupsDrawn, 6, `groupsDrawn ${st.groupsDrawn}: 이전 카메라 값(2)이 남음`);
  assert.equal(st.rasterCalls, 1, `rasterCalls ${st.rasterCalls}: 면 래스터 1회만 끝남`);
  assert.equal(st.workTris, EXPECTED_WORK.black.tris[1]);
  assert.equal(st.workCovered, EXPECTED_WORK.black.covered[1]);
});

test('rasterizeFlat: float32 범위를 넘는 깊이(카메라 t_z 3e38, 정점 ±3e38)는 깊이 버퍼에 쓰지 않는다', async () => {
  const { rasterizeFlat } = await import('./raster_flat.mjs');
  const camera = { width: 64, height: 64, K: { fx: 64, fy: 64, cx: 32, cy: 32 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 3e38] };
  const out = makeOut(camera);
  out.depth.fill(Infinity); out.index.fill(EMPTY_INDEX);
  const big = 3e38; // float32 로 표현되지만 z = 3e38 + 3e38 = 6e38 은 float32 최댓값(약 3.4e38)을 넘는다
  const group = {
    ids: [1],
    mesh: { positions: new Float32Array([-big, -big, big, big, -big, big, 0, big, big]), indices: new Uint32Array([0, 1, 2]) },
    edgeLines: new Float32Array(0), uv: new Float32Array(6), wallMask: new Uint8Array(3), points: new Float32Array(0),
  };
  rasterizeFlat(camera, [group], () => [10, 20, 30], out);
  let written = 0;
  for (let i = 0; i < out.index.length; i++) if (out.index[i] !== EMPTY_INDEX) written++;
  assert.equal(written, 0, `float32 밖 깊이로 ${written} 화소가 쓰임`);
  for (let i = 0; i < out.depth.length; i++) assert.ok(out.depth[i] === Infinity && out.color[3 * i] === 0, `화소 ${i} 가 바뀜`);
  // 같은 삼각형이 유한 깊이(t_z 100)에서는 그려진다: 시험이 빈 화면으로 통과하는 것이 아님을 확인.
  const near = { ...camera, t: [0, 0, 100], K: { fx: 64, fy: 64, cx: 32, cy: 32 } };
  const g2 = { ...group, mesh: { positions: new Float32Array([-30, -30, 0, 30, -30, 0, 0, 30, 0]), indices: new Uint32Array([0, 1, 2]) } };
  const out2 = makeOut(near);
  out2.depth.fill(Infinity); out2.index.fill(EMPTY_INDEX);
  rasterizeFlat(near, [g2], () => [10, 20, 30], out2);
  assert.ok(coveredPixels(out2) > 0);
});
