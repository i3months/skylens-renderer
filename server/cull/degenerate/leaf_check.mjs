// 컬링 단계 공용 리프 검사(F-150). frustum·distance·predict·occlusion 이 같은 규칙을 쓴다.
// leafIndex 는 -1(내부 노드) 또는 [0, leafCount) 이고 리프 ↔ 노드가 일대일이어야 한다. 리프 노드의 boxMin/boxMax 에 ±Infinity 가 있으면 구조 오류다(NaN 은 단계별 기존 정책대로 통과).
// 모든 오류는 'cull:' 로 시작한다. scratch 를 주면(길이 ≥ leafCount, 0 으로 채워진 Uint8Array) 새로 할당하지 않고 쓴 뒤 호출자가 비운다.

/**
 * @param {{leafIndex:Int32Array, boxMin:Float32Array, boxMax:Float32Array, leafCount:number, nodeCount:number}} oc 길이·형 검사가 끝난 octree
 * @param {Uint8Array} [scratch] 0 으로 채워진 검사표(길이 ≥ leafCount). 끝나면 호출자가 fill(0) 한다.
 */
export function checkLeafIndexOneToOne(oc, scratch) {
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
      const lo = oc.boxMin[3 * n + a], hi = oc.boxMax[3 * n + a];
      if (lo === Infinity || lo === -Infinity || hi === Infinity || hi === -Infinity) {
        throw new Error(`cull: 리프 노드 ${n} 의 상자 좌표가 유한하지 않음`);
      }
    }
  }
  if (leaves !== oc.leafCount) {
    throw new Error(`cull: leafIndex 의 리프 수(${leaves})가 leafCount(${oc.leafCount}) 와 다름`);
  }
}
