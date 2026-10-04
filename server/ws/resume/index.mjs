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
//     예외(F-197): 이미 기록한 같은 key·같은 seq 재기록은 멱등이다(true). 어댑터(server/adapter/core)는 송출 중 실패하면
//     실패한 시도가 쓰던 pieceSeq·key 그대로 다시 내보내므로, emit 안에서 recordSent 를 불러도 재시도가 막히지 않는다.
//     미확인 항목이면 bytes 를 새 값으로 바꾸고(바이트 상한 검사 포함) 'shouldSend=false' 로 둔다. 이미 확인된 항목이면
//     아무것도 바꾸지 않는다. 같은 seq 를 다른 key 로 쓰거나, 그 key 의 기록 순번과 다른 낮은 seq 면 여전히 RangeError.
//     (축출된 항목은 대조할 정보가 없다. seq 가 ackedUpTo 이하이고 항목이 없으면 멱등 true(F-219 ③), 그 밖은 RangeError.)
//   u32 끝(F-203 ②): seq 0xFFFFFFFF 도 기록할 수 있다(계약 범위). 그 뒤 세션의 다음 순번 2^32 는 WELCOME.nextPieceSeq(u32)
//     로 보낼 수 없으므로 그 세션은 이어받을 수 없다: open 은 그 세션을 지우고 새 세션(resumed=false, reason
//     'UNKNOWN_SESSION', nextPieceSeq 1)을 돌려준다. open 이 돌려주는 nextPieceSeq 는 언제나 1..0xFFFFFFFF 이다.
//   recordSent(sessionId, key, seq, bytes) -> boolean  전송 기록. bytes 는 조각 바이트(ArrayBuffer 뷰) 또는 바이트 수(정수).
//     같은 key 는 기록 후 shouldSend=false(재접속 후엔 후보일 때만 true). 모르는 세션이거나 상한(아래)에 걸리면 false 이고
//     아무것도 바꾸지 않는다 — 호출자는 recordSent 가 true 인 조각만 보낸 것으로 친다.
//   shouldSend(sessionId, key) -> boolean   ack 된 조각, 이미 보낸 조각, 추월당한 조각은 false. 모르는 세션은 false.
//     추월 묶음은 계약 overtakeGroup(key) 하나로 정한다: 묶음 = (segmentId, tileX, tileY, lod), chunkIndex 는 묶음 기준이 아니다.
//     같은 묶음에서 이미 더 높은 수준을 보냈으면 낮은 수준의 어떤 chunk 도(chunkIndex 가 달라도) 추월당한 것이라 false.
//     같은 수준의 다른 chunk 는 같은 조각 집합의 나머지라 추월이 아니다(아직 안 보냈으면 true).
//   ack(sessionId, upToSeq)  upToSeq 이하 순번 확인 처리(되돌리지 않는다). 보낸 최대 순번보다 큰 값은 그 순번으로 줄인다.
//   unacked(sessionId) -> [{seq,key}]       ack 되지 않은 조각 중 재전송 후보, 순번 오름차순(F-199).
//     추월당한 조각(같은 overtakeGroup 에서 더 높은 수준을 이미 기록: groupMax > key.level)은 빼고 돌려준다 — 추월당한
//     수준은 다시 보내지 않는다. 같은 수준의 다른 chunk 는 추월이 아니라 남는다. stats().unacked 는 보관 계측용이라
//     추월당한 미확인 항목도 센다.
//   close(sessionId)                         세션을 지운다(이어받기 불가).
//   size() -> 살아 있는 세션 수. stats(sessionId) -> { entries, retainedBytes, unacked, groups } | null (계측용).
//     groups = groupMax 에 남은 묶음 수.
//   retainedBytes() -> 모든 세션이 보관 중인 조각 바이트 합(계측용).
// 보관 정책(F-192):
//   - ack(또는 이어받기 open)로 확인된 항목은 즉시 bytes 를 놓는다(보관 바이트 0). 항목 자체(key·seq)와 묶음별 최고 수준
//     (groupMax)은 남겨 추월·중복 판정이 그대로 유지된다. retainedBytes 는 ack 되지 않은 항목의 바이트만 센다.
//   - 상한은 언제나 유한하다(F-192): 옵션을 주지 않으면 DEFAULT_MAX_ENTRIES_PER_SESSION·DEFAULT_MAX_BYTES_PER_SESSION.
//     Infinity·0·비정수는 RangeError.
//   - maxEntriesPerSession(기본 DEFAULT_MAX_ENTRIES_PER_SESSION): 기록 뒤 항목 수가 상한을 넘으면 가장 오래 전에 ack 된 항목부터 지운다.
//     지워진 항목이 그 묶음 최고 수준보다 낮으면 groupMax 덕분에 여전히 shouldSend=false 다. 최고 수준과 같은 수준이면
//     '같은 수준의 아직 안 보낸 chunk' 와 구별할 정보가 없어 다시 true 가 된다(이미 받은 조각의 중복 전송 가능 — 상한은
//     세션 작업 집합보다 넉넉히 잡는다). ack 된 항목이 없어 상한 안으로 못 줄이면 recordSent 는 false.
//   - groupMax 축출: 묶음별 최고 수준은 그 묶음 항목이 sent 에 하나라도 남아 있는 동안만 둔다(묶음별 항목 수를 센다).
//     묶음의 마지막 항목이 축출되면 groupMax 도 지운다 — groupMax 크기 ≤ 항목 수 ≤ maxEntriesPerSession. 대가: 그 뒤엔
//     그 묶음의 낮은 수준도 다시 true 가 될 수 있다(위와 같은 이유로 상한은 작업 집합보다 넉넉히).
//   - maxBytesPerSession(기본 DEFAULT_MAX_BYTES_PER_SESSION): ack 되지 않은 항목 바이트 합이 상한을 넘게 되는 recordSent 는 false(ack 된 항목은
//     이미 0 B 라 축출로는 줄지 않는다). 호출자는 클라이언트 ACK 를 기다리거나 ERR OVER_LIMIT 로 끊는다.
//   - 비용: ack 는 새로 확인된 항목만 앞에서부터 꺼낸다(순번이 늘기만 하므로 큐 하나로 충분). unacked 는 미확인 항목만 훑는다.
// 세션 수 상한: 가득 차면 만료분을 먼저 비우고, 그래도 가득이면 가장 오래 쓰이지 않은 세션을 쫓아낸다.
// TTL: 마지막 활동(open·recordSent·ack) 이후 ttlMs 가 지나면 만료(경계 포함: 경과 >= ttlMs 면 만료).
//   세션 Map 은 최근 사용 순서라(시계가 되돌아가지 않으면) 만료분은 맨 앞에 몰려 있다. sweep 은 앞에서부터 지우다
//   만료되지 않은 첫 세션에서 멈춘다.
import { randomInt } from 'node:crypto';
import { overtakeGroup, pieceKeyString, PIECE_SEQ_MIN } from '../../../contracts/proto/index.mjs';

