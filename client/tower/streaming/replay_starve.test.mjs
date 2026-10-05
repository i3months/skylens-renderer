// 경로 재생 시험(replay.test.mjs)이 기아·needed 누락 구현을 잡는지 확인하는 변이 시험(F-435).
// 구현 파일은 고치지 않고 createTowerStreaming 의 deps 주입으로 변이를 넣는다.
//   기아 변이: 첫 요청 뒤에는 자리가 남아도 요청하지 않는다(held·inflight 가 비어 있지 않으면 maxInflight 0 으로 계획).
//              옛 시험은 deferred 를 '요청한 적 있음'으로 쳐서 이 변이를 통과시켰다.
//   누락 변이: tilesInView 결과에서 가운데 타일 하나를 뺀다. missing 도 같은 needed 에서 나오므로 missing 0 은 통과한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planRequests } from './plan.mjs';
import { tilesInView } from './visible.mjs';
import { PATHS, DELAYS, replay, replayUnlimited } from './replay_harness.mjs';

const starving = (args) =>
  args.held.size === 0 && args.inflight.size === 0 ? planRequests(args) : planRequests({ ...args, opts: { ...args.opts, maxInflight: 0 } });

const dropMiddle = (view, opts) => {
  const out = tilesInView(view, opts);
  return out.filter((_, i) => i !== Math.floor(out.length / 2));
};

for (const [name, poses] of PATHS) {
  for (const [dname, makeDelay, maxDelay] of DELAYS) {
    // 기아 문턱 K 는 정상 구현을 넉넉히 통과시키려고 2 배 여유를 두었으므로 경로·정지 구간이 K 보다 짧으면 걸리지 않을 수 있다.
    // 정지 구간 판정(deferred 를 빼지 않는 오라클 ∩ missing)은 모든 경로·지연에서 걸려야 한다.
    test(`변이 감지: ${name} · 도착 ${dname} · 기아 구현 → 정지 뒤 오라클 ∩ missing 이 걸린다`, () => {
      const r = replay(name, poses, makeDelay, maxDelay, { deps: { planRequests: starving } });
      assert.ok(r.settledMissing > 0, `${name}: 정지 뒤 오라클 ∩ missing ${r.settledMissing}`);
      assert.ok(r.settledHeldGap > 0, `${name}: 정지 뒤 오라클 − held ${r.settledHeldGap}`);
      assert.ok(r.maxStreak > r.settle, `${name}: 최대 연속 deferred ${r.maxStreak} ≤ 정지 구간 ${r.settle}`);
    });
  }

  test(`변이 감지: ${name} · maxInflight 10000 · needed 한 타일 누락 → 오라클 ⊆ held 가 걸린다(missing 0 은 통과)`, () => {
    const r = replayUnlimited(name, poses, { deps: { tilesInView: dropMiddle } });
    assert.equal(r.missing, 0);
    assert.ok(r.heldGap > 0, `${name}: heldGap ${r.heldGap}`);
  });
}
