// 폴백 frame 성능 시험. 한도 규모(드론 256·탐지 4096·경로 64개×1500점 ≈ 10만 점)에서 frame 이 한 프레임 예산에 드는지 본다.
// 단언: 한도 규모 frame 묶음 중앙값 ≤ 16 ms(한 프레임 예산, FRAME_BUDGET_MS)·≤ 50 ms, 묶음 p90 ≤ 16 ms(P90_MAX_MS, 한 프레임 예산)·p90/중앙값 ≤ P90_MEDIAN_RATIO, 자동 맞춤 frame ≤ 16 ms(AUTO_FIT_MAX_MS),
// 같은 프로세스의 기준 연산(setView frame) 대비 비율 상한, 맞춤 순회 몫(자동 − setView frame)이 독립 기준 순회의 FIT_SHARE_RATIO 배 이하,
// 결과 개수가 입력과 같다(결정적), 자동 맞춤이 점마다 배열을 만들지 않는다(push 호출 0), 옛 구현과 결과가 같다,
// 맞춤 순회가 저장소 points 배열을 점당 1회 읽는다(시간이 아니라 접근 횟수 계수. 배열 읽기·좌표 읽기·setView frame 읽기를 센다).
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
// p90 문턱. 옛 8 ms 는 근거가 약했다: CPU 소모 프로세스 4개를 띄운 4코어에서 21묶음 p90 은 중앙값 5.5 ms(최소 4.1~최대 12.2 ms, 40회),
// 한가할 때도 3.5~5.7 ms 라 8 ms 에 여유가 크지 않았다(부하 평균 5 에서 8.56 ms 로 간헐 실패). 지금은 두 가지로 본다.
// ① 절대: p90 ≤ FRAME_BUDGET_MS(16 ms). 꼬리 프레임도 한 프레임 예산 안이라는 제품 요구 그대로다(측정에 맞춘 값이 아니다).
// ② 모양: p90 / 중앙값 ≤ P90_MEDIAN_RATIO. 꼬리가 몸통의 몇 배로 퍼지는지 본다. 묶음당 5회면 부하에서 비율이 최대 3.21(중앙값 1.8)까지 튀었고,
//    묶음당 10회(P90_PER_BATCH)로 늘리면 부하 80회·한가 40회 시행에서 최대 1.77(중앙값 1.2, 부하 최대 1.70)이다. 상한 2.5 는 그 최대의 약 1.4배.
// 이 문턱(p90 ≤ 16 ms)은 한가할 때 p90(3.5~5.7 ms)의 약 2.8~4.6배, 위 부하 최대 p90(12.2 ms)의 약 1.3배다. 그래서 정상 장면의 p90 은 약 3.6배 이상 느려져야(예: 4.5 ms → 16 ms 초과) 넘는다.
// 곧 약 3.6배 미만의 느려짐은 이 문턱 아래 잡음 범위이고, 이 단언으로 잡지 못한다(잡는 것은 아래 중앙값·기준 대비 비율·순회 몫 단언).
// 한계: 이 두 단언은 '꼬리가 예산을 넘지 않고 터지지 않는다' 만 본다. 균일한 N 배 느려짐(맞춤 순회 10배 등)은 비율이 그대로라 여기서 못 잡고,
// 중앙값·기준 대비 비율·맞춤 순회 몫 단언이 잡는다.
const P90_MAX_MS = FRAME_BUDGET_MS;
const P90_MEDIAN_RATIO = 2.5;
/** 꼬리 비율 p90/중앙값 의 단일 정의. 판정(ok)과 단언·로그가 모두 이 값을 쓴다. 중앙값 0: p90 도 0 이면 퍼짐 없음(1), p90 > 0 이면 무한대(실패). 0/0 = NaN 으로 두 판정이 갈리지 않게 한다. */
function tailOf(q, m) { return m > 0 ? q / m : (q > 0 ? Infinity : 1); }
const P90_BATCH = 21; // p90 을 내려면 묶음이 많아야 한다
const P90_PER_BATCH = 10; // p90 묶음 하나당 frame 호출 수(5 는 부하에서 꼬리 비율이 너무 튄다)
const P90_WARM = 8;
const FIT_SHARE_RATIO = 3; // 맞춤 순회 몫 / 독립 기준 순회 상한(같은 일을 하므로 상수배 안. 10배 변이는 실패)
const CAP_SCALE_MAX_MS = 100; // 총 점 상한 규모 절대 시간(헐렁한 상한, 실측은 수 ms)
const AUTO_FIT_MAX_MS = 16; // 자동 맞춤 frame 상한
const MAX_RATIO = 3; // 자동 맞춤 frame / setView frame 상한
// 긴 경로 장면(8×12,000점)은 GC 가 커서 비율이 흔들린다. 부하에서 30회 실측: 정상 비율 0.75~3.00(중앙값 1.02), 옛 push 구현(Pold) 2.43~5.48(중앙값 3.31).
// 두 분포가 겹쳐 비율 문턱으로는 Pold 를 오탐 없이 가를 수 없다. 5 는 정상 최대(3.00)보다 높게 잡은 '극단 GC·10배급 퇴행만 잡는' 헐렁한 상한이다.
// Pold 는 이 비율이 아니라 'Array push 호출 0' 단언이 잡는다. 이 상한을 Pold 를 잡는다고 읽지 않는다.
const BIG_RATIO = 5;
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
function batchesCpuMs(fn, batchCount = BATCH, warm = 1, perBatch = PER_BATCH) {
  for (let w = 0; w < warm; w += 1) fn();
  const batches = [];
  for (let b = 0; b < batchCount; b += 1) {
    const t0 = cpuMs();
    for (let r = 0; r < perBatch; r += 1) fn();
    batches.push((cpuMs() - t0) / perBatch);
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

/**
 * 부하로 한 번 튄 측정이 오탐이 되지 않게 최대 ATTEMPTS 번 재서, 한 번이라도 통과하면 통과로 본다.
 * 한계: 3회 중 1회만 통과해도 통과이므로, 간헐적으로만 느린 회귀(예: 3회 중 2회 이상 문턱을 넘지만 가끔 통과하는 정도)는 놓칠 수 있다.
 * 실제 회귀(맞춤 순회 10배·옛 push)는 측정마다 문턱을 크게 넘어 3회 모두 실패하므로 잡힌다(변이 시험으로 확인). 오탐 확률은 문턱 초과 확률 p 의 3제곱이다(시도가 서로 독립이라는 가정 아래서만 성립한다: 부하가 길게 이어져 연속 시도가 함께 느려지면 p^3 보다 크다).
 */
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
    const batches = batchesCpuMs(() => fb.frame(SIZE), P90_BATCH, P90_WARM, P90_PER_BATCH); // 첫 호출의 JIT·GC 꼬리가 p90 에 들지 않게 충분히 데운다
    const m = median(batches), q = p90(batches), tail = tailOf(q, m);
    return { ms: m, q90: q, tail, ok: m <= FRAME_BUDGET_MS && q <= P90_MAX_MS && tail <= P90_MEDIAN_RATIO };
  });
  const { ms, q90, tail } = r;
  console.log(`fallback perf: frame 한 번 묶음 중앙값 ${ms.toFixed(2)} ms (상한 ${MAX_MS} ms, 예산 ${FRAME_BUDGET_MS} ms), p90 ${q90.toFixed(2)} ms (상한 ${P90_MAX_MS} ms), p90/중앙값 ${tail.toFixed(2)} (상한 ${P90_MEDIAN_RATIO})`);
  assert.ok(ms <= MAX_MS, `중앙값 ${ms.toFixed(2)} ms > ${MAX_MS} ms`);
  assert.ok(ms <= FRAME_BUDGET_MS, `중앙값 ${ms.toFixed(2)} ms > 한 프레임 예산 ${FRAME_BUDGET_MS} ms`);
  assert.ok(q90 <= P90_MAX_MS, `p90 ${q90.toFixed(2)} ms > ${P90_MAX_MS} ms`);
  assert.ok(tail <= P90_MEDIAN_RATIO, `p90/중앙값 ${tail.toFixed(2)} > ${P90_MEDIAN_RATIO}`);
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