const U32_MAX = 0xffffffff;
/** 세션당 항목 수 기본 상한(F-192). */
export const DEFAULT_MAX_ENTRIES_PER_SESSION = 65536;
/** 세션당 미확인 조각 바이트 기본 상한(F-192). 초기 묶음 15 MB 를 넉넉히 담는 값. */
export const DEFAULT_MAX_BYTES_PER_SESSION = 64 * 1024 * 1024;

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
function optLimit(v, name, dflt) {
  if (v === undefined) return dflt;
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
  // keep(x) 가 참인 항목만 남기고 순서를 유지한 채 다시 채운다.
  compact(keep) { this.a = this.a.slice(this.h).filter(keep); this.h = 0; }
}

// 삽입 순서를 지키는 Map. 가장 오래된 항목 조회가 V8 Map 의 앞쪽 빈자리(keys().next() 가 매번 건너뛴다) 때문에 크기에 비례해
// 느려지지 않도록(F-213), 순서는 배열 + 머리 인덱스로 따로 두고 삭제는 표시만 한다(앞에서부터 걷으며 버린다).
class OrderedMap {
  constructor() {
    this.map = new Map(); // key -> 항목 {k, v, dead}
    this.q = [];          // 삽입 순서의 항목(죽은 것 포함)
    this.head = 0;        // q[head] 앞은 이미 버린 자리
    this.work = 0;        // 진단: oldest() 가 건너뛴 죽은 자리 + 압축이 훑은 자리의 누계(축출 1회당 O(1) 이어야 한다)
  }
  get size() { return this.map.size; }
  has(k) { return this.map.has(k); }
  get(k) { return this.map.get(k)?.v; }
  set(k, v) {
    const old = this.map.get(k);
    if (old) old.dead = true;
    const e = { k, v, dead: false };
    this.map.set(k, e);
    this.q.push(e);
    this.#maybeCompact();
    return this;
  }
  delete(k) {
    const e = this.map.get(k);
    if (!e) return false;
    e.dead = true;
    this.map.delete(k);
    this.#maybeCompact();
    return true;
  }
  /** 가장 오래된 살아 있는 항목 [k, v]. 없으면 undefined. 죽은 머리는 걷어낸다(상각 O(1)). */
  oldest() {
    const q = this.q;
    while (this.head < q.length && q[this.head].dead) { q[this.head++] = undefined; this.work++; }
    const e = q[this.head];
    return e ? [e.k, e.v] : undefined;
  }
  *values() { for (let i = this.head; i < this.q.length; i++) { const e = this.q[i]; if (e && !e.dead) yield e.v; } }
  *entries() { for (let i = this.head; i < this.q.length; i++) { const e = this.q[i]; if (e && !e.dead) yield [e.k, e.v]; } }
  #maybeCompact() {
    // 버린 머리와 가운데의 죽은 항목이 살아 있는 수의 2배(+32)를 넘으면 한 번에 다시 만든다(상각 O(1), 길이 <= 2×살아 있는 수 + 32 + a).
    if (this.q.length - this.head > 2 * this.map.size + 32 || this.head > 1024 + this.map.size) {
      this.work += this.q.length - this.head;
      this.q = this.q.slice(this.head).filter((e) => !e.dead);
      this.head = 0;
    }
  }
}

