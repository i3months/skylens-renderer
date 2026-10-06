// 폴백 frame 성능 시험. 한도 규모(드론 256·탐지 4096·경로 64개×1500점 ≈ 10만 점)에서 frame 이 한 프레임 예산에 드는지 본다.
// 단언: 한도 규모 frame 묶음 중앙값 ≤ 16 ms(한 프레임 예산, FRAME_BUDGET_MS)·≤ 50 ms, 묶음 p90 ≤ 8 ms(P90_MAX_MS), 자동 맞춤 frame ≤ 16 ms(AUTO_FIT_MAX_MS),
// 같은 프로세스의 기준 연산(setView frame) 대비 비율 상한, 맞춤 순회 몫(자동 − setView frame)이 독립 기준 순회의 FIT_SHARE_RATIO 배 이하,
// 결과 개수가 입력과 같다(결정적), 자동 맞춤이 점마다 배열을 만들지 않는다(push 호출 0), 옛 구현과 결과가 같다.
// 시간은 벽시계가 아니라 이 프로세스의 CPU 시간으로 잰다: 시험이 동시에 여러 개 돌아 CPU 를 나눠 써도 흔들리지 않는다.
// 상한을 측정에 맞춰 낮추지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
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
const FRAME_BUDGET_MS = 16; // 한 프레임 예산(60 Hz)
const P90_MAX_MS = 8; // 묶음 p90 상한(예산의 절반). 근거는 보고: CPU 시간 기준 실측 한 자리 ms 아래로 여유가 크다
const P90_BATCH = 21; // p90 을 내려면 묶음이 많아야 한다
const P90_WARM = 8;
const FIT_SHARE_RATIO = 3; // 맞춤 순회 몫 / 독립 기준 순회 상한(같은 일을 하므로 상수배 안. 10배 변이는 실패)
const CAP_SCALE_MAX_MS = 100; // 총 점 상한 규모 절대 시간(헐렁한 상한, 실측은 수 ms)
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
function medianCpuMs(fn) { return median(batchesCpuMs(fn)); }

/** 데운 뒤 묶음별 평균 CPU 시간(ms) 배열. */
function batchesCpuMs(fn, batchCount = BATCH, warm = 1) {
  for (let w = 0; w < warm; w += 1) fn();
  const batches = [];
  for (let b = 0; b < batchCount; b += 1) {
    const t0 = cpuMs();
    for (let r = 0; r < PER_BATCH; r += 1) fn();
    batches.push((cpuMs() - t0) / PER_BATCH);
  }
  return batches;
}

function p90(a) { return [...a].sort((x, y) => x - y)[Math.ceil(a.length * 0.9) - 1]; }

/** 독립 기준 순회: 경계 상자만 갱신한다(index.mjs 의 맞춤 순회와 같은 일). 몫의 기준이다. */
function refTraverse(scene) {
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  const upd = (q) => { if (q[0] < minE) minE = q[0]; if (q[0] > maxE) maxE = q[0]; if (q[1] < minN) minN = q[1]; if (q[1] > maxN) maxN = q[1]; };
  for (const d of scene.drones) upd(d.enu);
  for (const d of scene.detections) upd(d.enu);
  for (const p of scene.paths) for (const q of p.points) upd(q);
  return maxE - minE + maxN - minN;
}

function medianMs(target) { return medianCpuMs(() => target.frame(SIZE)); }

/** 기준 연산: 같은 장면에 view 를 직접 지정(setView)한 frame. 맞춤 순회만 빠진 같은 출력 비용이다. */
function floorOf(scene) {
  const fb = fbOf(scene);
  fb.setView({ centerE: 0, centerN: 0, metersPerPx: 0.5 });
  return () => fb.frame(SIZE);
}

