// 지형 높이만 전송 형식(H32) 계약(T15.10e, 결정 0058). 좌표는 GeoAnchor 기준 ENU, 1 unit = 1 m.
// 한 타일 = 머리 + 높이 배열. xy·인덱스는 보내지 않는다(받는 쪽이 cells·tx·ty 로 격자에서 만든다).
// 머리(리틀 엔디언): u8 magic(0x48) | u8 version(2) | u8 lod | u8 flags(bit0 = 양자화) | i32 tx | i32 ty | u16 cells | u16 0(예약)
//   = 16 B. 양자화면 이어서 i32 kbase | f32 step = 8 B 더(24 B). 뒤따르는 본문: 비양자화 f32[cells²], 양자화 u16[cells²](j·cells + i).
// 양자화(전역 격자, F-492): LOD 1~3 만, step = TERRAIN_H32_STEP_M. 격자 번호 K(h) = round(h/step)(배정밀도 나눗셈),
//   kbase = floor(min/step)(i32), q = K(h) − kbase, 복원 h' = fround((kbase + q)·step) = fround(K(h)·step).
//   kbase + q 는 정확한 정수이고 정수·step 곱의 배정밀도 반올림 → f32 반올림이 타일과 무관하므로, 같은 h 는 어느 타일에서든
//   같은 비트로 복원된다(같은 DEM·같은 LOD 이웃의 공유 가장자리 균열 없음). |h| 가 커도(예 8000 m) 같은 K 면 같은 비트다.
//   K(max) − kbase > 65535 이거나 kbase 또는 K(max) 가 i32 를 벗어나면 그 타일은 비양자화(f32)로 보낸다.
// 폴백 정책: LOD 1~3 에서 양자화하려다 범위 초과로 폴백한 타일은 f32 본문에 원본 대신 같은 전역 격자로 반올림한 값
//   snapHeightsToGrid(h) = fround(K(h)·step) 를 싣는다. 그래서 한쪽만 폴백한 이웃 사이 가장자리도 비트 동일하다.
//   LOD 0 은 늘 원본 그대로 f32(계약 상한 0 m 유지) — LOD0 이웃 가장자리는 원본 공유 표본이라 비트 동일하다.
//   호출자가 LOD 1~3 에서 quantize:false 를 주면 원본 f32 를 싣는다. 이때 이웃과 균열이 없으려면 같은 LOD 의 모든 타일에 같은 선택을 써야 한다.
//   LOD 1~3 타일(양자화·격자 폴백 모두)의 오차 상한 = terrainLodMaxErrorM(lod, cellM) + TERRAIN_H32_STEP_M/2 + f32 반올림(≈ |h|·2⁻²⁴).
// 구현 위치: 서버 server/terrain/height_format/index.mjs encodeTerrainTileH32(tile, opts?) -> Uint8Array,
//   클라이언트 client/tower/terrain/decode.mjs decodeTerrainTileH32(bytes) -> TerrainTile. 클라이언트는 이 파일(contracts)만 가져온다.

export const TERRAIN_H32_MAGIC = 0x48;
/** 형식 판. 2 = 양자화 머리 i32 kbase(전역 격자). 1(f32 base, 타일별 격자)은 받지 않는다. */
export const TERRAIN_H32_VERSION = 2;
export const TERRAIN_H32_HEADER_BYTES = 16;
export const TERRAIN_H32_QUANT_EXTRA_BYTES = 8;
export const TERRAIN_H32_FLAG_QUANTIZED = 1;
/** 양자화 격자 간격(m). 전역 격자라 모든 타일이 같은 step 을 써야 한다(디코더가 다른 step 을 거부). 선택 근거(F-493, 전역 격자 6e138ea 에서 재측정, ssim_h32_sweep.mjs, 128 장면 × LOD1~3 × 8시점): step 0.25 는 noiseBig 시드 6 에서 SSIM 0.9489 미달, 0.15 이하는 모든 장면 ≥ 0.95(0.15 최소 0.9627, 0.1 0.9642, 0.05 0.9647, 0.03 0.9648). 바이트는 step 과 무관(u16)이고 최소 SSIM 은 step ≤ 0.1 에서 LOD 솎기(lowNoise012 0.9647)가 정하므로, 오차를 줄이는 쪽(양자화 오차 ≤ step/2 = 0.015 m)으로 0.03 m 를 둔다. 작업자가 정한 값이며 SPEC 수치가 아니다. */
export const TERRAIN_H32_STEP_M = 0.03;
export const TERRAIN_H32_MAX_Q = 65535;
const I32_MIN = -0x80000000, I32_MAX = 0x7fffffff;
/** 초기 지형 몫(raw 웹소켓 바이트): 15,000,000 − 건물 3,157,410 − 드레이프 밉2 1,062,400 − WELCOME 27(결정 0056, 감독 승인 해석). */
export const TERRAIN_INITIAL_BUDGET_BYTES = 10_780_163;
/** 초기 합계 상한(SPEC S6). */
export const INITIAL_TOTAL_LIMIT_BYTES = 15_000_000;

