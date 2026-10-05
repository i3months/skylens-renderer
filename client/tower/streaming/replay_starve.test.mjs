// 경로 재생 시험(replay.test.mjs)이 기아·needed 누락 구현을 잡는지 확인하는 변이 시험(F-435).
// 구현 파일은 고치지 않고 createTowerStreaming 의 deps 주입으로 변이를 넣는다.
//   기아 변이: 첫 요청 뒤에는 자리가 남아도 요청하지 않는다(held·inflight 가 비어 있지 않으면 maxInflight 0 으로 계획).
//              옛 시험은 deferred 를 '요청한 적 있음'으로 쳐서 이 변이를 통과시켰다.
//   이동 중 기아 변이: needed 가 직전 update 의 needed 와 다르면(움직이는 중) maxInflight 0 으로 계획하고, 같으면(정지) 정상으로 계획한다.
//              정지 구간에서는 정상이라 정지 뒤 missing 은 0 이 된다. 기본 maxInflight 재생 15 실행이 모두 '빈 자리 낭비 0' 에서 걸려야 한다.
//   누락 변이: tilesInView 결과에서 가운데 타일 하나를 뺀다. missing 도 같은 needed 에서 나오므로 missing 0 은 통과한다.
//   F-441 변이(모두 기본값 15 실행 중 ≥ 10 실패를 단언, 대조군 15/15 통과):
//     (m1) 이동 중 전부 취소 후 재요청: 움직이는 동안 날아가는 요청을 모두 취소하고 같은 타일을 다시 요청한다(도착이 계속 밀린다).
//          즉시 도착이면 날아가는 요청이 없어 정상과 같으므로 즉시 5 실행은 잡을 수 없다(지연 2·무작위 10 실행이 걸려야 한다).
//     (m2) 이동 중 가짜 타일로 자리 채우기: 빈 자리 중 F(16·8) 개를 보이지 않는 먼 가짜 타일로 채운다(inflight 개수는 꽉 찬다).
//     (m3) 반노화: 4 시점 넘게 연속 보류된 타일을 needed 뒤로 민다(오래 기다린 타일일수록 더 뒤).
//     (m4) 먼 순: needed 를 뒤집어(먼 타일 먼저) 계획한다(F-441 ⑦).
// 대조군: 변이 없는 구현은 같은 15 실행이 모두 통과해야 한다(defaultFailures 빈 배열).
import test from 'node:test';
import assert from 'node:assert/strict';
import { planRequests, parseKey, tileKey } from './plan.mjs';
import { tilesInView } from './visible.mjs';
import { PATHS, DELAYS, replay, replayUnlimited, defaultFailures } from './replay_harness.mjs';

const starving = (args) =>
  args.held.size === 0 && args.inflight.size === 0 ? planRequests(args) : planRequests({ ...args, opts: { ...args.opts, maxInflight: 0 } });

/** 이동 중 기아 변이. 직전 needed 를 기억하므로 재생마다 새로 만든다. */
function movingStarving() {
  let prev = null;
  return (args) => {
    const sig = args.needed.map((t) => `${t.tx},${t.ty}`).join(';');
    const moving = prev !== null && sig !== prev;
    prev = sig;
    return moving ? planRequests({ ...args, opts: { ...args.opts, maxInflight: 0 } }) : planRequests(args);
  };
}

/** needed 서명이 직전과 다르면 움직이는 중. 재생마다 새로 만든다. */
function movingDetector() {
  let prev = null;
  return (needed) => {
    const sig = needed.map((t) => `${t.tx},${t.ty}`).join(';');
    const moving = prev !== null && sig !== prev;
    prev = sig;
    return moving;
  };
}

/** (m1) 이동 중 전부 취소 후 재요청. */
function cancelAllMoving() {
  const moving = movingDetector();
  return (args) => {
    if (!moving(args.needed)) return planRequests(args);
    const r = planRequests({ ...args, inflight: new Set() });
    const cancel = [...args.inflight].map(parseKey).sort((a, b) => a.tx - b.tx || a.ty - b.ty);
    return { ...r, plan: { ...r.plan, cancel } };
  };
}

/** (m2) 이동 중 빈 자리 F 개를 가짜 타일(900000+j, 900000)로 채운다. 남은 자리는 정상대로. */
function fakeFillMoving(F) {
  const moving = movingDetector();
  return (args) => {
    if (!moving(args.needed)) return planRequests(args);
    const kept = planRequests({ ...args, opts: { ...args.opts, maxInflight: 0 } }).inflight.size;
    const f = Math.min(F, Math.max(0, args.opts.maxInflight - kept));
    const r = planRequests({ ...args, opts: { ...args.opts, maxInflight: args.opts.maxInflight - f } });
    const inflight = new Set(r.inflight);
    const request = [...r.plan.request];
    for (let j = 0; j < f; j += 1) {
      const t = { tx: 900000 + j, ty: 900000 };
      inflight.add(tileKey(t.tx, t.ty));
      request.push(t);
    }
    return { ...r, inflight, plan: { ...r.plan, request } };
  };
}

