import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLeafIndexOneToOne, SENTINEL_SAMPLES } from './leaf_check.mjs';

// F-162①: 제자리 수정은 감지를 보장하지 않는다.
// 계약(contracts/cull/index.mjs): 검증을 통과한 계층은 불변이며, 제자리 수정은 표본에 걸릴 때만 감지된다.
// 즉 '보장하지 않음'이 계약이다. 바꾸려면 새 typed array 로 바꿔 끼워야 한다.
// 이 시험은 그 '보장 안 함'이라는 현재 동작을 고정한다(표본 크기 SENTINEL_SAMPLES=32, step=floor(1001/32)=31).

// 노드 1001개: 0=내부, 1..1000=리프 0..999 (노드 > 표본 크기)
const NODES = 1001;
const make = () => {
  const leafIndex = new Int32Array(NODES);
  leafIndex[0] = -1;
  for (let n = 1; n < NODES; n++) leafIndex[n] = n - 1;
  return {
    leafIndex,
    boxMin: new Float32Array(3 * NODES),
    boxMax: new Float32Array(3 * NODES).fill(1),
    leafCount: NODES - 1,
    nodeCount: NODES,
  };
};

// 표본 단계(SENTINEL_SAMPLES에서 계산)로 구한 표본 밖 노드
const step = Math.floor(NODES / SENTINEL_SAMPLES);
const LEAF = Math.floor(step / 2);
const OTHER = LEAF + 1;

// LEAF와 OTHER가 표본 집합 밖인지 사전 단언
{
  const samples = new Set();
  for (let n = 0; n < NODES; n += step) {
    samples.add(n);
  }
  samples.add(NODES - 1); // 마지막 노드도 표본에 포함됨
  assert(!samples.has(LEAF), `LEAF=${LEAF}가 표본 집합에 포함됨`);
  assert(!samples.has(OTHER), `OTHER=${OTHER}가 표본 집합에 포함됨`);
}

test('cull: 표본 밖 리프의 제자리 수정(상자 Infinity, leafIndex 중복)은 재검사에서 감지되지 않는다 - update when detection improves(보장하지 않음이 계약)', () => {
  const oc = make();
  assert.equal(checkLeafIndexOneToOne(oc), true);

  oc.boxMin[3 * LEAF + 1] = Infinity;
  oc.leafIndex[LEAF] = oc.leafIndex[OTHER];

  // 현재 동작: 캐시 적중(false)으로 통과하고 throw 하지 않는다. 이를 고치려 들지 않는 것이 계약이다.
  assert.doesNotThrow(() => checkLeafIndexOneToOne(oc));
  assert.equal(checkLeafIndexOneToOne(oc), false);
});

test('cull: 같은 수정을 새 typed array 로 바꿔 끼우면 다시 검사해 cull: 오류가 난다(대조 사례)', () => {
  const infinityCase = make();
  checkLeafIndexOneToOne(infinityCase);
  const boxMin = infinityCase.boxMin.slice();
  boxMin[3 * LEAF + 1] = Infinity;
  assert.throws(() => checkLeafIndexOneToOne({ ...infinityCase, boxMin }), /^Error: cull:/);

  const dupCase = make();
  checkLeafIndexOneToOne(dupCase);
  const leafIndex = dupCase.leafIndex.slice();
  leafIndex[LEAF] = leafIndex[OTHER];
  assert.throws(() => checkLeafIndexOneToOne({ ...dupCase, leafIndex }), /^Error: cull:/);
});