// ackedQ: 확인된 살아 있는 항목을 확인 순서로 담는 큐(F-213). 항목은 e.acked 로 소속을 표시하고 remove 는 표시만 바꾼다(해시 조회 없음).
// 가장 오래된 것은 머리 인덱스로 걷으며 죽은 자리를 버린다 — V8 Map 의 앞쪽 빈자리를 매번 건너뛰는 keys().next() 를 쓰지 않는다.
class AckedQueue {
  constructor(diag) { this.q = []; this.head = 0; this.size = 0; this.diag = diag; } // diag.ackedWork: 건너뛴 자리 + 압축이 훑은 자리의 진단 누계(모든 세션 합)
  push(e) {
    e.acked = true;
    this.q.push(e);
    this.size++;
  }
  remove(e) {
    if (!e.acked) return;
    e.acked = false;
    this.size--;
    // 버린 머리와 가운데의 죽은 자리가 살아 있는 수의 2배(+32)를 넘으면 한 번에 다시 만든다(상각 O(1)).
    if (this.q.length - this.head > 2 * this.size + 32 || this.head > 1024 + this.size) {
      this.diag.ackedWork += this.q.length - this.head;
      this.q = this.q.slice(this.head).filter((x) => x.acked);
      this.head = 0;
    }
  }
  /** 가장 오래전에 확인된 살아 있는 항목. 없으면 undefined. */
  oldest() {
    const q = this.q;
    while (this.head < q.length && !q[this.head].acked) { q[this.head++] = undefined; this.diag.ackedWork++; }
    return q[this.head];
  }
}