/** (m3) 반노화: 직전까지 A 시점 이상 연속 보류된 타일을 needed 뒤로(나이 오름차순, 가장 오래된 것이 맨 뒤). */
function antiAging(A = 4) {
  const age = new Map();
  return (args) => {
    const fresh = [];
    const old = [];
    for (const t of args.needed) ((age.get(tileKey(t.tx, t.ty)) ?? 0) >= A ? old : fresh).push(t);
    old.sort((a, b) => age.get(tileKey(a.tx, a.ty)) - age.get(tileKey(b.tx, b.ty)));
    const r = planRequests({ ...args, needed: [...fresh, ...old] });
    const next = new Map();
    for (const t of r.plan.deferred) {
      const k = tileKey(t.tx, t.ty);
      next.set(k, (age.get(k) ?? 0) + 1);
    }
    age.clear();
    for (const [k, n] of next) age.set(k, n);
    return r;
  };
}

/** (m4) 먼 순: needed 를 뒤집어 넘긴다. */
const farFirst = (args) => planRequests({ ...args, needed: [...args.needed].reverse() });

const MUTANTS = [
  ['(m1) 이동 중 전부 취소 후 재요청', () => cancelAllMoving(), 10],
  ['(m2) 이동 중 가짜 타일 16 개로 자리 채우기', () => fakeFillMoving(16), 10],
  ['(m2) 이동 중 가짜 타일 8 개로 자리 채우기', () => fakeFillMoving(8), 10],
  ['(m3) 오래 보류된 타일을 뒤로 미는 반노화', () => antiAging(4), 10],
  ['(m4) 먼 순 요청', () => farFirst, 15],
];

for (const [mname, make, minFail] of MUTANTS) {
  test(`변이 감지: ${mname} → 기본값 15 실행 중 ≥ ${minFail} 실패`, () => {
    const failed = [];
    for (const [name, poses] of PATHS) {
      for (const [dname, makeDelay, maxDelay] of DELAYS) {
        const r = replay(name, poses, makeDelay, maxDelay, { deps: { planRequests: make() } });
        if (defaultFailures(r).length > 0) failed.push(`${name}·${dname}`);
      }
    }
    assert.ok(failed.length >= minFail, `${mname}: 실패 ${failed.length}/15 (${failed.join(', ')})`);
  });
}

const dropMiddle = (view, opts) => {
  const out = tilesInView(view, opts);
  return out.filter((_, i) => i !== Math.floor(out.length / 2));
};

for (const [name, poses] of PATHS) {
  for (const [dname, makeDelay, maxDelay] of DELAYS) {
    // 기아 문턱 K = ceil(Nmax/16)·(D+3) 은 정상 구현을 통과시키려는 여유가 있어 이 변이가 K 로 걸린다는 보장은 없다.
    // 정지 구간 판정(deferred 를 빼지 않는 오라클 ∩ missing)은 모든 경로·지연에서 걸려야 한다.
    test(`변이 감지: ${name} · 도착 ${dname} · 기아 구현 → 정지 뒤 오라클 ∩ missing 이 걸린다`, () => {
      const r = replay(name, poses, makeDelay, maxDelay, { deps: { planRequests: starving } });
      assert.ok(r.settledMissing > 0, `${name}: 정지 뒤 오라클 ∩ missing ${r.settledMissing}`);
      assert.ok(r.settledHeldGap > 0, `${name}: 정지 뒤 오라클 − held ${r.settledHeldGap}`);
      assert.ok(r.maxStreak > r.settle, `${name}: 최대 연속 deferred ${r.maxStreak} ≤ 정지 구간 ${r.settle}`);
    });
  }

  test(`변이 감지: ${name} · 이동 중 기아 구현 → 3 지연 모델 모두 빈 자리 낭비로 걸린다(대조: 정상 구현은 모두 통과)`, () => {
    for (const [dname, makeDelay, maxDelay] of DELAYS) {
      const ok = replay(name, poses, makeDelay, maxDelay);
      assert.deepEqual(defaultFailures(ok), [], `${name} · ${dname} 정상 구현: ${ok.report.join('; ')}`);
      const r = replay(name, poses, makeDelay, maxDelay, { deps: { planRequests: movingStarving() } });
      assert.ok(r.wastedSlots > 0, `${name} · ${dname}: 빈 자리 낭비 ${r.wastedSlots}`);
      assert.ok(defaultFailures(r).length > 0, `${name} · ${dname}: 완료 기준 위반이 없다`);
    }
  });

  test(`변이 감지: ${name} · maxInflight 10000 · needed 한 타일 누락 → 오라클 ⊆ held 가 걸린다(missing 0 은 통과)`, () => {
    const r = replayUnlimited(name, poses, { deps: { tilesInView: dropMiddle } });
    assert.equal(r.missing, 0);
    assert.ok(r.heldGap > 0, `${name}: heldGap ${r.heldGap}`);
  });
}
