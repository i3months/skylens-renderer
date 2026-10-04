// T12.5 프레임 루프와 복호 Worker 클라이언트(계약: contracts/client_raster 머리 주석 ① 복호는 Worker, FrameStats.droppedFrames).
// 조각 도착(notifyArrival)과 그리기를 분리한다: 도착은 표지만 세우고 그리기는 프레임 콜백에서 프레임당 한 번만 한다.
// requestFrame·now 는 주입(결정적 시험). 도착하지 않은 것을 그리거나 메우지 않는다(도착 표지가 없으면 그리지 않는다).

/** 메인 스레드 long task 문턱(ms). 이 값을 넘는 한 번의 메인 스레드 작업을 long task 로 센다. */
export const LONG_TASK_MS = 50;
/** 기본 프레임 간격(ms): 60 Hz. */
export const DEFAULT_FRAME_MS = 1000 / 60;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * @param {{draw: () => any, requestFrame: (cb: () => void) => any, now: () => number,
 *          onFrame?: (info: {drawn: boolean, skipped: number, coalesced: number, drawMs: number}) => void,
 *          onError?: (err: any, where: 'draw'|'onFrame'|'requestFrame'|'now') => void,
 *          frameMs?: number}} opts
 */
export function createFrameLoop({ draw, requestFrame, now, onFrame, onError, frameMs = DEFAULT_FRAME_MS }) {
  // frameMs 가 0·음수·NaN·Infinity 이면 droppedFrames 가 Infinity·NaN 이 되므로 만들 때 거부한다.
  if (typeof frameMs !== 'number' || !Number.isFinite(frameMs) || frameMs <= 0) {
    throw new RangeError('frameMs 는 0 보다 큰 유한한 수여야 한다');
  }
  let running = false;
  let dirty = false;        // 마지막 그리기 뒤 도착이 있었는가
  let pendingArrivals = 0;  // 이번 프레임에 합쳐질 도착 수
  let lastFrameAt = null;   // 직전 프레임 콜백 시각
  let token = 0;            // stop 뒤 늦게 오는 콜백을 무시하는 세대 번호
  const s = { frames: 0, draws: 0, arrivals: 0, coalescedArrivals: 0, droppedFrames: 0, longTasks: 0, lastDrawMs: 0, maxDrawMs: 0, errors: 0 };

  // 예외는 세어서 알린다. 알림 콜백이 던져도 루프는 계속 돈다.
  function report(err, where) {
    s.errors++;
    if (onError) { try { onError(err, where); } catch { /* 알림 실패는 무시 */ } }
  }

  // 다음 프레임 예약. 예약 자체가 던지면 running=false 로 내려 start() 로 다시 켤 수 있게 한다.
  function schedule(gen) {
    try { requestFrame(() => tick(gen)); } catch (e) {
      if (gen === token) running = false;
      report(e, 'requestFrame');
    }
  }

  function tick(gen) {
    if (!running || gen !== token) return;
    // now() 가 던져도 루프가 멈추지 않게 한다: 오류를 세고 다음 프레임을 예약한 채 running 을 유지한다.
    let t0;
    try { t0 = now(); } catch (e) { report(e, 'now'); if (running && gen === token) schedule(gen); return; }
    // 프레임 간격이 frameMs 의 정수배보다 길면 그 사이 건너뛴 프레임 수를 센다(반올림 오차 흡수용 0.5 프레임 여유).
    let skipped = 0;
    if (lastFrameAt !== null) {
      skipped = Math.max(0, Math.floor((t0 - lastFrameAt) / frameMs + 0.5) - 1);
      s.droppedFrames += skipped;
    }
    lastFrameAt = t0;
    s.frames++;
    let drawn = false;
    const coalesced = Math.max(0, pendingArrivals - 1); // 한 프레임에 도착이 몰리면 첫 도착만 그리기를 일으킨다
    let drawMs = 0;
    if (dirty) {
      dirty = false;
      s.coalescedArrivals += coalesced;
      pendingArrivals = 0;
      // draw 예외 한 번에 루프가 멈추지 않게 한다(다음 프레임은 아래에서 항상 예약한다).
      try { draw(); } catch (e) { report(e, 'draw'); }
      drawn = true;
      s.draws++;
      try { drawMs = now() - t0; } catch (e) { report(e, 'now'); drawMs = 0; }
      s.lastDrawMs = drawMs;
      if (drawMs > s.maxDrawMs) s.maxDrawMs = drawMs;
      if (drawMs > LONG_TASK_MS) s.longTasks++;
    }
    if (onFrame) { try { onFrame({ drawn, skipped, coalesced, drawMs }); } catch (e) { report(e, 'onFrame'); } }
    if (running && gen === token) schedule(gen);
  }

  return {
    start() {
      if (running) return;
      running = true;
      dirty = true; // 시작 직후 첫 프레임에 한 번 그린다
      lastFrameAt = null;
      const gen = ++token;
      schedule(gen);
    },
    stop() { running = false; token++; },
    notifyArrival() { s.arrivals++; pendingArrivals++; dirty = true; },
    stats() { return { ...s, running }; },
  };
}

