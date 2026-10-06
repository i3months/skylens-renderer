// F-408 ⑦ 성능: render(camera, out) 버퍼 재사용 + 묶음 경계상자 컬링.
// 장면: 3000동을 60×50 격자(간격 50 m)로 놓고 6×5동씩 100개 묶음(10×10 타일, 한 묶음 300×250 m)으로 나눈다.
// 숫자(묶음 수·배율)는 이 장면과 카메라에서 잰 값이다. 실기기 fps 는 [local].
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_INDEX } from '../../../contracts/raster/index.mjs';
import { createBuildingsLayer } from './index.mjs';
import { makeAerialImage } from './test_support/fixtures.mjs';

const W = 1280, H = 720;
const COLS = 60, ROWS = 50, SPACING = 50, TILE_C = 6, TILE_R = 5;
const GROUPS = (COLS / TILE_C) * (ROWS / TILE_R); // 100
const RUNS = 7;

const BOX_TRIS = [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 5, 1], [0, 4, 5], [2, 7, 3], [2, 6, 7], [0, 3, 7], [0, 7, 4], [1, 5, 6], [1, 6, 2]];
const BOX_EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

/** 한 묶음(타일): 칸 (tc, tr) 의 6×5동. */
function makeGroup(tc, tr, base) {
  const ids = [], pos = [], idx = [], edges = [], pts = [];
  let vo = 0;
  for (let r = 0; r < TILE_R; r += 1) {
    for (let c = 0; c < TILE_C; c += 1) {
      const gx = tc * TILE_C + c, gy = tr * TILE_R + r;
      ids.push(base + ids.length);
      const cx = (gx - COLS / 2) * SPACING, cy = (gy - ROWS / 2) * SPACING;
      const h = 15 + ((gx * 7 + gy * 13) % 40);
      const v = [];
      for (let k = 0; k < 8; k += 1) v.push([cx + ((k & 1) ^ ((k >> 1) & 1) ? 10 : -10), cy + (k & 2 ? 10 : -10), k & 4 ? h : 0]);
      for (const p of v) pos.push(...p);
      for (const t of BOX_TRIS) idx.push(vo + t[0], vo + t[1], vo + t[2]);
      for (const [a, b] of BOX_EDGES) edges.push(...v[a], ...v[b]);
      for (let k = 0; k < 20; k += 1) pts.push(cx - 10 + (k % 5) * 5, cy - 10 + Math.floor(k / 5) * 6, (k * 3) % h);
      vo += 8;
    }
  }
  const nv = vo;
  const uv = new Float32Array(nv * 2);
  const wallMask = new Uint8Array(nv);
  for (let i = 0; i < nv; i += 1) { uv[2 * i] = (i % 8) / 8; uv[2 * i + 1] = ((i >> 1) % 4) / 4; wallMask[i] = (i % 8) < 4 ? 0 : 1; }
  return { ids, mesh: { positions: new Float32Array(pos), indices: new Uint32Array(idx) }, edgeLines: new Float32Array(edges), uv, wallMask, points: new Float32Array(pts) };
}

function makeBundle() {
  const groups = [];
  for (let tr = 0; tr < ROWS / TILE_R; tr += 1) for (let tc = 0; tc < COLS / TILE_C; tc += 1) groups.push(makeGroup(tc, tr, groups.length * TILE_C * TILE_R));
  return { groups, image: makeAerialImage() };
}

function lookAt(eye, target) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const n = Math.hypot(...a); return [a[0] / n, a[1] / n, a[2] / n]; };
  const fwd = norm(sub(target, eye));
  const up = Math.abs(fwd[2]) > 0.999 ? [0, 1, 0] : [0, 0, 1];
  const right = norm(cross(fwd, up));
  const down = cross(fwd, right);
  const R = [...right, ...down, ...fwd];
  const t = [0, 1, 2].map((i) => -(R[3 * i] * eye[0] + R[3 * i + 1] * eye[1] + R[3 * i + 2] * eye[2]));
  return { width: W, height: H, K: { fx: 1000, fy: 1000, cx: W / 2, cy: H / 2 }, R, t };
}

