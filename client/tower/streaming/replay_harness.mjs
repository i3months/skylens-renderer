// 관제탑 조각 요청 경로 재생(T15.7.4) 공용 틀. replay.test.mjs·replay_starve.test.mjs 가 함께 쓴다.
// 합성 경로·도착 지연 모델·시점별 오라클(replay_oracle.mjs, 구현과 독립)과 재생 함수 replay 를 둔다.
// 재생은 단언하지 않고 위반을 세어 돌려준다(시험이 단언한다). 변이 감지 시험이 같은 함수에 주입 구현을 넣어 쓰기 위해서다.
import { createTowerStreaming } from './index.mjs';
import { oracleTiles, tileKey } from './replay_oracle.mjs';
import { poseToCameraPose } from '../input/camera.mjs';
import { TOWER_STREAMING_LIMITS } from '../../../contracts/controlview/streaming.mjs';

export const SIZE = Object.freeze({ width: 160, height: 90 });
export const FOV = Math.PI / 3;
/** 광각 경로의 세로 화각(rad). 160×90 에서 가로 화각은 2·atan(16/9·tan(1.1)) ≈ 148° 다. */
export const FOV_WIDE = 2.2;
export const DEG = Math.PI / 180;

export const cam = (pos, yaw, pitch, fov = FOV) => poseToCameraPose({ pos, yaw, pitch }, fov);
export const keysOf = (tiles) => new Set(tiles.map((t) => tileKey(t.tx, t.ty)));

// ── 합성 경로 ──

/** 직선 전진: 북쪽으로 시점당 12 m, 약간 아래를 본다. */
function pathStraight() {
  const out = [];
  for (let i = 0; i < 120; i += 1) out.push(cam([20, -300 + 12 * i, 35], 0, -8 * DEG));
  return out;
}

/** 제자리 회전 360°: 시점당 3°(121 시점, 마지막은 출발 방향으로 돌아온다). */
function pathSpin() {
  const out = [];
  for (let i = 0; i <= 120; i += 1) out.push(cam([100, -50, 40], 3 * i * DEG, -12 * DEG));
  return out;
}

/** 나선 상승: 원점 둘레 반지름 300 m, 시점당 4°(120 시점 = 1⅓ 바퀴), 높이 10 → 550 m, 진행 방향을 보며 아래로 숙인다. */
function pathSpiral() {
  const out = [];
  const n = 120;
  for (let i = 0; i < n; i += 1) {
    const a = 4 * i * DEG;
    const pos = [300 * Math.cos(a), 300 * Math.sin(a), 10 + (540 * i) / (n - 1)];
    // 반시계로 돈다 → 진행 방향 = (−sin a, cos a). yaw 는 북에서 시계 방향.
    const yaw = Math.atan2(-Math.sin(a), Math.cos(a));
    out.push(cam(pos, yaw, -(10 + (40 * i) / (n - 1)) * DEG));
  }
  return out;
}

/** 급커브: 북쪽 57 시점 → 6 시점 안에 동쪽으로 90° 꺾음 → 동쪽 57 시점. 시점당 15 m. */
function pathSharpTurn() {
  const out = [];
  let x = 0, y = 0, yaw = 0;
  const push = (pitch) => out.push(cam([x, y, 60], yaw, pitch));
  for (let i = 0; i < 57; i += 1) { y += 15; push(-10 * DEG); }
  for (let i = 0; i < 6; i += 1) { yaw += 15 * DEG; x += 15 * Math.sin(yaw); y += 15 * Math.cos(yaw); push(-20 * DEG); }
  for (let i = 0; i < 57; i += 1) { x += 15; push(-10 * DEG); }
  return out;
}

/**
 * 광각 비행(F-438 ⑪): fovY 2.2 rad(가로 ≈ 148°). 북동쪽으로 시점당 10 m 나아가며 높이 50 → 170 m, yaw 를 −60° → +60° 로
 * 훑고 pitch 는 −20° 와 −35° 사이를 오간다. 넓은 화각이라 needed 가 다른 경로보다 훨씬 크다(maxInflight 대비 기아 압력이 크다).
 */
