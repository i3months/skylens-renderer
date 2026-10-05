// 관제탑 오버레이 퍼즈 불변식 시험: 시드 고정 PRNG 로 임의 유한 입력을 넣어도 던지지 않고, 유한하며, 보이는 점은 화면 안에 있다.
// 실패하면 메시지에 시드(반복 번호)가 찍힌다. 같은 시드는 같은 입력을 다시 만든다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTowerOverlay } from './index.mjs';

const NEAR = 0.1;
const ITER = 3000;

// mulberry32: 32 비트 시드 하나로 결정적 난수열을 만든다.
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}

const EXTREME = [3.4e38, -3.4e38, 1e-30, -1e-30, 0, -0, 1e4, -1e4];

// ENU 성분: 대부분 ±1e4 안, 가끔 극단값
function comp(r) {
  return r.next() < 0.15 ? r.pick(EXTREME) : r.range(-1e4, 1e4);
}
const enu = (r) => [comp(r), comp(r), comp(r)];

function genPose(r) {
  const p = () => (r.next() < 0.1 ? r.pick([0, -0, 1e-30, -1e-30, 1e4, -1e4]) : r.range(-1e4, 1e4));
  const yaw = r.next() < 0.1 ? r.pick([1e3, -1e3, 0, -0]) : r.range(-1e3, 1e3);
  const pitch = r.next() < 0.2 ? r.pick([Math.PI / 2, -Math.PI / 2, 0, -0]) : r.range(-Math.PI / 2, Math.PI / 2);
  // 카메라→ENU 회전 = Rz(yaw)·Rx(pitch), 단위 사원수 [x,y,z,w]
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  const q = [cy * sp, sy * sp, sy * cp, cy * cp];
  const n = Math.hypot(...q);
  return { pos: [p(), p(), p()], quat: q.map((x) => x / n), fovY: r.range(0.01, 3.1) };
}

function genSize(r) {
  const dim = () => (r.next() < 0.2 ? r.pick([1, 2, 4096, 4095]) : r.int(1, 4096));
  return { width: dim(), height: dim() };
}

const genDrones = (r) => Array.from({ length: r.int(0, 12) }, (_, i) => {
  const d = { id: `d${i}`, enu: enu(r) };
  if (r.next() < 0.5) d.yaw = r.range(-7, 7);
  return d;
});

const genDets = (r) => Array.from({ length: r.int(0, 12) }, (_, i) => {
  const d = { id: `t${i}`, enu: enu(r) };
  if (r.next() < 0.5) d.kind = r.pick(['detection', 'alert']);
  if (r.next() < 0.5) d.confidence = r.pick([0, 1, r.next()]);
  return d;
});

const genPath = (r, id) => ({ id, points: Array.from({ length: r.int(2, 10) }, () => enu(r)) });

// 투영 결과 한 점 불변식 (2)(3)
function checkPoint(p, size) {
  for (const k of ['u', 'v', 'depth']) assert.ok(Number.isFinite(p[k]), `${p.id}.${k} 비유한 ${p[k]}`);
  if (p.visible) {
    assert.ok(p.u >= 0 && p.u < size.width, `u=${p.u} 폭 ${size.width} 밖`);
    assert.ok(p.v >= 0 && p.v < size.height, `v=${p.v} 높이 ${size.height} 밖`);
    assert.ok(p.depth > 0, `depth=${p.depth}`);
  }
}

function checkPaths(res, paths) {
  assert.equal(res.paths.length, paths.length);
  res.paths.forEach((rp, i) => {
    assert.equal(rp.id, paths[i].id);
    for (const pl of rp.polylines) {
      assert.ok(pl.length >= 2, `polyline 점 ${pl.length}개`);
      for (const q of pl) {
        for (const k of ['u', 'v', 'depth']) assert.ok(Number.isFinite(q[k]), `경로 ${k} 비유한`);
        assert.ok(q.depth >= NEAR - 1e-9, `경로 depth=${q.depth} < nearM`);
      }
    }
  });
}

// 한 반복을 시드 하나로 돌린다. 실패하면 시드를 메시지에 붙여 다시 던진다.
function run(seed, body) {
  try { body(rng(seed), seed); } catch (e) {
    e.message = `시드 ${seed}: ${e.message}`;
    throw e;
  }
}

// 입력을 얼려 두면 내부 변경은 엄격 모드에서 바로 던진다. 복사본과의 비교는 -0 도 구분한다.
function deepFreeze(o) {
  if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
}

function projectTwice(ov, pose, size) {
  const a = ov.project(pose, size);
  const b = ov.project(pose, size);
  assert.deepStrictEqual(a, b, '같은 입력 두 번 투영 결과가 다르다');
  return a;
}

test('퍼즈: 드론 임의 입력은 유한·화면 안·개수 순서 id 보존·결정적', () => {
  for (let i = 0; i < ITER; i++) run(1000 + i, (r) => {
    const ov = createTowerOverlay();
    const list = genDrones(r), pose = genPose(r), size = genSize(r);
    const snap = structuredClone([list, pose, size]);
    deepFreeze(list); deepFreeze(pose); deepFreeze(size);
    try { ov.setDrones(list); } catch (e) { assert.ok(e instanceof RangeError, `거절은 RangeError: ${e}`); assert.deepEqual(ov.counts(), { drones: 0, detections: 0, paths: 0 }); return; }
    const res = projectTwice(ov, pose, size);
    assert.equal(res.drones.length, list.length);
    res.drones.forEach((p, k) => { assert.equal(p.id, list[k].id); checkPoint(p, size); });
    assert.deepStrictEqual(snap, structuredClone([list, pose, size]), '입력이 변했다');
  });
});

