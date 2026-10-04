// 재접속·이어받기 세션 저장소(T11.7). 의존성은 계약(contracts/proto)뿐, 시계는 주입(now)만 쓴다.
//   createSessionStore({ maxSessions, ttlMs, now, randomId?, maxEntriesPerSession?, maxBytesPerSession? }) -> SessionStore
//   open({sessionId, lastPieceSeq}) -> { sessionId, resumed, nextPieceSeq, reason }
//     sessionId 0 = 새 세션(reason null). 알 수 없거나 만료된 id 로 이어받기 요청 = 새 세션 + resumed=false,
//     reason 'UNKNOWN_SESSION'(서버가 ERR UNKNOWN_SESSION 을 낼지 선택). 이어받기 성공 reason null.
//     이어받기: lastPieceSeq 까지는 클라이언트가 받은 것으로 보고 ack 처리하고, 그 뒤에 보낸 조각은 "재전송 후보"가 된다
//     (shouldSend 가 한 번 true). 서버가 보낸 최대 순번보다 큰 lastPieceSeq 는 보낸 최대 순번으로 줄인다.
//   순번 규약(contracts/proto PIECE_SEQ_MIN, F-184): pieceSeq 는 1 부터. ackedUpTo·lastPieceSeq 0 = '받은 것 없음'.
//     새 세션 nextPieceSeq 는 PIECE_SEQ_MIN(1). recordSent 의 seq 는 PIECE_SEQ_MIN 이상이고, 이 세션에서 이미 기록한
//     최대 순번보다 커야 한다(순번은 늘기만 한다). 어기면 RangeError.
//   recordSent(sessionId, key, seq, bytes) -> boolean  전송 기록. bytes 는 조각 바이트(ArrayBuffer 뷰) 또는 바이트 수(정수).
//     같은 key 는 기록 후 shouldSend=false(재접속 후엔 후보일 때만 true). 모르는 세션이거나 상한(아래)에 걸리면 false 이고
//     아무것도 바꾸지 않는다 — 호출자는 recordSent 가 true 인 조각만 보낸 것으로 친다.
//   shouldSend(sessionId, key) -> boolean   ack 된 조각, 이미 보낸 조각, 추월당한 조각은 false. 모르는 세션은 false.
//     추월 묶음은 계약 overtakeGroup(key) 하나로 정한다: 묶음 = (segmentId, tileX, tileY, lod), chunkIndex 는 묶음 기준이 아니다.
//     같은 묶음에서 이미 더 높은 수준을 보냈으면 낮은 수준의 어떤 chunk 도(chunkIndex 가 달라도) 추월당한 것이라 false.
//     같은 수준의 다른 chunk 는 같은 조각 집합의 나머지라 추월이 아니다(아직 안 보냈으면 true).
//   ack(sessionId, upToSeq)  upToSeq 이하 순번 확인 처리(되돌리지 않는다). 보낸 최대 순번보다 큰 값은 그 순번으로 줄인다.
//   unacked(sessionId) -> [{seq,key}]       ack 되지 않은 조각, 순번 오름차순(재접속 직후엔 재전송 후보 전부).
//   close(sessionId)                         세션을 지운다(이어받기 불가).
//   size() -> 살아 있는 세션 수. stats(sessionId) -> { entries, retainedBytes, unacked } | null (계측용).
//   retainedBytes() -> 모든 세션이 보관 중인 조각 바이트 합(계측용).
// 보관 정책(F-192):
//   - ack(또는 이어받기 open)로 확인된 항목은 즉시 bytes 를 놓는다(보관 바이트 0). 항목 자체(key·seq)와 묶음별 최고 수준
//     (groupMax)은 남겨 추월·중복 판정이 그대로 유지된다. retainedBytes 는 ack 되지 않은 항목의 바이트만 센다.
//   - maxEntriesPerSession(기본 무제한): 기록 뒤 항목 수가 상한을 넘으면 가장 오래 전에 ack 된 항목부터 지운다.
//     지워진 항목이 그 묶음 최고 수준보다 낮으면 groupMax 덕분에 여전히 shouldSend=false 다. 최고 수준과 같은 수준이면
//     '같은 수준의 아직 안 보낸 chunk' 와 구별할 정보가 없어 다시 true 가 된다(이미 받은 조각의 중복 전송 가능 — 상한은
//     세션 작업 집합보다 넉넉히 잡는다). ack 된 항목이 없어 상한 안으로 못 줄이면 recordSent 는 false.
//   - maxBytesPerSession(기본 무제한): ack 되지 않은 항목 바이트 합이 상한을 넘게 되는 recordSent 는 false(ack 된 항목은
//     이미 0 B 라 축출로는 줄지 않는다). 호출자는 클라이언트 ACK 를 기다리거나 ERR OVER_LIMIT 로 끊는다.
//   - 비용: ack 는 새로 확인된 항목만 앞에서부터 꺼낸다(순번이 늘기만 하므로 큐 하나로 충분). unacked 는 미확인 항목만 훑는다.
// 세션 수 상한: 가득 차면 만료분을 먼저 비우고, 그래도 가득이면 가장 오래 쓰이지 않은 세션을 쫓아낸다.
// TTL: 마지막 활동(open·recordSent·ack) 이후 ttlMs 가 지나면 만료(경계 포함: 경과 >= ttlMs 면 만료).
//   세션 Map 은 최근 사용 순서라(시계가 되돌아가지 않으면) 만료분은 맨 앞에 몰려 있다. sweep 은 앞에서부터 지우다
//   만료되지 않은 첫 세션에서 멈춘다.
import { randomInt } from 'node:crypto';
import { overtakeGroup, pieceKeyString, PIECE_SEQ_MIN } from '../../../contracts/proto/index.mjs';

