// 조립(createTowerStreaming) 시험. 실제 visible·plan 대신 주입한 스텁으로 돌린다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTowerStreaming } from './index.mjs';

const T = TypeError, R = RangeError;
const pose = { pos: [10, 20, 100], quat: [0, 0, 0, 1], fovY: 1 };
const size = { width: 100, height: 80 };
const tile = (tx, ty) => ({ tx, ty });
const key = (tx, ty) => `${tx},${ty}`;

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// 시험용 스텁: tilesInView 는 NEEDED 를 그대로 돌려주고, planRequests 는 계약의 단순 구현이다.
function make(opts) {
  const ctx = { needed: [], calls: [], plans: 0 };
  const deps = {
    tileKey: key,
    tilesInView(view, o) {
      ctx.calls.push({ view, o });
      return ctx.needed.map((t) => tile(t.tx, t.ty));
    },
    planRequests({ needed, held, inflight, opts: o, center }) {
      ctx.plans++;
      ctx.center = center;
      const keys = new Set(needed.map((t) => key(t.tx, t.ty)));
      const nh = new Set(held), ni = new Set(inflight);
      const cancel = [], evict = [], request = [], deferred = [];
      const parse = (k) => tile(...k.split(',').map(Number));
      for (const k of inflight) if (!keys.has(k)) { cancel.push(parse(k)); ni.delete(k); }
      for (const k of held) if (!keys.has(k)) { evict.push(parse(k)); nh.delete(k); }
      for (const t of needed) {
        const k = key(t.tx, t.ty);
        if (nh.has(k) || ni.has(k)) continue;
        if (ni.size < o.maxInflight) { ni.add(k); request.push(t); } else deferred.push(t);
      }
      return { plan: { needed, request, cancel, evict, deferred }, held: nh, inflight: ni };
    },
  };
  return { s: createTowerStreaming(opts, deps), ctx };
}
const T1 = [tile(0, 0), tile(1, 0), tile(0, 1)];

test('create: opts 검사 위반은 던진다', () => {
  assert.throws(() => createTowerStreaming({ foo: 1 }, {}), R);
  assert.throws(() => createTowerStreaming({ maxInflight: '1' }, {}), T);
  assert.throws(() => createTowerStreaming(null, {}), T);
});

test('create: 초기 상태는 비어 있다', () => {
  const { s } = make();
  assert.deepEqual(s.state(), { held: [], inflight: [] });
});

test('update: 첫 호출은 needed 를 모두 request 하고 inflight 로 올린다', () => {
  const { s, ctx } = make();
  ctx.needed = T1;
  const p = s.update(pose, size);
  assert.deepEqual(p.needed, T1);
  assert.deepEqual(p.request, T1);
  assert.deepEqual([p.cancel, p.evict, p.deferred], [[], [], []]);
  assert.deepEqual(s.state(), { held: [], inflight: [tile(0, 0), tile(0, 1), tile(1, 0)] });
});

test('update: 정규화된 opts 와 view, center 를 의존 함수에 넘긴다', () => {
  const { s, ctx } = make({ maxInflight: 3 });
  s.update(pose, size);
  assert.equal(ctx.calls[0].o.maxInflight, 3);
  assert.equal(ctx.calls[0].o.maxDistM, 1500);
  assert.equal(ctx.calls[0].view.width, 100);
  assert.deepEqual(ctx.center, [10, 20]);
});

test('update: quat 원소 접근자가 두 번째 읽기에서 값을 바꿔도 검사한 값이 그대로 쓰인다', () => {
  const ref = make();
  ref.ctx.needed = T1;
  ref.s.update({ pos: [10, 20, 100], quat: [0, 0, 0, 1], fovY: 1 }, size);
  const { s, ctx } = make();
  ctx.needed = T1;
  let reads = 0;
  const quat = [0, 0, 0, 1];
  // 첫 읽기는 유효한 w=1, 이후 읽기는 비정규(w=0, 영 사원수)로 바뀐다
  Object.defineProperty(quat, 3, { get() { reads += 1; return reads === 1 ? 1 : 0; } });
  s.update({ pos: [10, 20, 100], quat, fovY: 1 }, size);
  assert.equal(reads, 1, 'quat 원소는 한 번만 읽는다');
  assert.deepEqual(ctx.calls[0].view, ref.ctx.calls[0].view);
});

