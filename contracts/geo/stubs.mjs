// T04.5·T04.6·T04.7 하위 작업이 채울 서명. 이 파일은 고치지 않는다.
/** @typedef {import('./index.mjs').Gps} Gps */
/** @typedef {import('./index.mjs').Enu} Enu */
const ni = (n, o) => { throw new Error(`not implemented: ${n} (${o})`); };

/** T04.5 server/geo/enu/ — GPS → ENU(anchor 기준). 비유한·위도 범위(−90..90)·경도 범위 밖은 GeoError('range').
 * @param {Gps} gps @param {Gps} anchor @returns {Enu} */
export function gpsToEnu(gps, anchor) { return ni('gpsToEnu', 'T04.5'); }
/** T04.5 — ENU → GPS(역변환, 왕복 오차 ≤ 1 mm). @param {Enu} enu @param {Gps} anchor @returns {Gps} */
export function enuToGps(enu, anchor) { return ni('enuToGps', 'T04.5'); }
/** T04.6 server/geo/scene/ — ENU 배열 3n → 씬 좌표 배열(복사). @param {Float32Array|Float64Array} enu @returns {Float32Array} */
export function enuArrayToScene(enu) { return ni('enuArrayToScene', 'T04.6'); }
/** T04.6 — 역. @param {Float32Array|Float64Array} scene @returns {Float32Array} */
export function sceneArrayToEnu(scene) { return ni('sceneArrayToEnu', 'T04.6'); }
/** T04.7 client/geo/ — 클라이언트 측 gpsToEnu(서버 구현과 같은 값). node: 모듈·Buffer 금지. */
export function gpsToEnuClient(gps, anchor) { return ni('gpsToEnuClient', 'T04.7'); }
