// T12.5 복호 Worker 스크립트(모듈 Worker). loop/index.mjs 의 createDecodeWorkerClient 규약을 따른다:
// 요청 {id, bytes} → 응답 {id, result: {header, planes, gpu}} 또는 {id, error: 문자열}.
// 복호(codec 0/1 → 평면)와 GPU 평면 변환(toGpuPlanes, origin = header.bboxMin)을 모두 이 Worker 에서 하고,
// 변환 결과 gpu.planes 의 버퍼(position·color·normalOct)를 transferable 로 넘겨 메인 스레드의 변환·복사를 없앤다.
// 복호 평면(planes)은 gpu 가 있으면 메인이 쓰지 않으므로 응답에서 뺀다(result.planes === undefined). header 는 유지한다.
// 메인(createRenderer.uploadPiece)은 decoded.gpu 가 있으면 길이·origin 만 검증하고 toGpuPlanes 를 다시 돌리지 않는다.
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
    // 형식·길이·유한성 검사를 겸해 GPU 평면까지 여기서 만든다(실패하면 error 응답). origin 은 조각 원점 bboxMin.
    const gpu = toGpuPlanes(decoded, decoded.header.bboxMin);
    // 같은 ArrayBuffer 를 두 번 전송하면 던지므로 중복을 뺀다. SharedArrayBuffer 는 전송 대상이 아니다.
    const transfer = [];
    for (const view of Object.values(gpu.planes)) {
      const b = view && view.buffer;
      if (b instanceof ArrayBuffer && !transfer.includes(b)) transfer.push(b);
    }
    return { message: { id, result: { header: decoded.header, planes: undefined, gpu } }, transfer };
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