test('update: 같은 시점을 다시 부르면 다시 요청하지 않는다', () => {
  const { s, ctx } = make();
  ctx.needed = T1;
  s.update(pose, size);
  const p = s.update(pose, size);
  assert.deepEqual(p.request, []);
  assert.equal(s.state().inflight.length, 3);
});

test('update: maxInflight 가 차면 deferred, 도착 후 다음 update 가 요청한다', () => {
  const { s, ctx } = make({ maxInflight: 2 });
  ctx.needed = T1;
  const p = s.update(pose, size);
  assert.deepEqual(p.request, [tile(0, 0), tile(1, 0)]);
  assert.deepEqual(p.deferred, [tile(0, 1)]);
  assert.equal(s.arrived(0, 0), true);
  const q = s.update(pose, size);
  assert.deepEqual(q.request, [tile(0, 1)]);
  assert.deepEqual(q.deferred, []);
});

test('update: 시점이 바뀌면 cancel·evict 가 상태에서 빠진다', () => {
  const { s, ctx } = make();
  ctx.needed = T1;
  s.update(pose, size);
  s.arrived(0, 0);
  ctx.needed = [tile(5, 5)];
  const p = s.update(pose, size);
  assert.deepEqual(p.evict, [tile(0, 0)]);
  assert.deepEqual(p.cancel.map((t) => key(t.tx, t.ty)).sort(), ['0,1', '1,0']);
  assert.deepEqual(p.request, [tile(5, 5)]);
  assert.deepEqual(s.state(), { held: [], inflight: [tile(5, 5)] });
});

test('arrived: inflight 였던 타일은 held 로 옮기고 true', () => {
  const { s, ctx } = make();
  ctx.needed = T1;
  s.update(pose, size);
  assert.equal(s.arrived(1, 0), true);
  assert.deepEqual(s.state().held, [tile(1, 0)]);
  assert.deepEqual(s.state().inflight, [tile(0, 0), tile(0, 1)]);
});

test('arrived: 요청한 적 없는 타일은 거절하고 상태 불변', () => {
  const { s, ctx } = make();
  ctx.needed = T1;
  s.update(pose, size);
  const before = s.state();
  assert.equal(s.arrived(9, 9), false);
  assert.deepEqual(s.state(), before);
});

test('arrived: 이미 도착한 타일을 다시 받으면 false', () => {
  const { s, ctx } = make();
  ctx.needed = T1;
  s.update(pose, size);
  assert.equal(s.arrived(0, 0), true);
  assert.equal(s.arrived(0, 0), false);
  assert.equal(s.state().held.length, 1);
});

test('arrived: 취소된 타일의 늦은 도착은 거절', () => {
  const { s, ctx } = make();
  ctx.needed = T1;
  s.update(pose, size);
  ctx.needed = [];
  s.update(pose, size);
  assert.equal(s.arrived(0, 0), false);
  assert.deepEqual(s.state(), { held: [], inflight: [] });
});

test('arrived·failed: 타일 번호 검사', () => {
  const { s } = make();
  assert.throws(() => s.arrived('0', 0), T);
  assert.throws(() => s.arrived(0.5, 0), R);
  assert.throws(() => s.failed(0, null), T);
  assert.throws(() => s.failed(1e9, 0), R);
});

test('failed: inflight 를 빼고 true, 다음 update 가 다시 요청', () => {
  const { s, ctx } = make();
  ctx.needed = [tile(0, 0)];
  s.update(pose, size);
  assert.equal(s.failed(0, 0), true);
  assert.deepEqual(s.state(), { held: [], inflight: [] });
  assert.deepEqual(s.update(pose, size).request, [tile(0, 0)]);
});

test('failed: inflight 가 아니면 false 이고 held 는 건드리지 않는다', () => {
  const { s, ctx } = make();
  ctx.needed = [tile(0, 0)];
  s.update(pose, size);
  s.arrived(0, 0);
  assert.equal(s.failed(0, 0), false);
  assert.equal(s.failed(7, 7), false);
  assert.deepEqual(s.state().held, [tile(0, 0)]);
});

test('missing: 필요하지만 held 가 아닌 타일, 상태 불변', () => {
  const { s, ctx } = make();
  ctx.needed = T1;
  s.update(pose, size);
  s.arrived(1, 0);
  const before = s.state();
  const plans = ctx.plans;
  assert.deepEqual(s.missing(pose, size), [tile(0, 0), tile(0, 1)]);
  assert.deepEqual(s.state(), before);
  assert.equal(ctx.plans, plans); // 계획 단계를 거치지 않는다
  ctx.needed = [tile(1, 0)];
  assert.deepEqual(s.missing(pose, size), []);
  assert.deepEqual(s.state(), before);
});

