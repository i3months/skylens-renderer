// 조각 GPU 버퍼 풀(T12.3). 복호된 조각(client/codec decodeChunkClient 의 {header, planes})의 평면을 key 별 GL 버퍼로 올리고
// 해제·상주량을 센다. 계약: contracts/client_raster/index.mjs 머리 주석(③ 조각 키, 메모리 maxResidentBytes).
// 상주량은 평면 typed array 의 byteLength 합(GPU 에 실제로 올린 바이트)이다.
import { ClientRasterError } from '../../../contracts/client_raster/index.mjs';

/** @param {unknown} v @param {string} name */
function checkLimit(v, name) {
  if (!Number.isSafeInteger(v) || v <= 0) throw new ClientRasterError('memory', `${name} 는 양의 정수여야 함: ${String(v)}`);
}

/**
 * decoded.planes 에서 올릴 평면 목록을 만든다. 평면은 ArrayBufferView 이어야 하고 비면 거부한다.
 * @param {any} decoded
 * @returns {{name: string, data: ArrayBufferView}[]}
 */
function planeList(decoded) {
  const planes = decoded && decoded.planes;
  if (planes === null || typeof planes !== 'object') throw new ClientRasterError('piece', 'decoded.planes 가 없음');
  const out = [];
  for (const name of Object.keys(planes)) {
    const data = planes[name];
    if (!ArrayBuffer.isView(data)) throw new ClientRasterError('piece', `평면 ${name} 이 typed array 가 아님`);
    out.push({ name, data });
  }
  if (out.length === 0) throw new ClientRasterError('piece', '평면이 하나도 없음');
  return out;
}

/**
 * @param {{gl: any, maxPieceBytes: number, maxResidentBytes: number}} opts
 */
export function createBufferPool({ gl, maxPieceBytes, maxResidentBytes }) {
  if (!gl) throw new ClientRasterError('context', 'gl 이 없음');
  checkLimit(maxPieceBytes, 'maxPieceBytes');
  checkLimit(maxResidentBytes, 'maxResidentBytes');
  /** @type {Map<string, {bytes: number, buffers: Record<string, any>}>} */
  const pieces = new Map();
  let resident = 0;

  function freeBuffers(buffers) {
    for (const name of Object.keys(buffers)) gl.deleteBuffer(buffers[name]);
  }

  return {
    /** 같은 key 를 다시 올리면 교체한다. 실패하면 기존 조각은 그대로 남는다. */
    upload(key, decoded) {
      if (typeof key !== 'string' || key === '') throw new ClientRasterError('piece', 'key 가 빈 문자열이거나 문자열이 아님');
      const list = planeList(decoded);
      let bytes = 0;
      for (const p of list) bytes += p.data.byteLength;
      if (bytes > maxPieceBytes) throw new ClientRasterError('piece', `조각 ${bytes} B 가 maxPieceBytes ${maxPieceBytes} 초과`);
      const old = pieces.get(key);
      const after = resident - (old ? old.bytes : 0) + bytes;
      if (after > maxResidentBytes) throw new ClientRasterError('memory', `상주 ${after} B 가 maxResidentBytes ${maxResidentBytes} 초과`);
      const buffers = {};
      try {
        for (const p of list) {
          const buf = gl.createBuffer();
          if (!buf) throw new ClientRasterError('memory', 'createBuffer 실패');
          buffers[p.name] = buf;
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.bufferData(gl.ARRAY_BUFFER, p.data, gl.STATIC_DRAW);
        }
      } catch (e) {
        freeBuffers(buffers); // 중간 실패: 만든 버퍼를 모두 돌려준다
        throw e;
      }
      if (old) freeBuffers(old.buffers);
      pieces.set(key, { bytes, buffers });
      resident = after;
      return { key, bytes, buffers };
    },
    /** 없는 key 나 이미 해제한 key 는 무시한다(중복 해제 허용). 해제했으면 true. */
    release(key) {
      const p = pieces.get(key);
      if (!p) return false;
      freeBuffers(p.buffers);
      pieces.delete(key);
      resident -= p.bytes;
      return true;
    },
    has(key) { return pieces.has(key); },
    residentBytes() { return resident; },
    keys() { return [...pieces.keys()]; },
    /** key 로 올린 GL 버퍼 묶음(그리기용). 없으면 undefined. */
    get(key) { const p = pieces.get(key); return p ? p.buffers : undefined; },
    clear() {
      for (const p of pieces.values()) freeBuffers(p.buffers);
      pieces.clear();
      resident = 0;
    },
  };
}
