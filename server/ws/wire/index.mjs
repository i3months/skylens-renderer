// ws 서버 진입점 배선(결정 0040 '다시 볼 조건' ①④; 계측·보고 규칙은 decisions 0042 §1). attachConnection 을 접속마다 실제로 연결한다.
// 설계 선택(0040 선택지 C): 접속 계층(이 파일)이 onStopped(재전송 정지 알림) 처리 중 store.close(sid) 를 직접 부른다.
//   호출자의 onStopped 는 알림·점검용이고 store.close 를 빠뜨려도 세션은 지워진다.
//   대가: 호출자 onStopped 가 비동기여도 기다리지 않는다. onStopped 의 반환 약속은 거부만 감시하고(삼키고 보고),
//   끝나기를 기다리지 않은 채 곧바로 store.close 를 부른다. 즉 비동기 onStopped 가 저장소의 빠진 조각을 점검하는 중에도
//   세션은 이미 지워질 수 있다. 호출 순서는 onStopped 시작 -> store.close 호출이고, onStopped 완료는 그 뒤일 수 있다.
// 계측(stats):
//   stoppedCalls     : onStopped 알림이 온 횟수.
//   storeCloseOk     : 성공한 store.close 수(동기로 던지지 않고 돌아왔거나, 돌려준 Promise 가 이행됨).
//   storeCloseFailed : 던졌거나 Promise 가 거부된 store.close 수. 비동기 close 는 끝나기 전에는 둘 다에 안 센다
//                      (stoppedCalls - storeCloseOk - storeCloseFailed 가 진행 중 수). 둘의 합이 stoppedCalls 와 늘 같다고 단언하지 않는다:
//                      close 가 실패하면 storeCloseOk < stoppedCalls 로 드러나는 것이 이 계측의 목적(0040 ① 신호).
//   onStoppedErrors  : 호출자 onStopped 가 던졌거나 거부한 횟수.
//   sameSidStops     : sid 별 정지 알림 횟수. maxSameSidStops: 그 최대값.
//   sameSidThresholdHit: maxSameSidStops 가 문턱(기본 3) 이상인가.
//     의미: store.close 가 성공하면 그 sid 는 다음 HELLO 에서 UNKNOWN_SESSION(새 세션)이 되어 같은 sid 로는 정지가 다시 오지 않는다.
//     그런데도 같은 sid 가 정지로 또 온다면 close 가 실패했거나, 성공이라 답했지만 세션을 실제로 지우지 못한 것이다.
//     따라서 sid 별 횟수가 2 이상이면 이미 이상 신호이고 문턱은 그것이 반복됨을 알리는 경보선이다.
// 호출자의 onStopped 가 던져도 store.close 는 시도하고, 어느 쪽이 던지거나 거부해도 연결 처리는 죽지 않고 unhandledRejection 도 없다.
import { attachConnection } from '../session/index.mjs';

export const DEFAULT_SAME_SID_STOP_THRESHOLD = 3;

/**
 * @param {{store: object, loadPiece: Function, onSession?: Function, onMessage?: Function, onClose?: Function, onStopped?: Function, onError?: Function, sameSidStopThreshold?: number, attach?: Function}} o
 * @returns {{onConnection(conn: object): object, stats(): object}}
 */
export function createWire({ store, loadPiece, onSession, onMessage, onClose, onStopped, onError, sameSidStopThreshold = DEFAULT_SAME_SID_STOP_THRESHOLD, attach = attachConnection }) {
  if (!store || typeof store.close !== 'function') throw new TypeError('store.close 필요');
  if (typeof loadPiece !== 'function') throw new TypeError('loadPiece 필요');
  if (!Number.isSafeInteger(sameSidStopThreshold) || sameSidStopThreshold < 1) {
    throw new RangeError(`sameSidStopThreshold 는 1 이상의 안전 정수여야 한다: ${String(sameSidStopThreshold)}`);
  }
  const c = { stoppedCalls: 0, storeCloseOk: 0, storeCloseFailed: 0, onStoppedErrors: 0 };
  const bySid = new Map();
  const report = (err, where) => {
    try {
      const r = onError?.(err, where);
      // 비동기 onError 의 거부도 삼킨다(보고 실패는 연결 처리를 죽이지 않는다).
      if (r && typeof r.then === 'function') r.then(undefined, () => {});
    } catch { /* 보고 실패는 삼킨다 */ }
  };
  const closeFailed = (e) => { c.storeCloseFailed++; report(e, 'store.close'); };

  const handleStopped = (sid, info) => {
    c.stoppedCalls++;
    bySid.set(sid, (bySid.get(sid) ?? 0) + 1);
    try {
      const r = onStopped?.(sid, info);
      // 비동기 onStopped 는 기다리지 않는다: 거부만 감시한다(위 대가 참고).
      if (r && typeof r.then === 'function') r.then(undefined, (e) => { c.onStoppedErrors++; report(e, 'onStopped'); });
    } catch (e) {
      c.onStoppedErrors++;
      report(e, 'onStopped');
    }
    try {
      const r = store.close(sid);
      if (r && typeof r.then === 'function') r.then(() => { c.storeCloseOk++; }, closeFailed);
      else c.storeCloseOk++;
    } catch (e) {
      closeFailed(e);
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