// 맞춤 순회 변이(Pfit10): frame 한 번에 경계 상자 순회를 10번 한다(독립 기준 순회 9번 + frame 안의 1번). frame 전체를 10번 하는 것보다 구체적인 회귀다.
// 측정(이 환경 CPU 시간 중앙값): 기준 순회 refTraverse ≈ 0.80 ms, 제품 순회(index.mjs 의 루프와 같은 복사본) ≈ 0.80 ms 라 둘은 거의 같은 비용이다(비 0.99).
// 그러므로 기준 순회 9회 추가 = 제품 순회 9회 추가(몫 ≈ 7.2 ms 추가)이지, 제품 순회 17배가 아니다(앞 주석의 '17배'는 틀렸다). 정상 몫은 1.2~1.7 ms(기준 순회의 1.5~2.2배, 문턱 3배 아래).
// 이 변이의 몫은 7.4 ms(실측 1회, 기준 순회의 약 9배)라 문턱 3×0.80 = 2.4 ms 를 약 3.1배 넘는다. 문턱의 정상 쪽 여유는 정상 몫 최대 1.7 ms 에 대해 2.4 ms(약 1.4배)다.
// 제품 index.mjs 의 순회 루프를 실제로 10번 돌게 고친 변이(직접 시험, 이 파일 밖)의 몫은 3.7~6.4 ms(기준 순회의 4.6~8.1배)로 흔들렸고, 문턱(2.4 ms)을 넘는 쪽이 많지만
// 13회 중 2회는 이 시간 판정을 통과해 살아남았다(F-472). 시간만으로는 이 변이를 확실히 잡지 못한다. 그래서 시간과 무관한 결정적 계수 시험(아래 '맞춤 순회는 저장소 points 배열을 점당 정확히 1회 읽는다')을 더했다.
// 문턱은 건드리지 않았다(3배 그대로). 정상 제품에서 그 시험은 시간을 재지 않으므로 부하에 흔들리지 않는다.
// 실제 변이는 한 함수 안에서 같은 루프를 되풀이해 JIT 이 더 싸게 돌리므로 별도 복사본 변이(아래 Pprod10)보다 몫이 작다. 둘 다 아래에서 시험한다.
test('perf: 맞춤 순회 10배 변이는 판정에서 실패한다', () => {
  const scene = makeScene();
  const fb = fbOf(scene);
  const slow = { frame(size) { for (let i = 0; i < 9; i += 1) refTraverse(scene); return fb.frame(size); } };
  const r = judge(slow, floorOf(scene), scene);
  assert.equal(r.ok, false, `맞춤 순회 10배 변이가 통과했다: ${r.ms.toFixed(2)} ms, 순회 몫 ${r.share.toFixed(2)} ms, 기준 순회 ${r.ref.toFixed(2)} ms`);
  assert.ok(r.share > FIT_SHARE_RATIO * r.ref, `순회 몫 ${r.share.toFixed(2)} ms 가 ${FIT_SHARE_RATIO}배 기준 순회 ${r.ref.toFixed(2)} ms 이하다(몫 단언이 변이를 잡지 못함)`);
  console.log(`fallback perf: Pfit10 몫 ${r.share.toFixed(2)} ms / 문턱 ${(FIT_SHARE_RATIO * r.ref).toFixed(2)} ms (기준 순회 ${r.ref.toFixed(2)} ms)`);
});