// 도시는 3000×2500 m. 위에서 내려다봄(fx=1000 이라 시야 폭 = 1.28·높이 m).
const CAM_ALL = lookAt([0, 0, 3600], [0, 0, 0]); // 4608×2592 m: 도시 전체
const CAM_TENTH = lookAt([0, 0, 900], [0, 0, 0]); // 1152×648 m ≈ 도시 면적의 1/10(가까이 확대: 화소 채우기가 비용을 지배한다)
// 같은 높이(3600 m)에서 도시 모서리 쪽으로 옮겨 화면에 도시의 약 1/10(동쪽 끝 1200×625 m)만 걸치게 한다. 동당 화소 크기가 CAM_ALL 과 같다.
const CAM_EDGE = lookAt([2604, 1921, 3600], [2604, 1921, 0]);
const CAM_ONE = lookAt([-1000, -900, 120], [-1000, -900, 0]); // 154×86 m: 몇 동만
const CAM_OBLIQUE = lookAt([800, -1500, 400], [0, 0, 0]);
const CAM_BEHIND = lookAt([0, 0, 500], [0, 0, 1000]); // 하늘 쪽(전부 카메라 뒤·위)

// 벽시계 대신 스레드 CPU 시간(threadCpuUsage, 없으면 프로세스 cpuUsage)으로 잰다: 다른 프로세스가 CPU 를 빼앗아 생기는 대기는 포함하지 않는다(fallback/perf.test.mjs 와 같은 방식).
// 문턱 1/3 은 측정에 맞춘 값이 아니라 원래 약속(②의 묶음 수 ≤ 33/100 과 같은 비율)이다. 컬링이 동작하면 1/10 은 전체의 약 1/10 일(묶음 수 비례)을 하므로 3배 여유가 있고,
// 컬링을 끄면 1/10 도 전체와 같은 일을 하므로 비율이 약 0.41~0.56 이 되어 실패한다.
function cpuMs() { const u = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage(); return (u.user + u.system) / 1000; }
function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }
function covered(r) { let n = 0; for (let i = 0; i < r.index.length; i += 1) if (r.index[i] !== EMPTY_INDEX) n += 1; return n; }
function sameResult(a, b) {
  assert.deepEqual(a.index, b.index);
  assert.deepEqual(a.depth, b.depth);
  assert.deepEqual(a.color, b.color);
}

const bundle = makeBundle();
function layer(mode, cull) {
  const l = createBuildingsLayer({ mode, cull });
  l.accept(0, bundle);
  return l;
}

test('장면: 3000동, 100묶음', () => {
  assert.equal(GROUPS, 100);
  const l = layer('black', true);
  assert.deepEqual(l.state(), { level: 0, groupCount: 100, buildingCount: 3000, mode: 'black' });
});

test('① out 재사용: 반환이 같은 객체이고 color·depth·index 가 ===, 크기가 다르면 던진다', () => {
  for (const mode of ['points', 'black', 'aerial']) {
    const l = layer(mode, true);
    const out = l.render(CAM_TENTH);
    const keep = { color: out.color, depth: out.depth, index: out.index };
    const first = { c: out.color.slice(), d: out.depth.slice(), i: out.index.slice() };
    const r2 = l.render(CAM_TENTH, out);
    assert.equal(r2, out, mode);
    assert.equal(r2.color, keep.color);
    assert.equal(r2.depth, keep.depth);
    assert.equal(r2.index, keep.index);
    assert.deepEqual(r2.index, first.i); // 같은 카메라면 같은 결과
    assert.deepEqual(r2.depth, first.d);
    assert.deepEqual(r2.color, first.c);
    // 다른 카메라로 다시 그리면 이전 화소가 남지 않는다(지움)
    const r3 = l.render(CAM_BEHIND, out);
    assert.equal(r3, out);
    assert.equal(covered(r3), 0, `${mode} 지움`);
    assert.ok(r3.color.every((v) => v === 0) && r3.depth.every((v) => v === 0));
  }
  const l = layer('points', true);
  const small = { width: 64, height: 36, color: new Uint8Array(64 * 36 * 3), depth: new Float32Array(64 * 36), index: new Int32Array(64 * 36).fill(-1) };
  assert.throws(() => l.render(CAM_TENTH, small), RangeError);
  // out 을 주지 않으면 이전처럼 매번 새로 만든다
  assert.notEqual(l.render(CAM_TENTH), l.render(CAM_TENTH));
});