/** 타일 하나의 H32 바이트 수. */
export function terrainH32Bytes(cells, quantized) {
  if (!Number.isInteger(cells) || cells < 2 || cells > 0xffff) throw new RangeError(`cells ${String(cells)}`);
  return TERRAIN_H32_HEADER_BYTES + (quantized ? TERRAIN_H32_QUANT_EXTRA_BYTES + 2 * cells * cells : 4 * cells * cells);
}

/** 배열(Array) 또는 TypedArray 만 받는다. BigInt64Array·BigUint64Array 는 원소가 bigint 라 산술에서 TypeError 가 나므로 RangeError 로 거부한다. length 만 있는 유사배열·문자열·DataView(length 없음, 빈 배열처럼 조용히 통과하던 입력)는 RangeError. */
function checkArray(a, name) {
  if (!Array.isArray(a) && !(ArrayBuffer.isView(a) && !(a instanceof DataView) && !(a instanceof BigInt64Array) && !(a instanceof BigUint64Array))) throw new RangeError(`${name} 가 배열이 아니다: ${String(a)}`);
}

/** step 이 number 가 아니면(문자열·불리언 등 암묵 변환 대상) RangeError. 유효한 number 면 f32 로 반올림한 값, 0 이하·비유한(f32 반올림 후 포함)이면 null. */
function checkStep(step) {
  if (typeof step !== 'number') throw new RangeError(`step ${String(step)} 가 number 가 아니다`);
  const s = Math.fround(step);
  return s > 0 && Number.isFinite(s) ? s : null;
}

/**
 * 높이 배열을 전역 격자로 양자화한다. 양자화할 수 없으면(비유한 높이·step ≤ 0·비유한 step·빈 배열·격자 범위 초과·i32 초과·복원값 fround(K·step)(K = 최소·최대의 격자 번호) 이 비유한(f32 범위 초과, dequantizeHeights 가 던지는 입력)) null. step 이 number 가 아니면 RangeError.
 * 반환 base 는 kbase 와 같은 값이다(옛 필드 이름 호환: dequantizeHeights(r.base, r.step, r.q) 호출이 그대로 동작한다).
 * @param {Float32Array} heights
 * @param {number} [step]
 * @returns {{ kbase:number, base:number, step:number, q:Uint16Array }|null}
 */
export function quantizeHeights(heights, step = TERRAIN_H32_STEP_M) {
  checkArray(heights, 'heights');
  const s = checkStep(step);
  if (s === null || heights.length === 0) return null;
  let min = Infinity, max = -Infinity;
  for (const h of heights) {
    if (!Number.isFinite(h)) return null;
    if (h < min) min = h;
    if (h > max) max = h;
  }
  const kbase = Math.floor(min / s);
  const kmin = Math.round(min / s), kmax = Math.round(max / s);
  if (kbase < I32_MIN || kbase > I32_MAX || kmax > I32_MAX) return null;
  if (kmax - kbase > TERRAIN_H32_MAX_Q) return null;
  // 복원 단조성: 양 끝(실제 최소 격자 번호 kmin·s, kmax·s)의 f32 복원값이 유한하면 사이 값도 유한하다. kbase(floor)는 kmin 보다 1 작을 수 있고 그 복원값은 쓰이지 않으므로 kbase·s 로 검사하지 않는다. 아니면 dequantizeHeights 가 던지므로 여기서 거른다.
  if (!Number.isFinite(Math.fround(kmin * s)) || !Number.isFinite(Math.fround(kmax * s))) return null;
  const q = new Uint16Array(heights.length);
  // 나눗셈이 단조이므로 min ≤ h ≤ max 이면 kbase ≤ round(h/s) ≤ kmax, q 는 0..65535 안이다.
  for (let k = 0; k < heights.length; k++) q[k] = Math.round(heights[k] / s) - kbase;
  return { kbase, base: kbase, step: s, q };
}

