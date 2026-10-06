// 지형 H32 타일 디코더(T15.1.10e, 계약 contracts/tower_assets/terrain_h32.mjs). 좌표: GeoAnchor 기준 ENU, 1 unit = 1 m.
// decodeTerrainTileH32(bytes) -> { tx, ty, lod, cells, heights:Float32Array }. 머리·길이가 계약과 한 바이트라도 어긋나면 RangeError 를 던진다.
// 양자화 머리는 i32 kbase · f32 step(전역 격자), 복원은 계약 dequantizeHeights. LOD 0 + 양자화 flag, 비유한 f32 본문·복원값은 던진다.
// DataView 로 읽으므로 subarray 처럼 바이트 오프셋이 4의 배수가 아닌 입력에서도 동작한다. heights 는 입력 버퍼와 별도 복사다.
// 클라이언트 코드이므로 server/ 를 가져오지 않고 contracts/ 만 가져온다.
import {
  TERRAIN_H32_MAGIC,
  TERRAIN_H32_VERSION,
  TERRAIN_H32_HEADER_BYTES,
  TERRAIN_H32_FLAG_QUANTIZED,
  TERRAIN_H32_STEP_M,
  terrainH32Bytes,
  dequantizeHeights,
} from '../../../contracts/tower_assets/terrain_h32.mjs';

const KNOWN_FLAGS = TERRAIN_H32_FLAG_QUANTIZED;
// 거부 이유(F-499 ⑤): 전역 격자가 타일 간 비트 동일을 보장하려면 모든 타일이 같은 step 을 써야 한다(계약: step = TERRAIN_H32_STEP_M).
// 다른 step 의 타일은 이웃과 격자가 달라 공유 가장자리가 갈라지고, 1e-45 같은 값은 복원값을 비유한·무의미하게 만든다.
// 디코더가 임의 step 을 허용해야 할 실사용 경로가 없다(서버 인코더는 늘 계약 step). 시험용 비표준 step 골든은 계약 step 골든으로 바꿨다.
const CONTRACT_STEP = Math.fround(TERRAIN_H32_STEP_M);

function fail(message) {
  return new RangeError(`terrain h32: ${message}`);
}

/** @param {Uint8Array|ArrayBuffer} bytes */
export function decodeTerrainTileH32(bytes) {
  let u8;
  if (bytes instanceof ArrayBuffer) u8 = new Uint8Array(bytes);
  else if (bytes instanceof Uint8Array) u8 = bytes;
  else throw fail('입력은 Uint8Array 또는 ArrayBuffer 여야 한다');
  if (u8.length < TERRAIN_H32_HEADER_BYTES) throw fail(`머리보다 짧다(${u8.length} B)`);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint8(0) !== TERRAIN_H32_MAGIC) throw fail('magic 이 다르다');
  if (dv.getUint8(1) !== TERRAIN_H32_VERSION) throw fail(`지원하지 않는 version ${dv.getUint8(1)}`);
  const lod = dv.getUint8(2);
  if (lod > 3) throw fail(`lod ${lod} 은 0..3 이어야 한다`);
  const flags = dv.getUint8(3);
  if ((flags & ~KNOWN_FLAGS) !== 0) throw fail(`알 수 없는 flags 0x${flags.toString(16)}`);
  const tx = dv.getInt32(4, true);
  const ty = dv.getInt32(8, true);
  const cells = dv.getUint16(12, true);
  if (dv.getUint16(14, true) !== 0) throw fail('예약 필드가 0 이 아니다');
  if (cells < 2) throw fail(`cells ${cells} 는 2 이상이어야 한다`);
  const quantized = (flags & TERRAIN_H32_FLAG_QUANTIZED) !== 0;
  if (quantized && lod === 0) throw fail('lod 0 은 양자화할 수 없다(계약: LOD0 비양자화)');
  const expected = terrainH32Bytes(cells, quantized);
  if (u8.length !== expected) throw fail(`길이 ${u8.length} B 가 기대 ${expected} B 와 다르다`);
  const n = cells * cells;
  let heights;
  if (quantized) {
    const kbase = dv.getInt32(TERRAIN_H32_HEADER_BYTES, true);
    const step = dv.getFloat32(TERRAIN_H32_HEADER_BYTES + 4, true);
    if (!Number.isFinite(step) || !(step > 0)) throw fail('step 이 유한한 양수가 아니다');
    if (step !== CONTRACT_STEP) throw fail(`step ${step} 이 계약 step ${CONTRACT_STEP} 과 다르다`);
    const q = new Uint16Array(n);
    const off = TERRAIN_H32_HEADER_BYTES + 8;
    for (let k = 0; k < n; k++) q[k] = dv.getUint16(off + 2 * k, true);
    heights = dequantizeHeights(kbase, step, q);
    for (let k = 0; k < n; k++) if (!Number.isFinite(heights[k])) throw fail(`복원 높이[${k}] 가 유한하지 않다`);
  } else {
    heights = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const v = dv.getFloat32(TERRAIN_H32_HEADER_BYTES + 4 * k, true);
      if (!Number.isFinite(v)) throw fail(`높이[${k}] 가 유한하지 않다`);
      heights[k] = v;
    }
  }
  return { tx, ty, lod, cells, heights };
}
