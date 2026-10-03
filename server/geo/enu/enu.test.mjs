// T04.5 GPS ↔ ENU 시험. skylens geo.ts 대조 기준이 없어 독립 검증만 한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeoError } from '../../../contracts/geo/index.mjs';
import { gpsToEnu, enuToGps } from './index.mjs';

// 고정 시드 난수(mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const near = (got, want, tol, msg) =>
  assert.ok(Math.abs(got - want) <= tol, `${msg}: ${got} vs ${want} (허용 ${tol})`);

const SEOUL = { lat: 37.5665, lon: 126.978, alt: 0 };
const EQ = { lat: 0, lon: 0, alt: 0 };

test('(1) 앵커 자신은 (0,0,0)', () => {
  for (const a of [SEOUL, EQ, { lat: -89.9, lon: 179.9, alt: 1234.5 }, { lat: 90, lon: -180, alt: -50 }]) {
    const enu = gpsToEnu(a, a);
    for (const v of enu) near(v, 0, 1e-9, '앵커');
    const g = enuToGps([0, 0, 0], a);
    near(g.lat, a.lat, 1e-12, 'lat');
    near(g.alt, a.alt, 1e-6, 'alt');
    if (Math.abs(a.lat) < 90) near(g.lon, a.lon, 1e-12, 'lon');
  }
});

// (2) 손계산 기준값. WGS-84 a=6378137, e²=f(2−f)=0.00669437999.
//  자오선 곡률반경 M=a(1−e²)/(1−e²sin²φ)^1.5, 묘유선 곡률반경 N=a/√(1−e²sin²φ).
//  적도: 위도 1도 = M0·π/180 = 110574.2758 m, 경도 1도 = a·π/180 = 111319.4908 m.
//  서울 φ=37.5665°: M=6359160.575 m(1도=110988.2897 m), N=6386087.458 m, N·cosφ·π/180 = 88346.9659 m.
//  1000 m 이동의 위 성분(지구 곡면 낙차)은 −d²/(2R): 적도 북 −0.078921, 적도 동 −0.078393,
//  서울 북 −0.078627, 서울 동 −0.078295 m. 위도 고정 동쪽 이동은 위선이 지축 쪽으로 굽어
//  북 성분 +d²·tanφ/(2N) = +0.060223 m(서울), 적도는 0.
test('(2) 동·북 1000 m 손계산 값과 일치', () => {
  // 허용오차 근거: 현(chord)은 호보다 d·θ²/24 ≈ 1 µm, 투영은 d·θ²/6 ≈ 4~7 µm 짧다(θ=d/R≈1.6e-4).
  // 북쪽은 1000 m 사이 M 변화(서울 dM/dφ·Δφ ≈ 9.7 m, 상대 1.5e−6)로 ≈0.8 mm 어긋날 수 있어 5 mm.
  // 위 성분은 d³ 항이 1e−5 m 이하라 1 mm.
  const cases = [
    { a: EQ, g: { lat: 1000 / 110574.2758, lon: 0, alt: 0 }, want: [0, 1000, -0.078921], tol: [1e-6, 5e-3, 1e-3] },
    { a: EQ, g: { lat: 0, lon: 1000 / 111319.4908, alt: 0 }, want: [1000, 0, -0.078393], tol: [1e-3, 1e-6, 1e-3] },
    { a: SEOUL, g: { lat: SEOUL.lat + 1000 / 110988.2897, lon: SEOUL.lon, alt: 0 }, want: [0, 1000, -0.078627], tol: [1e-6, 5e-3, 1e-3] },
    { a: SEOUL, g: { lat: SEOUL.lat, lon: SEOUL.lon + 1000 / 88346.9659, alt: 0 }, want: [1000, 0.060223, -0.078295], tol: [1e-3, 1e-3, 1e-3] },
  ];
  for (const c of cases) {
    const enu = gpsToEnu(c.g, c.a);
    for (let i = 0; i < 3; i++) near(enu[i], c.want[i], c.tol[i], `축${i} ${JSON.stringify(c.g)}`);
  }
  // 높이만 다르면 위 성분 = 높이 차
  const up = gpsToEnu({ ...SEOUL, alt: 321.5 }, SEOUL);
  near(up[0], 0, 1e-9, 'e'); near(up[1], 0, 1e-9, 'n'); near(up[2], 321.5, 1e-9, 'u');
});

test('(3) 무작위 1만 점 왕복 ENU→GPS→ENU 오차 ≤ 0.1 mm', (t) => {
  const r = rng(20261003);
  const anchors = [{ lat: 37.5665, lon: 126.978, alt: 38.2 }, { lat: -33.86, lon: 151.21, alt: 5 }, { lat: 78.2, lon: 15.6, alt: 0 }];
  let worst = 0, worstBack = 0;
  for (let i = 0; i < 10000; i++) {
    const a = anchors[i % anchors.length];
    const enu = [(r() * 2 - 1) * 50000, (r() * 2 - 1) * 50000, -200 + r() * 3200];
    const g = enuToGps(enu, a);
    const back = gpsToEnu(g, a);
    worst = Math.max(worst, Math.hypot(back[0] - enu[0], back[1] - enu[1], back[2] - enu[2]));
    // GPS→ENU→GPS 쪽도 거리(m)로 환산해 확인
    const g2 = enuToGps(back, a);
    const d = gpsToEnu(g2, g);
    worstBack = Math.max(worstBack, Math.hypot(d[0], d[1], d[2]));
  }
  t.diagnostic(`왕복 최대 오차 ENU→GPS→ENU ${worst.toExponential(3)} m, GPS→ENU→GPS ${worstBack.toExponential(3)} m`);
  assert.ok(worst <= 1e-4, `왕복 오차 ${worst}`);
  assert.ok(worstBack <= 1e-4, `역왕복 오차 ${worstBack}`);
});

