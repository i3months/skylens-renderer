// 클라이언트 측 GPS → ENU(WGS-84 타원체 → ECEF → anchor 기준 ENU 정확식). 순수 JS, Math 만 사용.
import { WGS84, GeoError } from '../../contracts/geo/index.mjs';

const RAD = Math.PI / 180;
const E2 = WGS84.f * (2 - WGS84.f); // 제1 이심률 제곱

// 입력 검증: 유한 + 위도 −90..90 + 경도 −180..180
function check(g, name) {
  if (g === null || typeof g !== 'object') throw new GeoError('range', `${name} must be an object`);
  const { lat, lon, alt } = g;
  if (typeof lat !== 'number' || typeof lon !== 'number' || typeof alt !== 'number'
    || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(alt)) {
    throw new GeoError('range', `${name} has non-finite lat/lon/alt`);
  }
  if (lat < -90 || lat > 90) throw new GeoError('range', `${name}.lat out of range: ${lat}`);
  if (lon < -180 || lon > 180) throw new GeoError('range', `${name}.lon out of range: ${lon}`);
}

function toEcef(g) {
  const la = g.lat * RAD, lo = g.lon * RAD;
  const sl = Math.sin(la), cl = Math.cos(la);
  const n = WGS84.a / Math.sqrt(1 - E2 * sl * sl);
  return [(n + g.alt) * cl * Math.cos(lo), (n + g.alt) * cl * Math.sin(lo), (n * (1 - E2) + g.alt) * sl];
}

/** GPS → ENU [동, 북, 위] m (anchor 기준). 서버 gpsToEnu 와 같은 값. */
export function gpsToEnuClient(gps, anchor) {
  check(gps, 'gps');
  check(anchor, 'anchor');
  const p = toEcef(gps), o = toEcef(anchor);
  const dx = p[0] - o[0], dy = p[1] - o[1], dz = p[2] - o[2];
  const la = anchor.lat * RAD, lo = anchor.lon * RAD;
  const sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
  return [
    -so * dx + co * dy,
    -sl * co * dx - sl * so * dy + cl * dz,
    cl * co * dx + cl * so * dy + sl * dz,
  ];
}
