// T04.5 GPS ↔ ENU 시험. 기본 경로는 skylens geo.ts 를 옮긴 기준 함수와 대조하고(아래 F-071 절),
// 참고용 WGS-84 정확식(gpsToEnuExact·enuToGpsExact)은 손계산·독립 구현으로 검증한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeoError } from '../../../contracts/geo/index.mjs';
import {
  gpsToEnu, enuToGps, gpsToEnuExact, enuToGpsExact,
  gpsToScene, sceneToGps, enuToScene, sceneToEnu, enuObjToArray, enuArrayToObj,
} from './index.mjs';

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

test('(1) 앵커 자신은 (0,0,0)(근사·정확식 모두)', () => {
  const pairs = [[gpsToEnu, enuToGps], [gpsToEnuExact, enuToGpsExact]];
  const anchors = [SEOUL, EQ, { lat: -89.9, lon: 179.9, alt: 1234.5 }, { lat: 90, lon: -180, alt: -50 }];
  for (const [fwd, inv] of pairs) for (const a of anchors) {
    const enu = fwd(a, a);
    for (const v of enu) near(v, 0, 1e-9, '앵커');
    const g = inv([0, 0, 0], a);
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
test('(2) 정확식: 동·북 1000 m 손계산 값과 일치', () => {
  const gpsToEnu = gpsToEnuExact;
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

test('(3) 정확식: 무작위 1만 점 왕복 ENU→GPS→ENU 오차 ≤ 0.1 mm', (t) => {
  const gpsToEnu = gpsToEnuExact, enuToGps = enuToGpsExact;
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

test('(4) 정확식: 독립 구현(회전행렬 직접)과 1 mm 이내 일치', (t) => {
  const gpsToEnu = gpsToEnuExact;
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

test('범위·비유한 입력은 GeoError(range)(근사·정확식 모두)', () => {
  for (const [fwd, inv] of [[gpsToEnu, enuToGps], [gpsToEnuExact, enuToGpsExact]]) {
    const bad = [
      { lat: 90.0001, lon: 0, alt: 0 }, { lat: -91, lon: 0, alt: 0 }, { lat: 0, lon: 180.5, alt: 0 },
      { lat: 0, lon: -181, alt: 0 }, { lat: NaN, lon: 0, alt: 0 }, { lat: 0, lon: Infinity, alt: 0 },
      { lat: 0, lon: 0, alt: -Infinity }, { lat: 0, lon: 0 }, null,
    ];
    const isRange = (e) => e instanceof GeoError && e.code === 'range';
    for (const b of bad) {
      assert.throws(() => fwd(b, SEOUL), isRange);
      assert.throws(() => fwd(SEOUL, b), isRange);
      assert.throws(() => inv([0, 0, 0], b), isRange);
    }
    for (const e of [[NaN, 0, 0], [0, Infinity, 0], [0, 0], null, [0, 0, '1']]) {
      assert.throws(() => inv(e, SEOUL), isRange);
    }
    // 경계값은 허용
    assert.doesNotThrow(() => fwd({ lat: 90, lon: 180, alt: 0 }, { lat: -90, lon: -180, alt: 0 }));
  }
});

// ── F-071: skylens geo.ts 등장방형 근사와 대조 ──
// 기준 함수: skylens develop src/shared/geo.ts(NET-Challenge-S13/skylens,
// 커밋 59edcf9b38b0887cb63dcaa2daa07a123f81dd95)의 gpsToEnu·enuToGps·enuToScene·sceneToEnu·gpsToScene·sceneToGps 를
// 형식 표기만 빼고 그대로 옮긴 것. 구현(index.mjs)과 따로 둔다.
const REF_R = 6378137; // Earth radius (m)
const REF_DEG = Math.PI / 180;
function refGpsToEnuSk(gps, anchor) {
  const dLat = (gps.lat - anchor.lat) * REF_DEG;
  const dLon = (gps.lon - anchor.lon) * REF_DEG;
  return {
    e: dLon * REF_R * Math.cos(anchor.lat * REF_DEG),
    n: dLat * REF_R,
    u: gps.alt - anchor.alt,
  };
}
function refEnuToGpsSk(enu, anchor) {
  return {
    lat: anchor.lat + (enu.n / REF_R) / REF_DEG,
    lon: anchor.lon + (enu.e / (REF_R * Math.cos(anchor.lat * REF_DEG))) / REF_DEG,
    alt: anchor.alt + enu.u,
  };
}
function refEnuToSceneSk(enu) { return [enu.e, enu.u, -enu.n]; }
function refSceneToEnuSk(v) { return { e: v[0], u: v[1], n: -v[2] }; }
function refGpsToSceneSk(gps, anchor) { return refEnuToSceneSk(refGpsToEnuSk(gps, anchor)); }
function refSceneToGpsSk(v, anchor) { return refEnuToGpsSk(refSceneToEnuSk(v), anchor); }

// GPS 두 점 차를 앵커 위도 기준 m 로 환산(위·경도 오차를 거리로 비교하기 위함)
function gpsDiffM(a, b, anchor) {
  const dn = (a.lat - b.lat) * REF_DEG * REF_R;
  const de = (a.lon - b.lon) * REF_DEG * REF_R * Math.cos(anchor.lat * REF_DEG);
  return Math.hypot(de, dn, a.alt - b.alt);
}

const SK_ANCHORS = [
  { lat: 37.5665, lon: 126.978, alt: 30 },
  { lat: 0, lon: 0, alt: 0 },
  { lat: -33.86, lon: 151.21, alt: 5 },
  { lat: 78.2, lon: 15.6, alt: -12.5 },
  { lat: 49.0, lon: -123.1, alt: 1500 },
];

// 앵커 기준 반경 radius m 원판 안 무작위 ENU(높이 −200..3000 m)
function randEnu(r, radius) {
  const rho = radius * Math.sqrt(r()), th = r() * 2 * Math.PI;
  return [rho * Math.cos(th), rho * Math.sin(th), -200 + r() * 3200];
}

for (const km of [0.1, 1, 10, 50]) {
  test(`F-071 반경 ${km} km 무작위 1만 점: 기준(geo.ts)과 차 ≤ 1 mm, 왕복 ≤ 1 mm`, (t) => {
    const r = rng(0x5eed + km * 1000);
    let fwd = 0, inv = 0, scn = 0, rt1 = 0, rt2 = 0;
    for (let i = 0; i < 10000; i++) {
      const a = SK_ANCHORS[i % SK_ANCHORS.length];
      const enu = randEnu(r, km * 1000);
      // 시험 점의 GPS 는 기준 함수로 만든다
      const g = refEnuToGpsSk({ e: enu[0], n: enu[1], u: enu[2] }, a);
      // 정방향: gpsToEnu vs 기준
      const got = gpsToEnu(g, a), want = refGpsToEnuSk(g, a);
      fwd = Math.max(fwd, Math.hypot(got[0] - want.e, got[1] - want.n, got[2] - want.u));
      // 역방향: enuToGps vs 기준(m 환산)
      inv = Math.max(inv, gpsDiffM(enuToGps(enu, a), refEnuToGpsSk({ e: enu[0], n: enu[1], u: enu[2] }, a), a));
      // 씬: gpsToScene vs 기준, sceneToGps vs 기준
      const s = gpsToScene(g, a), ws = refGpsToSceneSk(g, a);
      scn = Math.max(scn, Math.hypot(s[0] - ws[0], s[1] - ws[1], s[2] - ws[2]));
      scn = Math.max(scn, gpsDiffM(sceneToGps(ws, a), refSceneToGpsSk(ws, a), a));
      // 왕복 ENU→GPS→ENU, GPS→ENU→GPS
      const back = gpsToEnu(enuToGps(enu, a), a);
      rt1 = Math.max(rt1, Math.hypot(back[0] - enu[0], back[1] - enu[1], back[2] - enu[2]));
      rt2 = Math.max(rt2, gpsDiffM(enuToGps(gpsToEnu(g, a), a), g, a));
    }
    t.diagnostic(`${km} km: 정방향 ${fwd.toExponential(3)} m, 역방향 ${inv.toExponential(3)} m, 씬 ${scn.toExponential(3)} m, 왕복 ${rt1.toExponential(3)}/${rt2.toExponential(3)} m`);
    assert.ok(fwd <= 1e-3, `정방향 ${fwd}`);
    assert.ok(inv <= 1e-3, `역방향 ${inv}`);
    assert.ok(scn <= 1e-3, `씬 ${scn}`);
    assert.ok(rt1 <= 1e-3, `왕복 ENU→GPS→ENU ${rt1}`);
    assert.ok(rt2 <= 1e-3, `왕복 GPS→ENU→GPS ${rt2}`);
  });
}

test('F-071 손계산 값: 등장방형 근사 식 그대로', () => {
  // R·π/180 = 6378137·0.017453292519943295 = 111319.49079327357 m (경위도 1도)
  const deg1 = 111319.49079327357;
  const eq = { lat: 0, lon: 0, alt: 0 };
  let v = gpsToEnu({ lat: 0, lon: 1, alt: 0 }, eq);
  near(v[0], deg1, 1e-6, '적도 동 1도'); near(v[1], 0, 0, 'n'); near(v[2], 0, 0, 'u');
  v = gpsToEnu({ lat: 1, lon: 0, alt: 7 }, eq);
  near(v[0], 0, 0, 'e'); near(v[1], deg1, 1e-6, '적도 북 1도'); near(v[2], 7, 0, 'u');
  // 앵커 위도 60°: cos = 0.5 → 동 1도 = 55659.745 m. 위도 차는 앵커 위도와 무관.
  const a60 = { lat: 60, lon: 10, alt: 100 };
  v = gpsToEnu({ lat: 61, lon: 11, alt: 50 }, a60);
  near(v[0], deg1 * 0.5, 1e-6, '60° 동 1도'); near(v[1], deg1, 1e-6, '60° 북 1도'); near(v[2], -50, 1e-12, 'u');
  // 정확식이면 위 성분에 곡면 낙차가 들어가지만 근사는 높이 차뿐
  const s = SK_ANCHORS[0];
  v = gpsToEnu({ lat: s.lat + 0.1, lon: s.lon + 0.1, alt: s.alt }, s);
  assert.equal(v[2], 0);
  const g = enuToGps([deg1 * 0.5, deg1, -50], a60);
  near(g.lat, 61, 1e-12, 'lat'); near(g.lon, 11, 1e-12, 'lon'); near(g.alt, 50, 1e-12, 'alt');
});

test('F-073⑥ enuToGps 결과가 비유한이면 GeoError(range)', () => {
  const isRange = (e) => e instanceof GeoError && e.code === 'range';
  const pole = { lat: 90, lon: 0, alt: 0 };
  // cos(90°) ≈ 6.1e−17 → e/(R·cos) 가 넘쳐 Infinity
  assert.throws(() => enuToGps([1e300, 0, 0], pole), isRange);
  assert.throws(() => enuToGps([-1e300, 0, 0], { lat: -90, lon: 0, alt: 0 }), isRange);
  // 높이 합이 넘침
  assert.throws(() => enuToGps([0, 0, 1e308], { lat: 0, lon: 0, alt: 1e308 }), isRange);
  // 앵커 위도 89.9999999°(cos ≈ 1.7e−9)에서도 e 가 크면 넘침
  assert.throws(() => enuToGps([1.7e308, 0, 0], { lat: 89.9999999, lon: 0, alt: 0 }), isRange);
  assert.throws(() => sceneToGps([1e300, 0, 0], pole), isRange);
  // 극 앵커라도 e=0 이면 유한
  assert.deepEqual(enuToGps([0, 10, 0], pole), { lat: 90 + 10 / REF_R / REF_DEG, lon: 0, alt: 0 });
});

test('skylens 이름 6개와 어댑터: 기준 함수와 같은 의미', () => {
  const a = SK_ANCHORS[0];
  const g = { lat: 37.57, lon: 126.98, alt: 55 };
  // gpsToEnu·enuToGps: 배열 ↔ 객체 어댑터를 거치면 기준 객체와 같다
  const o = enuArrayToObj(gpsToEnu(g, a));
  const w = refGpsToEnuSk(g, a);
  for (const k of ['e', 'n', 'u']) near(o[k], w[k], 1e-9, k);
  assert.deepEqual(Object.keys(o), ['e', 'n', 'u']);
  // enuToScene·sceneToEnu: 기준 [e, u, −n]
  const enu = [1.5, -2.25, 3];
  assert.deepEqual(enuToScene(enu), refEnuToSceneSk(enuArrayToObj(enu)));
  assert.deepEqual(enuArrayToObj(sceneToEnu([1.5, 3, 2.25])), refSceneToEnuSk([1.5, 3, 2.25]));
  // gpsToScene·sceneToGps
  const s = gpsToScene(g, a), ws = refGpsToSceneSk(g, a);
  for (let i = 0; i < 3; i++) near(s[i], ws[i], 1e-9, `scene${i}`);
  const back = sceneToGps(s, a);
  assert.ok(gpsDiffM(back, g, a) <= 1e-6);
  const wg = refSceneToGpsSk(s, a);
  assert.ok(gpsDiffM(back, wg, a) <= 1e-9);
  // 씬 축: 동 → +x, 북 → −z, 위 → +y
  const north = gpsToScene({ lat: a.lat + 0.001, lon: a.lon, alt: a.alt }, a);
  assert.equal(north[0], 0); assert.equal(north[1], 0); assert.ok(north[2] < 0);
  // 어댑터 왕복
  assert.deepEqual(enuObjToArray({ e: 1, n: 2, u: 3 }), [1, 2, 3]);
  assert.deepEqual(enuArrayToObj([1, 2, 3]), { e: 1, n: 2, u: 3 });
  assert.deepEqual(enuObjToArray(enuArrayToObj([-4, 5.5, 0])), [-4, 5.5, 0]);
});

test('어댑터·씬 함수: 표현이 틀리면 GeoError(range)', () => {
  const isRange = (e) => e instanceof GeoError && e.code === 'range';
  const a = SK_ANCHORS[0];
  for (const bad of [null, undefined, 3, 'x', [1, 2, 3], { e: 1, n: 2 }, { e: 1, n: NaN, u: 0 }, { e: '1', n: 2, u: 3 }]) {
    assert.throws(() => enuObjToArray(bad), isRange);
  }
  for (const bad of [null, { e: 1, n: 2, u: 3 }, [1, 2], [1, 2, Infinity], new Float64Array(3), { 0: 1, 1: 2, 2: 3, length: 3 }]) {
    assert.throws(() => enuArrayToObj(bad), isRange);
  }
  // 객체 {e,n,u} 를 배열 자리에 넣으면 거부(F-072)
  assert.throws(() => sceneToGps({ e: 1, n: 2, u: 3 }, a), isRange);
  assert.throws(() => enuToGps({ e: 1, n: 2, u: 3 }, a), isRange);
  assert.throws(() => gpsToScene({ lat: 0, lon: 0 }, a), isRange);
});
