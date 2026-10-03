// 클라이언트 측 GPS → ENU. skylens develop src/shared/geo.ts 와 같은 등장방형(equirectangular) 소영역 근사(F-071).
//   e = Δλ · R · cos(φ0),  n = Δφ · R,  u = alt − alt0
//   R = EARTH_RADIUS_M(6378137 m), Δφ·Δλ 는 라디안, φ0 는 앵커 위도(라디안).
// 타원체 정확식이 아니다. 앵커에서 멀어질수록(수십 km 이상) 실제 거리와 어긋나지만 skylens 와 같은 값을 내는 것이 목적이다.
// 순수 JS, Math 만 사용.
import { EARTH_RADIUS_M, GeoError } from '../../contracts/geo/index.mjs';

const DEG = Math.PI / 180;

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

/** GPS → ENU [동, 북, 위] m (anchor 기준, 등장방형 근사). 비유한·범위 밖 입력과 비유한 결과는 GeoError('range'). */
export function gpsToEnuClient(gps, anchor) {
  check(gps, 'gps');
  check(anchor, 'anchor');
  const dPhi = (gps.lat - anchor.lat) * DEG; // Δφ (rad)
  // 경도 차가 ±180° 를 넘으면 짧은 쪽으로 감싼다(서버 gpsToEnu 와 같음). |Δ| ≤ 180 이면 geo.ts 와 같은 값.
  let dLon = gps.lon - anchor.lon;
  if (dLon > 180) dLon -= 360; else if (dLon < -180) dLon += 360;
  const dLambda = dLon * DEG; // Δλ (rad)
  // 극 앵커(|cos φ0| < 1e-12)는 동쪽이 정의되지 않아 e = 0(서버 gpsToEnu 와 같음)
  const cosPhi0 = Math.cos(anchor.lat * DEG);
  const e = dLambda * EARTH_RADIUS_M * (Math.abs(cosPhi0) < 1e-12 ? 0 : cosPhi0);
  const n = dPhi * EARTH_RADIUS_M;
  const u = gps.alt - anchor.alt;
  if (!Number.isFinite(e) || !Number.isFinite(n) || !Number.isFinite(u)) {
    throw new GeoError('range', `non-finite ENU result: ${e}, ${n}, ${u}`);
  }
  return [e, n, u];
}
