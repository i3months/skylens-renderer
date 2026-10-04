// 구간 도착 -> 조각 요청 계획(T13.1). 도착 이벤트 순서대로 PieceKey 를 쌓고 drain 이 PIECE_REQUEST 로 나눠 돌려준다.
// 같은 PieceKey 는 drain 된 뒤에도 다시 요청하지 않는다. 시계·타이머 없음. 입력 검사 위반은 TypeError/RangeError 이고
// 던질 때 상태는 바뀌지 않는다(검사를 모두 끝낸 뒤에 쌓는다).
import { MAX_REQUEST_ITEMS, CHUNK_INDEX_LIMIT, pieceKeyString } from '../../../contracts/proto/index.mjs';
import { SEGMENT_ID_LIMIT, LOD_MAX } from '../../../contracts/asset/index.mjs';

function checkInt(v, lo, hi, name) {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new TypeError(`${name} 는 정수여야 한다: ${String(v)}`);
  if (v < lo || v > hi) throw new RangeError(`${name} 범위 밖(${lo}..${hi}): ${v}`);
  return v;
}

function checkKey(k, where) {
  if (k === null || typeof k !== 'object') throw new TypeError(`${where} 는 객체여야 한다`);
  return {
    segmentId: checkInt(k.segmentId, 0, SEGMENT_ID_LIMIT - 1, `${where}.segmentId`),
    level: checkInt(k.level, 0, 3, `${where}.level`),
    lod: checkInt(k.lod, 0, LOD_MAX, `${where}.lod`),
    chunkIndex: checkInt(k.chunkIndex, 0, CHUNK_INDEX_LIMIT - 1, `${where}.chunkIndex`),
    tileX: checkInt(k.tileX, -0x80000000, 0x7fffffff, `${where}.tileX`),
    tileY: checkInt(k.tileY, -0x80000000, 0x7fffffff, `${where}.tileY`),
  };
}

/**
 * @param {{maxItems?: number}} [options]  한 요청의 항목 상한(1 이상 정수), 실제 상한은 min(maxItems, MAX_REQUEST_ITEMS)
 */
export function createArrivalPlanner(options = {}) {
  if (options === null || typeof options !== 'object') throw new TypeError('options 는 객체여야 한다');
  let limit = MAX_REQUEST_ITEMS;
  if (options.maxItems !== undefined) {
    checkInt(options.maxItems, 1, Number.MAX_SAFE_INTEGER, 'maxItems');
    limit = Math.min(options.maxItems, MAX_REQUEST_ITEMS);
  }
  const seen = new Set();
  let pending = [];
  let nextReqId = 0;

  return {
    onSegmentArrived(segmentId, keys) {
      checkInt(segmentId, 0, SEGMENT_ID_LIMIT - 1, 'segmentId');
      if (!Array.isArray(keys)) throw new TypeError('keys 는 배열이어야 한다');
      const fresh = [];
      const local = new Set();
      keys.forEach((k, i) => {
        const key = checkKey(k, `keys[${i}]`);
        const s = pieceKeyString(key);
        if (seen.has(s) || local.has(s)) return;
        local.add(s);
        fresh.push(key);
      });
      for (const s of local) seen.add(s);
      for (const key of fresh) pending.push(key);
    },
    drain() {
      const out = [];
      for (let i = 0; i < pending.length; i += limit) {
        out.push({ type: 'PIECE_REQUEST', reqId: nextReqId++, items: pending.slice(i, i + limit) });
      }
      pending = [];
      return out;
    },
    pendingCount() {
      return pending.length;
    },
  };
}