function pathWide() {
  const out = [];
  const n = 120;
  for (let i = 0; i < n; i += 1) {
    const u = i / (n - 1);
    const pos = [-200 + 7 * i, -400 + 7 * i, 50 + 120 * u];
    out.push(cam(pos, (-60 + 120 * u) * DEG, -(27.5 + 7.5 * Math.sin(4 * Math.PI * u)) * DEG, FOV_WIDE));
  }
  return out;
}

export const PATHS = [
  ['직선 전진', pathStraight()],
  ['제자리 회전 360°', pathSpin()],
  ['나선 상승', pathSpiral()],
  ['급커브', pathSharpTurn()],
  ['광각 비행', pathWide()],
];

// 시점별 오라클은 모든 실행이 함께 쓴다(한 번만 센다). 시험 시간을 맞추려고 광선을 32×18 로 줄인다
// (48×27 대비 시점당 평균 타일 수 차이 1% 미만, 표본이 적을수록 오라클은 더 작아질 뿐 거짓 단언은 생기지 않는다).
// 광각 경로는 같은 광선 수면 광선 사이 각이 약 2.5 배 벌어지므로 가로·세로 광선 수를 두 배(64×36)로 쓴다.
export const ORACLE_GRID = [32, 18];
export const ORACLE_GRID_WIDE = [64, 36];
const gridFor = (pose) => (pose.fovY > 1.5 ? ORACLE_GRID_WIDE : ORACLE_GRID);
export const ORACLE = new Map(PATHS.map(([name, poses]) => [name, poses.map((p) => keysOf(oracleTiles(p, SIZE, { grid: gridFor(p) })))]));

/** 시드 고정 난수(mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** [이름, 지연 생성기, 최대 지연(시점)]. 최대 지연은 정지 구간 길이·기아 문턱 유도에 쓴다. */
export const DELAYS = [
  ['즉시', () => () => 0, 0],
  ['2 시점 뒤', () => () => 2, 2],
  ['무작위 0~5 시점 뒤', () => { const r = rng(0x5eed7154); return () => Math.floor(r() * 6); }, 5],
];

/**
 * 한 타일이 연속으로 deferred 인 시점 수의 상한 K, 그리고 정지 구간 길이를 유도한다.
 * needed 는 '카메라 지면 투영점에서 가까운 순'이고 요청은 그 순서로 빈 자리(maxInflight)를 채운다. 한 '묶음'(빈 자리 maxInflight 개를
 * 채우고 그것이 모두 도착해 자리가 다시 비기까지)은 최대 지연 D 에 대해 D+1 시점 걸린다(도착은 요청 시점 + D 의 update 뒤에 처리되므로
 * 그 다음 update 에서 자리가 빈다). 시점 하나의 needed 가 N 개이면 정지한 카메라에서 맨 뒤 타일까지 ceil(N/maxInflight) 묶음,
 * 즉 ceil(N/maxInflight)·(D+1) 시점 안에 요청된다. 움직이는 카메라에서는 새로 들어온 가까운 타일이 앞을 차지하므로 이 수를 그대로 쓰면
 * 정상 구현도 넘을 수 있다. 그래서 N 대신 경로 전체 needed 크기의 최댓값 Nmax 를 쓰고 2 배 여유를 둔다:
 *   K = 2 · ceil(Nmax / maxInflight) · (D + 1).
 * (2026-10 측정: 정상 구현의 최대 연속 deferred / K 는 15 실행 중 가장 큰 것이 광각·즉시 70/108. 여유 없이 1 배를 쓰면 이 실행이 넘는다.)
 * 기아 구현(자리가 남아도 요청하지 않음)은 보이는 타일 하나를 경로 끝까지 계속 deferred 로 두므로 K 와 무관하게 걸린다.
 */