/** 부하로 한 번 튄 측정이 오탐이 되지 않게 최대 ATTEMPTS 번 재서, 한 번이라도 통과하면 통과로 본다. 실제 회귀(10배·옛 push)는 매번 실패한다. */
const ATTEMPTS = 3;
function untilOk(measure) {
  let r;
  for (let a = 0; a < ATTEMPTS; a += 1) { r = measure(); if (r.ok) return r; }
  return r;
}

/** target 이 자동 맞춤 상한(절대 16 ms, setView frame 대비 비율)을 지키는지 본다. */
function judge(target, floor, scene) { return untilOk(() => judgeOnce(target, floor, scene)); }
function judgeOnce(target, floor, scene) {
  const ms = medianMs(target);
  const base = medianCpuMs(floor);
  const ref = scene ? medianCpuMs(() => refTraverse(scene)) : 0;
  const share = ms - base; // 맞춤 순회 몫(음수면 잡음, 0 으로 본다)
  const shareOk = scene ? Math.max(share, 0) <= FIT_SHARE_RATIO * ref : true;
  return { ms, base, ref, share, ratio: ms / base, ok: ms <= AUTO_FIT_MAX_MS && ms <= MAX_RATIO * base && shareOk };
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
  const r = untilOk(() => {
    const batches = batchesCpuMs(() => fb.frame(SIZE), P90_BATCH, P90_WARM); // 첫 호출의 JIT·GC 꼬리가 p90 에 들지 않게 충분히 데운다
    const m = median(batches), q = p90(batches);
    return { ms: m, q90: q, ok: m <= FRAME_BUDGET_MS && q <= P90_MAX_MS };
  });
  const { ms, q90 } = r;
  console.log(`fallback perf: frame 한 번 묶음 중앙값 ${ms.toFixed(2)} ms (상한 ${MAX_MS} ms, 예산 ${FRAME_BUDGET_MS} ms), p90 ${q90.toFixed(2)} ms (상한 ${P90_MAX_MS} ms)`);
  assert.ok(ms <= MAX_MS, `중앙값 ${ms.toFixed(2)} ms > ${MAX_MS} ms`);
  assert.ok(ms <= FRAME_BUDGET_MS, `중앙값 ${ms.toFixed(2)} ms > 한 프레임 예산 ${FRAME_BUDGET_MS} ms`);
  assert.ok(q90 <= P90_MAX_MS, `p90 ${q90.toFixed(2)} ms > ${P90_MAX_MS} ms`);
});

test('perf: 총 점 상한 규모의 자동 맞춤 frame 절대 시간(한 번 호출 ms 단위)', () => {
  const cap = TOWER_OVERLAY_LIMITS.maxTotalPathPoints;
  assert.equal(cap, N_PATHS * N_POINTS); // 상한 규모 = 64×1500
  const fb = createTowerFallback();
  fb.setAvailable(false);
  const per = cap / N_PATHS;
  for (let k = 0; k < N_PATHS; k += 1) {
    const points = [];
    for (let j = 0; j < per; j += 1) points.push([k * 4 - 126, j * 0.2 - 150, 20]);
    fb.setPath({ id: `cap-${k}`, points });
  }
  const { ms } = untilOk(() => { const m = medianMs(fb); return { ms: m, ok: m <= FRAME_BUDGET_MS }; });
  console.log(`fallback perf: 총 점 상한 ${cap} 점 frame 묶음 p50 ${ms.toFixed(2)} ms (상한 ${FRAME_BUDGET_MS} ms 예산, 헐렁한 ${CAP_SCALE_MAX_MS} ms)`);
  assert.ok(ms <= CAP_SCALE_MAX_MS, `${ms.toFixed(2)} ms > ${CAP_SCALE_MAX_MS} ms`);
  assert.ok(ms <= FRAME_BUDGET_MS, `${ms.toFixed(2)} ms > 한 프레임 예산 ${FRAME_BUDGET_MS} ms`);
});

