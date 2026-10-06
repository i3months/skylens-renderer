// [cloud] T15.10b-B4: 지형 타일 전송 형식 후보의 부호화·복원(측정 전용, 계약 아님).
// F-457 ①·F-458: 지형 전송 형식 계약이 없으므로, 같은 TerrainTile(server/terrain/mesh_lod buildTerrainTile 출력)을
//   여러 형식으로 실제 바이트에 써 보고 길이를 센다. 서버·계약·클라이언트 코드는 바꾸지 않는다.
//
// 형식(조각 하나 = 프레임 머리 PIECE_FRAME_OVERHEAD_BYTES 38 B + 조각 머리 + 본문, 리틀 엔디언):
//   MESH  : 머리 16 B(정점 수 u32, 인덱스 수 u32, tx i32, ty i32) + positions f32 xyz + indices u32. bench/tower/lod_bytes.mjs 와 같다.
//   H32   : 머리 16 B(tx i32, ty i32, cells u16, lod u8, fmt u8, 예약 4 B) + heights f32 cells². xy·인덱스는 격자 규약으로 복원.
//   Q16   : 머리 24 B(H32 머리 + k0 i32 + step f32) + 오프셋 u16 cells². 높이 = fround((k0 + off)·step).
//   BPO   : 머리 28 B(Q16 머리 + bits u8 + 예약 3 B) + 오프셋을 bits 비트로 촘촘히(예측 없음).
//   BPP   : 머리 28 B(같음) + 평면 예측 잔차(지그재그)를 bits 비트로 촘촘히. 예측: (0,0)=0, 첫 행=왼쪽, 첫 열=아래, 나머지=왼+아래−왼아래.
//   BPX   : 타일마다 BPO·BPP 중 작은 쪽(머리 예약 바이트 하나를 예측 여부 표지로 쓴다고 가정, 머리 크기 같음).
// 양자화 격자는 전역이다(q = round(h/step), 타일마다 k0 = min q 만 뺀다). 그래서 이웃 타일이 공유하는 가장자리 표본은
//   같은 정수 q → 같은 Float32 높이로 복원되어 균열이 생기지 않는다(타일별 min/max 정규화는 이 성질이 없어 쓰지 않는다).
// Q16 는 타일 안 오프셋 범위가 65535 를 넘으면 표현할 수 없다(overflow 로 던짐 — 측정 DEM 에서는 생기지 않는다).
// BPO·BPP 는 정수 비트 폭이라 손실 없이 Q16 과 같은 높이를 복원한다(시험 b4_formats.test.mjs 가 왕복을 확인).
import { PIECE_FRAME_OVERHEAD_BYTES } from '../../../server/scheduler/initial/index.mjs';
import { terrainTileToMesh } from '../../../server/terrain/mesh_lod/index.mjs';

export const MESH_HEADER_BYTES = 16;
export const H32_HEADER_BYTES = 16;
export const Q16_HEADER_BYTES = 24;
export const BP_HEADER_BYTES = 28;
export { PIECE_FRAME_OVERHEAD_BYTES };

/** MESH 형식 조각 바이트(프레임 머리 포함). */
export function meshPieceBytes(tile) {
  const m = terrainTileToMesh(tile);
  return PIECE_FRAME_OVERHEAD_BYTES + MESH_HEADER_BYTES + m.positions.byteLength + m.indices.byteLength;
}

/** H32 형식 조각 바이트. */
export function h32PieceBytes(tile) {
  return PIECE_FRAME_OVERHEAD_BYTES + H32_HEADER_BYTES + tile.heights.byteLength;
}

/** 전역 격자 양자화: { k0, off(Int32Array), range, stepF32 }. */
export function quantize(heights, step) {
  const stepF32 = Math.fround(step);
  if (!Number.isFinite(stepF32) || !(stepF32 > 0)) throw new RangeError(`step must be finite and > 0, got ${step}`);
  const n = heights.length;
  for (let k = 0; k < n; k++) {
    if (!Number.isFinite(heights[k])) throw new RangeError(`heights[${k}] is not finite: ${heights[k]}`);
  }
  const q = new Float64Array(n);
  let k0 = Infinity, kMax = -Infinity;
  for (let k = 0; k < n; k++) {
    const v = Math.round(heights[k] / stepF32);
    q[k] = v;
    if (v < k0) k0 = v;
    if (v > kMax) kMax = v;
  }
  if (!Number.isSafeInteger(k0) || Math.abs(k0) > 0x7fffffff) throw new RangeError(`k0 ${k0} 가 i32 범위 밖`);
  const off = new Int32Array(n);
  for (let k = 0; k < n; k++) off[k] = q[k] - k0;
  return { k0, off, range: kMax - k0, stepF32 };
}

/** 양자화 정수 → Float32 높이(부호화 형식과 무관하게 같은 식). */
export function dequantize(k0, off, stepF32) {
  const out = new Float32Array(off.length);
  for (let k = 0; k < off.length; k++) out[k] = Math.fround((k0 + off[k]) * stepF32);
  return out;
}