test('퍼즈: 탐지 임의 입력은 유한·화면 안·개수 순서 id 보존·결정적', () => {
  for (let i = 0; i < ITER; i++) run(50000 + i, (r) => {
    const ov = createTowerOverlay();
    const list = genDets(r), pose = genPose(r), size = genSize(r);
    const snap = structuredClone([list, pose, size]);
    deepFreeze(list); deepFreeze(pose); deepFreeze(size);
    try { ov.setDetections(list); } catch (e) { assert.ok(e instanceof RangeError, `거절은 RangeError: ${e}`); assert.equal(ov.counts().detections, 0); return; }
    const res = projectTwice(ov, pose, size);
    assert.equal(res.detections.length, list.length);
    res.detections.forEach((p, k) => { assert.equal(p.id, list[k].id); checkPoint(p, size); });
    assert.deepStrictEqual(snap, structuredClone([list, pose, size]), '입력이 변했다');
  });
});

test('퍼즈: 경로 polyline 은 모두 nearM 이상 깊이이고 점이 2개 이상이다', () => {
  for (let i = 0; i < ITER; i++) run(90000 + i, (r) => {
    const ov = createTowerOverlay({ nearM: NEAR });
    const paths = Array.from({ length: r.int(0, 4) }, (_, k) => genPath(r, `p${k}`));
    const pose = genPose(r), size = genSize(r);
    const snap = structuredClone([paths, pose, size]);
    deepFreeze(paths); deepFreeze(pose); deepFreeze(size);
    const accepted = [];
    for (const p of paths) {
      try { ov.setPath(p); accepted.push(p); } catch (e) { assert.ok(e instanceof RangeError, `거절은 RangeError: ${e}`); }
    }
    assert.equal(ov.counts().paths, accepted.length);
    const res = projectTwice(ov, pose, size);
    checkPaths(res, accepted);
    assert.deepStrictEqual(snap, structuredClone([paths, pose, size]), '입력이 변했다');
  });
});

test('퍼즈: 드론·탐지·경로 혼합 입력도 한 번에 불변식을 지킨다', () => {
  for (let i = 0; i < ITER; i++) run(130000 + i, (r) => {
    const ov = createTowerOverlay();
    const drones = genDrones(r), dets = genDets(r), path = genPath(r, 'm');
    const pose = genPose(r), size = genSize(r);
    const okD = (() => { try { ov.setDrones(drones); return true; } catch (e) { assert.ok(e instanceof RangeError); return false; } })();
    const okT = (() => { try { ov.setDetections(dets); return true; } catch (e) { assert.ok(e instanceof RangeError); return false; } })();
    const okP = (() => { try { ov.setPath(path); return true; } catch (e) { assert.ok(e instanceof RangeError); return false; } })();
    const res = projectTwice(ov, pose, size);
    assert.equal(res.drones.length, okD ? drones.length : 0);
    assert.equal(res.detections.length, okT ? dets.length : 0);
    assert.equal(res.paths.length, okP ? 1 : 0);
    res.drones.forEach((p, k) => { assert.equal(p.id, drones[k].id); checkPoint(p, size); });
    res.detections.forEach((p, k) => { assert.equal(p.id, dets[k].id); checkPoint(p, size); });
    checkPaths(res, okP ? [path] : []);
  });
});

test('퍼즈: 거절된 입력은 이전 상태를 바꾸지 않는다', () => {
  const BAD = [NaN, Infinity, -Infinity];
  for (let i = 0; i < 1000; i++) run(170000 + i, (r) => {
    const ov = createTowerOverlay();
    const good = [{ id: 'g0', enu: [1, 2, 3] }, { id: 'g1', enu: [-4, 5, 6], yaw: 0.5 }];
    const goodDet = [{ id: 'k0', enu: [7, 8, 9], kind: 'alert', confidence: 0.5 }];
    const goodPath = { id: 'gp', points: [[0, 0, 0], [10, 10, 10]] };
    ov.setDrones(good); ov.setDetections(goodDet); ov.setPath(goodPath);
    const pose = genPose(r), size = genSize(r);
    const before = ov.project(pose, size);
    const cnt = ov.counts();
    // 비유한 성분·중복 id·범위 밖 confidence·점 하나짜리 경로 중 하나로 거절을 유도한다
    const bad = () => r.pick(BAD);
    const attempts = [
      () => ov.setDrones([{ id: 'x', enu: [bad(), 0, 0] }, ...genDrones(r)]),
      () => ov.setDrones([{ id: 'dup', enu: [0, 0, 0] }, { id: 'dup', enu: [1, 1, 1] }]),
      () => ov.setDetections([{ id: 'c', enu: [0, 0, 0], confidence: r.pick([1.5, -0.1, NaN]) }]),
      () => ov.setDetections([{ id: 'y', enu: [0, bad(), 0] }]),
      () => ov.setPath({ id: 'gp', points: [[0, 0, 0], [0, bad(), 0]] }),
      () => ov.setPath({ id: 'one', points: [[0, 0, 0]] }),
    ];
    const f = r.pick(attempts);
    assert.throws(f, (e) => e instanceof RangeError || e instanceof TypeError);
    assert.deepEqual(ov.counts(), cnt);
    assert.deepStrictEqual(ov.project(pose, size), before, '거절 뒤 상태가 변했다');
  });
});