const U32_MAX = 0xffffffff;

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
function byteSize(bytes) {
  if (bytes === undefined) return 0;
  if (Number.isInteger(bytes) && bytes >= 0) return bytes;
  if (ArrayBuffer.isView(bytes)) return bytes.byteLength;
  throw new TypeError('bytes 는 ArrayBuffer 뷰 또는 0 이상 정수여야 한다');
}
function optLimit(v, name) {
  if (v === undefined || v === Infinity) return Infinity;
  if (!Number.isInteger(v) || v < 1) throw new RangeError(`${name} 는 1 이상 정수: ${v}`);
  return v;
}

// 앞에서 꺼내는 큐(배열 + 머리 위치). 머리가 절반을 넘으면 앞을 잘라 메모리를 돌려준다.
class Queue {
  constructor() { this.a = []; this.h = 0; }
  get length() { return this.a.length - this.h; }
  push(x) { this.a.push(x); }
  peek() { return this.a[this.h]; }
  shift() {
    const x = this.a[this.h];
    this.a[this.h++] = undefined;
    if (this.h > 1024 && this.h * 2 > this.a.length) { this.a = this.a.slice(this.h); this.h = 0; }
    return x;
  }
  *[Symbol.iterator]() { for (let i = this.h; i < this.a.length; i++) yield this.a[i]; }
}

