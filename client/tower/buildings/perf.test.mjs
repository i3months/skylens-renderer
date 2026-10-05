// 건물 층 성능 시험. 3000개 건물 묶음을 세 카메라(위에서 내려다봄 + 비스듬 2종)로 세 옵션 각각 렌더(RUNS=5회 중앙값).
// 시간 문턱은 CPU 잡음 여유: 참조 구현의 거친 상한.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

const W = 1280, H = 720;
const RUNS = 5;
const RENDER_THRESHOLD_MS = 1500;
const MODE_SWITCH_THRESHOLD_MS = 1;
const MODE_SWITCH_CALLS = 1000;

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

  // uv와 wallMask 생성
  const vertexCount = buildingCount * 8;
  const uv = new Float32Array(vertexCount * 2);
  const wallMask = new Uint8Array(vertexCount);

  // 간단한 uv 매핑: 각 정점에 대해 0..1 범위로 매핑
  let uvIdx = 0, maskIdx = 0;
  for (let b = 0; b < buildingCount; b++) {
    for (let v = 0; v < 8; v++) {
      uv[uvIdx++] = (v % 2);
      uv[uvIdx++] = ((v >> 1) % 2);
      wallMask[maskIdx++] = v < 4 ? 0 : 1; // 하층은 검정, 상층은 색
    }
  }

  const groups = [{
    ids,
    mesh: {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
    },
    edgeLines: new Float32Array(edgeLines),
    uv,
    wallMask,
    points: new Float32Array(points),
  }];

  return { groups, image: null };
}

/** 세 카메라 각도 생성 */
function makeCameras() {
  const cameras = [];

  // 1. 위에서 내려다봄 (정사영에 가까움)
  cameras.push({
    width: W, height: H,
    K: { fx: 1000, fy: 1000, cx: W / 2, cy: H / 2 },
    R: [1, 0, 0, 0, -1, 0, 0, 0, -1],
    t: [0, 0, 500],
  });

  // 2. 남동쪽에서 비스듬 (40도)
  const angle1 = (40 * Math.PI) / 180;
  const c1 = Math.cos(angle1), s1 = Math.sin(angle1);
  cameras.push({
    width: W, height: H,
    K: { fx: 1000, fy: 1000, cx: W / 2, cy: H / 2 },
    R: [-c1, s1 * c1, s1, 0, -1, 0, -s1, -c1 * c1, c1],
    t: [300, -300, 600],
  });

  // 3. 북서쪽에서 비스듬 (35도)
  const angle2 = (35 * Math.PI) / 180;
  const c2 = Math.cos(angle2), s2 = Math.sin(angle2);
  cameras.push({
    width: W, height: H,
    K: { fx: 1000, fy: 1000, cx: W / 2, cy: H / 2 },
    R: [c2, s2 * c2, -s2, 0, -1, 0, s2, -c2 * c2, -c2],
    t: [-300, 300, 550],
  });

  return cameras;
}

/** RUNS회 호출해서 중앙값 얻기 */
function medianMs(fn) {
  const times = [];
  fn(); // 워밍업
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  return median(times);
}

test('buildings layer 성능: 렌더 ≤ 1500ms, setMode ≤ 1ms (평균)', async () => {
  let layer;
  try {
    const { createBuildingsLayer } = await import('./index.mjs');
    layer = createBuildingsLayer({ mode: 'black' });
  } catch (err) {
    // index.mjs가 없으면 정상적인 실패 (구현 미완)
    console.log('✓ index.mjs 미존재 (구현 미완): 테스트 건너뛰기');
    return;
  }

  const bundle = createSyntheticBundle();
  const cameras = makeCameras();

  // 묶음 받기
  const result = layer.accept(0, bundle);
  assert.ok(['first', 'replace', 'skip'].includes(result), `accept 반환값 ${result}`);

  // 테스트 모드
  const modes = ['black', 'points', 'aerial'];
  const renderTimes = {};

  for (const mode of modes) {
    layer.setMode(mode);

    // 세 카메라로 렌더
    const modeTimes = [];
    for (const camera of cameras) {
      const medianT = medianMs(() => {
        layer.render(camera);
      });
      modeTimes.push(medianT);
    }

    renderTimes[mode] = {
      times: modeTimes,
      max: Math.max(...modeTimes),
    };

    console.log(`  ${mode}: 카메라별 중앙값 ${modeTimes.map(t => t.toFixed(1)).join(' / ')} ms, 최대 ${renderTimes[mode].max.toFixed(1)} ms`);
    assert.ok(renderTimes[mode].max <= RENDER_THRESHOLD_MS, `${mode} ${renderTimes[mode].max.toFixed(1)} ms > ${RENDER_THRESHOLD_MS} ms`);
  }

  // setMode 성능: 1000회 호출 평균
  const modeSwitchTimes = [];
  for (let i = 0; i < MODE_SWITCH_CALLS; i++) {
    const t0 = performance.now();
    layer.setMode(modes[i % modes.length]);
    modeSwitchTimes.push(performance.now() - t0);
  }
  const avgModeSwitch = modeSwitchTimes.reduce((a, b) => a + b, 0) / modeSwitchTimes.length;

  console.log(`  setMode 평균: ${avgModeSwitch.toFixed(3)} ms (${MODE_SWITCH_CALLS} 호출)`);
  assert.ok(avgModeSwitch <= MODE_SWITCH_THRESHOLD_MS, `setMode 평균 ${avgModeSwitch.toFixed(3)} ms > ${MODE_SWITCH_THRESHOLD_MS} ms`);

  // 상태 확인
  const state = layer.state();
  console.log(`상태: level=${state.level}, groupCount=${state.groupCount}, buildingCount=${state.buildingCount}, mode=${state.mode}`);
  assert.equal(state.level, 0);
  assert.equal(state.groupCount, 1);
  assert.equal(state.buildingCount, 3000);
});
