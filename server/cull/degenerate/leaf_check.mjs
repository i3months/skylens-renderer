// 컬링 단계 공용 리프 검사(F-150). frustum·distance·predict·occlusion·priority 가 같은 규칙을 쓴다.
// leafIndex 는 -1(내부 노드) 또는 [0, leafCount) 이고 리프 ↔ 노드가 일대일이어야 한다. 리프 노드의 boxMin/boxMax 에 ±Infinity 가 있으면 구조 오류다(NaN 은 단계별 기존 정책대로 통과).
// 모든 오류는 'cull:' 로 시작한다(할당 실패·RangeError 제외). scratch 를 주면(길이 ≥ leafCount, 0 으로 채운 수 배열(Uint8Array 또는 Float64Array)) 새로 할당하지 않고 쓴 뒤 호출자가 비운다.
//
// 검사 캐시(F-154): 같은 계층을 시점마다 다시 검사하면 O(nodeCount) 가 매 호출 더해지므로, 통과한 계층은 한 번만 검사한다.
// 입력은 호출 사이에 바뀌지 않는다고 가정한다(불변 입력 가정: 계층의 typed array 는 만든 뒤 읽기 전용).
// 캐시 키는 leafIndex 객체(WeakMap, 계층이 사라지면 항목도 사라진다)이고, 항목은 boxMin·boxMax 객체 동일성, leafCount, nodeCount,
// 그리고 값 표본(sentinel: leafIndex·boxMin·boxMax 에서 균등 간격으로 뽑은 최대 SENTINEL_SAMPLES 개 원소)을 함께 기억한다.
// 배열을 바꿔 끼우거나 길이·개수를 바꾸면 반드시 다시 검사한다. 같은 배열 안의 원소를 제자리에서 고치면 표본에 걸릴 때만 다시 검사한다
// (표본은 O(1) 비용의 싼 보호 장치이지 완전한 변조 탐지가 아니다). 제자리 수정이 있을 수 있는 호출자는 새 typed array 로 바꿔 넘겨야 한다.
// 실패한 검사는 캐시하지 않는다(항상 같은 오류를 다시 던진다).

const SENTINEL_SAMPLES = 32;

/** @type {WeakMap<Int32Array, {boxMin:ArrayLike<number>, boxMax:ArrayLike<number>, leafCount:number, nodeCount:number, sentinel:number[]}>} */
const verified = new WeakMap();

function sample(oc) {
  const out = [];
  const { leafIndex, boxMin, boxMax, nodeCount } = oc;
  const step = Math.max(1, Math.floor(nodeCount / SENTINEL_SAMPLES));
  for (let n = 0; n < nodeCount; n += step) {
    out.push(leafIndex[n], boxMin[3 * n], boxMin[3 * n + 1], boxMin[3 * n + 2], boxMax[3 * n], boxMax[3 * n + 1], boxMax[3 * n + 2]);
  }
  const last = nodeCount - 1;
  if (last >= 0) out.push(leafIndex[last], boxMin[3 * last], boxMax[3 * last]);
  return out;
}

function sameSample(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/**
 * @param {{leafIndex:Int32Array, boxMin:Float32Array, boxMax:Float32Array, leafCount:number, nodeCount:number}} oc 길이·형 검사가 끝난 octree
 * @param {Uint8Array|Float64Array} [scratch] 0 으로 채운 수 배열(길이 ≥ leafCount). 끝나면 호출자가 fill(0) 한다.
 * @returns {boolean} 전체 검사를 실제로 돌렸으면 true(scratch 를 썼으므로 비워야 함), 캐시 적중이면 false(scratch 는 그대로 0)
 */
export function checkLeafIndexOneToOne(oc, scratch) {
  const key = oc.leafIndex;
  const hit = verified.get(key);
  if (hit && hit.boxMin === oc.boxMin && hit.boxMax === oc.boxMax && hit.leafCount === oc.leafCount && hit.nodeCount === oc.nodeCount
    && sameSample(hit.sentinel, sample(oc))) return false;
  verifyOnce(oc, scratch);
  verified.set(key, { boxMin: oc.boxMin, boxMax: oc.boxMax, leafCount: oc.leafCount, nodeCount: oc.nodeCount, sentinel: sample(oc) });
  return true;
}

function verifyOnce(oc, scratch) {
  const seen = scratch ?? new Uint8Array(oc.leafCount);
  let leaves = 0;
  for (let n = 0; n < oc.nodeCount; n++) {
    const k = oc.leafIndex[n];
    if (k === -1) continue;
    // 비정수(1.5, NaN 등)는 seen[k] 쓰기가 무시되어 통과해 버리므로 정수 여부를 먼저 요구한다
    if (!Number.isInteger(k)) {
      throw new Error(`cull: leafIndex[${n}]=${k} 가 정수가 아님`);
    }
    if (!(k >= 0 && k < oc.leafCount) || seen[k]) {
      throw new Error(`cull: leafIndex[${n}]=${k} 가 범위를 벗어났거나 중복됨`);
    }
    seen[k] = 1;
    leaves++;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(oc.boxMin[3 * n + a]) === Infinity || Math.abs(oc.boxMax[3 * n + a]) === Infinity) {
        throw new Error(`cull: 리프 노드 ${n} 의 상자 좌표가 유한하지 않음`);
      }
    }
  }
  if (leaves !== oc.leafCount) {
    throw new Error(`cull: leafIndex 의 리프 수(${leaves})가 leafCount(${oc.leafCount}) 와 다름`);
  }
}