test('perf: 총 점 상한을 넘기는 setPath 는 RangeError 이고 상태는 그대로다', () => {
  const cap = TOWER_OVERLAY_LIMITS.maxTotalPathPoints;
  const mk = (id, n) => ({ id, points: Array.from({ length: n }, (_, j) => [j, 0, 0]) });
  const fb = createTowerFallback();
  fb.setAvailable(false);
  fb.setPath(mk('a', cap - 2));
  fb.setPath(mk('b', 2)); // 합계 정확히 cap 은 허용
  const before = fb.frame(SIZE);
  assert.throws(() => fb.setPath(mk('c', 2)), RangeError); // 새 경로가 합계를 넘김
  assert.throws(() => fb.setPath(mk('b', 3)), RangeError); // 교체해도 합계가 넘으면 거부
  assert.deepEqual(fb.counts().paths, 2);
  assert.deepStrictEqual(fb.frame(SIZE), before);
  fb.setPath(mk('a', 10)); // 교체는 옛 점을 빼고 센다
  fb.setPath(mk('c', 2));
  assert.equal(fb.counts().paths, 3);
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
  const r = judge(fbOf(scene), floorOf(scene), scene);
  console.log(`fallback perf: 자동 맞춤 frame ${r.ms.toFixed(2)} ms, 기준 ${r.base.toFixed(2)} ms, 비율 ${r.ratio.toFixed(2)} (상한 ${AUTO_FIT_MAX_MS} ms, ${MAX_RATIO}배), 순회 몫 ${r.share.toFixed(2)} ms / 기준 순회 ${r.ref.toFixed(2)} ms (상한 ${FIT_SHARE_RATIO}배)`);
  assert.ok(r.ok, `frame ${r.ms.toFixed(2)} ms, 기준 ${r.base.toFixed(2)} ms, 비율 ${r.ratio.toFixed(2)}, 순회 몫 ${r.share.toFixed(2)} ms, 기준 순회 ${r.ref.toFixed(2)} ms`);
});

test('perf: 10배 느린 변이는 판정에서 실패한다', () => {
  const scene = makeScene();
  const fb = fbOf(scene);
  const slow = { frame(size) { let o; for (let i = 0; i < 10; i += 1) o = fb.frame(size); return o; } };
  const r = judge(slow, floorOf(scene), scene);
  assert.equal(r.ok, false, `10배 느린 변이가 통과했다: ${r.ms.toFixed(2)} ms, 비율 ${r.ratio.toFixed(2)}`);
});

// 총 점 상한(maxTotalPathPoints)이 생겨 64×10,000(64만 점)은 setPath 가 거부한다. 같은 합계 안에서 경로 하나가 긴 극단(8×12,000 점)을 비율 문턱(BIG_RATIO, 그대로)으로 본다.
test('perf: 총 점 상한 안의 긴 경로 장면(경로 8×12,000점)도 맞춤이 setView frame 의 비율 안이다', () => {
  assert.ok(8 * 12000 <= TOWER_OVERLAY_LIMITS.maxTotalPathPoints && 12000 <= TOWER_OVERLAY_LIMITS.maxPathPoints);
  const scene = makeScene();
  const paths = [];
  for (let k = 0; k < 8; k += 1) {
    const points = [];
    for (let j = 0; j < 12000; j += 1) points.push([k * 4 - 126 + Math.sin(j * 0.05) * 10, j * 0.03 - 150, 20]);
    paths.push({ id: `big-${k}`, points });
  }
  const big = { ...scene, paths };
  const fb = fbOf(big);
  const ms = medianCpuMs(() => fb.frame(SIZE));
  const base = medianCpuMs(floorOf(big));
  console.log(`fallback perf: 경로 8×12000점 frame ${ms.toFixed(2)} ms, 기준 ${base.toFixed(2)} ms, 비율 ${(ms / base).toFixed(2)}`);
  assert.ok(ms <= BIG_RATIO * base, `비율 ${(ms / base).toFixed(2)} > ${BIG_RATIO}`);
  assert.equal(fb.frame(SIZE).paths.length, 8);
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