/** 측정 구간 동안 형식 배열·ArrayBuffer 생성자 호출 수를 센다(생성자를 Proxy 로 감싼다). fn 이 끝나면 원래대로 되돌린다. */
function countTypedArrayAllocs(fn) {
  const names = ['Uint8Array', 'Float32Array', 'Int32Array', 'ArrayBuffer'];
  const originals = {};
  const counts = { total: 0 };
  for (const name of names) {
    const target = globalThis[name];
    originals[name] = target;
    globalThis[name] = new Proxy(target, {
      construct(t, args, newTarget) {
        counts.total += 1;
        counts[name] = (counts[name] ?? 0) + 1;
        return Reflect.construct(t, args, newTarget === globalThis[name] ? t : newTarget);
      },
    });
  }
  try { fn(); } finally { for (const name of names) globalThis[name] = originals[name]; }
  return counts;
}

test('① 연속 render 사이 새 형식 배열 생성이 없다(points·black·aerial, out 재사용)', () => {
  for (const mode of ['points', 'black', 'aerial']) {
    const l = layer(mode, true);
    const out = l.render(CAM_TENTH);
    l.render(CAM_TENTH, out);
    l.render(CAM_ALL, out); // 예열: 호출 사이 재사용 버퍼(선 표시 버퍼 등)는 여기서 한 번 만들어진다
    const counts = countTypedArrayAllocs(() => {
      for (let i = 0; i < 10; i += 1) l.render(i % 2 ? CAM_TENTH : CAM_ALL, out);
    });
    assert.equal(counts.total, 0, `${mode}: 측정 구간 배열 생성 ${JSON.stringify(counts)}`);
  }
});

test('① 생성 횟수 측정기가 실제 생성을 센다(양성 대조)', () => {
  const originals = {
    Uint8Array: globalThis.Uint8Array,
    Float32Array: globalThis.Float32Array,
    Int32Array: globalThis.Int32Array,
    ArrayBuffer: globalThis.ArrayBuffer,
  };
  const c = countTypedArrayAllocs(() => { new Uint8Array(4); new Float32Array(2); new Int32Array(1); Float32Array.from([1]); new ArrayBuffer(8); });
  assert.equal(c.Uint8Array, 1);
  assert.equal(c.Float32Array, 2);
  assert.equal(c.Int32Array, 1);
  assert.equal(c.ArrayBuffer, 1, 'ArrayBuffer(8) should be called once');
  assert.equal(globalThis.Uint8Array, originals.Uint8Array, 'Uint8Array constructor should be restored');
  assert.equal(globalThis.Float32Array, originals.Float32Array, 'Float32Array constructor should be restored');
  assert.equal(globalThis.Int32Array, originals.Int32Array, 'Int32Array constructor should be restored');
  assert.equal(globalThis.ArrayBuffer, originals.ArrayBuffer, 'ArrayBuffer constructor should be restored');
});

test('② 컬링을 켠 결과 = 끈 결과(화소 동일): 전체/1/10/몇 동/비스듬/뒤', () => {
  for (const mode of ['points', 'black', 'aerial']) {
    const on = layer(mode, true);
    const off = layer(mode, false);
    for (const [name, cam] of [['all', CAM_ALL], ['tenth', CAM_TENTH], ['edge', CAM_EDGE], ['one', CAM_ONE], ['oblique', CAM_OBLIQUE], ['behind', CAM_BEHIND]]) {
      const a = on.render(cam);
      const b = off.render(cam);
      sameResult(a, b);
      if (name !== 'behind') assert.ok(covered(a) > 0, `${mode}/${name} 비어 있음`);
    }
  }
});

test('② 묶음 번호 유지: index 는 accept 순서 묶음 번호이고 컬링해도 안 바뀐다', () => {
  const l = layer('black', true);
  const r = l.render(CAM_ONE);
  const seen = new Set(r.index);
  seen.delete(EMPTY_INDEX);
  assert.ok(seen.size >= 1 && seen.size <= 4);
  // CAM_ONE 은 (-1000,-900) 부근: 타일 열 = floor((-1000/50+30)/6)=1, 행 = floor((-900/50+25)/5)=1 → 번호 1*10+1
  assert.ok(seen.has(11), [...seen].join(','));
  assert.ok(Math.max(...seen) < GROUPS);
});

/** stats() 중 묶음 수만 본다(래스터 호출·화소 수는 perf.test.mjs 가 맡는다). */
const groupStats = (l) => { const { groupsTotal, groupsDrawn } = l.stats(); return { groupsTotal, groupsDrawn }; };

