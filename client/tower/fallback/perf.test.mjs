// 폴백 frame 성능 시험. 한도 규모(드론 256·탐지 4096·경로 64개×1500점 ≈ 10만 점)에서 frame 이 한 프레임 예산에 드는지 본다.
// 단언: 묶음 중앙값 ≤ 50 ms 와 자동 맞춤 frame ≤ 16 ms, 같은 프로세스의 기준 연산(setView frame) 대비 비율 상한,
// 결과 개수가 입력과 같다(결정적), 자동 맞춤이 점마다 배열을 만들지 않는다(push 호출 0), 옛 구현과 결과가 같다.
// 시간은 벽시계가 아니라 이 프로세스의 CPU 시간으로 잰다: 시험이 동시에 여러 개 돌아 CPU 를 나눠 써도 흔들리지 않는다.
// 상한을 측정에 맞춰 낮추지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createTowerFallback } from './index.mjs';
import { fitView } from './view.mjs';
import { buildMarkers } from './markers.mjs';
import { buildPaths } from './paths.mjs';
import { TOWER_OVERLAY_LIMITS } from '../../../contracts/controlview/overlay.mjs';

const N_DRONES = 256;
const N_DETECTIONS = 4096;
const N_PATHS = 64;
const N_POINTS = 1500;
const BATCH = 11; // 묶음 개수(중앙값을 낸다)
const PER_BATCH = 5; // 묶음 하나당 frame 호출 수(평균을 낸다)
const MAX_MS = 50;
const AUTO_FIT_MAX_MS = 16; // 자동 맞춤 frame 상한
const MAX_RATIO = 3; // 자동 맞춤 frame / setView frame 상한
const BIG_RATIO = 5; // 점 64만 개 규모는 GC 가 커서 비율 여유를 더 둔다(10배 느린 변이는 여전히 실패)
const FIT_OPTS = { minSpanM: 100, marginPx: 16 };
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

/** 이 스레드의 CPU 시간(ms, 없으면 프로세스 전체). 다른 프로세스와 CPU 를 나눠 쓰는 동안은 늘지 않는다. */
function cpuMs() { const u = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage(); return (u.user + u.system) / 1000; }

/** fn 을 데운 뒤 BATCH 묶음 × PER_BATCH 번 돌려 묶음 평균 CPU 시간(ms)의 중앙값을 돌려준다. */
function medianCpuMs(fn) {
  fn();
  const batches = [];
  for (let b = 0; b < BATCH; b += 1) {
    const t0 = cpuMs();
    for (let r = 0; r < PER_BATCH; r += 1) fn();
    batches.push((cpuMs() - t0) / PER_BATCH);
  }
  return median(batches);
}

function medianMs(target) { return medianCpuMs(() => target.frame(SIZE)); }

/** 기준 연산: 같은 장면에 view 를 직접 지정(setView)한 frame. 맞춤 순회만 빠진 같은 출력 비용이다. */
function floorOf(scene) {
  const fb = fbOf(scene);
  fb.setView({ centerE: 0, centerN: 0, metersPerPx: 0.5 });
  return () => fb.frame(SIZE);
}

/** target 이 자동 맞춤 상한(절대 16 ms, setView frame 대비 비율)을 지키는지 본다. */
function judge(target, floor) {
  const ms = medianMs(target);
  const base = medianCpuMs(floor);
  return { ms, base, ratio: ms / base, ok: ms <= AUTO_FIT_MAX_MS && ms <= MAX_RATIO * base };
}

/** 옛 구현: 점마다 [e,n] 배열을 만들어 fitView 에 넘긴다(회귀 비교용). */
function oldFit(scene, size) {
  const pts = [];
  for (const d of scene.drones) pts.push([d.enu[0], d.enu[1]]);
  for (const d of scene.detections) pts.push([d.enu[0], d.enu[1]]);
  for (const p of scene.paths) for (const q of p.points) pts.push([q[0], q[1]]);
  return fitView(pts, size, FIT_OPTS);
}

function oldFrame(scene, size) {
  const view = oldFit(scene, size);
  if (view === null) return null;
  return { view, drones: buildMarkers(view, size, scene.drones, false), detections: buildMarkers(view, size, scene.detections, true), paths: buildPaths(view, size, scene.paths) };
}

