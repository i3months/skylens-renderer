// WebGL2 렌더 문맥 초기화와 소실·복구 연결(T12.1).
//   createContext({canvas, attributes}) -> {gl, onLost(cb), onRestored(cb), isLost(), dispose()}
//   - canvas.getContext('webgl2', attributes) 가 null 이면 ClientRasterError('context').
//   - webglcontextlost 는 preventDefault 로 복구 가능 상태를 유지하고, webglcontextrestored 에서 복구 알림을 낸다.
//   - 같은 상태의 이벤트가 겹쳐 오면(소실 중 소실, 정상 중 복구) 무시한다(중복 해제).
//   - dispose 뒤에는 이벤트 리스너를 떼고 늦게 온 이벤트도 무시한다. 콜백 목록도 비운다.
//   GPU 자원의 재생성은 호출자 몫이다(소실 시 gl 의 자원은 모두 무효). 여기서는 알림만 한다.
import { ClientRasterError } from '../../../contracts/client_raster/index.mjs';

// 기본 속성: 알파·안티앨리어싱 없이 깊이만 쓴다. 호출자가 덮어쓸 수 있다.
const DEFAULT_ATTRIBUTES = Object.freeze({ alpha: false, antialias: false, depth: true, stencil: false });

/** @param {{canvas: any, attributes?: object}} opts */
export function createContext({ canvas, attributes } = {}) {
  if (canvas === null || typeof canvas !== 'object' || typeof canvas.getContext !== 'function'
    || typeof canvas.addEventListener !== 'function') {
    throw new ClientRasterError('context', 'canvas 가 getContext·addEventListener 를 가진 객체가 아님');
  }
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', { ...DEFAULT_ATTRIBUTES, ...(attributes ?? {}) });
  } catch (e) {
    throw new ClientRasterError('context', `WebGL2 문맥 생성 중 예외: ${e && e.message ? e.message : String(e)}`);
  }
  if (!gl) throw new ClientRasterError('context', 'WebGL2 를 얻지 못함');

  let lost = false;
  let disposed = false;
  const lostCbs = new Set();
  const restoredCbs = new Set();

  // 콜백 하나의 예외가 나머지 호출을 막지 않도록 모아서 마지막에 다시 던진다.
  const fire = (set) => {
    let first = null;
    for (const cb of [...set]) {
      try { cb(); } catch (e) { if (first === null) first = e; }
    }
    if (first !== null) throw first;
  };

  const handleLost = (ev) => {
    if (disposed) return;
    // 복구 이벤트가 오려면 기본 동작(영구 소실)을 막아야 한다. 이미 소실 중이어도 막아 둔다.
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    if (lost) return;
    lost = true;
    fire(lostCbs);
  };
  const handleRestored = () => {
    if (disposed || !lost) return;
    lost = false;
    fire(restoredCbs);
  };

  canvas.addEventListener('webglcontextlost', handleLost, false);
  canvas.addEventListener('webglcontextrestored', handleRestored, false);

  // 구독 해제 함수를 돌려준다.
  const subscribe = (set, cb) => {
    if (typeof cb !== 'function') throw new ClientRasterError('context', '콜백이 함수가 아님');
    if (disposed) return () => {};
    set.add(cb);
    return () => { set.delete(cb); };
  };

  return {
    gl,
    onLost: (cb) => subscribe(lostCbs, cb),
    onRestored: (cb) => subscribe(restoredCbs, cb),
    isLost: () => lost || (typeof gl.isContextLost === 'function' && gl.isContextLost()),
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('webglcontextlost', handleLost, false);
      canvas.removeEventListener('webglcontextrestored', handleRestored, false);
      lostCbs.clear();
      restoredCbs.clear();
    },
  };
}