test('② 경계: 한 묶음이라도 화면에 걸치면 포함(보수적), 전부 밖이면 0', () => {
  const l = layer('black', true);
  l.render(CAM_BEHIND);
  assert.deepEqual(groupStats(l), { groupsTotal: 100, groupsDrawn: 0 });
  l.render(CAM_ALL);
  assert.deepEqual(groupStats(l), { groupsTotal: 100, groupsDrawn: 100 });
});

test('③ 도시 1/10 만 보면 래스터에 넘어간 묶음 수 ≤ 1/3, black 시간 ≤ 1/3(중앙값)', () => {
  const l = layer('black', true);
  const out = l.render(CAM_ALL);
  l.render(CAM_ALL);
  assert.equal(l.stats().groupsDrawn, 100);
  l.render(CAM_EDGE, out);
  const drawn = l.stats().groupsDrawn;
  assert.ok(drawn <= 33, `묶음 ${drawn}/100`);
  assert.ok(drawn >= 1);
  const time = (cam) => {
    const ts = [];
    for (let r = 0; r < RUNS; r += 1) { const t0 = cpuMs(); l.render(cam, out); ts.push(cpuMs() - t0); }
    return median(ts);
  };
  time(CAM_EDGE);
  const tAll = time(CAM_ALL);
  const tTenth = time(CAM_EDGE);
  console.log(`# black 1280x720 3000동: 전체 ${tAll.toFixed(1)} ms, 1/10 ${tTenth.toFixed(1)} ms, 묶음 ${drawn}/100`);
  assert.ok(tTenth <= tAll / 3, `1/10 ${tTenth.toFixed(1)} ms > 전체 ${tAll.toFixed(1)} ms / 3`);
});

test('② 근평면 경계: 끝점이 정확히 z=nearM 인 선은 컬링 켬·끔 화소가 같다', () => {
  const cam = { width: 64, height: 64, K: { fx: 100, fy: 100, cx: 32, cy: 32 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0.01] };
  const line = new Float32Array([-0.001, -0.0005, 0, 0.001, 0.0005, 0]); // 카메라 공간 z = 0 + 0.01 = nearM
  const one = { ids: [0], mesh: { positions: new Float32Array(0), indices: new Uint32Array(0) }, edgeLines: line, uv: new Float32Array(0), wallMask: new Uint8Array(0), points: new Float32Array(0) };
  const results = [true, false].map((cull) => {
    const l = createBuildingsLayer({ mode: 'black', cull });
    l.accept(0, { groups: [one], image: makeAerialImage() });
    return l.render(cam);
  });
  assert.ok(covered(results[1]) > 0, '컬링 끔에서 선이 그려져야 함');
  assert.equal(covered(results[0]), covered(results[1]));
  sameResult(results[0], results[1]);
});

test('① out 의 color·depth·index 가 ArrayBuffer 를 공유하면 던진다', () => {
  const l = layer('black', true);
  const n = 64 * 36;
  const cam = { ...CAM_TENTH, width: 64, height: 36, K: { fx: 100, fy: 100, cx: 32, cy: 18 } };
  const buf = new ArrayBuffer(n * 12);
  const mk = (color, depth, index) => ({ width: 64, height: 36, color, depth, index });
  // 색(3n B) 과 깊이(4n B)·색과 index(4n B)·깊이와 index 가 한 버퍼를 겹쳐 쓰는 경우
  assert.throws(() => l.render(cam, mk(new Uint8Array(buf, 0, 3 * n), new Float32Array(buf, 0, n), new Int32Array(new ArrayBuffer(n * 4)))), RangeError);
  assert.throws(() => l.render(cam, mk(new Uint8Array(buf, 0, 3 * n), new Float32Array(new ArrayBuffer(n * 4)), new Int32Array(buf, 4 * n, n))), RangeError);
  assert.throws(() => l.render(cam, mk(new Uint8Array(new ArrayBuffer(3 * n)), new Float32Array(buf, 0, n), new Int32Array(buf, 4 * n, n))), RangeError);
  assert.throws(() => l.render(cam, mk(new Uint8Array(buf, 0, 3 * n), new Float32Array(buf, 4 * n, n), new Int32Array(buf, 8 * n, n))), RangeError); // 같은 버퍼의 겹치지 않는 구간도 거절
  // 서로 다른 버퍼면 통과
  assert.doesNotThrow(() => l.render(cam, mk(new Uint8Array(3 * n), new Float32Array(n), new Int32Array(n))));
});