/**
 * codec 복호를 Web Worker 에 맡기는 얇은 래퍼. spawn() 은 Worker 모양 객체
 * ({postMessage, onmessage, onerror, terminate?})를 돌려준다. 요청 {id, bytes} → 응답 {id, result} 또는 {id, error}.
 * 메인 스레드에서는 postMessage 와 응답 배달만 한다. 그 한 번의 작업이 LONG_TASK_MS 를 넘으면 longTasks 로 센다.
 * 소유권: decode(bytes) 는 bytes 가 버퍼 전체를 덮으면 그 버퍼를 Worker 로 transfer 하므로 호출 뒤 호출자의 bytes 는
 * detach 된다(길이 0). 일부만 덮는 뷰(subarray)는 그 범위만 복사해 넘기므로 원본은 그대로다. 복사를 피하려는 쪽은
 * 전체 버퍼를 넘기고 이후 쓰지 않는다. 응답 result 는 가공 없이 그대로 돌려준다(그 안의 ArrayBuffer 는 Worker 가 transfer).
 * 오류 경로: onerror·onmessageerror(역직렬화 실패)는 대기 중 전부를 reject 한다. onerror 는 Worker 가 죽은 것으로 보고
 * terminated 도 세우므로 이후 decode 는 즉시 reject 한다. onmessageerror 도 terminated 를 세우고 Worker 를 terminate 한다.
 * timeoutMs(선택, 기본 없음)는 Worker 가 요청을 하나씩 순서대로 처리한다고 보고 맨 앞 요청의 처리 시작부터 잰다.
 * 맨 앞 요청이 timeoutMs 안에 응답하지 않으면 그 요청은 'timeout' 으로 reject 하고, Worker 가 그 요청을 아직 처리 중이라
 * 막힌 것으로 보아 그 시점에 대기 중이던 나머지 요청도 전부 reject 한다(failAll, 뒤 요청의 연쇄 오탐 방지). 버려진 id 의
 * 늦은 응답은 무시한다. 시한이 지나면 Worker 를 terminate 하고 terminated 상태가 되어 이후 decode 는 즉시 'terminated' 로
 * reject 한다(거짓 timeout 방지). 새 Worker 를 만드는 것은 호출자 몫이다.
 * setTimeoutFn 이 던지면 아직 보내지 않은 요청만 던진 오류로 reject 하고 대기열·pending 에는 남기지 않는다.
 * 이미 보낸 요청(앞 요청 응답 뒤 맨 앞이 된 것)의 타이머 설정이 던지면 거부하지 않고 시한 없이 처리 중으로 두며, 뒤 요청은 그 응답 뒤
 * 처리 시작 기준으로 시한을 받는다. clearTimeoutFn 이 던져도 settle 이 먼저이고 정리는 계속된다.
 * timeoutMs 는 2^31-1 이하여야 한다(넘으면 RangeError). 모든 reject 는 stats().errors 에 세어 requests = responses + errors + pending 이다.
 * (setTimeoutFn·clearTimeoutFn 주입으로 가짜 타이머 시험)
 * @param {{spawn: () => any, now?: () => number, timeoutMs?: number,
 *          setTimeoutFn?: Function, clearTimeoutFn?: Function}} opts
 */
