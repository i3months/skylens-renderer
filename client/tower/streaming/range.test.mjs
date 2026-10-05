// F-434·F-438 범위 시험: 좌표 상한, 타일 번호 상한, 상속 옵션, zRangeM float32, pos 재읽기.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTowerStreaming } from './index.mjs';
import { checkOpts, checkCoordRange, TILE_INDEX_MAX } from './validate.mjs';
import { poseToView } from '../overlay/view.mjs';
import { tilesInView } from './visible.mjs';
import { TOWER_STREAMING_LIMITS as L } from '../../../contracts/controlview/streaming.mjs';

const R = RangeError;
const size = { width: 800, height: 600 };
const emptyState = { held: [], inflight: [] };
const poseToViewOf = (pose) => poseToView(pose, { width: 800, height: 600 });

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

// ── F-439 ② 경계·상태 불변·z 멀리 있는 시점 ──

function pose(pos, yaw, fovY = 1) {
  // 카메라 축 OpenCV: elev=0 이면 th = −π/2 (회전 후 앞축이 수평). 시험용 자세 공식은 visible.test.mjs 와 같다.
  const th = -Math.PI / 2;
  const qa = [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)];
  const qb = [Math.sin(th / 2), 0, 0, Math.cos(th / 2)];
  const quat = [
    qa[3] * qb[0] + qa[0] * qb[3] + qa[1] * qb[2] - qa[2] * qb[1],
    qa[3] * qb[1] - qa[0] * qb[2] + qa[1] * qb[3] + qa[2] * qb[0],
    qa[3] * qb[2] + qa[0] * qb[1] - qa[1] * qb[0] + qa[2] * qb[3],
    qa[3] * qb[3] - qa[0] * qb[0] - qa[1] * qb[1] - qa[2] * qb[2],
  ];
  return { pos, quat, fovY };
}

const IMAX = L.tileIndexMax;
const inRange = (list) => list.every((t) => Math.abs(t.tx) <= IMAX && Math.abs(t.ty) <= IMAX);

// 네 방향 경계: |pos| + maxDistM = maxCoordM 에서 그 방향을 본다. 반대편 한 칸(−IMAX−1)은 경계 여유로 자르고 던지지 않는다.
const DIRS = [
  { name: '+x', yaw: -Math.PI / 2, pos: (m) => [m, 0, 100] },
  { name: '−x', yaw: Math.PI / 2, pos: (m) => [-m, 0, 100] },
  { name: '+y', yaw: 0, pos: (m) => [0, m, 100] },
  { name: '−y', yaw: Math.PI, pos: (m) => [0, -m, 100] },
];
for (const dir of DIRS) {
  test(`수평 경계 ${dir.name}: 경계 끝에서 그쪽을 봐도 던지지 않고 번호는 ±tileIndexMax 안, 경계 타일 포함`, () => {
    const m = L.maxCoordM - L.maxDistM;
    const s = createTowerStreaming();
    const p = pose(dir.pos(m), dir.yaw);
    const miss = s.missing(p, size);
    assert.ok(miss.length > 0);
    assert.ok(inRange(miss), 'missing 전체 결과가 ±tileIndexMax 안이어야 한다');
    const up = s.update(p, size);
    assert.ok(inRange(up.needed));
    // 경계에 닿는 번호: +방향은 IMAX(맞닿음), −방향은 −IMAX−1 이 잘려 −IMAX
    const axis = dir.name.endsWith('x') ? 'tx' : 'ty';
    const sign = dir.name[0] === '+' ? 1 : -1;
    assert.ok(up.needed.some((t) => t[axis] === sign * IMAX), `${axis}=${sign * IMAX} 타일이 있어야 한다`);
    // 같은 자세에서 한 칸 넘어가면(경계 + 64 m) 진입 검사에서 RangeError
    const over = pose(dir.pos(m + 64), dir.yaw);
    assert.throws(() => s.update(over, size), R);
    assert.throws(() => s.missing(over, size), R);
  });
}

