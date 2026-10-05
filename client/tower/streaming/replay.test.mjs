// 관제탑 조각 요청 경로 재생 시험(T15.7.4). 완료 기준(TASKS T15.7): 경로 재생 중 '요청한 적 없는 보이는 타일' 0,
// 도착이 즉시이면 매 시점 missing 0. 정답 집합은 replay_oracle.mjs(광선 표본, 구현과 독립)가 센다.
// 합성 경로 4개 × 도착 지연 모델 3종(즉시·2 시점 뒤·무작위 0~5 시점 뒤, 시드 고정)에 maxInflight 10000 즉시 실행을 더한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTowerStreaming } from './index.mjs';
import { oracleTiles, tileKey } from './replay_oracle.mjs';
import { poseToCameraPose } from '../input/camera.mjs';
import { TOWER_STREAMING_LIMITS, TOWER_STREAMING_MAX_NEVER_REQUESTED } from '../../../contracts/controlview/streaming.mjs';

const SIZE = Object.freeze({ width: 160, height: 90 });
const FOV = Math.PI / 3;
const DEG = Math.PI / 180;

const cam = (pos, yaw, pitch, fov = FOV) => poseToCameraPose({ pos, yaw, pitch }, fov);
const keysOf = (tiles) => new Set(tiles.map((t) => tileKey(t.tx, t.ty)));

// ── 오라클 자체 시험: 손으로 센 타일 수 ──

test('오라클: 수직 하향(32,32,10) fov 90° 정사각, maxDist 50 → 3×3 = 9 타일', () => {
  // 깊이 s 에서 반폭 = s·tan45°·(1−2·1e-4) ≈ s. s ≤ 50 → x,y ∈ [32−49.99, 32+49.99] = [−17.99, 81.99] → tx,ty ∈ {−1,0,1}.
  const pose = cam([32, 32, 10], 0, -Math.PI / 2, Math.PI / 2);
  const got = oracleTiles(pose, { width: 90, height: 90 }, { maxDistM: 50, grid: [48, 48] });
  assert.equal(got.length, 9);
  assert.deepEqual(got[0], { tx: -1, ty: -1 });
  assert.deepEqual(got[8], { tx: 1, ty: 1 });
});

test('오라클: 수평 북향(10,10,5) fov 90° 정사각, maxDist 100 → ty0 2개 + ty1 4개 = 6 타일', () => {
  // 바닥 쐐기 y−10 = s ∈ [0.1,100], |x−10| ≤ s. 높이는 z ∈ 5±100 로 slab 안.
  // ty0(y<64): x ∈ (−44, 64) → tx −1,0. ty1(y∈[64,110]): x ∈ [−90, 110] → tx −2,−1,0,1.
  const pose = cam([10, 10, 5], 0, 0, Math.PI / 2);
  const got = oracleTiles(pose, { width: 90, height: 90 }, { maxDistM: 100, grid: [48, 48] });
  assert.deepEqual(got, [
    { tx: -2, ty: 1 }, { tx: -1, ty: 0 }, { tx: -1, ty: 1 }, { tx: 0, ty: 0 }, { tx: 0, ty: 1 }, { tx: 1, ty: 1 },
  ]);
});

test('오라클: slab 위(0,0,700) 수직 하향 fov 90° 정사각, maxDist 750 → 24×24 = 576 타일', () => {
  // slab 은 s ∈ [100, 800] 이고 maxDist 로 s ≤ 750. 반폭 ≈ 750(−11.72·64 … 11.72·64) → tx,ty ∈ [−12, 11] 곧 24 개씩.
  // 광선 간격은 s=750 에서 1500/47 ≈ 32 m < 64 m 라 발자국 안 모든 타일에 광선이 떨어진다.
  const pose = cam([0, 0, 700], 0, -Math.PI / 2, Math.PI / 2);
  const got = oracleTiles(pose, { width: 90, height: 90 }, { maxDistM: 750, grid: [48, 48] });
  assert.equal(got.length, 576);
  assert.deepEqual(got[0], { tx: -12, ty: -12 });
  assert.deepEqual(got[575], { tx: 11, ty: 11 });
});

