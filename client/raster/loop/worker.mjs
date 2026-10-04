// T12.5 복호 Worker 스크립트(모듈 Worker). loop/index.mjs 의 createDecodeWorkerClient 규약을 따른다:
// 요청 {id, bytes} → 응답 {id, result: {header, planes}} 또는 {id, error: 문자열}.
// 복호(codec 0/1 → 평면)와 GPU 평면 검증(toGpuPlanes)을 이 Worker 에서 하고, 평면 버퍼는 transferable 로 넘겨 메인 스레드 복사를 없앤다.
// 응답 모양은 createRenderer 기본 decodeChunkClient 와 같아(header·planes) decode 옵션에 그대로 꽂힌다.
import { decodeChunkClient } from '../../codec/index.mjs';
import { toGpuPlanes } from '../index.mjs';

/**
 * 요청 하나를 처리해 {message, transfer} 를 돌려준다(Worker 밖에서도 시험할 수 있게 분리).
 * @param {{id: number, bytes: Uint8Array|ArrayBuffer}} data
 * @returns {{message: object, transfer: ArrayBuffer[]}}
 */
export function handleDecodeRequest(data) {
  const id = data && data.id;
  try {
    if (!data || typeof data !== 'object') throw new Error('요청이 객체가 아님');
    const decoded = decodeChunkClient(data.bytes);
    toGpuPlanes(decoded); // 형식·길이·유한성 검사를 Worker 에서 먼저 한다(실패하면 error 응답)
    // 같은 ArrayBuffer 를 두 번 전송하면 던지므로 중복을 뺀다. SharedArrayBuffer 는 전송 대상이 아니다.
    const transfer = [];
    for (const view of Object.values(decoded.planes)) {
      const b = view && view.buffer;
      if (b instanceof ArrayBuffer && !transfer.includes(b)) transfer.push(b);
    }
    return { message: { id, result: { header: decoded.header, planes: decoded.planes } }, transfer };
  } catch (e) {
    return { message: { id, error: e && e.message ? String(e.message) : String(e) }, transfer: [] };
  }
}

// Worker 전역에서 불렸을 때만 메시지를 받는다(메인 스레드에서 import 해도 부작용 없음).
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  globalThis.onmessage = (ev) => {
    const { message, transfer } = handleDecodeRequest(ev.data);
    globalThis.postMessage(message, transfer);
  };
}
