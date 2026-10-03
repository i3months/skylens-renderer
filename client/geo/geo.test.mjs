import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gpsToEnuClient } from './index.mjs';
import { GeoError } from '../../contracts/geo/index.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// 고정 시드 PRNG(mulberry32)
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 기준 함수: skylens develop src/shared/geo.ts 의 gpsToEnu 를 그대로 옮긴 것.
// 상수는 contracts 가 아니라 이 파일의 리터럴로 둔다(구현 쪽 상수가 바뀌면 이 테스트가 잡도록).
// 출처: https://github.com/NET-Challenge-S13/skylens/blob/develop/src/shared/geo.ts
const SKYLENS_R = 6378137; // Earth radius (m)
const SKYLENS_DEG = Math.PI / 180;
function skylensGpsToEnu(gps, anchor) {
  const dLat = (gps.lat - anchor.lat) * SKYLENS_DEG;
  const dLon = (gps.lon - anchor.lon) * SKYLENS_DEG;
  return {
    e: dLon * SKYLENS_R * Math.cos(anchor.lat * SKYLENS_DEG),
    n: dLat * SKYLENS_R,
    u: gps.alt - anchor.alt,
  };
}
const refEnu = (g, a) => { const r = skylensGpsToEnu(g, a); return [r.e, r.n, r.u]; };

// 앵커: 서울시청 부근
const ANCHOR = Object.freeze({ lat: 37.5665, lon: 126.978, alt: 30 });
// 여러 앵커: 북·남반구, 동·서경, 고위도, 고도 ≠ 30(서버 SK_ANCHORS 와 같은 구성). Seoul 하나로는 cos·상수 변이를 못 잡는다.
const ANCHORS = [
  ANCHOR,
  { lat: 0, lon: 0, alt: 0 },
  { lat: -33.86, lon: 151.21, alt: 5 },
  { lat: 78.2, lon: 15.6, alt: -12.5 },
  { lat: 49.0, lon: -123.1, alt: 1500 },
  { lat: -54.8, lon: -68.3, alt: 20 },
];
const RADII_KM = [0.1, 1, 10, 50];
const N_POINTS = 10000;

