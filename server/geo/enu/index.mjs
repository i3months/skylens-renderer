// T04.5 GPS ↔ ENU. WGS-84 타원체 정확식(측지 → ECEF → anchor 기준 동·북·위). 구면 근사 아님.
import { WGS84, GeoError } from '../../../contracts/geo/index.mjs';

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
 * GPS → ENU(anchor 기준, m). 비유한·범위 밖은 GeoError('range').
 * @param {import('../../../contracts/geo/index.mjs').Gps} gps
 * @param {import('../../../contracts/geo/index.mjs').Gps} anchor
 * @returns {import('../../../contracts/geo/index.mjs').Enu}
 */
export function gpsToEnu(gps, anchor) {
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
 * ENU → GPS(역변환). 비유한·anchor 범위 밖은 GeoError('range').
 * @param {import('../../../contracts/geo/index.mjs').Enu} enu
 * @param {import('../../../contracts/geo/index.mjs').Gps} anchor
 * @returns {import('../../../contracts/geo/index.mjs').Gps}
 */
export function enuToGps(enu, anchor) {
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
