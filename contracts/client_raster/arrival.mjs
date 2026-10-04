// 수준 도착의 완료 key 집합(F-230). 계약: ./index.mjs ④, contracts/proto(PIECE·LEVEL_ARRIVED·재전송 규약)
//
// 선의 LEVEL_ARRIVED 는 {segmentId, level, pieceCount} 뿐이고 key 가 없다. selectDrawable 의 arrived 항목
// {segmentId, level, keys} 는 받은 PIECE 열과 LEVEL_ARRIVED 로 여기서 만든다. 순수 함수이고 상태를 두지 않는다.
//
// 규칙(받은 순서대로 본 PIECE 들과 그 뒤에 온 LEVEL_ARRIVED 하나, 연결이 바뀌어도 한 세션의 수신 이력 전체):
//   ⓪ 세션(F-234): 입력은 한 세션의 수신 이력이다. 새 세션은 pieceSeq 를 1 부터 다시 쓰므로(server/ws/resume) 앞 세션의
//      순번과 섞으면 창이 엉뚱한 조각을 가리킨다. 그래서 collectArrivals 는 WELCOME resumed=false 를 PIECE 를 하나라도 받은
//      뒤에 만나면 ClientRasterError('piece') 로 거부한다(첫 PIECE 앞의 WELCOME 은 통과). 새 세션의 수신은 새 입력으로
//      넣고, 앞 세션에서 받은 key 는 ./index.mjs ④ 정리 규칙(재개 재시작 = 시도 끝)대로 호출자가 해제한다.
//      WELCOME resumed=true 는 같은 세션의 이어받기라 이력을 그대로 잇는다(앞서 본 WELCOME 과 sessionId 가 다르면 거부).
//   ① 중복: 같은 pieceSeq·같은 PieceKey 의 PIECE 는 한 조각이다(proto 재전송 규약). 같은 pieceSeq 에 다른 PieceKey 가
//      오면 계약 위반(F-204)이라 거부한다. 같은 key 가 다른 pieceSeq 로 다시 오는 것은 허용한다(새 어댑터의 재송출 등).
//      단조(F-234): 재전송이 아닌(처음 보는) pieceSeq 는 그때까지 받은 가장 큰 pieceSeq 보다 커야 한다. 아니면
//      ClientRasterError('piece')(completedKeys 도 같다). 서버는 한 세션에서 순번을 늘리기만 하고(server/ws/resume
//      recordSent) 선은 순서를 지키므로, 작은 새 순번은 다른 세션의 조각이거나 계약 위반이다.
//   ② 창: s = 그 LEVEL_ARRIVED 전까지 받은 가장 큰 pieceSeq, n = pieceCount. 완료 key 집합은 pieceSeq s−n+1..s 의 조각
//      n 개의 key 다(pieceSeq 순). 그 n 개는 모두 받았어야 하고, 모두 LEVEL_ARRIVED 의 (segmentId, level) 이어야 하며,
//      key 가 서로 달라야 한다. 어기면 ClientRasterError('piece')(조각 모자람·다른 수준 섞임·key 중복).
//   근거(server/adapter/core 의 출력): 어댑터는 한 수준 도착을 PIECE pieceSeq f..f+n−1 → LEVEL_ARRIVED(n) 순서로 연달아
//   내보내고, 끝나지 않은 이벤트가 있는 동안 다른 이벤트를 내보내지 않는다(F-204). 그래서 LEVEL_ARRIVED 직전의 가장 큰
//   pieceSeq 는 언제나 f+n−1 이고, 그 창 안에는 그 수준의 조각만 있다.
//     - 송출 실패 뒤 같은 이벤트 재시도: 같은 pieceSeq·key 로 처음부터 다시 나간다 → ① 로 하나로 센다. 실패가 LEVEL_ARRIVED
//       를 쓴 뒤였으면 LEVEL_ARRIVED 가 두 번 오고 두 번 다 같은 창이다.
//     - 재시도가 skip(F-219 ②·F-223 ①·F-235): 받는 쪽은 선만 본다. LEVEL_ARRIVED 가 쓰였으면 완료로 센다 — 실패한
//       시도가 PIECE 전부와 LEVEL_ARRIVED 를 쓴 뒤 던졌다면 그 창은 완료 집합이고 그 수준이 가장 높으면 그린다.
//       LEVEL_ARRIVED 가 쓰이지 않았으면(조각 일부만 나감) 그 pieceSeq 는 태워져 뒤 이벤트는 더 큰 pieceSeq 를 쓰므로 창에
//       들지 않는다. 그 key 는 어느 완료 집합에도 없고 selectDrawable 이 pending(그 구간에 도착 수준이 없거나 더 높은
//       수준) 또는 discard(같거나 낮은 수준)로 둔다. 서버 어댑터의 해제 알림(onRelease·결과의 abandoned)은 서버 안의
//       콜백이고 선에 실리지 않으므로 이 규칙의 근거가 아니다.
//     - 어댑터 교체(F-219 ④): 새 어댑터의 첫 pieceSeq 는 옛 어댑터가 쓸 수 있던 순번보다 크다. 옛 시도가 남긴 같은
//       수준 조각은 새 LEVEL_ARRIVED 의 창 밖이라 완료가 아니다(같은 수준 abandoned → discard).
//     - 이어받기(HELLO lastPieceSeq): 연결 전후의 수신을 이어서 넣는다. 다시 보내는 쪽은 각 LEVEL_ARRIVED 를 자기 조각
//       뒤, 더 큰 pieceSeq 의 PIECE 앞에 두어야 한다(어댑터 송출 순서 그대로). 어긴 순서는 ② 에서 거부된다.
// key 문자열은 format/ASSET_FORMAT §11 정규형(server/asset/ids encodeChunkKey 와 같은 문자열)이다.
import { ClientRasterError, SEGMENT_ID_LIMIT, parsePieceKey } from './index.mjs';

