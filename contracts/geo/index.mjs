// 좌표 계약(T04). 로컬 좌표는 GeoAnchor 기준 ENU, 1 unit = 1 m. 씬 좌표는 x=동, y=위, z=−북(three.js 규약).
// 하위 작업이 채울 함수의 서명은 ./stubs.mjs 에 있다.

/** @typedef {{lat: number, lon: number, alt: number}} Gps 도·도·m(타원체 높이로 가정; skylens 가 쓰는 높이 기준은 T04.5 가 확인) */
/** @typedef {Gps} GeoAnchor ENU 원점 */
/** @typedef {[number, number, number]} Enu [동, 북, 위] m */
/** @typedef {[number, number, number]} Scene [x, y, z] = [동, 위, −북] */

/** WGS-84 타원체 상수. 기본 GPS↔ENU 는 skylens `geo.ts` 와 같은 등장방형 근사(EARTH_RADIUS_M)를 쓰고(F-071),
 * 이 상수는 참고용 정확식(server/geo/enu 의 gpsToEnuExact)과 client/geo 가 쓴다. */
export const WGS84 = Object.freeze({ a: 6378137, f: 1 / 298.257223563 });

export class GeoError extends Error {
  constructor(code, message) { super(`geo: ${code}: ${message}`); this.name = 'GeoError'; this.code = code; }
}

// 좌표 표현은 배열 [a, b, c] 만 받는다(F-072). 객체 {e,n,u}·형식 배열·길이 3 아님·비유한은 GeoError('range').
// 객체 표현이 필요하면 server/geo/enu 의 enuObjToArray·enuArrayToObj 어댑터를 쓴다.
function checkVec3(v, name) {
  if (!Array.isArray(v) || v.length !== 3) throw new GeoError('range', `${name}: 길이 3 배열이어야 한다`);
  for (let i = 0; i < 3; i++) {
    if (typeof v[i] !== 'number' || !Number.isFinite(v[i])) throw new GeoError('range', `${name}[${i}] 유한한 수가 아님: ${v[i]}`);
  }
}

/** ENU → 씬 좌표 [x, y, z] = [e, u, −n]. −0 은 +0 으로 정규화한다(server/geo/scene 의 enuArrayToScene 과 같은 값).
 * @param {Enu} enu @returns {Scene} */
export function enuToScene(enu) {
  checkVec3(enu, 'enuToScene');
  return [enu[0] + 0, enu[2] + 0, 0 - enu[1]];
}
/** 씬 좌표 → ENU [e, n, u] = [x, −z, y]. −0 은 +0 으로 정규화한다.
 * @param {Scene} s @returns {Enu} */
export function sceneToEnu(s) {
  checkVec3(s, 'sceneToEnu');
  return [s[0] + 0, 0 - s[2], s[1] + 0];
}

/** skylens src/shared/geo.ts 의 지구 반경 R(m). GPS↔ENU 소영역 등장방형 근사가 쓴다(F-071). */
export const EARTH_RADIUS_M = 6378137;