export function createSessionStore({ maxSessions, ttlMs, now, randomId, maxEntriesPerSession, maxBytesPerSession } = {}) {
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new RangeError(`maxSessions 는 1 이상 정수: ${maxSessions}`);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError(`ttlMs 는 양수: ${ttlMs}`);
  if (typeof now !== 'function') throw new TypeError('now 시계 함수가 필요하다');
  const maxEntries = optLimit(maxEntriesPerSession, 'maxEntriesPerSession');
  const maxBytes = optLimit(maxBytesPerSession, 'maxBytesPerSession');
  const genId = randomId ?? (() => randomInt(1, U32_MAX));
  /** @type {Map<number, any>} 삽입 순서 = 최근 사용 순서(touch 때 다시 넣는다) */
  const sessions = new Map();

  const expired = (s, t) => t - s.last >= ttlMs;
  function sweep(t) {
    for (const [id, s] of sessions) {
      if (!expired(s, t)) break; // 뒤쪽은 더 최근에 쓰인 세션
      sessions.delete(id);
    }
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
    // sent: keyStr -> 항목 {seq,key,bytes,size,pending,dead}. pendingQ: 미확인 항목(순번 순). ackedQ: 확인된 항목(확인 순).
    const s = {
      last: t, nextSeq: PIECE_SEQ_MIN, ackedUpTo: 0, sent: new Map(), groupMax: new Map(),
      pendingQ: new Queue(), ackedQ: new Queue(), retained: 0,
    };
    sessions.set(id, s);
    return id;
  }
  // ackedUpTo 이하로 새로 확인된 항목의 바이트를 놓고 ackedQ 로 옮긴다.
  function release(s) {
    while (s.pendingQ.length > 0 && s.pendingQ.peek().seq <= s.ackedUpTo) {
      const e = s.pendingQ.shift();
      if (e.dead) continue;
      s.retained -= e.size;
      e.bytes = null;
      e.size = 0;
      e.pending = false;
      s.ackedQ.push(e);
    }
  }
  // 항목 하나를 sent 에서 뺀다(같은 key 로 다시 기록돼 대체된 경우 포함). 큐에는 dead 표시만 남긴다.
  function drop(s, e) {
    e.dead = true;
    s.retained -= e.size;
    e.bytes = null;
    e.size = 0;
  }

  return {
    open(hello) {
      const { sessionId, lastPieceSeq = 0 } = hello ?? {};
      assertU32(sessionId, 'sessionId');
      assertU32(lastPieceSeq, 'lastPieceSeq');
      const t = now();
      if (sessionId === 0) {
        const id = create(t);
        return { sessionId: id, resumed: false, nextPieceSeq: PIECE_SEQ_MIN, reason: null };
      }
      const s = live(sessionId);
      if (!s) {
        const id = create(t);
        return { sessionId: id, resumed: false, nextPieceSeq: PIECE_SEQ_MIN, reason: 'UNKNOWN_SESSION' };
      }
      const upTo = Math.min(lastPieceSeq, s.nextSeq - 1);
      if (upTo > s.ackedUpTo) s.ackedUpTo = upTo;
      release(s);
      for (const e of s.pendingQ) if (!e.dead) e.pending = true; // 못 받은 조각 = 재전송 후보
      touch(sessionId, s, t);
      return { sessionId, resumed: true, nextPieceSeq: s.nextSeq, reason: null };
    },
    recordSent(sessionId, key, seq, bytes) {
      assertKey(key);
      assertU32(seq, 'seq');
      if (seq < PIECE_SEQ_MIN) throw new RangeError(`seq 는 ${PIECE_SEQ_MIN} 이상이어야 한다(0 = 받은 것 없음): ${seq}`);
      const size = byteSize(bytes);
      const s = live(sessionId);
      if (!s) return false;
      if (seq < s.nextSeq) throw new RangeError(`seq 는 이미 기록한 최대 순번(${s.nextSeq - 1})보다 커야 한다: ${seq}`);
      const ks = pieceKeyString(key);
      const old = s.sent.get(ks);
      const oldSize = old ? old.size : 0;
      if (s.retained - oldSize + size > maxBytes) return false;
      // 항목 수 상한: 대체가 아니면 하나 늘어난다. 가장 오래 전에 ack 된 것부터 지운다(대체될 항목은 건드리지 않는다).
      if (!old && s.sent.size + 1 > maxEntries) {
        let evictable = 0;
        for (const e of s.ackedQ) if (!e.dead) { evictable++; if (s.sent.size + 1 - evictable <= maxEntries) break; }
        if (s.sent.size + 1 - evictable > maxEntries) return false;
        while (s.sent.size + 1 > maxEntries) {
          const e = s.ackedQ.shift();
          if (e.dead) continue;
          drop(s, e);
          s.sent.delete(pieceKeyString(e.key));
        }
      }
      if (old) drop(s, old);
      const e = { seq, key: { ...key }, bytes: bytes ?? null, size, pending: false, dead: false };
      s.sent.set(ks, e);
      s.pendingQ.push(e);
      s.retained += size;
      const g = overtakeGroup(key);
      if ((s.groupMax.get(g) ?? -1) < key.level) s.groupMax.set(g, key.level);
      s.nextSeq = seq + 1;
      touch(sessionId, s, now());
      return true;
    },
    shouldSend(sessionId, key) {
      assertKey(key);
      const s = live(sessionId);
      if (!s) return false;
      const top = s.groupMax.get(overtakeGroup(key)) ?? -1;
      const e = s.sent.get(pieceKeyString(key));
      if (e) return e.pending && top <= key.level;
      return top <= key.level;
    },
    ack(sessionId, upToSeq) {
      assertU32(upToSeq, 'upToSeq');
      const s = live(sessionId);
      if (!s) return;
      const upTo = Math.min(upToSeq, s.nextSeq - 1); // 보낸 적 없는 순번은 확인할 수 없다
      if (upTo > s.ackedUpTo) s.ackedUpTo = upTo;
      release(s);
      touch(sessionId, s, now());
    },
    unacked(sessionId) {
      const s = live(sessionId);
      if (!s) return [];
      const out = [];
      for (const e of s.pendingQ) if (!e.dead) out.push({ seq: e.seq, key: { ...e.key } });
      return out; // pendingQ 는 순번 오름차순
    },
    close(sessionId) {
      sessions.delete(sessionId);
    },
    size() {
      sweep(now());
      return sessions.size;
    },
    stats(sessionId) {
      const s = live(sessionId);
      if (!s) return null;
      let unacked = 0;
      for (const e of s.pendingQ) if (!e.dead) unacked++;
      return { entries: s.sent.size, retainedBytes: s.retained, unacked };
    },
    retainedBytes() {
      let sum = 0;
      for (const s of sessions.values()) sum += s.retained;
      return sum;
    },
  };
}