const U32_MAX = 0xffffffff;
const LEVEL_MAX = 3;

function isObject(v) {
  return v !== null && typeof v === 'object';
}

/**
 * PieceKey 객체({segmentId, level, lod, chunkIndex, tileX, tileY})를 §11 정규 문자열로 바꾼다
 * (server/asset/ids encodeChunkKey 와 같은 문자열). 범위 밖이면 ClientRasterError('piece').
 * @param {import('../proto/index.mjs').PieceKey} key
 * @returns {string}
 */
export function pieceKeyToString(key) {
  if (!isObject(key)) throw new ClientRasterError('piece', 'PieceKey 가 객체가 아님');
  const { segmentId, level, tileX, tileY, lod, chunkIndex } = key;
  for (const [n, v] of [['segmentId', segmentId], ['level', level], ['tileX', tileX], ['tileY', tileY], ['lod', lod], ['chunkIndex', chunkIndex]]) {
    if (!Number.isInteger(v)) throw new ClientRasterError('piece', `PieceKey.${n} 는 정수여야 함: ${String(v)}`);
  }
  // -0 은 템플릿 문자열에서 '0' 이 된다(encodeChunkKey 와 같음). 모양·범위는 parsePieceKey 가 본다.
  const s = `${segmentId}.${level}.${tileX}.${tileY}.${lod}.${chunkIndex}`;
  parsePieceKey(s);
  return s;
}

/** 받은 PIECE 들의 색인. pieceSeq -> {key, segmentId, level}, 그리고 가장 큰 pieceSeq. */
function createIndex() {
  return { bySeq: new Map(), maxSeq: 0 };
}

function addPiece(index, m) {
  if (!isObject(m) || m.type !== 'PIECE') throw new ClientRasterError('piece', `PIECE 메시지가 아님: ${isObject(m) ? String(m.type) : String(m)}`);
  const seq = m.pieceSeq;
  if (!Number.isInteger(seq) || seq < 1 || seq > U32_MAX) throw new ClientRasterError('piece', `pieceSeq 범위 밖: ${String(seq)}`);
  const key = pieceKeyToString(m.key);
  const prev = index.bySeq.get(seq);
  if (prev !== undefined) {
    if (prev.key !== key) throw new ClientRasterError('piece', `pieceSeq ${seq} 가 두 key 에 쓰임: ${prev.key}, ${key}`);
    return key; // 재전송: 한 조각으로 센다
  }
  // 규칙 ① 단조: 처음 보는 pieceSeq 는 지금까지의 가장 큰 pieceSeq 보다 커야 한다(F-234).
  if (seq <= index.maxSeq) {
    throw new ClientRasterError('piece', `pieceSeq ${seq} 가 재전송이 아닌데 받은 가장 큰 pieceSeq ${index.maxSeq} 이하(순번은 늘기만 한다)`);
  }
  index.bySeq.set(seq, { key, segmentId: m.key.segmentId, level: m.key.level });
  index.maxSeq = seq;
  return key;
}

function checkLevelArrived(a) {
  if (!isObject(a) || (a.type !== undefined && a.type !== 'LEVEL_ARRIVED')) throw new ClientRasterError('piece', 'LEVEL_ARRIVED 메시지가 아님');
  const { segmentId, level, pieceCount } = a;
  // -0 은 selectDrawable 과 같이 거부한다(F-237 ①). 받아 두면 {segmentId: -0} 항목이 나가 selectDrawable 이 던진다.
  if (!Number.isInteger(segmentId) || Object.is(segmentId, -0) || segmentId < 0 || segmentId >= SEGMENT_ID_LIMIT) {
    throw new ClientRasterError('piece', `LEVEL_ARRIVED segmentId 가 범위 밖(< ${SEGMENT_ID_LIMIT}): ${String(segmentId)}`);
  }
  if (!Number.isInteger(level) || level < 0 || level > LEVEL_MAX) throw new ClientRasterError('piece', `LEVEL_ARRIVED level 범위 밖: ${String(level)}`);
  if (!Number.isInteger(pieceCount) || pieceCount < 1 || pieceCount > U32_MAX) {
    throw new ClientRasterError('piece', `LEVEL_ARRIVED pieceCount 는 1 이상 u32 여야 함: ${String(pieceCount)}`);
  }
}