export function createSessionStore({ maxSessions, ttlMs, now, randomId, maxEntriesPerSession, maxBytesPerSession } = {}) {
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new RangeError(`maxSessions 는 1 이상 정수: ${maxSessions}`);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError(`ttlMs 는 양수: ${ttlMs}`);
  if (typeof now !== 'function') throw new TypeError('now 시계 함수가 필요하다');
  const maxEntries = optLimit(maxEntriesPerSession, 'maxEntriesPerSession', DEFAULT_MAX_ENTRIES_PER_SESSION);
  const maxBytes = optLimit(maxBytesPerSession, 'maxBytesPerSession', DEFAULT_MAX_BYTES_PER_SESSION);
  const genId = randomId ?? (() => randomInt(1, U32_MAX));
  /** @type {Map<number, any>} 삽입 순서 = 최근 사용 순서(touch 때 다시 넣는다) */
  const sessions = new OrderedMap();
  const evictionDiag = { sessionEvictions: 0, ackedEvictions: 0, ackedWork: 0 }; // 진단(테스트): 축출 횟수와 그 때 쓴 걸음 수

  const expired = (s, t) => t - s.last >= ttlMs;
  function sweep(t) {
    for (let o = sessions.oldest(); o && expired(o[1], t); o = sessions.oldest()) sessions.delete(o[0]); // 뒤쪽은 더 최근에 쓰인 세션
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
    while (sessions.size >= maxSessions) { sessions.delete(sessions.oldest()[0]); evictionDiag.sessionEvictions++; }
    let id;
    do { id = genId(); } while (id === 0 || sessions.has(id));
    // sent: keyStr -> 항목 {seq,key,bytes,size,pending,dead}. pendingQ: 미확인 항목(순번 순). ackedQ: 확인된 살아 있는 항목(확인 순, 머리 인덱스 큐; 대체·축출 때 바로 지워 dead 가 쌓이지 않는다).
    // groupRefs: 묶음 -> sent 에 남은 그 묶음 항목 수(0 이 되면 groupMax 도 지운다).
    const s = {
      last: t, nextSeq: PIECE_SEQ_MIN, ackedUpTo: 0, sent: new Map(), groupMax: new Map(), groupRefs: new Map(),
      pendingQ: new Queue(), ackedQ: new AckedQueue(evictionDiag), retained: 0, deadQ: 0,
    };
    sessions.set(id, s);
    return id;
  }
  // ackedUpTo 이하로 새로 확인된 항목의 바이트를 놓고 ackedQ 로 옮긴다.
  function release(s) {
    while (s.pendingQ.length > 0 && s.pendingQ.peek().seq <= s.ackedUpTo) {
      const e = s.pendingQ.shift();
      e.queued = false;
      if (e.dead) { s.deadQ--; continue; }
      s.retained -= e.size;
      e.bytes = null;
      e.size = 0;
      e.pending = false;
      s.ackedQ.push(e);
    }
  }
  // 항목 하나를 sent 에서 뺀다(같은 key 로 다시 기록돼 대체된 경우 포함). pendingQ 에는 dead 표시만 남기고(release 가 걷는다),
  // ackedQ 에서는 O(1) 로 바로 지운다.
  function drop(s, e) {
    e.dead = true;
    if (e.queued) {
      s.deadQ++;
      // 죽은 항목이 살아 있는 항목보다 많아지면 큐를 압축한다(큐 길이 <= 2 × 살아 있는 항목 <= 2 × maxEntries, 상각 O(1)).
      if (s.deadQ * 2 > s.pendingQ.length) {
        s.pendingQ.compact((x) => !x.dead);
        s.deadQ = 0;
        e.queued = false;
      }
    }
    s.ackedQ.remove(e);
    s.retained -= e.size;
    e.bytes = null;
    e.size = 0;
  }

  // 축출: 항목을 sent 에서 지우고, 그 묶음의 마지막 항목이었으면 groupMax 도 지운다.
  function evict(s, e) {
    drop(s, e);
    s.sent.delete(e.ks);
    const g = overtakeGroup(e.key);
    const n = s.groupRefs.get(g) - 1;
    if (n > 0) s.groupRefs.set(g, n);
    else { s.groupRefs.delete(g); s.groupMax.delete(g); }
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
      let s = live(sessionId);
      if (s && s.nextSeq > U32_MAX) { sessions.delete(sessionId); s = null; } // 순번 공간을 다 쓴 세션(F-203 ②)
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
      const ks = pieceKeyString(key);
      const old = s.sent.get(ks);
      if (seq < s.nextSeq) {
        // 같은 key·같은 seq 재기록 = 멱등(F-197). 그 밖의 역행은 RangeError.
        // 예외(F-219 ③): 이미 ack 된 순번(seq <= ackedUpTo)이고 그 key 항목이 없으면(어댑터 재시도 사이에 ack·축출로
        // 지워짐) 멱등 true 로 아무것도 바꾸지 않는다. 클라이언트가 이미 받았다고 확인한 순번이라 보관할 것이 없다.
        // 축출된 항목은 key 를 대조할 정보가 없으므로, 이 경로는 같은 seq 를 다른 key 로 쓰는 것을 잡지 못한다.
        if (!old && seq <= s.ackedUpTo) { touch(sessionId, s, now()); return true; }
        if (!old || old.seq !== seq) {
          throw new RangeError(`seq 는 이미 기록한 최대 순번(${s.nextSeq - 1})보다 커야 한다: ${seq}`);
        }
        if (seq > s.ackedUpTo) {
          if (s.retained - old.size + size > maxBytes) return false;
          s.retained += size - old.size;
          old.bytes = bytes ?? null;
          old.size = size;
          old.pending = false;
        }
        touch(sessionId, s, now());
        return true;
      }
      const oldSize = old ? old.size : 0;
      if (s.retained - oldSize + size > maxBytes) return false;
      // 항목 수 상한: 대체가 아니면 하나 늘어난다. 가장 오래 전에 ack 된 것부터 지운다(대체될 항목은 건드리지 않는다).
      if (!old && s.sent.size + 1 > maxEntries) {
        const need = s.sent.size + 1 - maxEntries;
        if (s.ackedQ.size < need) return false; // ackedQ 는 살아 있는 항목만 담으므로 O(1)
        for (let i = 0; i < need; i++) { evict(s, s.ackedQ.oldest()); evictionDiag.ackedEvictions++; }
      }
      const g = overtakeGroup(key);
      if (old) drop(s, old); // 같은 key 대체: 묶음 항목 수는 그대로
      else s.groupRefs.set(g, (s.groupRefs.get(g) ?? 0) + 1);
      const e = { seq, ks, key: { ...key }, bytes: bytes ?? null, size, pending: false, dead: false, queued: true, acked: false };
      s.sent.set(ks, e);
      s.pendingQ.push(e);
      s.retained += size;
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
      for (const e of s.pendingQ) {
        if (e.dead) continue;
        if ((s.groupMax.get(overtakeGroup(e.key)) ?? -1) > e.key.level) continue; // 추월당한 조각(F-199)
        out.push({ seq: e.seq, key: { ...e.key } });
      }
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
      return { entries: s.sent.size, retainedBytes: s.retained, unacked, groups: s.groupMax.size };
    },
    /** 진단용(테스트): 축출 횟수와 걸음 수(건너뛴 자리 + 압축이 훑은 자리). 두 work 모두 해당 큐 전체 누계(압축 포함)다. */
    evictionStats() {
      return { sessionEvictions: evictionDiag.sessionEvictions, sessionWork: sessions.work, ackedEvictions: evictionDiag.ackedEvictions, ackedWork: evictionDiag.ackedWork };
    },
    /** 진단용(테스트): 세션의 ackedQ 길이. 없는 세션은 -1. */
    ackedQueueLength(sessionId) {
      const s = live(sessionId);
      return s ? s.ackedQ.size : -1;
    },
    /** 진단용(테스트): 세션의 pendingQ 물리 길이(죽은 항목 포함). 없는 세션은 -1. */
    pendingQueueLength(sessionId) {
      const s = live(sessionId);
      return s ? s.pendingQ.length : -1;
    },
    retainedBytes() {
      let sum = 0;
      for (const s of sessions.values()) sum += s.retained;
      return sum;
    },
  };
}