// ── 합성 경로 ──

/** 직선 전진: 북쪽으로 시점당 12 m, 약간 아래를 본다. */
function pathStraight() {
  const out = [];
  for (let i = 0; i < 130; i += 1) out.push(cam([20, -300 + 12 * i, 35], 0, -8 * DEG));
  return out;
}

/** 제자리 회전 360°: 시점당 2.5°(144 시점, 마지막은 출발 방향으로 돌아온다). */
function pathSpin() {
  const out = [];
  for (let i = 0; i <= 144; i += 1) out.push(cam([100, -50, 40], 2.5 * i * DEG, -12 * DEG));
  return out;
}

/** 나선 상승: 원점 둘레 반지름 300 m, 시점당 4°, 높이 10 → 550 m, 진행 방향을 보며 아래로 숙인다. */
function pathSpiral() {
  const out = [];
  const n = 160;
  for (let i = 0; i < n; i += 1) {
    const a = 4 * i * DEG;
    const pos = [300 * Math.cos(a), 300 * Math.sin(a), 10 + (540 * i) / (n - 1)];
    // 반시계로 돈다 → 진행 방향 = (−sin a, cos a). yaw 는 북에서 시계 방향.
    const yaw = Math.atan2(-Math.sin(a), Math.cos(a));
    out.push(cam(pos, yaw, -(10 + (40 * i) / (n - 1)) * DEG));
  }
  return out;
}

/** 급커브: 북쪽 60 시점 → 6 시점 안에 동쪽으로 90° 꺾음 → 동쪽 60 시점. 시점당 15 m. */
function pathSharpTurn() {
  const out = [];
  let x = 0, y = 0, yaw = 0;
  const push = (pitch) => out.push(cam([x, y, 60], yaw, pitch));
  for (let i = 0; i < 60; i += 1) { y += 15; push(-10 * DEG); }
  for (let i = 0; i < 6; i += 1) { yaw += 15 * DEG; x += 15 * Math.sin(yaw); y += 15 * Math.cos(yaw); push(-20 * DEG); }
  for (let i = 0; i < 60; i += 1) { x += 15; push(-10 * DEG); }
  return out;
}

const PATHS = [
  ['직선 전진', pathStraight()],
  ['제자리 회전 360°', pathSpin()],
  ['나선 상승', pathSpiral()],
  ['급커브', pathSharpTurn()],
];

// 시점별 오라클은 모든 실행이 함께 쓴다(한 번만 센다).
const ORACLE = new Map(PATHS.map(([name, poses]) => [name, poses.map((p) => keysOf(oracleTiles(p, SIZE)))]));

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

const DELAYS = [
  ['즉시', () => () => 0],
  ['2 시점 뒤', () => () => 2],
  ['무작위 0~5 시점 뒤', () => { const r = rng(0x5eed7154); return () => Math.floor(r() * 6); }],
];

/**
 * 경로 하나를 재생한다. 요청은 지연 모델대로 도착시키고, 취소된 요청은 망에서 버린다(도착시키지 않는다).
 * 매 시점 단언: 오라클 ⊆ held ∪ inflight ∪ plan.deferred, held 수 ≤ maxHeld, 이미 날아가는 타일을 다시 요청하지 않음,
 * 도착시킨 타일은 arrived 가 true. immediate(즉시 도착)이면 missing ∩ 오라클 ⊆ plan.deferred.
 */