/** 규칙 ②: 색인에서 창 maxSeq−n+1..maxSeq 의 key 들을 꺼낸다. */
function windowKeys(index, a) {
  checkLevelArrived(a);
  const { segmentId, level, pieceCount } = a;
  const last = index.maxSeq;
  const first = last - pieceCount + 1;
  if (pieceCount > index.bySeq.size || first < 1) {
    throw new ClientRasterError('piece', `LEVEL_ARRIVED(${segmentId}, ${level}) pieceCount ${pieceCount} 만큼 조각을 받지 못함(받은 조각 ${index.bySeq.size})`);
  }
  const keys = [];
  const seen = new Set();
  for (let s = first; s <= last; s += 1) {
    const p = index.bySeq.get(s);
    if (p === undefined) throw new ClientRasterError('piece', `LEVEL_ARRIVED(${segmentId}, ${level}) 의 pieceSeq ${s} 조각을 받지 못함(창 ${first}..${last})`);
    if (p.segmentId !== segmentId || p.level !== level) {
      throw new ClientRasterError('piece', `LEVEL_ARRIVED(${segmentId}, ${level}) 의 창 ${first}..${last} 에 다른 구간·수준 조각이 섞임: pieceSeq ${s} ${p.key}`);
    }
    if (seen.has(p.key)) throw new ClientRasterError('piece', `LEVEL_ARRIVED(${segmentId}, ${level}) 의 창에 같은 key 가 두 번: ${p.key}`);
    seen.add(p.key);
    keys.push(p.key);
  }
  return keys;
}

/**
 * LEVEL_ARRIVED 하나의 완료 key 집합(헤더 규칙 ①②). 순수 함수.
 * @param {{type?: 'PIECE', pieceSeq: number, key: import('../proto/index.mjs').PieceKey}[]} pieces
 *   그 LEVEL_ARRIVED 전까지 받은 PIECE 전부(받은 순서, 재전송 포함. chunk 는 보지 않는다)
 * @param {{type?: 'LEVEL_ARRIVED', segmentId: number, level: number, pieceCount: number}} levelArrived
 * @returns {string[]} 완료 key(§11 정규 문자열, pieceSeq 순)
 */
export function completedKeys(pieces, levelArrived) {
  if (!Array.isArray(pieces)) throw new ClientRasterError('piece', 'pieces 는 배열이어야 함');
  const index = createIndex();
  for (const m of pieces) addPiece(index, isObject(m) && m.type === undefined ? { ...m, type: 'PIECE' } : m);
  return windowKeys(index, levelArrived);
}

/**
 * 받은 메시지 열(복호 결과, 받은 순서)을 selectDrawable 입력으로 바꾼다. 순수 함수.
 * 입력은 한 세션의 수신 이력이다(헤더 규칙 ⓪). PIECE 는 색인에 넣고, LEVEL_ARRIVED 마다 그때까지의 색인으로
 * completedKeys 와 같은 규칙의 항목을 만든다. WELCOME 은 세션 경계만 본다: resumed=false 가 PIECE 뒤에 오면, 또는
 * resumed=true 의 sessionId 가 앞 WELCOME 과 다르면 ClientRasterError('piece'). 그 밖의 종류(MISSING·ERROR)는 이 규칙과
 * 무관해 건너뛴다. type 이 문자열이 아니면 ClientRasterError('piece').
 * @param {object[]} messages
 * @returns {{keys: string[], arrived: {segmentId: number, level: number, keys: string[]}[]}}
 *   keys: 받은 조각 key(중복 없이 처음 받은 순서), arrived: LEVEL_ARRIVED 순서의 항목
 */
export function collectArrivals(messages) {
  if (!Array.isArray(messages)) throw new ClientRasterError('piece', 'messages 는 배열이어야 함');
  const index = createIndex();
  const keys = [];
  const known = new Set();
  const arrived = [];
  let sessionId; // 앞서 본 WELCOME 의 sessionId(없으면 undefined)
  for (const m of messages) {
    if (!isObject(m) || typeof m.type !== 'string') throw new ClientRasterError('piece', '메시지 type 이 없음');
    if (m.type === 'WELCOME') {
      if (typeof m.resumed !== 'boolean') throw new ClientRasterError('piece', `WELCOME resumed 는 boolean 이어야 함: ${String(m.resumed)}`);
      if (!m.resumed && index.bySeq.size > 0) {
        throw new ClientRasterError('piece', 'WELCOME resumed=false(새 세션)가 PIECE 뒤에 옴: 새 세션의 수신은 새 입력으로 넣는다(F-234)');
      }
      if (m.resumed && sessionId !== undefined && m.sessionId !== sessionId) {
        throw new ClientRasterError('piece', `WELCOME resumed=true 의 sessionId ${String(m.sessionId)} 가 앞 세션 ${sessionId} 와 다름`);
      }
      sessionId = m.sessionId;
    } else if (m.type === 'PIECE') {
      const k = addPiece(index, m);
      if (!known.has(k)) { known.add(k); keys.push(k); }
    } else if (m.type === 'LEVEL_ARRIVED') {
      arrived.push({ segmentId: m.segmentId, level: m.level, keys: windowKeys(index, m) });
    }
  }
  return { keys, arrived };
}
