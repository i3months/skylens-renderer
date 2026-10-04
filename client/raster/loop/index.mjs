// T12.5 프레임 루프와 복호 Worker 클라이언트(계약: contracts/client_raster 머리 주석 ① 복호는 Worker, FrameStats.droppedFrames).
// 조각 도착(notifyArrival)과 그리기를 분리한다: 도착은 표지만 세우고 그리기는 프레임 콜백에서 프레임당 한 번만 한다.
// requestFrame·now 는 주입(결정적 시험). 도착하지 않은 것을 그리거나 메우지 않는다(도착 표지가 없으면 그리지 않는다).

/** 메인 스레드 long task 문턱(ms). 이 값을 넘는 한 번의 메인 스레드 작업을 long task 로 센다. */
export const LONG_TASK_MS = 50;
/** 기본 프레임 간격(ms): 60 Hz. */
export const DEFAULT_FRAME_MS = 1000 / 60;

/**
 * @param {{draw: () => any, requestFrame: (cb: () => void) => any, now: () => number,
 *          onFrame?: (info: {drawn: boolean, skipped: number, coalesced: number, drawMs: number}) => void,
 *          frameMs?: number}} opts
 */
export function createFrameLoop({ draw, requestFrame, now, onFrame, frameMs = DEFAULT_FRAME_MS }) {
  let running = false;
  let dirty = false;        // 마지막 그리기 뒤 도착이 있었는가
  let pendingArrivals = 0;  // 이번 프레임에 합쳐질 도착 수
  let lastFrameAt = null;   // 직전 프레임 콜백 시각
  let token = 0;            // stop 뒤 늦게 오는 콜백을 무시하는 세대 번호
  const s = { frames: 0, draws: 0, arrivals: 0, coalescedArrivals: 0, droppedFrames: 0, longTasks: 0, lastDrawMs: 0, maxDrawMs: 0 };

  function tick(gen) {
    if (!running || gen !== token) return;
    const t0 = now();
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
      draw();
      drawn = true;
      s.draws++;
      drawMs = now() - t0;
      s.lastDrawMs = drawMs;
      if (drawMs > s.maxDrawMs) s.maxDrawMs = drawMs;
      if (drawMs > LONG_TASK_MS) s.longTasks++;
    }
    if (onFrame) onFrame({ drawn, skipped, coalesced, drawMs });
    if (running && gen === token) requestFrame(() => tick(gen));
  }

  return {
    start() {
      if (running) return;
      running = true;
      dirty = true; // 시작 직후 첫 프레임에 한 번 그린다
      lastFrameAt = null;
      const gen = ++token;
      requestFrame(() => tick(gen));
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
 * @param {{spawn: () => any, now?: () => number}} opts
 */
export function createDecodeWorkerClient({ spawn, now = () => 0 }) {
  const worker = spawn();
  const pending = new Map();
  let nextId = 1;
  const st = { requests: 0, responses: 0, errors: 0, mainThreadEvents: 0, longTasks: 0, maxMainMs: 0 };

  function measure(fn) {
    const t0 = now();
    try { return fn(); } finally {
      const ms = now() - t0;
      st.mainThreadEvents++;
      if (ms > st.maxMainMs) st.maxMainMs = ms;
      if (ms > LONG_TASK_MS) st.longTasks++;
    }
  }
  function failAll(err) {
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  }

  worker.onmessage = (ev) => measure(() => {
    const m = ev && ev.data !== undefined ? ev.data : ev;
    const p = pending.get(m.id);
    if (!p) return; // 알 수 없는 응답은 버린다
    pending.delete(m.id);
    if ('error' in m && m.error !== undefined) { st.errors++; p.reject(new Error(String(m.error))); }
    else { st.responses++; p.resolve(m.result); }
  });
  worker.onerror = (e) => measure(() => failAll(e instanceof Error ? e : new Error(String((e && e.message) || e))));

  return {
    decode(bytes) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        st.requests++;
        measure(() => worker.postMessage({ id, bytes }, bytes && bytes.buffer ? [bytes.buffer] : []));
      });
    },
    terminate() { if (worker.terminate) worker.terminate(); failAll(new Error('terminated')); },
    stats() { return { ...st, pending: pending.size }; },
  };
}
