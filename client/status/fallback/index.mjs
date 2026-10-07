// 폴백 화면 상태(확정(SPEC §5, 사람 결정 2026-10-06)). 계약: contracts/statusview 의 createFallbackController.
// 연결이 끊겼거나 서버가 불가이거나 응답이 늦으면 폴백 상태를 돌려줄 뿐이다. 폴백에서도 도착하지 않은 것을 그리거나 채우지 않는다.
// 시계·타이머 없음: timeout 은 호출자가 알려 준다.
import { ERR_CODES } from '../../../contracts/proto/index.mjs';

const NORMAL_CLOSE = 1000;

/** reason 별 한국어 고정 문장. */
const MESSAGES = Object.freeze({
  closed: '연결이 닫혔습니다. 도착하지 않은 것은 그리지 않고 비워 둡니다.',
  unavailable: '서버를 쓸 수 없습니다. 도착하지 않은 것은 그리지 않고 비워 둡니다.',
  timeout: '응답이 늦어지고 있습니다. 도착하지 않은 것은 그리지 않고 비워 둡니다.',
});

const KINDS = ['connected', 'closed', 'error', 'timeout'];

function fallbackState(reason) {
  return { mode: 'fallback', reason, message: MESSAGES[reason] };
}

/** @param {{helloTimeoutMs?: number}} [options] */
export function createFallbackController(options = {}) {
  if (options === null || typeof options !== 'object') throw new TypeError('options 는 객체여야 한다');
  const helloTimeoutMs = options.helloTimeoutMs;
  if (helloTimeoutMs !== undefined && (!Number.isInteger(helloTimeoutMs) || helloTimeoutMs <= 0)) {
    throw new RangeError(`helloTimeoutMs 는 양의 정수여야 한다: ${String(helloTimeoutMs)}`);
  }
  let current = { mode: 'live', reason: null, message: null };
  const copy = () => ({ ...current });

  return {
    handle(event) {
      if (event === null || typeof event !== 'object') throw new TypeError('event 는 객체여야 한다');
      const { kind, code } = event;
      if (!KINDS.includes(kind)) throw new TypeError(`알 수 없는 kind: ${String(kind)}`);
      if (code !== undefined && typeof code !== 'number') throw new TypeError('code 는 숫자여야 한다');
      if (kind === 'connected') {
        current = { mode: 'live', reason: null, message: null };
      } else if (kind === 'timeout') {
        current = fallbackState('timeout');
      } else if (kind === 'closed') {
        // 정상 종료(1000)는 폴백이 아니고 상태를 유지한다.
        if (code !== NORMAL_CLOSE) current = fallbackState('closed');
      } else if (code === ERR_CODES.UNAVAILABLE) {
        current = fallbackState('unavailable');
      }
      // 그 외 error code(BAD_MESSAGE 등)는 연결 문제가 아니라 규약 문제이므로 폴백으로 보내지 않고 상태를 유지한다.
      return copy();
    },
    state: copy,
    /** 보관만 하는 값(state 에는 노출하지 않는다). */
    helloTimeoutMs: () => helloTimeoutMs,
  };
}