export function starveBound(nMax, maxInflight, maxDelay) {
  return 2 * Math.ceil(nMax / maxInflight) * (maxDelay + 1);
}

/** 정지 구간 길이: 마지막 시점의 needed 전체가 요청·도착하는 데 드는 묶음 수 ceil(N/maxInflight)·(D+1) 에 지연 D 와 여유 1 을 더한다. */
export function settleSteps(nLast, maxInflight, maxDelay) {
  return Math.ceil(nLast / maxInflight) * (maxDelay + 1) + maxDelay + 1;
}

/**
 * 경로 하나를 재생한다. 요청은 지연 모델대로 도착시키고, 취소된 요청은 망에서 버린다(도착시키지 않는다).
 * 경로 끝에서는 마지막 시점을 settleSteps 만큼 반복한다(정지 구간).
 * 세는 것(시험이 단언):
 *   neverRequested : 경로 시점마다 오라클 − (held ∪ inflight). inflight 에는 이번 update 가 요청한 것이 들어 있다.
 *                    deferred 는 '요청한 적 있음'이 아니므로 빼지 않는다(F-435). 진단용 수치다.
 *   dropped        : 오라클 − (held ∪ inflight ∪ deferred). 보이는 타일을 계획에서 아예 놓친 경우(경로 중에도 0 이어야 한다).
 *   maxStreak      : 한 타일이 연속 deferred 였던 최대 시점 수(경로 + 정지 구간).
 *   immediateViolations : 즉시 도착일 때 경로 중 missing ∩ 오라클 − deferred(자리 부족으로 보류된 것만 허용).
 *   settledMissing : 정지 구간 끝에서 missing ∩ 오라클(deferred 를 빼지 않는다). 모든 지연 모델에서 0 이어야 한다.
 *   settledHeldGap : 정지 구간 끝에서 오라클 − held.
 *   protocol       : 날아가는 타일 재요청·도착시킨 타일의 arrived false·held > maxHeld 위반 수.
 */
export function replay(name, poses, makeDelay, maxDelay, { opts, deps } = {}) {
  const streaming = createTowerStreaming(opts, deps);
  const maxInflight = opts?.maxInflight ?? TOWER_STREAMING_LIMITS.maxInflight;
  const maxHeld = opts?.maxHeld ?? TOWER_STREAMING_LIMITS.maxHeld;
  const immediate = maxDelay === 0;
  const delay = makeDelay();
  const oracle = ORACLE.get(name);
  const pending = new Map(); // key → {tx, ty, due}
  const streak = new Map(); // key → 연속 deferred 시점 수
  const r = {
    neverRequested: 0, dropped: 0, maxStreak: 0, maxStreakTile: '', immediateViolations: 0,
    settledMissing: -1, settledHeldGap: -1, protocol: 0, neededMax: 0, settle: 0, report: [],
  };
  const note = (s) => { if (r.report.length < 5) r.report.push(s); };

  const total = poses.length;
  let settleEnd = total;
  for (let step = 0; step < settleEnd; step += 1) {
    const pose = poses[Math.min(step, total - 1)];
    const want = oracle[Math.min(step, total - 1)];
    const plan = streaming.update(pose, SIZE);
    r.neededMax = Math.max(r.neededMax, plan.needed.length);
    if (step === total - 1) {
      r.settle = settleSteps(plan.needed.length, maxInflight, maxDelay);
      settleEnd = total + r.settle;
    }
    for (const t of plan.cancel) pending.delete(tileKey(t.tx, t.ty));
    for (const t of plan.request) {
      const k = tileKey(t.tx, t.ty);
      if (pending.has(k)) { r.protocol += 1; note(`${name} 시점 ${step}: 날아가는 타일 ${k} 를 다시 요청`); }
      pending.set(k, { tx: t.tx, ty: t.ty, due: step + delay() });
    }
    for (const [k, p] of [...pending]) {
      if (p.due > step) continue;
      pending.delete(k);
      if (streaming.arrived(p.tx, p.ty) !== true) { r.protocol += 1; note(`${name} 시점 ${step}: inflight 인 ${k} 의 arrived 가 false`); }
    }

    const deferred = keysOf(plan.deferred);
    const next = new Map();
    for (const k of deferred) {
      const n = (streak.get(k) ?? 0) + 1;
      next.set(k, n);
      if (n > r.maxStreak) { r.maxStreak = n; r.maxStreakTile = `${k}@${step}`; }
    }
    streak.clear();
    for (const [k, n] of next) streak.set(k, n);

    const st = streaming.state();
    if (st.held.length > maxHeld) { r.protocol += 1; note(`${name} 시점 ${step}: held ${st.held.length} > maxHeld ${maxHeld}`); }
    const covered = keysOf([...st.held, ...st.inflight]);
    const held = keysOf(st.held);

    if (step < total) {
      for (const k of want) {
        if (covered.has(k)) continue;
        r.neverRequested += 1;
        if (!deferred.has(k)) { r.dropped += 1; note(`${name} 시점 ${step}: 보이는 ${k} 가 held·inflight·deferred 어디에도 없다`); }
      }
      if (immediate) {
        for (const t of streaming.missing(pose, SIZE)) {
          const k = tileKey(t.tx, t.ty);
          if (want.has(k) && !deferred.has(k)) { r.immediateViolations += 1; note(`${name} 시점 ${step}: 즉시 도착인데 missing ${k}`); }
        }
      }
    }
    if (step === settleEnd - 1) {
      r.settledMissing = streaming.missing(pose, SIZE).filter((t) => want.has(tileKey(t.tx, t.ty))).length;
      r.settledHeldGap = [...want].filter((k) => !held.has(k)).length;
      if (r.settledMissing > 0) note(`${name}: 정지 ${r.settle} 시점 뒤에도 오라클 ∩ missing ${r.settledMissing}`);
    }
  }
  return r;
}

