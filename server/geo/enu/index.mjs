// T04.5 GPS ↔ ENU. 기본 경로(gpsToEnu·enuToGps)는 skylens develop src/shared/geo.ts
// (NET-Challenge-S13/skylens, 커밋 59edcf9b38b0887cb63dcaa2daa07a123f81dd95)와 같은 등장방형 소영역 근사다(F-071).
// 식만 맞추고 코드는 따로 썼다:
//   e = Δλ·R·cos(φ0), n = Δφ·R, u = alt − alt0  (Δ 는 라디안, φ0 = 앵커 위도, R = EARTH_RADIUS_M = 6378137)
//   역: φ = φ0 + n/R, λ = λ0 + e/(R·cos φ0), alt = alt0 + u
// 좌표 표현은 배열 [e, n, u](F-072). skylens 의 객체 {e,n,u} 는 enuObjToArray·enuArrayToObj 로 바꾼다.
// WGS-84 정확식은 참고용 gpsToEnuExact·enuToGpsExact 로만 남기고 기본 경로에서 쓰지 않는다.
import { WGS84, GeoError, EARTH_RADIUS_M, enuToScene, sceneToEnu } from '../../../contracts/geo/index.mjs';

// skylens geo.ts 의 이름 6개를 이 모듈 하나에서 제공한다(enuToScene·sceneToEnu 는 계약의 것을 그대로 내보냄).
export { enuToScene, sceneToEnu };

const A = WGS84.a;
const F = WGS84.f;
const E2 = F * (2 - F); // 제1 이심률 제곱
const DEG = Math.PI / 180;

// 입력 검사: 유한·위도 −90..90·경도 −180..180
function checkGps(g, name) {
  if (g === null || typeof g !== 'object') throw new GeoError('range', `${name} 가 객체가 아니다`);
  const { lat, lon, alt } = g;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(alt)) {
    throw new GeoError('range', `${name} 에 유한하지 않은 값: ${lat}, ${lon}, ${alt}`);
  }
  if (lat < -90 || lat > 90) throw new GeoError('range', `${name}.lat 범위 밖: ${lat}`);
  if (lon < -180 || lon > 180) throw new GeoError('range', `${name}.lon 범위 밖: ${lon}`);
}

function checkEnu(enu) {
  if (enu === null || typeof enu !== 'object' || enu.length !== 3) {
    throw new GeoError('range', 'enu 는 길이 3 배열이어야 한다');
  }
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(enu[i])) throw new GeoError('range', `enu[${i}] 유한하지 않음: ${enu[i]}`);
  }
}

// 측지 → ECEF
function toEcef(lat, lon, alt) {
  const sp = Math.sin(lat * DEG), cp = Math.cos(lat * DEG);
  const sl = Math.sin(lon * DEG), cl = Math.cos(lon * DEG);
  const n = A / Math.sqrt(1 - E2 * sp * sp);
  return [(n + alt) * cp * cl, (n + alt) * cp * sl, (n * (1 - E2) + alt) * sp];
}

// anchor 의 ECEF 원점과 회전 계수(sin/cos)
function frame(anchor) {
  const sp = Math.sin(anchor.lat * DEG), cp = Math.cos(anchor.lat * DEG);
  const sl = Math.sin(anchor.lon * DEG), cl = Math.cos(anchor.lon * DEG);
  return { o: toEcef(anchor.lat, anchor.lon, anchor.alt), sp, cp, sl, cl };
}

/**
 * 참고용 WGS-84 정확식 GPS → ENU(측지 → ECEF → anchor 기준 동·북·위). 기본 경로에서 쓰지 않는다.
 * @param {import('../../../contracts/geo/index.mjs').Gps} gps
 * @param {import('../../../contracts/geo/index.mjs').Gps} anchor
 * @returns {import('../../../contracts/geo/index.mjs').Enu}
 */
export function gpsToEnuExact(gps, anchor) {
  checkGps(gps, 'gps');
  checkGps(anchor, 'anchor');
  const { o, sp, cp, sl, cl } = frame(anchor);
  const p = toEcef(gps.lat, gps.lon, gps.alt);
  const dx = p[0] - o[0], dy = p[1] - o[1], dz = p[2] - o[2];
  // ECEF 차이를 동·북·위 축에 투영
  return [
    -sl * dx + cl * dy,
    -sp * cl * dx - sp * sl * dy + cp * dz,
    cp * cl * dx + cp * sl * dy + sp * dz,
  ];
}

// ECEF → 측지(위도 고정점 반복; 극·적도 모두 수렴)
function fromEcef(x, y, z) {
  const p = Math.hypot(x, y);
  const lon = Math.atan2(y, x);
  // 초기값: Bowring 근사
  let lat = Math.atan2(z, p * (1 - E2));
  for (let i = 0; i < 20; i++) {
    const s = Math.sin(lat);
    const n = A / Math.sqrt(1 - E2 * s * s);
    const next = Math.atan2(z + E2 * n * s, p);
    const done = Math.abs(next - lat) < 1e-15;
    lat = next;
    if (done) break;
  }
  const s = Math.sin(lat), c = Math.cos(lat);
  const n = A / Math.sqrt(1 - E2 * s * s);
  // 극 근처에서도 안정한 높이식
  const alt = p * c + z * s - A * A / n;
  let lonDeg = lon / DEG;
  if (lonDeg > 180) lonDeg = 180;
  if (lonDeg < -180) lonDeg = -180;
  return { lat: lat / DEG, lon: lonDeg, alt };
}