/** 제품 index.mjs 의 맞춤 순회 루프(드론·탐지·경로 점을 인덱스 for 로 돌며 경계 상자 갱신)의 인라인 복사본. 제품 순회 10회 변이용. */
function prodTraverse(scene) {
  const { drones, detections, paths } = scene;
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (let i = 0; i < drones.length; i++) { const q = drones[i].enu; const e = q[0], n = q[1]; if (e < minE) minE = e; if (e > maxE) maxE = e; if (n < minN) minN = n; if (n > maxN) maxN = n; }
  for (let i = 0; i < detections.length; i++) { const q = detections[i].enu; const e = q[0], n = q[1]; if (e < minE) minE = e; if (e > maxE) maxE = e; if (n < minN) minN = n; if (n > maxN) maxN = n; }
  for (let k = 0; k < paths.length; k++) {
    const pp = paths[k].points;
    for (let i = 0; i < pp.length; i++) { const q = pp[i]; const e = q[0], n = q[1]; if (e < minE) minE = e; if (e > maxE) maxE = e; if (n < minN) minN = n; if (n > maxN) maxN = n; }
  }
  return maxE - minE + maxN - minN;
}

// 제품 순회 10회 변이(Pprod10): 제품 루프 복사본을 9번 더 돈다. 몫 ≈ 정상 몫 + 9×0.80 ms 라 문턱 3×기준 순회를 넘어야 한다.
test('perf: 제품 순회 10회 변이(인라인 복사본)는 판정에서 실패한다', () => {
  const scene = makeScene();
  const fb = fbOf(scene);
  const slow = { frame(size) { for (let i = 0; i < 9; i += 1) prodTraverse(scene); return fb.frame(size); } };
  const r = judge(slow, floorOf(scene), scene);
  assert.equal(r.ok, false, `제품 순회 10회 변이가 통과했다: ${r.ms.toFixed(2)} ms, 순회 몫 ${r.share.toFixed(2)} ms, 기준 순회 ${r.ref.toFixed(2)} ms`);
  assert.ok(r.share > FIT_SHARE_RATIO * r.ref, `순회 몫 ${r.share.toFixed(2)} ms 가 ${FIT_SHARE_RATIO}배 기준 순회 ${r.ref.toFixed(2)} ms 이하다`);
});

