// 지형 높이만 전송 형식(H32) 계약(T15.10e, 결정 0058). 좌표는 GeoAnchor 기준 ENU, 1 unit = 1 m.
// 한 타일 = 머리 + 높이 배열. xy·인덱스는 보내지 않는다(받는 쪽이 cells·tx·ty 로 격자에서 만든다).
// 머리(리틀 엔디언): u8 magic(0x48) | u8 version(1) | u8 lod | u8 flags(bit0 = 양자화) | i32 tx | i32 ty | u16 cells | u16 0(예약)
//   = 16 B. 양자화면 이어서 f32 base | f32 step = 8 B 더(24 B). 뒤따르는 본문: 비양자화 f32[cells²], 양자화 u16[cells²](j·cells + i).
// 양자화: LOD 1~3 만, step = TERRAIN_H32_STEP_M, base = 타일 높이 최솟값(f32), q = round((h − base)/step), 복원 h' = fround(base + q·step).
//   (max − min)/step > 65535 이면 그 타일은 비양자화(f32)로 보낸다. LOD 0 은 늘 비양자화(계약 상한 0 m 유지).
//   양자화 타일의 실제 오차 상한 = terrainLodMaxErrorM(lod, cellM) + TERRAIN_H32_STEP_M/2 (+ f32 반올림).
// 구현 위치: 서버 server/terrain/height_format/index.mjs encodeTerrainTileH32(tile, opts?) -> Uint8Array,
//   클라이언트 client/tower/terrain/decode.mjs decodeTerrainTileH32(bytes) -> TerrainTile. 클라이언트는 이 파일(contracts)만 가져온다.

export const TERRAIN_H32_MAGIC = 0x48;
export const TERRAIN_H32_VERSION = 1;
export const TERRAIN_H32_HEADER_BYTES = 16;
export const TERRAIN_H32_QUANT_EXTRA_BYTES = 8;
export const TERRAIN_H32_FLAG_QUANTIZED = 1;
/** 양자화 간격(m). 결정 0056 은 noiseBig 시드 0 한 장면만 쟀다(하락 0.0076). ssim_h32.test 측정(31 장면): 하락 최대 hill 0.0365·lowNoise 0.0183·noiseBig 0.0090, 최소 SSIM 0.9555(여유 약 0.006). 작업자가 정한 상한이며 SPEC 수치가 아니다. */
export const TERRAIN_H32_STEP_M = 0.05;
export const TERRAIN_H32_MAX_Q = 65535;
/** 초기 지형 몫(raw 웹소켓 바이트): 15,000,000 − 건물 3,157,410 − 드레이프 밉2 1,062,400 − WELCOME 27(결정 0056, 감독 승인 해석). */
export const TERRAIN_INITIAL_BUDGET_BYTES = 10_780_163;
/** 초기 합계 상한(SPEC S6). */
export const INITIAL_TOTAL_LIMIT_BYTES = 15_000_000;

/** 타일 하나의 H32 바이트 수. */
export function terrainH32Bytes(cells, quantized) {
  if (!Number.isInteger(cells) || cells < 2 || cells > 0xffff) throw new RangeError(`cells ${String(cells)}`);
  return TERRAIN_H32_HEADER_BYTES + (quantized ? TERRAIN_H32_QUANT_EXTRA_BYTES + 2 * cells * cells : 4 * cells * cells);
}

/**
 * 높이 배열 양자화. 양자화할 수 없으면(범위 초과·비유한) null.
 * @param {Float32Array} heights
 * @param {number} [step]
 * @returns {{ base:number, step:number, q:Uint16Array }|null}
 */
export function quantizeHeights(heights, step = TERRAIN_H32_STEP_M) {
  const s = Math.fround(step);
  if (!(s > 0) || !Number.isFinite(s) || heights.length === 0) return null;
  let min = Infinity, max = -Infinity;
  for (const h of heights) {
    if (!Number.isFinite(h)) return null;
    if (h < min) min = h;
    if (h > max) max = h;
  }
  if ((max - min) / s > TERRAIN_H32_MAX_Q) return null;
  const base = Math.fround(min);
  const q = new Uint16Array(heights.length);
  for (let k = 0; k < heights.length; k++) {
    const v = Math.round((heights[k] - base) / s);
    q[k] = v < 0 ? 0 : v > TERRAIN_H32_MAX_Q ? TERRAIN_H32_MAX_Q : v;
  }
  return { base, step: s, q };
}

/** 양자화 복원. */
export function dequantizeHeights(base, step, q) {
  const out = new Float32Array(q.length);
  for (let k = 0; k < q.length; k++) out[k] = Math.fround(base + q[k] * step);
  return out;
}

/** 양자화 후 오차 상한(m): LOD 상한 + step/2 (f32 반올림 제외). */
export function terrainH32ErrorBoundM(lodMaxErrorM, quantized, step = TERRAIN_H32_STEP_M) {
  return lodMaxErrorM + (quantized ? step / 2 : 0);
}
