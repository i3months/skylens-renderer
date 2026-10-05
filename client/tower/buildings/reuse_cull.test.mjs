// F-408 ⑦ 성능: render(camera, out) 버퍼 재사용 + 묶음 경계상자 컬링.
// 장면: 3000동을 60×50 격자(간격 50 m)로 놓고 6×5동씩 100개 묶음(10×10 타일, 한 묶음 300×250 m)으로 나눈다.
// 숫자(묶음 수·배율)는 이 장면과 카메라에서 잰 값이다. 실기기 fps 는 [local].
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
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

test('① 연속 render 사이 새 ArrayBuffer 할당이 없다(points·aerial, out 재사용)', () => {
  // black 은 lines.mjs 가 호출마다 lineMark(W·H 바이트)를 만든다. 그 파일은 이 작업의 소유가 아니라 notes 에 보고한다.
  for (const mode of ['points', 'aerial']) {
    const l = layer(mode, true);
    const out = l.render(CAM_TENTH);
    l.render(CAM_TENTH, out);
    global.gc?.();
    const before = process.memoryUsage().arrayBuffers;
    for (let i = 0; i < 10; i += 1) l.render(i % 2 ? CAM_TENTH : CAM_ALL, out);
    const grown = process.memoryUsage().arrayBuffers - before;
    // 예전 방식이면 10회 × (W·H·8 B = 7.4 MB) ≈ 74 MB 가 늘어난다.
    assert.ok(grown < 2 * 1024 * 1024, `${mode}: arrayBuffers +${grown} B`);
  }
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

test('② 경계: 한 묶음이라도 화면에 걸치면 포함(보수적), 전부 밖이면 0', () => {
  const l = layer('black', true);
  l.render(CAM_BEHIND);
  assert.deepEqual(l.stats(), { groupsTotal: 100, groupsDrawn: 0 });
  l.render(CAM_ALL);
  assert.deepEqual(l.stats(), { groupsTotal: 100, groupsDrawn: 100 });
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
    for (let r = 0; r < RUNS; r += 1) { const t0 = performance.now(); l.render(cam, out); ts.push(performance.now() - t0); }
    return median(ts);
  };
  time(CAM_EDGE);
  const tAll = time(CAM_ALL);
  const tTenth = time(CAM_EDGE);
  console.log(`# black 1280x720 3000동: 전체 ${tAll.toFixed(1)} ms, 1/10 ${tTenth.toFixed(1)} ms, 묶음 ${drawn}/100`);
  assert.ok(tTenth <= tAll / 3, `1/10 ${tTenth.toFixed(1)} ms > 전체 ${tAll.toFixed(1)} ms / 3`);
});