function fbOf(scene) {
  const fb = createTowerFallback();
  fb.setAvailable(false);
  fb.setDrones(scene.drones);
  fb.setDetections(scene.detections);
  for (const p of scene.paths) fb.setPath(p);
  return fb;
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

test('perf: 자동 맞춤 frame ≤ 16 ms 이고 setView frame 대비 비율 안(동시 실행에도 안정)', () => {
  const scene = makeScene();
  const r = judge(fbOf(scene), floorOf(scene));
  console.log(`fallback perf: 자동 맞춤 frame ${r.ms.toFixed(2)} ms, 기준 ${r.base.toFixed(2)} ms, 비율 ${r.ratio.toFixed(2)} (상한 ${AUTO_FIT_MAX_MS} ms, ${MAX_RATIO}배)`);
  assert.ok(r.ok, `frame ${r.ms.toFixed(2)} ms, 기준 ${r.base.toFixed(2)} ms, 비율 ${r.ratio.toFixed(2)}`);
});

test('perf: 10배 느린 변이는 판정에서 실패한다', () => {
  const scene = makeScene();
  const fb = fbOf(scene);
  const slow = { frame(size) { let o; for (let i = 0; i < 10; i += 1) o = fb.frame(size); return o; } };
  const r = judge(slow, floorOf(scene));
  assert.equal(r.ok, false, `10배 느린 변이가 통과했다: ${r.ms.toFixed(2)} ms, 비율 ${r.ratio.toFixed(2)}`);
});

test('perf: 계약 한도 규모(경로 64×10,000점)도 맞춤이 setView frame 의 비율 안이다', () => {
  assert.ok(TOWER_OVERLAY_LIMITS.maxPaths >= 64 && TOWER_OVERLAY_LIMITS.maxPathPoints >= 10000);
  const scene = makeScene();
  const paths = [];
  for (let k = 0; k < 64; k += 1) {
    const points = [];
    for (let j = 0; j < 10000; j += 1) points.push([k * 4 - 126 + Math.sin(j * 0.05) * 10, j * 0.03 - 150, 20]);
    paths.push({ id: `big-${k}`, points });
  }
  const big = { ...scene, paths };
  const fb = fbOf(big);
  const ms = medianCpuMs(() => fb.frame(SIZE));
  const base = medianCpuMs(floorOf(big));
  console.log(`fallback perf: 경로 64×10000점 frame ${ms.toFixed(2)} ms, 기준 ${base.toFixed(2)} ms, 비율 ${(ms / base).toFixed(2)}`);
  assert.ok(ms <= BIG_RATIO * base, `비율 ${(ms / base).toFixed(2)} > ${BIG_RATIO}`);
  assert.equal(fb.frame(SIZE).paths.length, 64);
});

test('perf: 자동 맞춤은 점마다 배열을 만들지 않는다(Array push 호출 0, 양성 대조 포함)', () => {
  const scene = makeScene();
  const fb = fbOf(scene);
  fb.frame(SIZE);
  const orig = Array.prototype.push;
  let calls = 0;
  Array.prototype.push = function (...a) { calls += 1; return orig.apply(this, a); };
  try {
    fb.frame(SIZE);
    const newCalls = calls;
    calls = 0;
    oldFit(scene, SIZE);
    const oldCalls = calls;
    assert.equal(newCalls, 0, `새 경로가 push 를 ${newCalls} 번 불렀다`);
    assert.ok(oldCalls >= N_DRONES + N_DETECTIONS + N_PATHS * N_POINTS, `옛 경로 대조 호출 수 ${oldCalls}`);
  } finally {
    Array.prototype.push = orig;
  }
});

test('perf: 자동 맞춤 결과(view·마커·폴리선)가 옛 구현과 같다', () => {
  const scene = makeScene();
  const sizes = [SIZE, { width: 400, height: 900 }];
  for (const size of sizes) {
    const out = fbOf(scene).frame(size);
    const old = oldFrame(scene, size);
    assert.deepStrictEqual(out.view, old.view);
    assert.deepStrictEqual(out.drones, old.drones);
    assert.deepStrictEqual(out.detections, old.detections);
    assert.deepStrictEqual(out.paths, old.paths);
  }
  // 한 종류만 있을 때·음수 좌표·점 하나
  const only = [
    { drones: [{ id: 'a', enu: [-5, -7, 1] }], detections: [], paths: [] },
    { drones: [], detections: [{ id: 'd', enu: [300, -900, 0], kind: 'alert' }], paths: [] },
    { drones: [], detections: [], paths: [{ id: 'p', points: [[-1000, 20, 0], [40, -3000, 0], [7, 7, 0]] }] },
  ];
  for (const sc of only) {
    const out = fbOf(sc).frame(SIZE);
    const old = oldFrame(sc, SIZE);
    assert.deepStrictEqual(out.view, old.view);
    assert.deepStrictEqual(out.drones, old.drones);
    assert.deepStrictEqual(out.detections, old.detections);
    assert.deepStrictEqual(out.paths, old.paths);
  }
  const empty = fbOf({ drones: [], detections: [], paths: [] }).frame(SIZE);
  assert.equal(empty.view, null);
});

test('perf: 측정기가 실제로 일을 잰다(양성 대조: 같은 일을 8번 하면 8배에 가깝다)', () => {
  const fb = loaded();
  const one = medianMs(fb);
  const many = medianMs({ frame(size) { let o; for (let i = 0; i < 8; i += 1) o = fb.frame(size); return o; } });
  assert.ok(many >= 4 * one, `8번 한 값 ${many.toFixed(2)} ms 가 한 번 ${one.toFixed(2)} ms 의 4배 미만`);
});
