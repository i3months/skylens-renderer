// 오버레이 project 성능 시험. 드론 256·탐지 4096·경로 64(각 1000점)를 넣고 project 를 반복해 한 번 평균 시간을 잰다.
// 단언: 한 번 평균 ≤ 85 ms(헐렁한 상한) 그리고 결과 개수가 입력과 같다. 상한을 측정에 맞춰 낮추지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createTowerOverlay } from './index.mjs';
import { poseToView } from './view.mjs';
import { clipPolyline } from './clip.mjs';

const SET_MAX_MS = 400;

const N_DRONES = 256;
const N_DETECTIONS = 4096;
const N_PATHS = 64;
const N_POINTS = 1000;
const REPEAT = 20;
const MAX_MS = 85;

const POSE = { pos: [0, 0, 300], quat: [0, 0, 0, 1], fovY: 1 };
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
    for (let j = 0; j < N_POINTS; j += 1) points.push([k * 4 - 126 + Math.sin(j * 0.05) * 10, j * 0.3 - 150, 20 + (k % 5)]);
    paths.push({ id: `path-${k}`, points });
  }
  return { drones, detections, paths };
}

function loaded() {
  const { drones, detections, paths } = makeScene();
  const overlay = createTowerOverlay();
  overlay.setDrones(drones);
  overlay.setDetections(detections);
  for (const p of paths) overlay.setPath(p);
  return overlay;
}

/** project 를 데운 뒤 REPEAT 번 돌려 한 번 평균(ms)을 돌려준다. */
function meanMs(overlay) {
  overlay.project(POSE, SIZE);
  const t0 = performance.now();
  for (let r = 0; r < REPEAT; r += 1) overlay.project(POSE, SIZE);
  return (performance.now() - t0) / REPEAT;
}

test('perf: 드론 256·탐지 4096·경로 64×1000점 project 한 번 평균 ≤ 85 ms', () => {
  const overlay = loaded();
  assert.deepEqual(overlay.counts(), { drones: N_DRONES, detections: N_DETECTIONS, paths: N_PATHS });
  const ms = meanMs(overlay);
  console.log(`overlay perf: project 한 번 평균 ${ms.toFixed(2)} ms (상한 ${MAX_MS} ms)`);
  assert.ok(ms <= MAX_MS, `평균 ${ms.toFixed(2)} ms > ${MAX_MS} ms`);
});

test('perf: 결과 개수가 입력과 같다(드론 256·탐지 4096·경로 64)', () => {
  const overlay = loaded();
  const out = overlay.project(POSE, SIZE);
  assert.equal(out.drones.length, 256);
  assert.equal(out.detections.length, 4096);
  assert.equal(out.paths.length, 64);
  assert.equal(out.drones[0].id, 'drone-0');
  assert.equal(out.drones[255].id, 'drone-255');
  assert.equal(out.detections[4095].id, 'det-4095');
  assert.equal(out.paths[63].id, 'path-63');
});

test('perf: 반복해도 결과 개수가 변하지 않는다(상태 불변)', () => {
  const overlay = loaded();
  for (let r = 0; r < 3; r += 1) {
    const out = overlay.project(POSE, SIZE);
    assert.equal(out.drones.length, 256);
    assert.equal(out.detections.length, 4096);
    assert.equal(out.paths.length, 64);
  }
  assert.deepEqual(overlay.counts(), { drones: 256, detections: 4096, paths: 64 });
});

test('perf: 측정기가 실제로 시간을 잰다(양성 대조)', () => {
  const slow = { project() { const end = performance.now() + 10; while (performance.now() < end); } };
  const ms = meanMs(slow);
  assert.ok(ms >= 9, `10 ms 짜리 호출의 평균이 ${ms.toFixed(2)} ms`);
  assert.ok(ms < MAX_MS, '느린 모의가 상한 안이어야 측정기 검증이 성립한다');
});

// F-430: 상한 규모(경로당 100000 점) 에서 project 가 clipPolyline 만 돌린 시간의 2배 이하여야 한다(복사 없는 읽기).
const BIG_PATHS = 4;
const BIG_POINTS = 100_000;
const BIG_REPEAT = 7;
const RATIO_MAX = 2;

function median(a) { return [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]; }

test('perf: 4 경로 × 100000 점 project 시간 ≤ clipPolyline 만 돌린 시간의 2배(중앙값)', () => {
  const paths = [];
  for (let k = 0; k < BIG_PATHS; k += 1) {
    const points = [];
    for (let j = 0; j < BIG_POINTS; j += 1) points.push([k * 4 - 6 + Math.sin(j * 0.05) * 10, j * 0.003 - 150, 20 + k]);
    paths.push({ id: `big-${k}`, points });
  }
  const overlay = createTowerOverlay();
  for (const p of paths) overlay.setPath(p);
  assert.equal(overlay.counts().paths, BIG_PATHS);
  const view = poseToView(POSE, SIZE);
  const clipOnly = () => { for (const p of paths) clipPolyline(view, p.points, 0.1); };
  clipOnly(); overlay.project(POSE, SIZE);
  const tc = [], tp = [];
  for (let r = 0; r < BIG_REPEAT; r += 1) {
    let t0 = performance.now(); clipOnly(); tc.push(performance.now() - t0);
    t0 = performance.now(); overlay.project(POSE, SIZE); tp.push(performance.now() - t0);
  }
  const mc = median(tc), mp = median(tp);
  console.log(`overlay big: clip ${mc.toFixed(1)} ms, project ${mp.toFixed(1)} ms, 비 ${(mp / mc).toFixed(2)}`);
  assert.ok(mp <= RATIO_MAX * mc, `project ${mp.toFixed(1)} ms > ${RATIO_MAX} × clip ${mc.toFixed(1)} ms`);
});

// F-433 ⑥: 100000 점 setPath 시간 상한(여유 있는 상한).
test('perf: 100000 점 setPath 한 번 중앙값 ≤ SET_MAX_MS', () => {
  const points = [];
  for (let j = 0; j < BIG_POINTS; j += 1) points.push([j * 0.01, 0, 10]);
  const overlay = createTowerOverlay();
  overlay.setPath({ id: 'warm', points });
  const ts = [];
  for (let r = 0; r < 5; r += 1) {
    const t0 = performance.now();
    overlay.setPath({ id: 'p', points });
    ts.push(performance.now() - t0);
  }
  const m = median(ts);
  console.log(`overlay setPath 100000 점 중앙값 ${m.toFixed(1)} ms (상한 ${SET_MAX_MS} ms)`);
  assert.ok(m <= SET_MAX_MS, `setPath ${m.toFixed(1)} ms > ${SET_MAX_MS} ms`);
});
