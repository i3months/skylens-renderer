// F-128 ①: 법선 원뿔(leafNormalCones, O(N))은 계층마다 한 번만 만든다. cullAndSelectDefault 를 같은 계층에 두 번 불러도 한 번.
// 세는 방법: leafNormalCones 안에서 일어나는 levels[0].normals 접근 횟수를 Proxy 로 센다(호출 스택으로 구분).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/select/index.mjs';
import { cullAndSelectDefault, cachedNormalCones } from './index.mjs';

const CAM = { width: 64, height: 48, K: { fx: 60, fy: 60, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
function scene() {
  const pos = [], nor = [];
  for (let i = 0; i < 200; i++) { pos.push((i % 10) * 0.1 - 0.5, Math.floor(i / 10) * 0.1 - 1, 5 + (i % 3) * 0.1); nor.push(0, 0, -1); }
  const n = pos.length / 3;
  return buildHierarchy({ format: 1, count: n, positions: Float32Array.from(pos), normals: Float32Array.from(nor), colors: new Uint8Array(3 * n).fill(200) },
    { edge0M: 0.5, levelCount: 2, maxLeafPoints: 16 });
}

test('cullAndSelectDefault 를 같은 계층에 두 번 불러도 leafNormalCones 입력(normals)은 한 번만 읽힌다', async () => {
  const h = scene();
  let reads = 0;
  const lv0 = new Proxy(h.levels[0], { get: (o, k, r) => { if (k === 'normals' && new Error().stack.includes('leafNormalCones')) reads++; return Reflect.get(o, k, r); } });
  const hp = { ...h, levels: [lv0, ...h.levels.slice(1)] };
  const opts = { thresholdPx: 0.5, stages: ['backface'], pointSizeM: 0.05 };
  await cullAndSelectDefault(hp, CAM, opts);
  const first = reads;
  assert.ok(first >= 1, `첫 호출에서 원뿔을 만들어야 함: ${first}`);
  await cullAndSelectDefault(hp, CAM, opts);
  assert.equal(reads, first, '두 번째 호출은 원뿔을 다시 만들지 않아야 함');
});

test('cachedNormalCones: 같은 계층은 compute 1 회, 다른 계층은 따로', () => {
  const a = {}, b = {};
  let calls = 0;
  const compute = (h) => { calls++; return { of: h }; };
  const c1 = cachedNormalCones(a, compute);
  assert.equal(cachedNormalCones(a, compute), c1);
  assert.equal(calls, 1);
  assert.notEqual(cachedNormalCones(b, compute), c1);
  assert.equal(calls, 2);
});

// F-131 ⑤: stats.kept 는 chunks 길이(mask 1 이면서 LOD 가 그리는 리프)다. LOD 가 시야 밖으로 NOT_DRAWN 한 리프는 mask 가 1 이어도 세지 않는다(F-118 ⑤).
test('stats.kept = chunks.length = mask 1 이면서 NOT_DRAWN 이 아닌 리프 수', async () => {
  const pts = [];
  const put = (x, n) => { for (let i = 0; i < n; i++) pts.push(x + (i % 3) * 0.02, (i % 2) * 0.02, 5); };
  put(0, 20); // 화면 안
  put(500, 20); // 시야 밖(LOD 가 NOT_DRAWN)
  const n = pts.length / 3;
  const hh = buildHierarchy({ format: 1, count: n, positions: Float32Array.from(pts), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n).fill(200) },
    { edge0M: 0.5, levelCount: 2, maxLeafPoints: 8 });
  const r = await cullAndSelectDefault(hh, CAM, { thresholdPx: 0.5, stages: [] });
  const maskOnes = r.cull.mask.reduce((a, m) => a + m, 0);
  const drawn = r.selection.leafLevel.reduce((a, l) => a + (l !== 255 ? 1 : 0), 0);
  assert.ok(drawn < maskOnes, `장면이 두 값을 가르지 못함: mask1 ${maskOnes}, drawn ${drawn}`);
  assert.equal(r.cull.stats.kept, r.cull.chunks.length);
  assert.equal(r.cull.stats.kept, drawn);
});

// F-135: 캐시 키가 계층 객체뿐이면 levels[0].normals·leafStart·리프 수를 바꿔 끼운 뒤에도 낡은 원뿔을 쓴다. 입력 참조가 다르면 다시 계산한다.
test('cachedNormalCones: normals 만 교체하면 다시 계산하고 새 객체로 처음 계산한 결과와 같다', () => {
  const mk = () => ({ octree: { leafCount: 2 }, levels: [{ normals: new Float32Array([0, 0, 1, 0, 0, 1]), leafStart: new Uint32Array([0, 1, 2]) }] });
  const compute = (h) => { calls++; return Array.from(h.levels[0].normals); };
  let calls = 0;
  const h = mk();
  cachedNormalCones(h, compute);
  h.levels[0].normals = new Float32Array([0, 1, 0, 0, 1, 0]);
  const got = cachedNormalCones(h, compute);
  assert.equal(calls, 2);
  const fresh = mk(); fresh.levels[0].normals = h.levels[0].normals;
  assert.deepEqual(got, compute(fresh));
  assert.deepEqual(got, [0, 1, 0, 0, 1, 0]);
});

test('cachedNormalCones: 리프 수(leafStart/L)를 교체하면 다시 계산하고 새 객체로 처음 계산한 결과와 같다', () => {
  let calls = 0;
  const compute = (h) => { calls++; return { n: h.octree.leafCount, starts: Array.from(h.levels[0].leafStart) }; };
  const normals = new Float32Array(9);
  const h = { octree: { leafCount: 2 }, levels: [{ normals, leafStart: new Uint32Array([0, 1, 2]) }] };
  cachedNormalCones(h, compute);
  // leafStart 만 교체(L 같음)
  h.levels[0].leafStart = new Uint32Array([0, 2, 3]);
  assert.deepEqual(cachedNormalCones(h, compute), { n: 2, starts: [0, 2, 3] });
  assert.equal(calls, 2);
  // leafStart 와 L 함께 교체
  h.octree = { leafCount: 3 };
  h.levels[0].leafStart = new Uint32Array([0, 1, 2, 3]);
  assert.deepEqual(cachedNormalCones(h, compute), { n: 3, starts: [0, 1, 2, 3] });
  assert.equal(calls, 3);
  // L 만 교체
  h.octree = { leafCount: 4 };
  assert.equal(cachedNormalCones(h, compute).n, 4);
  assert.equal(calls, 4);
  // 같은 입력 재호출은 캐시
  cachedNormalCones(h, compute);
  assert.equal(calls, 4);
});

test('cachedNormalCones: null hierarchy 는 cull: 오류', () => {
  assert.throws(
    () => cachedNormalCones(null, () => ({})),
    { message: /^cull:/ }
  );
});

test('cachedNormalCones: 비객체 hierarchy 는 cull: 오류', () => {
  assert.throws(
    () => cachedNormalCones('not an object', () => ({})),
    { message: /^cull:/ }
  );
  assert.throws(
    () => cachedNormalCones(42, () => ({})),
    { message: /^cull:/ }
  );
});

test('cachedNormalCones: 비함수 compute 는 cull: 오류', () => {
  const h = { octree: { leafCount: 1 }, levels: [{ normals: new Float32Array(), leafStart: new Uint32Array() }] };
  assert.throws(
    () => cachedNormalCones(h, null),
    { message: /^cull:/ }
  );
  assert.throws(
    () => cachedNormalCones(h, 'not a function'),
    { message: /^cull:/ }
  );
});
