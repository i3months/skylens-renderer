// 좌표 계약(T04). 로컬 좌표는 GeoAnchor 기준 ENU, 1 unit = 1 m. 씬 좌표는 x=동, y=위, z=−북(three.js 규약).
// 하위 작업이 채울 함수의 서명은 ./stubs.mjs 에 있다.

/** @typedef {{lat: number, lon: number, alt: number}} Gps 도·도·m(타원체 높이로 가정; skylens 가 쓰는 높이 기준은 T04.5 가 확인) */
/** @typedef {Gps} GeoAnchor ENU 원점 */
/** @typedef {[number, number, number]} Enu [동, 북, 위] m */
/** @typedef {[number, number, number]} Scene [x, y, z] = [동, 위, −북] */

/** 지구 모델: WGS-84. skylens `geo.ts` 의 식이 다르면(예: 구면 근사) T04.5 가 같은 식으로 맞추고 결정 기록에 쓴다. */
export const WGS84 = Object.freeze({ a: 6378137, f: 1 / 298.257223563 });

/** ENU → 씬 좌표 [x, y, z] = [e, u, −n]. */
export function enuToScene(enu) { return [enu[0], enu[2], -enu[1]]; }
/** 씬 좌표 → ENU. */
export function sceneToEnu(s) { return [s[0], -s[2], s[1]]; }

export class GeoError extends Error {
  constructor(code, message) { super(`geo: ${code}: ${message}`); this.name = 'GeoError'; this.code = code; }
}

/** skylens src/shared/geo.ts 의 지구 반경 R(m). GPS↔ENU 소영역 등장방형 근사가 쓴다(F-071). */
export const EARTH_RADIUS_M = 6378137;