// 두 번째 구현: 극반경 b 로 ECEF z 를 쓰고, R = R1(90°−φ)·R3(90°+λ) 행렬곱을 직접 만든다.
function refGpsToEnu(g, o) {
  const a = 6378137, f = 1 / 298.257223563, b = a * (1 - f);
  const ecef = ({ lat, lon, alt }) => {
    const p = (lat * Math.PI) / 180, l = (lon * Math.PI) / 180;
    const N = (a * a) / Math.sqrt(a * a * Math.cos(p) ** 2 + b * b * Math.sin(p) ** 2);
    return [(N + alt) * Math.cos(p) * Math.cos(l), (N + alt) * Math.cos(p) * Math.sin(l), ((b * b) / (a * a) * N + alt) * Math.sin(p)];
  };
  const r3 = (t) => [[Math.cos(t), Math.sin(t), 0], [-Math.sin(t), Math.cos(t), 0], [0, 0, 1]];
  const r1 = (t) => [[1, 0, 0], [0, Math.cos(t), Math.sin(t)], [0, -Math.sin(t), Math.cos(t)]];
  const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
  const R = mul(r1(Math.PI / 2 - (o.lat * Math.PI) / 180), r3(Math.PI / 2 + (o.lon * Math.PI) / 180));
  const P = ecef(g), O = ecef(o);
  const d = [P[0] - O[0], P[1] - O[1], P[2] - O[2]];
  return R.map((row) => row[0] * d[0] + row[1] * d[1] + row[2] * d[2]);
}

test('(4) 독립 구현(회전행렬 직접)과 1 mm 이내 일치', (t) => {
  const r = rng(7);
  const anchors = [SEOUL, EQ, { lat: -45.1, lon: -170.3, alt: 800 }, { lat: 85, lon: 60, alt: 10 }];
  let worst = 0;
  for (let i = 0; i < 10000; i++) {
    const a = anchors[i % anchors.length];
    // ±50 km 반경을 위경도로 환산(대략 1도≈111 km, 고위도는 경도 폭 보정)
    const dLat = ((r() * 2 - 1) * 50000) / 111000;
    const dLon = ((r() * 2 - 1) * 50000) / (111000 * Math.max(Math.cos((a.lat * Math.PI) / 180), 0.1));
    let lon = a.lon + dLon;
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    const g = { lat: Math.max(-90, Math.min(90, a.lat + dLat)), lon, alt: a.alt - 200 + r() * 3000 };
    const x = gpsToEnu(g, a), y = refGpsToEnu(g, a);
    worst = Math.max(worst, Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]));
  }
  t.diagnostic(`독립 구현과 최대 차이 ${worst.toExponential(3)} m`);
  assert.ok(worst <= 1e-3, `차이 ${worst}`);
});

test('구면 근사와의 차이(참고 수치, 50 km 에서 미터 단위로 벌어진다)', (t) => {
  // 구면 등장방형 근사: e = R·Δλ·cosφ0, n = R·Δφ, R = 6371000
  const R = 6371000;
  for (const d of [1000, 10000, 50000]) {
    const g = enuToGps([d, d, 0], SEOUL);
    const ex = gpsToEnu(g, SEOUL);
    const se = R * ((g.lon - SEOUL.lon) * Math.PI / 180) * Math.cos(SEOUL.lat * Math.PI / 180);
    const sn = R * ((g.lat - SEOUL.lat) * Math.PI / 180);
    t.diagnostic(`d=${d} m: 정확 (${ex[0].toFixed(3)}, ${ex[1].toFixed(3)}) 구면 (${se.toFixed(3)}, ${sn.toFixed(3)})`);
  }
  const g = enuToGps([50000, 50000, 0], SEOUL);
  const sn = R * ((g.lat - SEOUL.lat) * Math.PI / 180);
  assert.ok(Math.abs(sn - 50000) > 10, '구면 근사는 북 50 km 에서 10 m 넘게 어긋나야 한다');
});

test('범위·비유한 입력은 GeoError(range)', () => {
  const bad = [
    { lat: 90.0001, lon: 0, alt: 0 }, { lat: -91, lon: 0, alt: 0 }, { lat: 0, lon: 180.5, alt: 0 },
    { lat: 0, lon: -181, alt: 0 }, { lat: NaN, lon: 0, alt: 0 }, { lat: 0, lon: Infinity, alt: 0 },
    { lat: 0, lon: 0, alt: -Infinity }, { lat: 0, lon: 0 }, null,
  ];
  const isRange = (e) => e instanceof GeoError && e.code === 'range';
  for (const b of bad) {
    assert.throws(() => gpsToEnu(b, SEOUL), isRange);
    assert.throws(() => gpsToEnu(SEOUL, b), isRange);
    assert.throws(() => enuToGps([0, 0, 0], b), isRange);
  }
  for (const e of [[NaN, 0, 0], [0, Infinity, 0], [0, 0], null, [0, 0, '1']]) {
    assert.throws(() => enuToGps(e, SEOUL), isRange);
  }
  // 경계값은 허용
  assert.doesNotThrow(() => gpsToEnu({ lat: 90, lon: 180, alt: 0 }, { lat: -90, lon: -180, alt: 0 }));
});