test('missing: 입력 검사 위반은 던지고 상태 불변', () => {
  const { s, ctx } = make();
  ctx.needed = T1;
  s.update(pose, size);
  const before = s.state();
  assert.throws(() => s.missing(null, size), T);
  assert.throws(() => s.missing(pose, { width: -1, height: 1 }), R);
  assert.deepEqual(s.state(), before);
});

test('update: 입력 검사 위반은 던지고 상태 불변', () => {
  const { s, ctx } = make();
  ctx.needed = T1;
  s.update(pose, size);
  s.arrived(0, 0);
  const before = s.state();
  assert.throws(() => s.update(null, size), T);
  assert.throws(() => s.update({ ...pose, pos: [1, 2] }, size), T);
  assert.throws(() => s.update({ ...pose, fovY: 0 }, size), R);
  assert.throws(() => s.update(pose, 'x'), T);
  assert.throws(() => s.update(pose, { width: 0, height: 5 }), R);
  assert.deepEqual(s.state(), before);
  assert.equal(ctx.plans, 1);
});

test('update: needed 가 maxTilesPerUpdate 를 넘으면 RangeError 이고 상태 불변', () => {
  const { s, ctx } = make();
  ctx.needed = T1;
  s.update(pose, size);
  const before = s.state();
  ctx.needed = Array.from({ length: 4097 }, (_, i) => tile(i, 0));
  assert.throws(() => s.update(pose, size), R);
  assert.throws(() => s.missing(pose, size), R);
  assert.deepEqual(s.state(), before);
  ctx.needed = Array.from({ length: 4096 }, (_, i) => tile(i, 0));
  assert.doesNotThrow(() => s.update(pose, size)); // 경계는 허용
});

test('update: 의존 함수(tilesInView·planRequests)가 던져도 상태 불변', () => {
  const ctx = { boom: null };
  const base = make();
  const deps = {
    tileKey: key,
    tilesInView: (v, o) => (ctx.boom === 'view' ? (() => { throw new Error('v'); })() : T1),
    planRequests: (a) => {
      if (ctx.boom === 'plan') throw new Error('p');
      return base.s && { plan: { needed: a.needed, request: a.needed, cancel: [], evict: [], deferred: [] }, held: new Set(a.held), inflight: new Set([...a.inflight, ...a.needed.map((t) => key(t.tx, t.ty))]) };
    },
  };
  const s = createTowerStreaming({}, deps);
  s.update(pose, size);
  const before = s.state();
  ctx.boom = 'view';
  assert.throws(() => s.update(pose, size), /v/);
  ctx.boom = 'plan';
  assert.throws(() => s.update(pose, size), /p/);
  assert.deepEqual(s.state(), before);
});

test('state: 사전순 새 배열이며 바꿔도 내부는 불변', () => {
  const { s, ctx } = make();
  ctx.needed = [tile(2, 1), tile(-1, 5), tile(2, -3), tile(-1, -2)];
  s.update(pose, size);
  const a = s.state();
  assert.deepEqual(a.inflight, [tile(-1, -2), tile(-1, 5), tile(2, -3), tile(2, 1)]);
  a.inflight.length = 0;
  a.held.push(tile(9, 9));
  assert.equal(s.state().inflight.length, 4);
  assert.deepEqual(s.state().held, []);
  assert.notEqual(s.state(), s.state());
});

test('reset: held·inflight 를 모두 비운다', () => {
  const { s, ctx } = make();
  ctx.needed = T1;
  s.update(pose, size);
  s.arrived(0, 0);
  assert.equal(s.reset(), undefined);
  assert.deepEqual(s.state(), { held: [], inflight: [] });
  assert.equal(s.arrived(1, 0), false);
  assert.deepEqual(s.update(pose, size).request, T1); // 처음부터 다시 요청
});

test('인스턴스는 서로 상태를 공유하지 않는다', () => {
  const a = make(), b = make();
  a.ctx.needed = T1;
  a.s.update(pose, size);
  assert.deepEqual(b.s.state(), { held: [], inflight: [] });
});