/** 값 v(0 이상 정수)를 담는 최소 비트 수(0 이면 0). */
function bitsFor(maxV) {
  let b = 0;
  while (b < 32 && maxV >= 2 ** b) b++;
  return b;
}

/** 부호 없는 정수 배열을 bits 비트씩 촘촘히 쓴다(LSB 먼저). */
export function packBits(values, bits) {
  const out = new Uint8Array(Math.ceil((values.length * bits) / 8));
  if (bits === 0) return out;
  let bitPos = 0;
  for (let k = 0; k < values.length; k++) {
    let v = values[k];
    for (let b = 0; b < bits; b++) {
      if (v & 1) out[bitPos >> 3] |= 1 << (bitPos & 7);
      v = Math.floor(v / 2);
      bitPos++;
    }
  }
  return out;
}

export function unpackBits(bytes, count, bits) {
  const out = new Uint32Array(count);
  if (bits === 0) return out;
  let bitPos = 0;
  for (let k = 0; k < count; k++) {
    let v = 0;
    for (let b = 0; b < bits; b++) {
      if (bytes[bitPos >> 3] & (1 << (bitPos & 7))) v += 2 ** b;
      bitPos++;
    }
    out[k] = v;
  }
  return out;
}

const zig = (r) => (r >= 0 ? 2 * r : -2 * r - 1);
const unzig = (z) => (z % 2 === 0 ? z / 2 : -(z + 1) / 2);

/** 평면 예측 잔차(지그재그). off 는 cells² 행 우선(j·cells + i). */
export function planarResiduals(off, cells) {
  const z = new Uint32Array(off.length);
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const k = j * cells + i;
      let pred;
      if (i === 0 && j === 0) pred = 0;
      else if (j === 0) pred = off[k - 1];
      else if (i === 0) pred = off[k - cells];
      else pred = off[k - 1] + off[k - cells] - off[k - cells - 1];
      z[k] = zig(off[k] - pred);
    }
  }
  return z;
}

export function planarRestore(z, cells) {
  const off = new Int32Array(z.length);
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const k = j * cells + i;
      let pred;
      if (i === 0 && j === 0) pred = 0;
      else if (j === 0) pred = off[k - 1];
      else if (i === 0) pred = off[k - cells];
      else pred = off[k - 1] + off[k - cells] - off[k - cells - 1];
      off[k] = unzig(z[k]) + pred;
    }
  }
  return off;
}

/**
 * 양자화 형식 셋(Q16·BPO·BPP)을 실제로 부호화해 바이트와 복원 높이를 낸다.
 * @returns {{ q16:number, bpo:number, bpp:number, bpx:number, bitsO:number, bitsP:number, heights:Float32Array, range:number }}
 *   heights = 세 형식 공통 복원값(BPO·BPP 복호 결과가 Q16 과 같은지 verify 가 참이면 확인한다).
 */
export function encodeQuantized(tile, step, { verify = false } = {}) {
  if (tile.heights.length !== tile.cells * tile.cells) {
    throw new RangeError(`heights.length ${tile.heights.length} != cells^2 ${tile.cells * tile.cells}`);
  }
  const { k0, off, range, stepF32 } = quantize(tile.heights, step);
  if (range > 0xffff) throw new RangeError(`Q16 overflow: 타일 (${tile.tx},${tile.ty}) 오프셋 범위 ${range} > 65535 (step ${step})`);
  const n = off.length;
  const bitsO = bitsFor(range);
  const packedO = packBits(off, bitsO);
  const z = planarResiduals(off, tile.cells);
  let zMax = 0;
  for (let k = 0; k < n; k++) if (z[k] > zMax) zMax = z[k];
  const bitsP = bitsFor(zMax);
  const packedP = packBits(z, bitsP);
  const heights = dequantize(k0, off, stepF32);
  if (verify) {
    const o2 = unpackBits(packedO, n, bitsO);
    const o3 = planarRestore(unpackBits(packedP, n, bitsP), tile.cells);
    for (let k = 0; k < n; k++) {
      if (o2[k] !== off[k] || o3[k] !== off[k]) throw new Error(`왕복 불일치 k=${k}`);
    }
  }
  return {
    q16: PIECE_FRAME_OVERHEAD_BYTES + Q16_HEADER_BYTES + 2 * n,
    bpo: PIECE_FRAME_OVERHEAD_BYTES + BP_HEADER_BYTES + packedO.byteLength,
    bpp: PIECE_FRAME_OVERHEAD_BYTES + BP_HEADER_BYTES + packedP.byteLength,
    bpx: PIECE_FRAME_OVERHEAD_BYTES + BP_HEADER_BYTES + Math.min(packedO.byteLength, packedP.byteLength),
    bitsO, bitsP, heights, range,
  };
}