function replay(name, poses, makeDelay, immediate) {
  const streaming = createTowerStreaming();
  const maxHeld = TOWER_STREAMING_LIMITS.maxHeld;
  const delay = makeDelay();
  const oracle = ORACLE.get(name);
  const pending = new Map(); // key → {tx, ty, due}
  let neverRequested = 0;
  let immediateViolations = 0;
  const report = [];

  for (let step = 0; step < poses.length; step += 1) {
    const plan = streaming.update(poses[step], SIZE);
    for (const t of plan.cancel) pending.delete(tileKey(t.tx, t.ty));
    for (const t of plan.request) {
      const k = tileKey(t.tx, t.ty);
      assert.ok(!pending.has(k), `${name} 시점 ${step}: 날아가는 타일 ${k} 를 다시 요청`);
      pending.set(k, { tx: t.tx, ty: t.ty, due: step + delay() });
    }
    for (const [k, p] of [...pending]) {
      if (p.due > step) continue;
      pending.delete(k);
      assert.equal(streaming.arrived(p.tx, p.ty), true, `${name} 시점 ${step}: inflight 인 ${k} 의 arrived 가 false`);
    }

    const st = streaming.state();
    assert.ok(st.held.length <= maxHeld, `${name} 시점 ${step}: held ${st.held.length} > maxHeld ${maxHeld}`);
    const covered = new Set([...st.held, ...st.inflight, ...plan.deferred].map((t) => tileKey(t.tx, t.ty)));
    const want = oracle[step];
    for (const k of want) {
      if (!covered.has(k)) {
        neverRequested += 1;
        if (report.length < 5) report.push(`시점 ${step} 타일 ${k}`);
      }
    }
    if (immediate) {
      const deferred = keysOf(plan.deferred);
      for (const t of streaming.missing(poses[step], SIZE)) {
        const k = tileKey(t.tx, t.ty);
        if (want.has(k) && !deferred.has(k)) {
          immediateViolations += 1;
          if (report.length < 5) report.push(`시점 ${step} 즉시 도착인데 missing ${k}`);
        }
      }
    }
  }
  return { neverRequested, immediateViolations, report };
}

test('재생: 경로마다 시점 ≥ 120 이고 오라클이 비지 않는다', () => {
  for (const [name, poses] of PATHS) {
    assert.ok(poses.length >= 120, `${name}: ${poses.length}`);
    const sizes = ORACLE.get(name).map((s) => s.size);
    assert.ok(Math.min(...sizes) > 0, `${name}: 오라클이 빈 시점이 있다`);
  }
});

for (const [name, poses] of PATHS) {
  for (const [dname, makeDelay] of DELAYS) {
    test(`재생: ${name} · 도착 ${dname} → 요청한 적 없는 보이는 타일 0`, () => {
      const r = replay(name, poses, makeDelay, dname === '즉시');
      assert.equal(r.neverRequested, TOWER_STREAMING_MAX_NEVER_REQUESTED, r.report.join('; '));
      assert.equal(r.immediateViolations, 0, r.report.join('; '));
    });
  }

  test(`재생: ${name} · 즉시 도착 maxInflight 10000 → 매 시점 missing 0`, () => {
    const streaming = createTowerStreaming({ maxInflight: 10000 });
    const oracle = ORACLE.get(name);
    for (let step = 0; step < poses.length; step += 1) {
      const plan = streaming.update(poses[step], SIZE);
      assert.equal(plan.deferred.length, 0, `${name} 시점 ${step}: deferred ${plan.deferred.length}`);
      for (const t of plan.request) assert.equal(streaming.arrived(t.tx, t.ty), true);
      const missing = streaming.missing(poses[step], SIZE);
      const hit = missing.filter((t) => oracle[step].has(tileKey(t.tx, t.ty)));
      assert.equal(hit.length, 0, `${name} 시점 ${step}: 오라클 ∩ missing ${hit.length}`);
      assert.equal(missing.length, 0, `${name} 시점 ${step}: missing ${missing.length}`);
      assert.ok(streaming.state().held.length <= TOWER_STREAMING_LIMITS.maxHeld);
    }
  });
}