/**
 * 저장소가 가진 경로의 points 를 접근 계수 Proxy 로 바꾼다(제품 코드는 고치지 않는다).
 * 두 가지를 센다: arr = 저장소 points 배열의 인덱스 읽기, coord = 점 하나의 좌표(q[0]/q[1]) 읽기.
 * 점마다 Proxy 를 씌우므로 points.slice() 로 복사한 뒤 되풀이 순회해도(복사본 원소는 같은 점 Proxy) coord 가 늘어난다.
 * 값을 복사하는 검증 뒤에 저장소 안의 배열을 보므로 Array.from 을 잠시 가로챈다. counter.stored 는 가로챈 저장소 경로 목록이다.
 */
function countPointReads(fn) {
  const origFrom = Array.from;
  const wrapped = new WeakSet();
  const counter = { arr: 0, coord: 0, stored: [] };
  const isIdx = (k) => typeof k === 'string' && /^(0|[1-9][0-9]*)$/.test(k);
  const pointHandler = { get(t, k, r) { if (isIdx(k)) counter.coord += 1; return Reflect.get(t, k, r); } };
  const arrHandler = { get(t, k, r) { if (isIdx(k)) counter.arr += 1; return Reflect.get(t, k, r); } };
  Array.from = function (src, ...rest) {
    const out = origFrom.call(this, src, ...rest);
    if (src && src[Symbol.toStringTag] === 'Map Iterator') {
      counter.stored = out;
      for (const p of out) {
        if (p && Array.isArray(p.points) && !wrapped.has(p.points)) {
          const px = new Proxy(p.points.map((q) => new Proxy(q, pointHandler)), arrHandler);
          wrapped.add(px);
          p.points = px;
        }
      }
    }
    return out;
  };
  try { fn(counter); } finally { Array.from = origFrom; }
  return counter;
}

