// F-152: nodeCount·leafIndex·boxMin·positions 구조 검사는 'cull:' 오류, 계층 읽기가 아닌 오류는 계층 오류로 오인하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/select/index.mjs';
import { orderChunks, leafPriority } from './index.mjs';

const CAM = { width: 320, height: 180, K: { fx: 400, fy: 400, cx: 160, cy: 90 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const pos = [];
for (let i = 0; i < 20; i++) for (let j = 0; j < 12; j++) pos.push((i - 10) * 0.05, (j - 6) * 0.05, 1.5);
const n = pos.length / 3;
const cloud = { format: 1, count: n, positions: Float32Array.from(pos), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n).fill(200) };
const good = buildHierarchy(cloud, { edge0M: 0.05, levelCount: 2, maxLeafPoints: 16 });
const L = good.octree.leafCount;
const mask = new Uint8Array(L).fill(1);
const CULL = /^Error: cull:/;
const bad = (h) => {
  assert.throws(() => leafPriority(h, CAM), (e) => CULL.test(String(e)));
  assert.throws(() => orderChunks(h, CAM, mask), (e) => CULL.test(String(e)));
};
const withOc = (patch) => ({ ...good, octree: { ...good.octree, ...patch } });
const leafNode = () => Array.from(good.octree.leafIndex).findIndex((k) => k >= 0);

test('nodeCount 가 정수가 아니거나 leafCount 보다 작으면 cull: 오류', () => {
  bad(withOc({ nodeCount: 1.5 }));
  bad(withOc({ nodeCount: undefined }));
  bad(withOc({ nodeCount: L - 1 }));
});

test('leafIndex·boxMin·boxMax 가 nodeCount 에 비해 짧으면 cull: 오류', () => {
  const nc = good.octree.nodeCount;
  bad(withOc({ leafIndex: good.octree.leafIndex.slice(0, nc - 1) }));
  bad(withOc({ boxMin: good.octree.boxMin.slice(0, 3 * nc - 1) }));
  bad(withOc({ boxMax: good.octree.boxMax.slice(0, 3 * nc - 1) }));
});

test('leafIndex 범위 밖·중복·누락은 cull: 오류', () => {
  const k = leafNode();
  const li = (v) => { const a = Int32Array.from(good.octree.leafIndex); a[k] = v; return a; };
  bad(withOc({ leafIndex: li(L) }));
  bad(withOc({ leafIndex: li(-2) }));
  bad(withOc({ leafIndex: li(-1) })); // 리프 하나 사라짐
  const dup = Int32Array.from(good.octree.leafIndex);
  const other = Array.from(dup).findIndex((v, i) => v >= 0 && i !== k);
  dup[other] = dup[k];
  bad(withOc({ leafIndex: dup }));
});

test('리프 상자의 ±Infinity 는 cull: 오류', () => {
  const k = leafNode();
  const bmin = Float32Array.from(good.octree.boxMin); bmin[3 * k] = -Infinity;
  bad(withOc({ boxMin: bmin }));
  const bmax = Float32Array.from(good.octree.boxMax); bmax[3 * k + 2] = Infinity;
  bad(withOc({ boxMax: bmax }));
});

test('levels[0].positions·leafStart 가 어긋나면 cull: 오류', () => {
  const lv = good.levels[0];
  bad({ ...good, levels: [{ ...lv, positions: lv.positions.slice(0, lv.positions.length - 3) }] });
  bad({ ...good, levels: [{ ...lv, leafStart: lv.leafStart.slice(0, L) }] });
  bad({ ...good, levels: [{ ...lv, leafStart: undefined }] });
});

test('계층 읽기가 아닌 오류(거대 할당 RangeError)는 계층 읽기 오류로 오인하지 않는다', () => {
  const Real = globalThis.Float64Array;
  globalThis.Float64Array = new Proxy(Real, {
    construct(t, args, nt) {
      if (args[0] === L) throw new RangeError('Array buffer allocation failed'); // 리프별 wins/out 할당 모사
      return Reflect.construct(t, args, nt);
    },
  });
  try {
    assert.throws(() => leafPriority(good, CAM), (e) => e instanceof RangeError && !/계층/.test(e.message));
  } finally {
    globalThis.Float64Array = Real;
  }
  // coarseWins 안의 할당(Float32Array 깊이 버퍼)만 실패시킨다.
  const RealF = globalThis.Float32Array;
  globalThis.Float32Array = new Proxy(RealF, {
    construct(t, args, nt) {
      if (typeof args[0] === 'number' && args[0] > 1000) throw new RangeError('Array buffer allocation failed');
      return Reflect.construct(t, args, nt);
    },
  });
  try {
    assert.throws(() => leafPriority(good, CAM), (e) => e instanceof RangeError && !/계층 필드를 읽는 중/.test(e.message));
    assert.throws(() => orderChunks(good, CAM, mask), (e) => e instanceof RangeError && !/계층 필드를 읽는 중/.test(e.message));
  } finally {
    globalThis.Float32Array = RealF;
  }
});

test('정상 입력은 그대로 통과(점수·순서 결정적)', () => {
  const s = leafPriority(good, CAM);
  assert.equal(s.length, L);
  const o = orderChunks(good, CAM, mask);
  assert.equal(o.length, L);
  assert.deepEqual(Array.from(orderChunks(good, CAM, mask)), Array.from(o));
});
