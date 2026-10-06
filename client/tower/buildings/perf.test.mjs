// 건물 층 성능 시험. 3000개 건물 묶음을 세 카메라(위에서 내려다봄 + 비스듬 2종)로 세 옵션 각각 렌더(RUNS=5회 중앙값).
// 시간 문턱은 CPU 잡음 여유: 참조 구현의 거친 상한.
// 렌더 문턱은 CPU 래스터의 회귀 감시용일 뿐 S1 판정이 아니다. black 최대가 S1 의 33 ms 를 넘을 수 있다(black 최대 64 ms·전체(aerial) 최대 70 ms). 실기기 fps 는 T17 [local] 에서 잰다.
// 각 모드·카메라 조합의 덮인 화소 수는 측정값과 ±0.1% 안이어야 한다(일부만 그리거나 비우는 변이가 통과하지 못하게 한다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_INDEX } from '../../../contracts/raster/index.mjs';
import { makeAerialImage } from './test_support/fixtures.mjs';

const W = 1280, H = 720;
const RUNS = 5;
const GROUP_COUNT = 6; // 합성 장면을 나눌 묶음 수(3000개 건물을 500개씩)
// 합성 항공영상 범위(ENU m): 건물 격자(약 ±1400 m) 전체를 덮는다.
const AERIAL_BOUNDS_M = { minX: -1500, minY: -1500, maxX: 1500, maxY: 1500 };
// 모드별 렌더 문턱(ms). 세 모드가 한 문턱(300 ms)을 쓰면 points(실측 2~4 ms)는 75배 느려져도 통과했다.
// 스레드 CPU 시간으로 바꾼 뒤에는 CPU 대기 잡음이 빠져(8 프로세스 부하에서도 black·aerial 최대 47 ms) 큰 여유가 필요 없다.
// black·aerial: 실측 최대 40~70 ms 의 약 1.4~2.5배인 100 ms. 렌더를 4회 반복하는 변이는 140~200 ms 라 실패한다.
// points: 1회가 threadCpuUsage 눈금(이 VM 약 4 ms)보다 짧아 20회를 한 쌍으로 재서 호출당 값을 낸다(실측 1~3 ms, 부하에서도 같은 범위).
//   6 ms 는 실측 최대의 약 2배, 4회 반복 변이(호출당 약 7~9 ms, 5회 시행 5/5)는 실패한다.
const POINTS_REPS = 20; // points 는 1회가 눈금보다 짧아 20회를 한 쌍으로 잰다
const RENDER_THRESHOLD_MS = { black: 100, points: 6, aerial: 100 };
// 모드·카메라(위/남동/북서)별 덮인 화소 수의 측정값. 래스터는 결정적이라 3회 실행이 같았고(묶음 1개·6개 모두), 측정값과 ±0.1% 안이어야 한다.
const EXPECTED_COVERED = {
  black: [261789, 398769, 415587],
  points: [1348, 4268, 3995],
  aerial: [251783, 383930, 400922],
};
const COVERED_TOLERANCE = 0.001;
// aerial 카메라별 서로 다른 색 수 하한: 원본 결과(19230/51954/48890)의 약 90%. 1×1 단색 영상이면 몇 가지뿐이다.
const MIN_AERIAL_COLORS = [17300, 46700, 44000];
const MODE_SWITCH_THRESHOLD_MS = 1;
const MODE_SWITCH_CALLS = 1000;

// 벽시계 대신 스레드 CPU 시간(threadCpuUsage, 없으면 프로세스 cpuUsage)으로 잰다: 전체 npm test 처럼 다른 프로세스가 CPU 를 빼앗아 생기는 대기(한 번 300 ms 를 넘긴 적이 있다)는 포함하지 않는다(reuse_cull.test.mjs 와 같은 방식).
// 문턱(모드별 렌더·setMode 1 ms)은 올리지도 측정에 맞춰 조정하지도 않았다. 렌더가 실제로 느려지는 변이(CPU 일 증가)는 CPU 시간에도 그대로 잡히므로 계속 실패한다.
// 한계: CPU 시간은 Atomics.wait·sleep·I/O 대기 같은 비CPU 지연을 보지 못한다(그런 변이는 이 시험을 통과한다).
// 그런 멈춤은 실기기 fps(T17 [local])와 벽시계 시험이 맡고, 여기서는 CPU 일 증가만 감시한다.
// 결정적 단언(덮인 화소 수 ±0.1%·aerial 색 수 하한·묶음 수·건물 수)은 시간과 별개로 병행한다.
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

/** RUNS회 호출해서 중앙값 얻기 */
function medianMs(fn, reps = 1) {
  const times = [];
  fn(); // 워밍업
  for (let r = 0; r < RUNS; r++) {
    const t0 = cpuMs();
    for (let k = 0; k < reps; k++) fn(); // reps 회를 한 쌍으로 재고 나눈다(눈금 약 4 ms 보다 짧은 연산용)
    times.push((cpuMs() - t0) / reps);
  }
  return median(times);
}

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
      if (mode === 'aerial') {
        // 영상을 표본하는 것은 지붕(wallMask 0)이다. 실제로 표본했다면 지붕 화소 색이 다양해야 한다(1×1 단색 영상이면 몇 가지뿐).
        const colors = distinctCoveredColors(res);
        console.log(`  aerial 카메라 ${ci}: 서로 다른 색 ${colors}`);
        assert.ok(colors >= MIN_AERIAL_COLORS[ci], `aerial 카메라 ${ci}: 서로 다른 색 ${colors} < 하한 ${MIN_AERIAL_COLORS[ci]}`);
      }
      const medianT = medianMs(() => {
        layer.render(camera);
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