test('tilesInView 직접 호출: 경계 한 칸 넘침(−IMAX−1)은 −IMAX 로 자르고, 두 칸 이상은 루프 전에 던진다', () => {
  // clampIdx 는 ±(IMAX+1) 까지만 허용한다(경계 맞닿음 여유). 진입 검사를 거치지 않는 직접 호출에서도 번호는 ±IMAX 안.
  const edge = L.maxCoordM; // = IMAX·64
  const o = checkOpts({});
  const mk = (x, y, yaw) => poseToViewOf(pose([x, y, 100], yaw));
  const west = tilesInView(mk(-(edge - o.maxDistM), 0, Math.PI / 2), o);
  assert.ok(west.length > 0 && inRange(west));
  assert.ok(west.some((t) => t.tx === -IMAX));
  // 한 칸 더 멀리(IMAX+2 번 타일이 범위에 들어옴): 던진다
  const far = timed(() => tilesInView(mk(-(edge + 64 * 3), 0, Math.PI / 2), o));
  assert.ok(far.err instanceof R, String(far.err));
  assert.match(far.err.message, /tileIndexMax/);
  const farY = timed(() => tilesInView(mk(0, edge + 64 * 3, 0), o));
  assert.ok(farY.err instanceof R, String(farY.err));
});

test('상태 채운 뒤 범위 밖 update·missing 은 상태를 그대로 둔다(x, y 각각)', () => {
  const s = createTowerStreaming();
  const ok = s.update(pose([100, 100, 100], -Math.PI / 2), size);
  assert.ok(ok.request.length >= 2);
  s.arrived(ok.request[0].tx, ok.request[0].ty); // held 1 개 이상, inflight 1 개 이상
  const before = s.state();
  assert.ok(before.held.length > 0 && before.inflight.length > 0, JSON.stringify([before.held.length, before.inflight.length]));
  for (const pos of [[L.maxCoordM, 0, 100], [0, L.maxCoordM, 100], [-1e9, 0, 100], [0, 1e9, 100], [0, -1e9, 100]]) {
    assert.throws(() => s.update(pose(pos, 0), size), R);
    assert.throws(() => s.missing(pose(pos, 0), size), R);
    assert.deepEqual(s.state(), before);
  }
});

test('y 만 상한을 넘는 진입 오류 메시지는 maxCoordM 을 말한다', () => {
  const s = createTowerStreaming();
  for (const pos of [[0, 7e7, 100], [0, -7e7, 100], [10, 6.4e7, 100]]) {
    for (const call of ['update', 'missing']) {
      assert.throws(() => s[call](pose(pos, 0), size), (e) => e instanceof R && /maxCoordM/.test(e.message));
    }
  }
  assert.throws(() => checkCoordRange([0, 7e7, 100], 1500), (e) => e instanceof R && /maxCoordM/.test(e.message));
  assert.throws(() => checkCoordRange([0, -7e7, 100], 1500), R);
  assert.doesNotThrow(() => checkCoordRange([0, L.maxCoordM - 1500, 100], 1500));
});

// ── F-439 ① z 슬랩에서 멀리 있는 시점: 작업량은 결정적 상한으로 본다(시간 단언 없음) ──

const zMax0 = L.zMaxM;
const farOpts = (maxDistM) => checkOpts({ maxDistM });
function work(maxDistM, z, x = 0, y = 0) {
  const o = farOpts(maxDistM);
  const stats = { rows: 0, cells: 0 };
  const view = poseToViewOf({ pos: [x, y, z], quat: [1, 0, 0, 0], fovY: 2.5 });
  let err = null;
  let val = null;
  try { val = tilesInView(view, o, stats); } catch (e) { err = e; }
  const dz = Math.max(0, z - o.zRangeM[1], o.zRangeM[0] - z);
  const hy = Math.sqrt(Math.max(0, maxDistM * maxDistM - dz * dz));
  return { err, val, stats, rowBound: Math.ceil((2 * hy) / 64) + 4 };
}

