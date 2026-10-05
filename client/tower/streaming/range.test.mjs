// F-434·F-438 범위 시험: 좌표 상한, 타일 번호 상한, 상속 옵션, zRangeM float32, pos 재읽기.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTowerStreaming } from './index.mjs';
import { checkOpts, TILE_INDEX_MAX } from './validate.mjs';
import { tilesInView } from './visible.mjs';
import { TOWER_STREAMING_LIMITS as L } from '../../../contracts/controlview/streaming.mjs';

const R = RangeError;
const size = { width: 800, height: 600 };
const emptyState = { held: [], inflight: [] };

function timed(fn) {
  const t0 = performance.now();
  let err = null;
  let val;
  try { val = fn(); } catch (e) { err = e; }
  return { err, val, ms: performance.now() - t0 };
}

test('계약 상한이 validate 의 TILE_INDEX_MAX 와 같다', () => {
  assert.equal(TILE_INDEX_MAX, L.tileIndexMax);
});

for (const x of [6.5e7, 1e8, 6e17, 1e18, 1e20]) {
  test(`x=${x} 는 100 ms 안에 RangeError, 상태 불변`, () => {
    const s = createTowerStreaming();
    const before = s.state();
    for (const call of ['update', 'missing']) {
      const r = timed(() => s[call]({ pos: [x, 0, 100], quat: [0, 0, 0, 1], fovY: 1 }, size));
      assert.ok(r.err instanceof R, `${call}: ${r.err}`);
      assert.ok(r.ms < 100, `${call} ${r.ms} ms`);
    }
    assert.deepEqual(s.state(), before);
    assert.deepEqual(s.state(), emptyState);
  });
}

test('y=1e19 와 음수 좌표도 RangeError', () => {
  const s = createTowerStreaming();
  for (const pos of [[0, 1e19, 100], [0, -1e19, 100], [-1e20, 0, 100]]) {
    const r = timed(() => s.update({ pos, quat: [0, 0, 0, 1], fovY: 1 }, size));
    assert.ok(r.err instanceof R);
    assert.ok(r.ms < 100);
  }
  assert.deepEqual(s.state(), emptyState);
});

test('경계: |pos|+maxDistM = maxCoordM 는 허용, 조금 넘으면 RangeError', () => {
  const s = createTowerStreaming();
  const ok = timed(() => s.update({ pos: [L.maxCoordM - L.maxDistM, 0, 100], quat: [0, 0, 0, 1], fovY: 1 }, size));
  assert.equal(ok.err, null, String(ok.err));
  for (const t of ok.val.request) assert.doesNotThrow(() => s.arrived(t.tx, t.ty));
  const s2 = createTowerStreaming();
  assert.throws(() => s2.update({ pos: [-(L.maxCoordM - L.maxDistM) - 1, 0, 100], quat: [0, 0, 0, 1], fovY: 1 }, size), R);
  const s3 = createTowerStreaming({ maxDistM: 1e6 });
  assert.throws(() => s3.update({ pos: [L.maxCoordM, 0, 100], quat: [0, 0, 0, 1], fovY: 1 }, size), R);
});

test('옆을 보는 시점 pos [1e8,0,10] 은 타일 번호 밖 요청을 만들지 않는다', () => {
  const s = createTowerStreaming();
  const r = timed(() => s.update({ pos: [1e8, 0, 10], quat: [0.7071068, 0, 0, 0.7071068], fovY: 1 }, { width: 100, height: 80 }));
  assert.ok(r.err instanceof R);
  assert.ok(r.ms < 100);
});

test('tilesInView 방어: 번호가 상한 밖이 될 좌표는 루프 전에 RangeError', () => {
  const view = (x) => ({ R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [-x, 0, 100], K: { fx: 500, fy: 500, cx: 400, cy: 300 }, width: 800, height: 600 });
  const o = checkOpts({});
  for (const x of [1e9, 1e17, 1e30]) {
    const r = timed(() => tilesInView(view(x), o));
    assert.ok(r.err instanceof R, `x=${x} ${r.err}`);
    assert.ok(r.ms < 100);
  }
});