// 앵커에서 반경 radiusM 안(원판 균등)의 무작위 점 n 개. 미터 → 도 환산은 1° ≈ 111320 m 의 대략값이면 충분하다
// (점이 '대략 그 반경 안' 에 있기만 하면 되고, 비교는 같은 점에 대해 두 함수 값끼리 한다).
function pointsAround(anchor, radiusM, n, seed) {
  const r = rng(seed), out = [];
  const mPerDegLat = 111320, mPerDegLon = 111320 * Math.cos((anchor.lat * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    const d = radiusM * Math.sqrt(r()), th = 2 * Math.PI * r();
    out.push({
      lat: anchor.lat + (d * Math.cos(th)) / mPerDegLat,
      lon: anchor.lon + (d * Math.sin(th)) / mPerDegLon,
      alt: anchor.alt - 100 + r() * 600,
    });
  }
  return out;
}
const maxDiff = (u, v) => Math.max(...u.map((x, i) => Math.abs(x - v[i])));

test('앵커 자신 → (0,0,0)', () => {
  const e = gpsToEnuClient({ ...ANCHOR }, ANCHOR);
  assert.deepEqual(e.map(Math.abs), [0, 0, 0]);
});

test('손계산 기준값(앵커 37.5665N 126.978E 30m, 등장방형 근사)', () => {
  // 유도 근거(R = 6378137, DEG = π/180):
  //   R·DEG = 6378137 × 0.017453292519943295 = 111319.49079327357 m/도 (위도 1° 당 북쪽 거리)
  //   cos(φ0) = cos(37.5665°) = 0.7926462508178724
  // ① 위도 +0.01°: n = 0.01 × 111319.49079327357 = 1113.1949079327357, e = 0, u = 0
  // ② 경도 +0.01°: e = 0.01 × 111319.49079327357 × 0.7926462508178724 = 882.3697702024297, n = 0, u = 0
  // ③ 위도 −0.05°: n = −0.05 × 111319.49079327357 = −5565.974539663679
  // ④ 경도 −0.02°, 고도 130 m: e = −0.02 × 111319.49079327357 × 0.7926462508178724 = −1764.7395404048593,
  //    u = 130 − 30 = 100
  // ⑤ 고도만 −20 m: u = −20 − 30 = −50
  const a = ANCHOR;
  const cases = [
    [{ lat: 37.5765, lon: 126.978, alt: 30 }, [0, 1113.1949079327357, 0]],
    [{ lat: 37.5665, lon: 126.988, alt: 30 }, [882.3697702024297, 0, 0]],
    [{ lat: 37.5165, lon: 126.978, alt: 30 }, [0, -5565.974539663679, 0]],
    [{ lat: 37.5665, lon: 126.958, alt: 130 }, [-1764.7395404048593, 0, 100]],
    [{ lat: 37.5665, lon: 126.978, alt: -20 }, [0, 0, -50]],
  ];
  // 위경도 덧셈(37.5665+0.01 등)의 부동소수 반올림이 Δ 에 ~1e-15° 남으므로 허용 오차 1e-6 m
  for (const [g, want] of cases) {
    const got = gpsToEnuClient(g, a);
    assert.ok(maxDiff(got, want) < 1e-6, `${JSON.stringify(g)} -> ${got} vs ${want}`);
  }
});

test('앵커별 손계산 값(경도 +0.01° 의 e = 0.01·R·DEG·cos φ0, 위도 +0.01° 의 n = 1113.19…)', () => {
  // cos φ0 와 e 는 독립 계산(파이썬 math.cos) 리터럴. R·DEG = 111319.49079327357
  const table = [
    [{ lat: 0, lon: 0, alt: 0 }, 1113.1949079327357],
    [{ lat: -33.86, lon: 151.21, alt: 5 }, 924.3986794126988],
    [{ lat: 78.2, lon: 15.6, alt: -12.5 }, 227.64396360262964],
    [{ lat: 49.0, lon: -123.1, alt: 1500 }, 730.3215703755278],
    [{ lat: 60, lon: 10, alt: 100 }, 556.597453966368],
  ];
  for (const [a, e0] of table) {
    const east = gpsToEnuClient({ lat: a.lat, lon: a.lon + 0.01, alt: a.alt + 7 }, a);
    assert.ok(Math.abs(east[0] - e0) < 1e-6, `${JSON.stringify(a)} e ${east[0]} vs ${e0}`);
    assert.ok(Math.abs(east[1]) < 1e-6 && east[2] === 7);
    const north = gpsToEnuClient({ lat: a.lat + 0.01, lon: a.lon, alt: a.alt - 3 }, a);
    assert.ok(Math.abs(north[1] - 1113.1949079327357) < 1e-6, `${JSON.stringify(a)} n ${north[1]}`);
    assert.ok(Math.abs(north[0]) < 1e-6 && north[2] === -3);
  }
});

for (const km of RADII_KM) {
  test(`skylens geo.ts 기준 함수와 반경 ${km} km 무작위 ${N_POINTS} 점(앵커 ${ANCHORS.length} 개) 차 = 0 m`, () => {
    let worst = 0;
    for (const [ai, a] of ANCHORS.entries()) {
      for (const g of pointsAround(a, km * 1000, Math.floor(N_POINTS / ANCHORS.length), 20261003 + km * 1000 + ai)) {
        worst = Math.max(worst, maxDiff(gpsToEnuClient(g, a), refEnu(g, a)));
      }
    }
    console.log(`radius ${km} km: max diff vs skylens geo.ts = ${worst} m`);
    assert.equal(worst, 0, `max diff ${worst} m`);
  });
}

test('날짜변경선 건너 경도 차는 짧은 쪽(±360° 보정)', () => {
  const a = { lat: 10, lon: 179.9999, alt: 0 };
  const e = gpsToEnuClient({ lat: 10, lon: -179.9999, alt: 0 }, a);
  const want = 0.0002 * 111319.49079327357 * Math.cos(10 * Math.PI / 180);
  assert.ok(Math.abs(e[0] - want) < 1e-6, `${e[0]} vs ${want}`);
});

test('비유한·범위 밖은 GeoError(range)', () => {
  const a = { lat: 0, lon: 0, alt: 0 };
  const bad = [
    { lat: NaN, lon: 0, alt: 0 }, { lat: 0, lon: Infinity, alt: 0 }, { lat: 0, lon: 0, alt: NaN },
    { lat: 90.1, lon: 0, alt: 0 }, { lat: -91, lon: 0, alt: 0 }, { lat: 0, lon: 180.5, alt: 0 }, { lat: 0, lon: -181, alt: 0 },
    { lat: '0', lon: 0, alt: 0 }, null,
  ];
  for (const b of bad) {
    for (const f of [() => gpsToEnuClient(b, a), () => gpsToEnuClient(a, b)]) {
      assert.throws(f, (e) => e instanceof GeoError && e.code === 'range');
    }
  }
});

test('결과가 비유한이면 GeoError(range)', () => {
  // 1.7e308 − (−1.7e308) 은 Number.MAX_VALUE 를 넘어 Infinity
  assert.throws(
    () => gpsToEnuClient({ lat: 0, lon: 0, alt: 1.7e308 }, { lat: 0, lon: 0, alt: -1.7e308 }),
    (e) => e instanceof GeoError && e.code === 'range',
  );
});

test('index.mjs 에 node: 모듈·Buffer 없음(소스 검사)', () => {
  const src = readFileSync(here('./index.mjs'), 'utf8');
  assert.ok(!/node:/.test(src));
  assert.ok(!/\bBuffer\b/.test(src));
});

// 서버 gpsToEnu 도 같은 등장방형 식으로 맞춘다(F-071). 서버·클라이언트가 다시 갈라지면 이 테스트가 잡는다.
const serverPath = here('../../server/geo/enu/index.mjs');
test('서버·클라이언트 동치 회귀 감시', async (t) => {
  if (!existsSync(serverPath)) return t.skip('server/geo/enu/index.mjs 없음');
  const { gpsToEnu } = await import(pathToFileURL(serverPath).href);
  let worst = 0;
  for (const [ai, a] of ANCHORS.entries()) {
    for (const km of RADII_KM) {
      for (const g of pointsAround(a, km * 1000, N_POINTS / RADII_KM.length / ANCHORS.length, 777 + km * 1000 + ai)) {
        worst = Math.max(worst, maxDiff(gpsToEnuClient(g, a), gpsToEnu(g, a)));
      }
    }
  }
  console.log(`max diff vs server: ${worst} m`);
  assert.ok(worst <= 1e-3, `max diff ${worst} m`);
});