/**
 * maxInflight 를 사실상 무한(10000)으로 두고 즉시 도착시키며 경로 하나를 재생한다. 자리 제한이 없으므로 완료 기준
 * '요청한 적 없는 보이는 타일 0'·'매 시점 missing 0' 을 문자 그대로 잰다. missing 은 구현 자신의 needed 에서 나오므로
 * needed 가 보이는 타일을 빠뜨리면 missing 0 이 그대로 통과한다. 그래서 오라클[step] ⊆ held 를 따로 센다(heldGap).
 */
export function replayUnlimited(name, poses, { deps } = {}) {
  const streaming = createTowerStreaming({ maxInflight: 10000 }, deps);
  const oracle = ORACLE.get(name);
  const r = { neverRequested: 0, deferred: 0, missing: 0, oracleMissing: 0, heldGap: 0, protocol: 0, report: [] };
  const note = (s) => { if (r.report.length < 5) r.report.push(s); };
  for (let step = 0; step < poses.length; step += 1) {
    const plan = streaming.update(poses[step], SIZE);
    r.deferred += plan.deferred.length;
    const st0 = streaming.state();
    const covered = keysOf([...st0.held, ...st0.inflight]);
    for (const k of oracle[step]) if (!covered.has(k)) { r.neverRequested += 1; note(`${name} 시점 ${step}: 요청한 적 없는 ${k}`); }
    for (const t of plan.request) if (streaming.arrived(t.tx, t.ty) !== true) r.protocol += 1;
    const missing = streaming.missing(poses[step], SIZE);
    r.missing += missing.length;
    r.oracleMissing += missing.filter((t) => oracle[step].has(tileKey(t.tx, t.ty))).length;
    const st = streaming.state();
    if (st.held.length > TOWER_STREAMING_LIMITS.maxHeld) r.protocol += 1;
    const held = keysOf(st.held);
    for (const k of oracle[step]) if (!held.has(k)) { r.heldGap += 1; note(`${name} 시점 ${step}: 보이는 ${k} 가 held 에 없다`); }
  }
  return r;
}
