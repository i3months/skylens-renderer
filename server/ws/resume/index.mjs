// 재접속·이어받기 세션 저장소(T11.7). 의존성 없음, 시계는 주입(now)만 쓴다.
//   createSessionStore({ maxSessions, ttlMs, now, randomId? }) -> SessionStore
//   open({sessionId, lastPieceSeq}) -> { sessionId, resumed, nextPieceSeq, reason }
//     sessionId 0 = 새 세션(reason null). 알 수 없거나 만료된 id 로 이어받기 요청 = 새 세션 + resumed=false,
//     reason 'UNKNOWN_SESSION'(서버가 ERR UNKNOWN_SESSION 을 낼지 선택). 이어받기 성공 reason null.
//     이어받기: lastPieceSeq 까지는 클라이언트가 받은 것으로 보고 ack 처리하고, 그 뒤에 보낸 조각은 "재전송 후보"가 된다
//     (shouldSend 가 한 번 true). 서버가 보낸 최대 순번보다 큰 lastPieceSeq 는 보낸 최대 순번으로 줄인다.
//   recordSent(sessionId, key, seq, bytes)  전송 기록. 같은 key 는 기록 후 shouldSend=false(재접속 후엔 후보일 때만 true).
//   shouldSend(sessionId, key) -> boolean   ack 된 조각, 이미 보낸 조각, 추월당한 조각(같은 구간·타일·lod·chunkIndex 에서
//     이미 더 높거나 같은 수준을 보냄)은 false. 모르는 세션은 false.
//   ack(sessionId, upToSeq)  upToSeq 이하 순번 확인 처리(되돌리지 않는다).
//   unacked(sessionId) -> [{seq,key}]       ack 되지 않은 조각, 순번 오름차순(재접속 직후엔 재전송 후보 전부).
//   close(sessionId)                         세션을 지운다(이어받기 불가).
// 세션 수 상한: 가득 차면 만료분을 먼저 비우고, 그래도 가득이면 가장 오래 쓰이지 않은 세션을 쫓아낸다.
// TTL: 마지막 활동(open·recordSent·ack) 이후 ttlMs 가 지나면 만료(경계 포함: 경과 >= ttlMs 면 만료).
import { randomInt } from 'node:crypto';

const U32_MAX = 0xffffffff;
const keyStr = (k) => `${k.segmentId}|${k.level}|${k.lod}|${k.chunkIndex}|${k.tileX}|${k.tileY}`;
const groupStr = (k) => `${k.segmentId}|${k.lod}|${k.chunkIndex}|${k.tileX}|${k.tileY}`;

function assertU32(v, name) {
  if (!Number.isInteger(v) || v < 0 || v > U32_MAX) throw new RangeError(`${name} 는 u32 정수여야 한다: ${v}`);
}
function assertKey(k) {
  if (k === null || typeof k !== 'object') throw new TypeError('key 는 객체여야 한다');
  for (const f of ['segmentId', 'level', 'lod', 'chunkIndex']) {
    if (!Number.isInteger(k[f]) || k[f] < 0) throw new RangeError(`key.${f} 범위 밖: ${k[f]}`);
  }
  for (const f of ['tileX', 'tileY']) if (!Number.isInteger(k[f])) throw new RangeError(`key.${f} 는 정수여야 한다`);
}

export function createSessionStore({ maxSessions, ttlMs, now, randomId } = {}) {
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new RangeError(`maxSessions 는 1 이상 정수: ${maxSessions}`);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError(`ttlMs 는 양수: ${ttlMs}`);
  if (typeof now !== 'function') throw new TypeError('now 시계 함수가 필요하다');
  const genId = randomId ?? (() => randomInt(1, U32_MAX));
  /** @type {Map<number, any>} 삽입 순서 = 최근 사용 순서(touch 때 다시 넣는다) */
  const sessions = new Map();

  const expired = (s, t) => t - s.last >= ttlMs;
  function sweep(t) {
    for (const [id, s] of sessions) if (expired(s, t)) sessions.delete(id);
  }
  function touch(id, s, t) {
    s.last = t;
    sessions.delete(id);
    sessions.set(id, s);
  }
  function live(id) {
    const s = sessions.get(id);
    if (!s) return null;
    if (expired(s, now())) { sessions.delete(id); return null; }
    return s;
  }
  function create(t) {
    sweep(t);
    while (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
    let id;
    do { id = genId(); } while (id === 0 || sessions.has(id));
    const s = { last: t, nextSeq: 1, ackedUpTo: 0, sent: new Map(), groupMax: new Map() };
    sessions.set(id, s);
    return id;
  }

  return {
    open(hello) {
      const { sessionId, lastPieceSeq = 0 } = hello ?? {};
      assertU32(sessionId, 'sessionId');
      assertU32(lastPieceSeq, 'lastPieceSeq');
      const t = now();
      if (sessionId === 0) {
        const id = create(t);
        return { sessionId: id, resumed: false, nextPieceSeq: 1, reason: null };
      }
      const s = live(sessionId);
      if (!s) {
        const id = create(t);
        return { sessionId: id, resumed: false, nextPieceSeq: 1, reason: 'UNKNOWN_SESSION' };
      }
      const upTo = Math.min(lastPieceSeq, s.nextSeq - 1);
      if (upTo > s.ackedUpTo) s.ackedUpTo = upTo;
      for (const e of s.sent.values()) e.pending = e.seq > s.ackedUpTo; // 못 받은 조각 = 재전송 후보
      touch(sessionId, s, t);
      return { sessionId, resumed: true, nextPieceSeq: s.nextSeq, reason: null };
    },
    recordSent(sessionId, key, seq, bytes) {
      assertKey(key);
      assertU32(seq, 'seq');
      const s = live(sessionId);
      if (!s) return false;
      s.sent.set(keyStr(key), { seq, key: { ...key }, bytes, pending: false });
      const g = groupStr(key);
      if ((s.groupMax.get(g) ?? -1) < key.level) s.groupMax.set(g, key.level);
      if (seq >= s.nextSeq) s.nextSeq = seq + 1;
      touch(sessionId, s, now());
      return true;
    },
    shouldSend(sessionId, key) {
      assertKey(key);
      const s = live(sessionId);
      if (!s) return false;
      const e = s.sent.get(keyStr(key));
      if (e) return e.pending && (s.groupMax.get(groupStr(key)) ?? -1) <= key.level;
      return (s.groupMax.get(groupStr(key)) ?? -1) < key.level;
    },
    ack(sessionId, upToSeq) {
      assertU32(upToSeq, 'upToSeq');
      const s = live(sessionId);
      if (!s) return;
      if (upToSeq > s.ackedUpTo) s.ackedUpTo = Math.min(upToSeq, s.nextSeq - 1);
      touch(sessionId, s, now());
    },
    unacked(sessionId) {
      const s = live(sessionId);
      if (!s) return [];
      const out = [];
      for (const e of s.sent.values()) if (e.seq > s.ackedUpTo) out.push({ seq: e.seq, key: { ...e.key } });
      return out.sort((a, b) => a.seq - b.seq);
    },
    close(sessionId) {
      sessions.delete(sessionId);
    },
    size() {
      sweep(now());
      return sessions.size;
    },
  };
}
