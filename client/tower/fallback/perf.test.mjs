// 폴백 frame 성능 시험. 한도 규모(드론 256·탐지 4096·경로 64개×1500점 ≈ 10만 점)에서 frame 이 한 프레임 예산에 드는지 본다.
// 단언: 묶음 중앙값 ≤ 50 ms(헐렁한 상한, 부하에서 흔들리지 않게 한 번이 아니라 묶음 중앙값) 그리고 결과 개수가 입력과 같다(결정적).
// 상한을 측정에 맞춰 낮추지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createTowerFallback } from './index.mjs';

const N_DRONES = 256;
const N_DETECTIONS = 4096;
const N_PATHS = 64;
const N_POINTS = 1500;
const BATCH = 7; // 묶음 개수(중앙값을 낸다)
const PER_BATCH = 5; // 묶음 하나당 frame 호출 수(평균을 낸다)
const MAX_MS = 50;
const SIZE = { width: 1280, height: 720 };

/** 결정적 합성 장면: 격자 위 점들. */
function makeScene() {
  const drones = [];
  for (let i = 0; i < N_DRONES; i += 1) drones.push({ id: `drone-${i}`, enu: [(i % 16) * 20 - 150, Math.floor(i / 16) * 20 - 150, 50 + (i % 7)], yaw: i * 0.01 });
  const detections = [];
  for (let i = 0; i < N_DETECTIONS; i += 1) {
    detections.push({ id: `det-${i}`, enu: [(i % 64) * 5 - 160, Math.floor(i / 64) * 5 - 160, i % 3], kind: i % 5 === 0 ? 'alert' : 'detection', confidence: (i % 100) / 100 });
  }
  const paths = [];
  for (let k = 0; k < N_PATHS; k += 1) {
    const points = [];
    for (let j = 0; j < N_POINTS; j += 1) points.push([k * 4 - 126 + Math.sin(j * 0.05) * 10, j * 0.2 - 150, 20 + (k % 5)]);
    paths.push({ id: `path-${k}`, points });
  }
  return { drones, detections, paths };
}

function loaded() {
  const { drones, detections, paths } = makeScene();
  const fb = createTowerFallback();
  fb.setAvailable(false);
  fb.setDrones(drones);
  fb.setDetections(detections);
  for (const p of paths) fb.setPath(p);
  return fb;
}

function median(a) { return [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]; }

/** frame 을 데운 뒤 BATCH 묶음 × PER_BATCH 번 돌려 묶음 평균(ms)의 중앙값을 돌려준다. */
function medianMs(target) {
  target.frame(SIZE);
  const batches = [];
  for (let b = 0; b < BATCH; b += 1) {
    const t0 = performance.now();
    for (let r = 0; r < PER_BATCH; r += 1) target.frame(SIZE);
    batches.push((performance.now() - t0) / PER_BATCH);
  }
  return median(batches);
}

test('perf: 드론 256·탐지 4096·경로 64×1500점 frame 묶음 중앙값 ≤ 50 ms', () => {
  const fb = loaded();
  assert.deepEqual(fb.counts(), { drones: N_DRONES, detections: N_DETECTIONS, paths: N_PATHS });
  const ms = medianMs(fb);
  console.log(`fallback perf: frame 한 번 묶음 중앙값 ${ms.toFixed(2)} ms (상한 ${MAX_MS} ms)`);
  assert.ok(ms <= MAX_MS, `중앙값 ${ms.toFixed(2)} ms > ${MAX_MS} ms`);
});

test('perf: 결과 개수가 입력과 같다(결정적)', () => {
  const fb = loaded();
  const out = fb.frame(SIZE);
  assert.equal(out.mode, 'fallback');
  assert.equal(out.empty, false);
  assert.equal(out.drones.length, N_DRONES);
  assert.equal(out.detections.length, N_DETECTIONS);
  assert.equal(out.paths.length, N_PATHS);
  assert.equal(out.drones[0].id, 'drone-0');
  assert.equal(out.drones[N_DRONES - 1].id, `drone-${N_DRONES - 1}`);
  assert.equal(out.detections[N_DETECTIONS - 1].id, `det-${N_DETECTIONS - 1}`);
  assert.equal(out.paths[N_PATHS - 1].id, `path-${N_PATHS - 1}`);
  // 경로는 점을 솎지 않는다
  for (const p of out.paths) assert.equal(p.polyline.length, N_POINTS);
});

test('perf: 반복해도 결과가 같고 상태가 변하지 않는다', () => {
  const fb = loaded();
  const first = fb.frame(SIZE);
  for (let r = 0; r < 3; r += 1) {
    const out = fb.frame(SIZE);
    assert.equal(out.drones.length, N_DRONES);
    assert.equal(out.detections.length, N_DETECTIONS);
    assert.equal(out.paths.length, N_PATHS);
  }
  assert.deepStrictEqual(fb.frame(SIZE), first);
  assert.deepEqual(fb.counts(), { drones: N_DRONES, detections: N_DETECTIONS, paths: N_PATHS });
});

test('perf: 측정기가 실제로 시간을 잰다(양성 대조)', () => {
  const slow = { frame() { const end = performance.now() + 10; while (performance.now() < end); } };
  const ms = medianMs(slow);
  assert.ok(ms >= 9, `10 ms 짜리 호출의 중앙값이 ${ms.toFixed(2)} ms`);
  assert.ok(ms < MAX_MS, '느린 모의가 상한 안이어야 측정기 검증이 성립한다');
});
