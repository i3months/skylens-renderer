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

// 원거리는 카메라로부터의 유클리드 거리 ‖X − pos‖ ≤ maxDistM, 근평면은 깊이 ≥ nearM 이다.
// fov 90° 정사각이면 깊이 s 의 점은 옆 거리 |가로|,|세로| ≤ s(가장자리 광선은 1e-4 안쪽이라 사실상 s).

test('오라클: 수직 하향(32,32,10) fov 90° 정사각, maxDist 50 → 십자 5 타일', () => {
  // 옆 거리 (ex,ey), 깊이 s ≥ max(|ex|,|ey|), 거리² = s² + ex² + ey² ≤ 2500.
  // 옆 타일(tx=1): ex ≥ 32 → 32²·2 = 2048 ≤ 2500 → 닿는다(네 방향 같음). 대각 타일: |ex|,|ey| ≥ 32 → 32²·3 = 3072 > 2500 → 못 닿는다.
  const pose = cam([32, 32, 10], 0, -Math.PI / 2, Math.PI / 2);
  const got = oracleTiles(pose, { width: 90, height: 90 }, { maxDistM: 50, grid: [48, 48] });
  assert.deepEqual(got, [{ tx: -1, ty: 0 }, { tx: 0, ty: -1 }, { tx: 0, ty: 0 }, { tx: 0, ty: 1 }, { tx: 1, ty: 0 }]);
});

test('오라클: 수평 북향(10,10,5) fov 90° 정사각, maxDist 100 → ty0 2개 + ty1 3개 = 5 타일', () => {
  // 앞 s = y−10, 옆 ex = x−10(|ex| ≤ s), 위아래 |ez| ≤ s, 거리² = s² + ex² + ez² ≤ 10000. ty2 는 s ≥ 118 > 100 이라 없다.
  // ty0(s < 54): |ex| < 54 → x ∈ (−44, 64) → tx −1,0.
  // ty1(s ≥ 54): tx 1 은 ex ≥ 54 → 54²·2 = 5832 ≤ 10000 → 닿는다. tx −2 는 ex ≤ −74 → 74²·2 = 10952 > 10000 → 못 닿는다. → tx −1,0,1.
  const pose = cam([10, 10, 5], 0, 0, Math.PI / 2);
  const got = oracleTiles(pose, { width: 90, height: 90 }, { maxDistM: 100, grid: [48, 48] });
  assert.deepEqual(got, [{ tx: -1, ty: 0 }, { tx: -1, ty: 1 }, { tx: 0, ty: 0 }, { tx: 0, ty: 1 }, { tx: 1, ty: 1 }]);
});

test('오라클: slab 위(0,0,700) 수직 하향 fov 90° 정사각, maxDist 750 → 284 타일', () => {
  // 깊이 s = 700 − z ≥ 100(slab 윗면 600), 옆 |x|,|y| ≤ s, 거리² = s² + x² + y² ≤ 750². 타일 안에서 원점에 가장 가까운 점
  // (X, Y)(성분별 최소 |x|,|y|)로 판정: max(X, Y, 100)² + X² + Y² ≤ 562500.
  // 행별(ty) 개수(Y = 그 행의 최소 |y|, X = 최소 |x|, s = max(X, Y)):
  //   ty −9·8  (Y=512): X=192 → 2·512² + 192² = 561152 ≤ 562500, X=256 → 589824 넘음 → tx −4..3 = 8.
  //   ty −8·7  (Y=448): X=384 → 2·448² + 384² = 548864 ≤, X=448 → 3·448² = 602112 넘음 → tx −7..6 = 14.
  //   ty −7..−5·4..6 (Y=384·320·256): X=448 → 2·448² + Y² ≤ 548864 ≤, X=512 → 2·512² + 256² = 589824 넘음 → tx −8..7 = 16.
  //   ty −4..3 (Y ≤ 192): X=512 → 2·512² + 192² = 561152 ≤, X=576 → 663552 넘음 → tx −9..8 = 18.
  //   ty −10·9 (Y=576): 2·576² = 663552 넘음 → 0.
  //   합: 2·8 + 2·14 + 6·16 + 8·18 = 284.
  // 경계에 거의 접하는 타일(예: (3,−9) 최근점 거리 749.1 m)까지 맞히려고 이 시험만 광선을 400×400 으로 촘촘히 쏜다.
  const pose = cam([0, 0, 700], 0, -Math.PI / 2, Math.PI / 2);
  const got = oracleTiles(pose, { width: 90, height: 90 }, { maxDistM: 750, grid: [400, 400] });
  assert.equal(got.length, 284);
  const rows = new Map();
  for (const t of got) rows.set(t.ty, (rows.get(t.ty) ?? 0) + 1);
  for (const [ty, n] of [[-9, 8], [-8, 14], [-7, 16], [-5, 16], [-4, 18], [0, 18], [3, 18], [4, 16], [6, 16], [7, 14], [8, 8]]) {
    assert.equal(rows.get(ty), n, `ty ${ty}`);
  }
});

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

const PATHS = [
  ['직선 전진', pathStraight()],
  ['제자리 회전 360°', pathSpin()],
  ['나선 상승', pathSpiral()],
  ['급커브', pathSharpTurn()],
];

// 시점별 오라클은 모든 실행이 함께 쓴다(한 번만 센다). 시험 시간(합 5 초 이내)을 맞추려고 광선을 32×18 로 줄인다
// (48×27 대비 시점당 평균 타일 수 차이 1% 미만, 표본이 적을수록 오라클은 더 작아질 뿐 거짓 단언은 생기지 않는다).
const ORACLE_GRID = [32, 18];
const ORACLE = new Map(PATHS.map(([name, poses]) => [name, poses.map((p) => keysOf(oracleTiles(p, SIZE, { grid: ORACLE_GRID })))]));

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