for (const [d, z] of [[1e6, 999500], [3e6, 2999500], [1e7, 9999000], [6e7, 6e7 - 1000]]) {
  test(`z 가 슬랩에서 먼 시점 maxDistM=${d}, z=${z}: 행 수·칸 수가 결정적 상한 이하, update·missing 이 던지거나 유효`, () => {
    const w = work(d, z);
    assert.ok(w.stats.rows <= w.rowBound, `rows ${w.stats.rows} > ${w.rowBound}`);
    assert.ok(w.stats.cells <= L.maxTilesPerUpdate + 1 + 2 * w.stats.rows, `cells ${w.stats.cells}`);
    if (w.err) assert.equal(w.err.message, 'maxTilesPerUpdate');
    else assert.ok(inRange(w.val));
    // 공개 API: 시간 초과 없이(--test-timeout 이 지킨다) 던지거나 유효, 던지면 상태 불변
    const s = createTowerStreaming({ maxDistM: d });
    const p = { pos: [0, 0, z], quat: [1, 0, 0, 0], fovY: 2.5 };
    for (const call of ['update', 'missing']) {
      try { s[call](p, size); } catch (e) { assert.ok(e instanceof R, String(e)); assert.deepEqual(s.state(), emptyState); }
    }
  });
}

test('z 가 슬랩보다 maxDistM 이상 멀면 빈 결과(반복 0)', () => {
  const o = farOpts(1000);
  const stats = { rows: 0, cells: 0 };
  const view = poseToViewOf({ pos: [0, 0, zMax0 + 1000 + 1], quat: [1, 0, 0, 0], fovY: 2.5 });
  assert.deepEqual(tilesInView(view, o, stats), []);
  assert.deepEqual(stats, { rows: 0, cells: 0 });
});

test('퍼즈 3: maxDistM 1e5..6e7, z = zMax + D − U(0,0.01D), 결정적 작업량 상한·시간 초과 0', () => {
  let seed = 0xf439;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let maxRows = 0, maxCells = 0, thrown = 0, ok = 0;
  for (let i = 0; i < 400; i += 1) {
    const D = 10 ** (5 + rnd() * (Math.log10(6e7) - 5));
    const z = zMax0 + D - rnd() * 0.01 * D;
    const room = L.maxCoordM - D;
    const x = (rnd() * 2 - 1) * room;
    const y = (rnd() * 2 - 1) * room;
    const a = rnd() * 2 * Math.PI;
    const q = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
    const n = Math.hypot(...q);
    const o = farOpts(D);
    const stats = { rows: 0, cells: 0 };
    const view = poseToViewOf({ pos: [x, y, z], quat: q.map((v) => v / n), fovY: 0.1 + (a % 2.4) });
    let err = null;
    let val = null;
    try { val = tilesInView(view, o, stats); } catch (e) { err = e; }
    const dz = Math.max(0, z - o.zRangeM[1]);
    const rowBound = Math.ceil((2 * Math.sqrt(Math.max(0, D * D - dz * dz))) / 64) + 4;
    assert.ok(stats.rows <= rowBound, `i=${i} rows ${stats.rows} > ${rowBound}`);
    assert.ok(stats.cells <= L.maxTilesPerUpdate + 1 + 2 * stats.rows, `i=${i} cells ${stats.cells}`);
    maxRows = Math.max(maxRows, stats.rows); maxCells = Math.max(maxCells, stats.cells);
    if (err) { assert.equal(err.message, 'maxTilesPerUpdate', `i=${i}: ${err}`); thrown += 1; } else { assert.ok(inRange(val)); ok += 1; }
  }
  console.log(`fuzz3: ok=${ok} maxTiles=${thrown} maxRows=${maxRows} maxCells=${maxCells}`);
});
