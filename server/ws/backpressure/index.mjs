// 역압(느린 클라이언트) 처리(T11.6). 순수 로직 + 접속 객체 래퍼. 시계·타이머·소켓을 직접 쓰지 않는다.
// 접속 객체 모양(가정): { send(Uint8Array), bufferedAmount(), close() }.
//
// 규칙:
//   trySend(conn, bytes, {droppable}) -> 'sent' | 'deferred' | 'dropped' | 'closed'
//     큐가 비어 있고 bufferedAmount+bytes ≤ hardLimit 이면 즉시 보낸다('sent'). 그래서 send 직후 bufferedAmount ≤ hardLimit.
//     넘치거나 앞서 밀린 큐가 있으면: droppable(조각 외 갱신류)은 버린다('dropped').
//       조각(droppable=false)은 큐에 쌓는다('deferred'). 순서 보존을 위해 큐가 비어 있지 않으면 항상 뒤에 쌓는다.
//       큐 바이트 합이 maxQueueBytes(기본 hardLimit)를 넘게 되면 쌓지 않고 접속을 닫는다('closed').
//       닫을 때는 close() 만 호출한다(ERR_CODES.TOO_SLOW 오류 메시지는 만들지 않는다).
//   onDrain(conn?) : bufferedAmount 가 highWater 미만이면 큐를 앞에서부터 순서대로 내보낸다(다음 항목이 hardLimit 를 넘기면 멈춤).
//     conn 을 생략하면 큐를 가진 모든 접속에 적용한다.
//   guardRequest(decoded, nowMs, decodeStartMs) -> { ok:true } | { ok:false, reason }
//     reason: 'shape'(PIECE_REQUEST 아님) | 'items'(항목 수 > maxRequestItems, F-175 ⑥) | 'decode_time'(nowMs-decodeStartMs > maxDecodeMs).
//     시계는 호출자가 주입한다.
import { MAX_REQUEST_ITEMS } from '../../../contracts/proto/index.mjs';

export function createBackpressure({ highWaterBytes, hardLimitBytes, maxRequestItems = MAX_REQUEST_ITEMS, maxDecodeMs, maxQueueBytes = hardLimitBytes } = {}) {
  for (const [k, v] of Object.entries({ highWaterBytes, hardLimitBytes, maxDecodeMs, maxQueueBytes })) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`backpressure: ${k} 는 0 이상의 유한 수여야 한다`);
  }
  if (highWaterBytes > hardLimitBytes) throw new RangeError('backpressure: highWaterBytes ≤ hardLimitBytes 여야 한다');

  /** @type {WeakMap<object,{queue:Uint8Array[],queued:number,closed:boolean}>} */
  const states = new WeakMap();
  /** 큐를 가진 접속(onDrain() 인자 없이 쓸 때). */
  const pending = new Set();

  function stateOf(conn) {
    let s = states.get(conn);
    if (!s) { s = { queue: [], queued: 0, closed: false }; states.set(conn, s); }
    return s;
  }
  function closeConn(conn, s) {
    s.closed = true;
    s.queue = [];
    s.queued = 0;
    pending.delete(conn);
    conn.close();
  }
  function flush(conn, s) {
    while (s.queue.length > 0) {
      const buffered = conn.bufferedAmount();
      if (buffered >= highWaterBytes) break;
      const next = s.queue[0];
      if (buffered + next.length > hardLimitBytes) break;
      s.queue.shift();
      s.queued -= next.length;
      conn.send(next);
    }
    if (s.queue.length === 0) pending.delete(conn);
  }

  function trySend(conn, bytes, { droppable = false } = {}) {
    const s = stateOf(conn);
    if (s.closed) return 'closed';
    flush(conn, s);
    if (s.queue.length === 0 && conn.bufferedAmount() + bytes.length <= hardLimitBytes) {
      conn.send(bytes);
      return 'sent';
    }
    if (droppable) return 'dropped';
    if (s.queued + bytes.length > maxQueueBytes) { closeConn(conn, s); return 'closed'; }
    s.queue.push(bytes);
    s.queued += bytes.length;
    pending.add(conn);
    return 'deferred';
  }

  function onDrain(conn) {
    if (conn !== undefined) {
      const s = states.get(conn);
      if (s && !s.closed) flush(conn, s);
      return;
    }
    for (const c of [...pending]) {
      const s = states.get(c);
      if (s && !s.closed) flush(c, s);
    }
  }

  function guardRequest(decoded, nowMs, decodeStartMs) {
    if (!decoded || decoded.type !== 'PIECE_REQUEST' || !Array.isArray(decoded.items)) return { ok: false, reason: 'shape' };
    if (decoded.items.length > maxRequestItems) return { ok: false, reason: 'items' };
    if (nowMs - decodeStartMs > maxDecodeMs) return { ok: false, reason: 'decode_time' };
    return { ok: true };
  }

  /** 시험·계측용: 접속의 큐 상태. */
  function queueInfo(conn) {
    const s = states.get(conn);
    return { count: s ? s.queue.length : 0, bytes: s ? s.queued : 0, closed: s ? s.closed : false };
  }

  return { trySend, onDrain, guardRequest, queueInfo };
}
