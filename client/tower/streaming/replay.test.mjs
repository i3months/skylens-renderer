// 관제탑 조각 요청 경로 재생 시험(T15.7.4). 완료 기준(TASKS T15.7): 경로 재생 중 '요청한 적 없는 보이는 타일' 0,
// 도착이 즉시이면 매 시점 missing 0. 정답 집합은 replay_oracle.mjs(광선 표본, 구현과 독립)가 센다.
// 합성 경로 5개(fov 60° 4개 + 광각 fovY 2.2 rad 1개) × 도착 지연 모델 3종(즉시·2 시점 뒤·무작위 0~5 시점 뒤, 시드 고정)에
// maxInflight 10000 즉시 실행을 더한다. 경로·오라클·재생 함수는 replay_harness.mjs 에 있다.
// '요청한 적 있음'은 held ∪ inflight(이번 update 가 요청한 것 포함)이다. deferred 는 요청한 적 없음이다(F-435).
// 기본 maxInflight(16)에서는 자리가 모자라 보이는 타일이 잠시 deferred 로 남는 것이 정상이므로, 그 경우의 완료 기준은
// (1) 보이는 타일을 계획에서 놓치지 않음(held ∪ inflight ∪ deferred), (2) 같은 타일이 연속 K 시점 넘게 deferred 가 아님(기아 없음),
// (3) 경로 끝 시점을 충분히 반복한 뒤 오라클 ∩ missing = ∅(deferred 를 빼지 않음)으로 잰다. 자리 제한이 없는 maxInflight 10000 실행은
// '요청한 적 없는 보이는 타일 0'·'missing 0'·'오라클 ⊆ held' 를 매 시점 문자 그대로 단언한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { oracleTiles } from './replay_oracle.mjs';
import { TOWER_STREAMING_LIMITS, TOWER_STREAMING_MAX_NEVER_REQUESTED } from '../../../contracts/controlview/streaming.mjs';
import { cam, PATHS, DELAYS, ORACLE, FOV_WIDE, replay, replayUnlimited, starveBound } from './replay_harness.mjs';

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

// ── 경로 재생 ──

test('재생: 경로마다 시점 ≥ 120 이고 오라클이 비지 않는다', () => {
  for (const [name, poses] of PATHS) {
    assert.ok(poses.length >= 120, `${name}: ${poses.length}`);
    const sizes = ORACLE.get(name).map((s) => s.size);
    assert.ok(Math.min(...sizes) > 0, `${name}: 오라클이 빈 시점이 있다`);
  }
});

test('재생: 광각 경로(fovY 2.2 rad)가 들어 있다', () => {
  assert.ok(PATHS.some(([, poses]) => poses.every((p) => Math.abs(p.fovY - FOV_WIDE) < 1e-12)));
});

for (const [name, poses] of PATHS) {
  for (const [dname, makeDelay, maxDelay] of DELAYS) {
    test(`재생: ${name} · 도착 ${dname} → 놓친 타일 0, 기아 없음, 정지 뒤 missing 0`, () => {
      const r = replay(name, poses, makeDelay, maxDelay);
      const msg = r.report.join('; ');
      assert.equal(r.protocol, 0, msg);
      assert.equal(r.dropped, TOWER_STREAMING_MAX_NEVER_REQUESTED, msg);
      const K = starveBound(r.neededMax, TOWER_STREAMING_LIMITS.maxInflight, maxDelay);
      assert.ok(r.maxStreak <= K, `${name}: 타일 ${r.maxStreakTile} 가 연속 ${r.maxStreak} 시점 deferred(K ${K})`);
      assert.equal(r.immediateViolations, 0, msg);
      assert.equal(r.settledMissing, 0, msg);
      assert.equal(r.settledHeldGap, 0, msg);
    });
  }

  test(`재생: ${name} · 즉시 도착 maxInflight 10000 → 매 시점 요청한 적 없는 보이는 타일 0, missing 0, 오라클 ⊆ held`, () => {
    const r = replayUnlimited(name, poses);
    const msg = r.report.join('; ');
    assert.equal(r.protocol, 0, msg);
    assert.equal(r.deferred, 0, msg);
    assert.equal(r.neverRequested, TOWER_STREAMING_MAX_NEVER_REQUESTED, msg);
    assert.equal(r.oracleMissing, 0, msg);
    assert.equal(r.missing, 0, msg);
    assert.equal(r.heldGap, 0, msg);
  });
}