// 맞춤 순회 저장소 배열 읽기 1회: 자동 맞춤 frame 의 읽기 수에서 setView frame(순회 없이 출력만, buildPaths 1회)의 읽기 수를 빼면 맞춤 순회 몫이다.
// 시간이 아니라 횟수라 부하·GC 와 무관하게 결정적이다. 세 가지를 모두 단언한다.
// ① setView frame: 저장소 배열 읽기 = total(buildPaths 1회), 좌표 읽기 = 2·total. buildPaths 를 10번 돌리는 변이가 실패한다.
// ② 맞춤 몫의 저장소 배열 읽기 = total, 좌표 읽기 = 2·total. points.slice() 로 한 번 복사한 뒤 10회 순회하는 변이는 배열 읽기만 보면 1회로 보이지만 좌표 읽기가 20·total 이 되어 실패한다.
// 이 시험이 보증하는 것은 '맞춤이 저장소 points 를 점당 1회 읽는다' 까지다(원소 객체를 따로 캐시한 순회까지 막지는 않는다).
test('perf: 맞춤 순회는 저장소 points 배열을 점당 정확히 1회 읽는다(결정적 계수)', () => {
  const scene = makeScene();
  const total = N_PATHS * N_POINTS;
  const auto = fbOf(scene);
  const view = fbOf(scene);
  view.setView({ centerE: 0, centerN: 0, metersPerPx: 0.5 });
  let a = null, again = null, v = null, storedAuto = -1, storedView = -1;
  countPointReads((c) => { auto.frame(SIZE); storedAuto = c.stored.length; a = { arr: c.arr, coord: c.coord }; c.arr = 0; c.coord = 0; auto.frame(SIZE); again = { arr: c.arr, coord: c.coord }; });
  countPointReads((c) => { view.frame(SIZE); storedView = c.stored.length; v = { arr: c.arr, coord: c.coord }; });
  // 계수기가 저장소 경로 목록을 가로채지 못하면(Array.from(Map 반복자) 경로가 바뀐 경우) 읽기 수가 0 이 되므로 원인을 먼저 가린다.
  assert.equal(storedAuto, N_PATHS, `계수기가 가로챈 저장소 경로 ${storedAuto} 개(자동 맞춤 frame), 기대 ${N_PATHS}: 저장소 경로를 Array.from(Map 반복자)로 읽지 않게 바뀌었는지 확인`);
  assert.equal(storedView, N_PATHS, `계수기가 가로챈 저장소 경로 ${storedView} 개(setView frame), 기대 ${N_PATHS}: 저장소 경로를 Array.from(Map 반복자)로 읽지 않게 바뀌었는지 확인`);
  assert.ok(v.arr > 0 && v.coord > 0, `계수가 동작하지 않는다(setView frame 의 points 읽기 배열 ${v.arr}·좌표 ${v.coord}, 가로챈 경로 ${storedView} 개)`);
  assert.equal(v.arr, total, `setView frame 의 배열 읽기 ${v.arr} 번, 기대 ${total}(buildPaths 1회)`);
  assert.equal(v.coord, 2 * total, `setView frame 의 좌표 읽기 ${v.coord} 번, 기대 ${2 * total}`);
  assert.equal(a.arr - v.arr, total, `맞춤 순회 배열 읽기 ${a.arr - v.arr} 번, 기대 ${total}(순회 ${((a.arr - v.arr) / total).toFixed(2)} 회)`);
  assert.equal(a.coord - v.coord, 2 * total, `맞춤 순회 좌표 읽기 ${a.coord - v.coord} 번, 기대 ${2 * total}(복사 뒤 반복 순회 의심)`);
  assert.deepEqual(again, a, '같은 frame 을 되풀이해도 읽기 수가 같아야 한다');
  // 양성 대조: 설치된 Proxy 위에서 저장소 points 를 한 번 더 읽으면 계수기가 그만큼 올라야 한다(복사 뒤 반복도 좌표 계수에 잡힌다)
  countPointReads((c) => {
    auto.frame(SIZE);
    c.arr = 0; c.coord = 0;
    for (const p of c.stored) for (let i = 0; i < p.points.length; i++) { const q = p.points[i]; q[0]; q[1]; }
    assert.equal(c.arr, total, '설치된 Proxy 가 추가 순회의 배열 읽기를 total 만큼 세지 못했다');
    assert.equal(c.coord, 2 * total, '설치된 Proxy 가 추가 순회의 좌표 읽기를 2·total 만큼 세지 못했다');
    c.arr = 0; c.coord = 0;
    for (const p of c.stored) { const cp = p.points.slice(); for (let r = 0; r < 3; r++) for (let i = 0; i < cp.length; i++) { const q = cp[i]; q[0]; q[1]; } }
    assert.equal(c.arr, total, 'slice 는 배열 읽기를 1회로만 센다');
    assert.equal(c.coord, 6 * total, '복사 뒤 3회 순회의 좌표 읽기를 세지 못했다');
  });
});

test('perf: 꼬리 비율은 중앙값 0 에서도 판정과 단언이 같다', () => {
  for (const [name, batches] of [['[0,0,0]', [0, 0, 0]], ['[0,0,1]', [0, 0, 1]], ['[2,2,3]', [2, 2, 3]], ['[1,1,10]', [1, 1, 10]]]) {
    const m = median(batches), q = p90(batches), tail = tailOf(q, m);
    assert.ok(!Number.isNaN(tail), `${name}: tail 이 NaN 이면 판정(<=)과 단언이 갈린다`);
    assert.equal(tail <= P90_MEDIAN_RATIO, name !== '[0,0,1]' && name !== '[1,1,10]', name); // 판정과 단언은 같은 tail 한 값을 쓴다
  }
  assert.equal(tailOf(0, 0), 1); // 퍼짐 없음 → 통과
  assert.equal(tailOf(1, 0), Infinity); // 몸통 0 에 꼬리 > 0 → 실패
  assert.ok(tailOf(0, 0) <= P90_MEDIAN_RATIO && !(tailOf(1, 0) <= P90_MEDIAN_RATIO));
  assert.equal(tailOf(3, 2), 1.5);
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
