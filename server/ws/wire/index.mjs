// ws 서버 진입점 배선(결정 0040 '다시 볼 조건' ①④). attachConnection 을 접속마다 실제로 연결하고,
// onStopped(재전송 정지 알림)에서 세션 저장소의 store.close(sid) 를 부른다. 두 호출 수와 같은 sid 정지 횟수를 센다.
//   stoppedCalls   : onStopped 가 불린 횟수
//   storeCloseCalls: onStopped 안에서 store.close 를 시도한 횟수(던져도 센다). 둘이 다르면 결정 0040 ① 을 다시 본다.
//   storeCloseErrors / onStoppedErrors: store.close·호출자 onStopped 가 던진 횟수
//   sameSidStops   : sid 별 정지 횟수, maxSameSidStops: 그 최대값, sameSidThresholdHit: 문턱(기본 3) 이상이 나왔는가
// 호출자의 onStopped 가 던져도 store.close 는 시도하고, 어느 쪽이 던져도 연결 처리는 죽지 않는다.
import { attachConnection } from '../session/index.mjs';

export const DEFAULT_SAME_SID_STOP_THRESHOLD = 3;

/**
 * @param {{store: object, loadPiece: Function, onSession?: Function, onMessage?: Function, onClose?: Function, onStopped?: Function, onError?: Function, sameSidStopThreshold?: number, attach?: Function}} o
 * @returns {{onConnection(conn: object): object, stats(): object}}
 */
export function createWire({ store, loadPiece, onSession, onMessage, onClose, onStopped, onError, sameSidStopThreshold = DEFAULT_SAME_SID_STOP_THRESHOLD, attach = attachConnection }) {
  if (!store || typeof store.close !== 'function') throw new TypeError('store.close 필요');
  if (typeof loadPiece !== 'function') throw new TypeError('loadPiece 필요');
  const c = { stoppedCalls: 0, storeCloseCalls: 0, storeCloseErrors: 0, onStoppedErrors: 0 };
  const bySid = new Map();
  const report = (err, where) => { try { onError?.(err, where); } catch { /* 보고 실패는 삼킨다 */ } };

  const handleStopped = (sid, info) => {
    c.stoppedCalls++;
    bySid.set(sid, (bySid.get(sid) ?? 0) + 1);
    try {
      const r = onStopped?.(sid, info);
      if (r && typeof r.then === 'function') r.then(undefined, (e) => { c.onStoppedErrors++; report(e, 'onStopped'); });
    } catch (e) {
      c.onStoppedErrors++;
      report(e, 'onStopped');
    }
    c.storeCloseCalls++; // 시도 수: 던져도 센다
    try {
      store.close(sid);
    } catch (e) {
      c.storeCloseErrors++;
      report(e, 'store.close');
    }
  };

  return {
    onConnection(conn) {
      return attach({ conn, store, loadPiece, onSession, onMessage, onClose, onStopped: handleStopped });
    },
    stats() {
      let max = 0;
      for (const n of bySid.values()) if (n > max) max = n;
      return {
        ...c,
        sameSidStops: Object.fromEntries(bySid),
        maxSameSidStops: max,
        sameSidThresholdHit: max >= sameSidStopThreshold,
      };
    },
  };
}