test('퍼즈: pos 크기 1e0~1e38 로그 균등 2만 건, 시간 초과 0, request 타일은 arrived 가 던지지 않는다', () => {
  let seed = 0x5eed1234;
  const rnd = () => { // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const mag = () => 10 ** (rnd() * 38) * (rnd() < 0.5 ? -1 : 1);
  const s = createTowerStreaming();
  let slow = 0, thrown = 0, okCount = 0, maxMs = 0, tiles = 0;
  for (let i = 0; i < 20000; i += 1) {
    const pos = [mag(), mag(), rnd() < 0.5 ? 100 : mag()];
    if (rnd() < 0.3) pos[rnd() < 0.5 ? 0 : 1] = 0;
    let q = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
    const n = Math.hypot(...q);
    q = q.map((v) => v / n);
    const pose = { pos, quat: q, fovY: 0.1 + rnd() * 2.5 };
    const sz = { width: 1 + Math.floor(rnd() * 1000), height: 1 + Math.floor(rnd() * 1000) };
    const r = timed(() => s.update(pose, sz));
    maxMs = Math.max(maxMs, r.ms);
    if (r.ms >= 100) slow += 1;
    if (r.err) {
      assert.ok(r.err instanceof R, `i=${i}: ${r.err}`);
      thrown += 1;
      continue;
    }
    okCount += 1;
    for (const t of r.val.request) {
      tiles += 1;
      assert.ok(Math.abs(t.tx) <= TILE_INDEX_MAX && Math.abs(t.ty) <= TILE_INDEX_MAX);
      assert.doesNotThrow(() => s.arrived(t.tx, t.ty));
    }
    if (i % 500 === 0) s.reset();
  }
  console.log(`fuzz: ok=${okCount} rangeError=${thrown} tiles=${tiles} maxMs=${maxMs.toFixed(1)}`);
  assert.equal(slow, 0);
});

test('퍼즈 2: 범위 안 pos(1e0~6e7), 큰 maxDistM 도 시간 초과 0·arrived 안전', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  let slow = 0;
  for (let i = 0; i < 2000; i += 1) {
    const s = createTowerStreaming({ maxDistM: [1500, 1e4, 1e6, 6e7][i % 4] });
    const sg = () => (rnd() < 0.5 ? -1 : 1);
    const pos = [sg() * 10 ** (rnd() * 7.7), sg() * 10 ** (rnd() * 7.7), 100];
    const a = rnd() * 6.28;
    const r = timed(() => s.update({ pos, quat: [0, 0, Math.sin(a / 2), Math.cos(a / 2)], fovY: 1 }, size));
    if (r.ms >= 100) slow += 1;
    if (r.err) { assert.ok(r.err instanceof R, String(r.err)); continue; }
    for (const t of r.val.request) assert.doesNotThrow(() => s.arrived(t.tx, t.ty));
  }
  assert.equal(slow, 0);
});

test('F-438 ① 상속 속성은 읽지 않는다', () => {
  assert.equal(checkOpts(Object.create({ maxInflight: 3 })).maxInflight, 16);
  assert.deepEqual(checkOpts(Object.create({ zRangeM: [1, 2], maxDistM: 5 })).zRangeM, [L.zMinM, L.zMaxM]);
  assert.equal(checkOpts(Object.create({ maxDistM: 5 })).maxDistM, L.maxDistM);
  assert.equal(checkOpts({ maxInflight: 3 }).maxInflight, 3);
  // 상속 키는 알 수 없는 키 검사에도 걸리지 않는다(Object.keys 는 자기 속성만)
  assert.doesNotThrow(() => checkOpts(Object.create({ bogus: 1 })));
});

test('F-438 ② zRangeM 은 float32 로도 유한해야 한다', () => {
  assert.throws(() => checkOpts({ zRangeM: [0, 1e39] }), R);
  assert.throws(() => checkOpts({ zRangeM: [-1e39, 0] }), R);
  assert.throws(() => checkOpts({ zRangeM: [-1e300, 1e300] }), R);
  assert.deepEqual(checkOpts({ zRangeM: [-1e30, 1e30] }).zRangeM, [-1e30, 1e30]);
  assert.throws(() => checkOpts({ maxDistM: 1e39 }), R);
});

test('F-438 ④ update 는 검사한 pos 를 center 로 쓴다(접근자가 두 번째 읽기에서 바뀌어도)', () => {
  let centerSeen = null;
  const deps = {
    tilesInView: () => [{ tx: 0, ty: 0 }],
    planRequests: (a) => { centerSeen = a.center; return { held: a.held, inflight: a.inflight, plan: { needed: a.needed, request: [], cancel: [], evict: [], deferred: [] } }; },
  };
  const s = createTowerStreaming({}, deps);
  let reads = 0;
  const pose = { quat: [0, 0, 0, 1], fovY: 1, get pos() { reads += 1; return reads === 1 ? [10, 20, 100] : [1e30, 1e30, 100]; } };
  s.update(pose, size);
  assert.deepEqual(centerSeen, [10, 20]);
  // 검사를 통과한 뒤 pos 배열 자체가 바뀌어도 center 는 검사한 값
  const arr = [5, 6, 100];
  const pose2 = { quat: [0, 0, 0, 1], fovY: 1, pos: arr };
  deps.planRequests = (a) => { centerSeen = a.center; arr[0] = 1e30; return { held: a.held, inflight: a.inflight, plan: { needed: a.needed, request: [], cancel: [], evict: [], deferred: [] } }; };
  const s2 = createTowerStreaming({}, deps);
  s2.update(pose2, size);
  assert.deepEqual(centerSeen, [5, 6]);
});