/** 양자화 복원: fround((kbase + q)·step). kbase 는 i32 정수. step·q 가 잘못됐거나 복원값이 비유한(f32 범위 초과)이면 RangeError. */
export function dequantizeHeights(kbase, step, q) {
  if (typeof step !== 'number' || !Number.isFinite(step) || !(step > 0)) throw new RangeError(`step ${String(step)} 가 유한한 양수가 아니다`);
  if (!Number.isInteger(kbase) || kbase < I32_MIN || kbase > I32_MAX) throw new RangeError(`kbase ${String(kbase)} 가 i32 정수가 아니다`);
  checkArray(q, 'q');
  // step 은 f32 로 반올림해 쓴다: double 0.03 과 fround(0.03) 가 같은 비트를 내야 한다(quantizeHeights 는 fround 한 step 으로 격자를 만든다).
  const s = Math.fround(step);
  if (!(s > 0) || !Number.isFinite(s)) throw new RangeError(`step ${String(step)} 가 f32 로 유한한 양수가 아니다`);
  const out = new Float32Array(q.length);
  for (let k = 0; k < q.length; k++) {
    const v = q[k];
    if (!Number.isInteger(v) || v < 0 || v > TERRAIN_H32_MAX_Q) throw new RangeError(`q[${k}] ${String(v)} 가 0..65535 정수가 아니다`);
    const r = Math.fround((kbase + v) * s);
    if (!Number.isFinite(r)) throw new RangeError(`복원값이 비유한이다: (${kbase} + ${v})·${String(step)}`);
    out[k] = r;
  }
  return out;
}

/**
 * 폴백(f32) 타일용: 높이를 양자화와 같은 전역 격자 값 fround(round(h/step)·step) 로 반올림한다.
 * 같은 h 는 dequantizeHeights 복원과 같은 비트가 된다. 비유한 높이·잘못된 step·복원값 비유한이면 null.
 * @returns {Float32Array|null}
 */
export function snapHeightsToGrid(heights, step = TERRAIN_H32_STEP_M) {
  checkArray(heights, 'heights');
  const s = checkStep(step);
  if (s === null) return null;
  const out = new Float32Array(heights.length);
  for (let k = 0; k < heights.length; k++) {
    if (!Number.isFinite(heights[k])) return null;
    // + 0: h ∈ (−s/2, 0) 이면 round 가 −0 을 내 비트가 0x80000000 이 된다. 양자화 복원 경로는 +0 이므로 +0 으로 맞춘다(−0 + 0 = +0).
    const v = Math.fround(Math.round(heights[k] / s) * s) + 0;
    if (!Number.isFinite(v)) return null;
    out[k] = v;
  }
  return out;
}

/**
 * 오차 상한(m), f32 반올림 항 제외: LOD 상한 + (격자 반올림이면 step/2).
 * quantized = 전역 격자 반올림을 거쳤는가(양자화 타일과 LOD 1~3 격자 폴백 타일 모두 true, LOD 0·quantize:false 는 false).
 * 실제 오차는 여기에 복원값의 f32 반올림(≈ |h|·2⁻²⁴, 8000 m 대에서 약 0.0005 m)이 더해질 수 있다 — 이 함수는 그 항을 넣지 않는다.
 */
export function terrainH32ErrorBoundM(lodMaxErrorM, quantized, step = TERRAIN_H32_STEP_M) {
  return lodMaxErrorM + (quantized ? step / 2 : 0);
}