test('입력 객체 불변: 깊은 동결 pose·size·opts 로 모든 호출이 통한다', () => {
  const dp = deepFreeze({ pos: [10, 20, 100], quat: [0, 0, 0, 1], fovY: 1 });
  const dz = deepFreeze({ width: 100, height: 80 });
  const dopts = deepFreeze({ zRangeM: [-5, 50], maxInflight: 2 });
  const { s, ctx } = make(dopts);
  ctx.needed = T1;
  const p = s.update(dp, dz);
  assert.deepEqual(p.request.length, 2);
  s.missing(dp, dz);
  s.arrived(0, 0);
  assert.deepEqual(dp, { pos: [10, 20, 100], quat: [0, 0, 0, 1], fovY: 1 });
  assert.deepEqual(dz, { width: 100, height: 80 });
  assert.deepEqual(dopts, { zRangeM: [-5, 50], maxInflight: 2 });
  assert.deepEqual(ctx.calls[0].o.zRangeM, [-5, 50]);
});

test('update: 돌려준 계획을 바꿔도 의존 함수 결과·상태에 영향이 없다', () => {
  const { s, ctx } = make();
  ctx.needed = T1;
  const p = s.update(pose, size);
  p.request[0].tx = 99;
  p.needed.length = 0;
  assert.deepEqual(s.state().inflight, [tile(0, 0), tile(0, 1), tile(1, 0)]);
  assert.deepEqual(ctx.needed, T1);
});

test('update·missing: pos·quat 접근자는 한 번만 읽고, 비배열 pos·quat 는 TypeError (늘 스냅샷)', () => {
  const { s } = make();
  const counts = { pos: 0, quat: 0 };
  const acc = {
    get pos() { counts.pos += 1; return [10, 20, 100]; },
    get quat() { counts.quat += 1; return [0, 0, 0, 1]; },
    fovY: 1,
  };
  s.update(acc, size);
  assert.deepEqual(counts, { pos: 1, quat: 1 });
  s.missing(acc, size);
  assert.deepEqual(counts, { pos: 2, quat: 2 });
  // 비배열(유사 배열·접근자가 매번 다른 값을 주는 객체)은 다시 읽지 못하게 TypeError
  let reads = 0;
  const arrayLike = { get pos() { reads += 1; return { 0: 10, 1: 20, 2: 100, length: 3 }; }, quat: [0, 0, 0, 1], fovY: 1 };
  assert.throws(() => s.update(arrayLike, size), T);
  assert.throws(() => s.missing(arrayLike, size), T);
  assert.equal(reads, 2);
  assert.throws(() => s.update({ ...pose, quat: { 0: 0, 1: 0, 2: 0, 3: 1, length: 4 } }, size), T);
  assert.throws(() => s.update({ ...pose, quat: 'abcd' }, size), T);
  // 접근자가 읽을 때마다 바꿔도 검사한 값과 사용한 값이 같다(center 는 첫 읽기 값)
  let n = 0;
  const flip = { get pos() { n += 1; return n === 1 ? [10, 20, 100] : [1e30, 0, 0]; }, quat: [0, 0, 0, 1], fovY: 1 };
  assert.doesNotThrow(() => s.update(flip, size));
  assert.equal(n, 1);
});

test('update·missing: size 접근자는 한 번만 읽고 검사값과 사용값이 같다, 비객체 size 는 TypeError', () => {
  // 호출마다 새 접근자: 첫 읽기는 유효값, 이후 읽기는 무효값(width 100 → 0.5)
  const mk = () => {
    const reads = { width: 0, height: 0, devicePixelRatio: 0 };
    const acc = {
      get width() { reads.width += 1; return reads.width === 1 ? 100 : 0.5; },
      get height() { reads.height += 1; return reads.height === 1 ? 80 : 0.5; },
      get devicePixelRatio() { reads.devicePixelRatio += 1; return reads.devicePixelRatio === 1 ? 2 : -1; },
    };
    return { reads, acc };
  };
  const { s, ctx } = make();
  ctx.needed = [tile(1, 1)];
  const a = mk();
  assert.doesNotThrow(() => s.update(pose, a.acc));
  assert.deepEqual(a.reads, { width: 1, height: 1, devicePixelRatio: 1 });
  const v = ctx.calls[0].view;
  assert.deepEqual([v.width, v.height, v.devicePixelRatio], [100, 80, 2]);
  const b = mk();
  assert.doesNotThrow(() => s.missing(pose, b.acc));
  assert.deepEqual(b.reads, { width: 1, height: 1, devicePixelRatio: 1 });
  for (const bad of [null, undefined, 5, 'abc', true]) {
    assert.throws(() => s.update(pose, bad), T);
    assert.throws(() => s.missing(pose, bad), T);
  }
});