export function createDecodeWorkerClient({ spawn, now = () => 0, timeoutMs, setTimeoutFn = globalThis.setTimeout, clearTimeoutFn = globalThis.clearTimeout }) {
  // setTimeout 은 2^31-1 ms 를 넘으면 1 ms 로 잘라 즉시 timeout 이 되므로 만들 때 거부한다.
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS)) {
    throw new RangeError('timeoutMs 는 0 보다 크고 2^31-1 이하인 유한한 수여야 한다');
  }
  const worker = spawn();
  const pending = new Map();
  let nextId = 1;
  let terminated = false;
  // 워커는 요청을 순서대로 하나씩 처리하므로 타임아웃은 '처리 시작'부터 잰다.
  // order 의 맨 앞 요청만 타이머를 가지고, 앞 요청이 끝나면 다음 요청의 타이머를 시작한다.
  const order = [];
  function arm(entry) {
    if (timeoutMs === undefined || entry.timer !== undefined) return;
    entry.timer = setTimeoutFn(() => {
      entry.timer = undefined;
      if (pending.get(entry.id) !== entry) return;
      // 시한을 넘긴 Worker 는 그 요청을 아직 처리 중이므로 막힌 것으로 보고 뒤 요청까지 모두 거부한다.
      pending.delete(entry.id); st.errors++;
      entry.reject(new Error('timeout'));
      // 막힌 Worker 는 죽이고 'terminated' 로 세운다: 살려 두면 새 요청이 처리 중 요청 뒤에 줄 서서 거짓 timeout 을 받는다.
      terminated = true;
      try { if (worker.terminate) worker.terminate(); } catch { /* 종료 실패는 무시 */ }
      failAll(new Error('timeout: worker blocked'));
    }, timeoutMs);
  }
  // 이미 보낸 맨 앞 요청의 타이머 설정이 던지면 그 요청은 시한 없이 그대로 처리 중으로 둔다(거부하지 않는다).
  // Worker 가 아직 그 요청을 처리 중이므로 뒤 요청은 그 응답이 온 뒤 처리 시작 기준으로 시한을 받는다.
  function armHead() {
    if (order.length > 0) { try { arm(order[0]); } catch { /* 이 요청만 시한 없음 */ } }
  }
  function release(entry) {
    const i = order.indexOf(entry);
    if (i < 0) return;
    order.splice(i, 1);
    if (i === 0) armHead();
  }
  const st = { requests: 0, responses: 0, errors: 0, mainThreadEvents: 0, longTasks: 0, maxMainMs: 0 };

  function measure(fn) {
    let t0;
    try { t0 = now(); } catch { /* now threw, skip timing */ }

    try {
      return fn();
    } finally {
      if (t0 !== undefined) {
        let t1;
        try { t1 = now(); } catch { /* now threw, skip timing */ }
        if (t1 !== undefined) {
          const ms = t1 - t0;
          st.mainThreadEvents++;
          if (ms > st.maxMainMs) st.maxMainMs = ms;
          if (ms > LONG_TASK_MS) st.longTasks++;
        }
      }
    }
  }
  // clearTimeoutFn 이 던져도 settle·정리가 끊기지 않게 한다.
  function safeClear(timer) { try { clearTimeoutFn(timer); } catch { /* 해제 실패는 무시 */ } }
  function failAll(err) {
    const all = [...pending.values()];
    pending.clear();
    order.length = 0;
    for (const p of all) { st.errors++; if (p.timer !== undefined) { safeClear(p.timer); p.timer = undefined; } p.reject(err); }
  }
  // message 없는 객체가 '[object Object]' 가 되지 않게 오류 값을 Error 로 바꾼다.
  function toError(e) {
    if (e instanceof Error) return e;
    if (e && typeof e.message === 'string' && e.message) return new Error(e.message);
    if (typeof e === 'string') return new Error(e);
    let text;
    try { text = JSON.stringify(e); } catch { /* 순환 등 */ }
    return new Error(text === undefined ? String(e) : text);
  }

  worker.onmessage = (ev) => measure(() => {
    const m = ev && ev.data !== undefined ? ev.data : ev;
    if (m === null || typeof m !== 'object') return; // data 가 null 이거나 객체가 아니면 버린다
    const p = pending.get(m.id);
    if (!p) return; // 알 수 없는 응답은 버린다
    pending.delete(m.id);
    const timer = p.timer;
    p.timer = undefined;
    // 먼저 settle 하고 그 뒤에 타이머를 해제하고 다음 요청 타이머를 건다(타이머 쪽 오류가 이 요청을 미결로 두지 않게).
    if ('error' in m && m.error !== undefined) { st.errors++; p.reject(toError(m.error)); }
    else { st.responses++; p.resolve(m.result); }
    if (timer !== undefined) safeClear(timer);
    release(p);
  });
  worker.onerror = (e) => measure(() => {
    terminated = true; // 죽은 Worker 로는 응답이 오지 않으니 이후 decode 는 영구 미결 대신 reject 한다
    failAll(toError(e));
  });
  // 응답 역직렬화 실패는 어느 요청의 것인지 알 수 없으므로 대기 중 전부를 거부한다.
  // 버려진 요청을 Worker 가 계속 처리하므로 살려 두면 새 decode 가 거짓 timeout 을 받는다: terminated 로 세우고 terminate 한다.
  worker.onmessageerror = () => measure(() => {
    terminated = true;
    try { if (worker.terminate) worker.terminate(); } catch { /* 종료 실패는 무시 */ }
    failAll(new Error('messageerror'));
  });

  return {
    decode(bytes) {
      return new Promise((resolve, reject) => {
        // terminate 뒤에는 응답이 올 수 없으니 영원히 미결로 두지 않고 즉시 거부한다.
        if (terminated) { reject(new Error('terminated')); return; }
        const id = nextId++;
        const entry = { id, resolve, reject, timer: undefined };
        order.push(entry);
        pending.set(id, entry);
        st.requests++;
        if (order.length === 1) {
          // 아직 보내지 않은 요청이므로 타이머 설정이 던지면 그 요청만 던진 오류로 거부한다.
          try { arm(entry); } catch (err) {
            order.length = 0; pending.delete(id); entry.timer = undefined; st.errors++;
            reject(err); return;
          }
        }
        try {
          measure(() => {
            let payload = bytes;
            let transfer = [];
            if (bytes && bytes.buffer) {
              // 부분 뷰(subarray)면 버퍼 전체가 넘어가 호출자의 다른 뷰가 깨지므로 뷰 범위만 복사해 그 사본을 넘긴다.
              const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
              payload = whole ? bytes : bytes.slice();
              transfer = [payload.buffer];
            }
            worker.postMessage({ id, bytes: payload }, transfer);
          });
        } catch (e) {
          // postMessage 실패 시 대기 항목이 새지 않게 한다(먼저 settle)
          const timer = entry.timer;
          entry.timer = undefined;
          if (pending.delete(id)) st.errors++;
          reject(e);
          if (timer !== undefined) safeClear(timer);
          release(entry);
        }
      });
    },
    terminate() {
      terminated = true;
      try { if (worker.terminate) worker.terminate(); } finally { failAll(new Error('terminated')); }
    },
    stats() { return { ...st, pending: pending.size }; },
  };
}