/**
 * 참고용 WGS-84 정확식 ENU → GPS(gpsToEnuExact 의 역). 기본 경로에서 쓰지 않는다.
 * @param {import('../../../contracts/geo/index.mjs').Enu} enu
 * @param {import('../../../contracts/geo/index.mjs').Gps} anchor
 * @returns {import('../../../contracts/geo/index.mjs').Gps}
 */
export function enuToGpsExact(enu, anchor) {
  checkEnu(enu);
  checkGps(anchor, 'anchor');
  const { o, sp, cp, sl, cl } = frame(anchor);
  const [e, n, u] = enu;
  // 회전 전치로 ECEF 차이 복원
  const dx = -sl * e - sp * cl * n + cp * cl * u;
  const dy = cl * e - sp * sl * n + cp * sl * u;
  const dz = cp * n + sp * u;
  return fromEcef(o[0] + dx, o[1] + dy, o[2] + dz);
}

// ── 기본 경로: skylens geo.ts 와 같은 등장방형 근사 ──

/**
 * GPS → ENU [e, n, u] m(anchor 기준, 등장방형 근사). 비유한·위경도 범위 밖 입력은 GeoError('range').
 * @param {import('../../../contracts/geo/index.mjs').Gps} gps
 * @param {import('../../../contracts/geo/index.mjs').Gps} anchor
 * @returns {import('../../../contracts/geo/index.mjs').Enu}
 */
export function gpsToEnu(gps, anchor) {
  checkGps(gps, 'gps');
  checkGps(anchor, 'anchor');
  const phi0 = anchor.lat * DEG;
  const dPhi = (gps.lat - anchor.lat) * DEG;
  const dLam = (gps.lon - anchor.lon) * DEG;
  return [dLam * EARTH_RADIUS_M * Math.cos(phi0), dPhi * EARTH_RADIUS_M, gps.alt - anchor.alt];
}

/**
 * ENU [e, n, u] → GPS(gpsToEnu 의 역). 입력 비유한·anchor 범위 밖, 또는 결과가 비유한(예: 극 앵커에서
 * cos φ0 ≈ 0 으로 경도가 넘침)이면 GeoError('range'). 결과 경도·위도를 감싸거나 자르지는 않는다(skylens 와 같음).
 * @param {import('../../../contracts/geo/index.mjs').Enu} enu
 * @param {import('../../../contracts/geo/index.mjs').Gps} anchor
 * @returns {import('../../../contracts/geo/index.mjs').Gps}
 */
export function enuToGps(enu, anchor) {
  checkEnu(enu);
  checkGps(anchor, 'anchor');
  const [e, n, u] = enu;
  const lat = anchor.lat + n / EARTH_RADIUS_M / DEG;
  const lon = anchor.lon + e / (EARTH_RADIUS_M * Math.cos(anchor.lat * DEG)) / DEG;
  const alt = anchor.alt + u;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(alt)) {
    throw new GeoError('range', `enuToGps 결과가 유한하지 않다: ${lat}, ${lon}, ${alt}`);
  }
  return { lat, lon, alt };
}

/**
 * GPS → 씬 좌표 [x, y, z] = [동, 위, −북](skylens gpsToScene 과 같은 이름·의미).
 * @param {import('../../../contracts/geo/index.mjs').Gps} gps
 * @param {import('../../../contracts/geo/index.mjs').Gps} anchor
 * @returns {import('../../../contracts/geo/index.mjs').Scene}
 */
export function gpsToScene(gps, anchor) {
  return enuToScene(gpsToEnu(gps, anchor));
}

/**
 * 씬 좌표 [x, y, z] → GPS(skylens sceneToGps 와 같은 이름·의미).
 * @param {import('../../../contracts/geo/index.mjs').Scene} scene
 * @param {import('../../../contracts/geo/index.mjs').Gps} anchor
 * @returns {import('../../../contracts/geo/index.mjs').Gps}
 */
export function sceneToGps(scene, anchor) {
  return enuToGps(sceneToEnu(scene), anchor);
}

/**
 * skylens 객체 표현 {e, n, u} → 배열 [e, n, u]. 객체가 아니거나 성분이 유한한 수가 아니면 GeoError('range').
 * @param {{e: number, n: number, u: number}} o
 * @returns {import('../../../contracts/geo/index.mjs').Enu}
 */
export function enuObjToArray(o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new GeoError('range', 'enuObjToArray: {e,n,u} 객체가 아니다');
  const { e, n, u } = o;
  for (const [k, v] of [['e', e], ['n', n], ['u', u]]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new GeoError('range', `enuObjToArray: ${k} 유한한 수가 아님: ${v}`);
  }
  return [e, n, u];
}

/**
 * 배열 [e, n, u] → skylens 객체 표현 {e, n, u}. 길이 3 배열이 아니거나 비유한이면 GeoError('range').
 * @param {import('../../../contracts/geo/index.mjs').Enu} a
 * @returns {{e: number, n: number, u: number}}
 */
export function enuArrayToObj(a) {
  if (!Array.isArray(a)) throw new GeoError('range', 'enuArrayToObj: 배열이 아니다');
  checkEnu(a);
  return { e: a[0], n: a[1], u: a[2] };
}
