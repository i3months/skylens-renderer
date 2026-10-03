// 원본 점 입력 계약(T04). 두 형식: 27 B 점(법선 포함)과 56 B 가우시안(0차 SH 색·불투명도·크기·회전).
// 모든 값은 little-endian, PLY 는 binary_little_endian 이다. 좌표는 GeoAnchor 기준 ENU(m)로 가정한다(T04 가 실제 자산 축을 확인).
// 하위 작업이 채울 함수의 서명은 ./stubs.mjs 에 있다.

/** 형식 표시. contracts/asset 의 FORMAT_POINT27·FORMAT_GAUSS56 과 같은 값이다. */
export const FORMAT_POINT27 = 1;
export const FORMAT_GAUSS56 = 2;
export const RECORD_BYTES = Object.freeze({ [FORMAT_POINT27]: 27, [FORMAT_GAUSS56]: 56 });

/** 27 B 점 레코드: x y z nx ny nz (f32) r g b (u8). 위치·법선 순서와 형은 정확히 이렇고, 색 속성 이름 red/green/blue 는 PLY 관례를 따른다(실제 skylens 자산은 모두 56 B 라 27 B 실물 근거는 없음). */
export const POINT27_PROPERTIES = Object.freeze([
  { name: 'x', type: 'float' }, { name: 'y', type: 'float' }, { name: 'z', type: 'float' },
  { name: 'nx', type: 'float' }, { name: 'ny', type: 'float' }, { name: 'nz', type: 'float' },
  { name: 'red', type: 'uchar' }, { name: 'green', type: 'uchar' }, { name: 'blue', type: 'uchar' },
]);
/** 56 B 가우시안 레코드: x y z f_dc_0..2 opacity scale_0..2 rot_0..3 (모두 f32). */
export const GAUSS56_PROPERTIES = Object.freeze([
  ...['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
    .map((name) => ({ name, type: 'float' })),
]);
export const PROPERTIES = Object.freeze({ [FORMAT_POINT27]: POINT27_PROPERTIES, [FORMAT_GAUSS56]: GAUSS56_PROPERTIES });

const TYPE_BYTES = { float: 4, uchar: 1 };
export const stride = (props) => props.reduce((s, p) => s + TYPE_BYTES[p.type], 0);

/**
 * @typedef {Object} Point27Cloud  원본 27 B 점군(열 배열)
 * @property {1} format
 * @property {number} count
 * @property {Float32Array} positions 3n [x,y,z]
 * @property {Float32Array} normals   3n 원본 값 그대로(길이 1 미보장, T04.8 이 검사)
 * @property {Uint8Array} colors      3n rgb
 *
 * @typedef {Object} Gauss56Cloud  원본 56 B 가우시안(열 배열)
 * @property {2} format
 * @property {number} count
 * @property {Float32Array} positions 3n
 * @property {Float32Array} fdc       3n f_dc_0..2
 * @property {Float32Array} opacity   n  로짓(시그모이드 전 값)
 * @property {Float32Array} scales    3n ln s
 * @property {Float32Array} rotations 4n (w,x,y,z) = rot_0..3, 정규화 미보장
 */

/** 점 입력 오류. code: 'header' | 'format' | 'size' | 'truncated' | 'range' | 'name'. */
export class PointsError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(`points: ${code}: ${message}`);
    this.name = 'PointsError';
    this.code = code;
  }
}

/**
 * PLY 머리 속성 목록으로 두 형식을 가른다. 이름·순서·형이 POINT27_PROPERTIES 또는 GAUSS56_PROPERTIES 와 정확히 같을 때만 형식을 돌려주고,
 * 그 밖(속성 추가·순서 다름·double 좌표·rgb 이름 다름)은 null 을 돌려준다(추측하지 않는다).
 * 실제 skylens 자산은 56 B 가우시안 PLY 다(F-002 측정: stride 56).
 * @param {{name: string, type: string}[]} properties parsePlyHeader 의 properties
 * @returns {1|2|null}
 */
export function detectFormat(properties) {
  for (const f of [FORMAT_POINT27, FORMAT_GAUSS56]) {
    const exp = PROPERTIES[f];
    if (properties.length === exp.length && properties.every((p, i) => p.name === exp[i].name && p.type === exp[i].type)) return f;
  }
  return null;
}
