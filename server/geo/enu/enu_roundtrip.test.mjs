// F-079 GPS↔ENU 경계 왕복·날짜변경선 시험. 결정 0017(날짜변경선 ±360 감싸기 허용)에 따라 경도는 (−180, 180] 로 정규화하며
// 왕복 비교는 경도를 360 법(mod 360)으로 한다. 극 앵커는 gpsToEnu 가 e = 0 을 내는 방식(경도 정의 불가).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gpsToEnu, enuToGps } from './index.mjs';
import { gpsToEnuClient } from '../../../client/geo/index.mjs';

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
// 경도 차(mod 360, −180..180)
const lonDiff = (a, b) => { let d = (a - b) % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return d; };
const maxAbs = (u, v) => Math.max(...u.map((x, i) => Math.abs(x - v[i])));

test('앵커 lat ∈ {90,−90} × gps lon ∈ {−180,−10,10,180} 왕복 오류 0', () => {
  let fails = 0, n = 0;
  for (const alat of [90, -90]) for (const alon of [-180, -10, 10, 180, 0]) {
    const anchor = { lat: alat, lon: alon, alt: 5 };
    for (const lat of [-90, -45, 0, 45, 89.99, 90]) for (const lon of [-180, -10, 10, 180]) {
      const g = { lat, lon, alt: 12 };
      n++;
      try {
        const enu = gpsToEnu(g, anchor);
        const back = enuToGps(enu, anchor);
        // 위도·고도 일치, ENU 재투영이 원래 ENU 와 같음(극 앵커에서 경도는 정의되지 않으므로 ENU 로 비교)
        assert.ok(Math.abs(back.lat - lat) < 1e-9, `lat ${back.lat} vs ${lat}`);
        assert.equal(back.alt, 12);
        assert.ok(maxAbs(gpsToEnu(back, anchor), enu) < 1e-6);
        assert.ok(enu[0] === 0, `e=${enu[0]}`); // -0 도 허용
      } catch (e) { fails++; console.log('실패', JSON.stringify(anchor), JSON.stringify(g), e.message); }
    }
  }
  assert.equal(fails, 0, `${n} 중 ${fails} 실패`);
});

test('비극 앵커에서 gps lon ∈ {−180,−10,10,180} 왕복(경도 mod 360 일치)', () => {
  for (const alat of [0, 45, -45, 89, -89]) for (const alon of [-180, -170, 0, 170, 180]) {
    const anchor = { lat: alat, lon: alon, alt: 0 };
    for (const lon of [-180, -10, 10, 180]) {
      const g = { lat: alat * 0.5, lon, alt: 3 };
      const back = enuToGps(gpsToEnu(g, anchor), anchor);
      assert.ok(Math.abs(lonDiff(back.lon, lon)) < 1e-9, `${JSON.stringify(anchor)} lon ${lon} -> ${back.lon}`);
      assert.ok(back.lon > -180 && back.lon <= 180);
      assert.ok(Math.abs(back.lat - g.lat) < 1e-9);
    }
  }
});

test('gps.lat=±90 무작위 앵커 10만 회 왕복 실패 0', () => {
  const r = rng(79079);
  let fails = 0;
  for (let i = 0; i < 100000; i++) {
    // 앵커 위도는 극 아님(|lat| < 90) 무작위, 경도 전 범위 포함 ±180 경계 가끔
    const lonPick = r();
    const anchor = {
      lat: (r() * 2 - 1) * 90,
      lon: lonPick < 0.05 ? -180 : lonPick < 0.1 ? 180 : (r() * 2 - 1) * 180,
      alt: r() * 1000,
    };
    const g = { lat: r() < 0.5 ? 90 : -90, lon: (r() * 2 - 1) * 180, alt: r() * 100 };
    try {
      const back = enuToGps(gpsToEnu(g, anchor), anchor);
      // 극점 자체이므로 경도는 의미 없음: 위도 일치와 ENU 재투영 일치로 판정
      if (!(Math.abs(back.lat - g.lat) < 1e-9) || !(maxAbs(gpsToEnu(back, anchor), gpsToEnu(g, anchor)) < 1e-3)) fails++;
    } catch { fails++; }
  }
  assert.equal(fails, 0);
});

test('enuToGps([0,0,0], lon −180 앵커) 의 lon 은 180', () => {
  assert.equal(enuToGps([0, 0, 0], { lat: 0, lon: -180, alt: 0 }).lon, 180);
  assert.equal(enuToGps([0, 0, 0], { lat: 0, lon: 180, alt: 0 }).lon, 180);
});

test('enuToGps 경도 모듈로: ±180 을 넘는 e 는 감싸고, 정확히 −180 은 180', () => {
  const a = { lat: 0, lon: 179, alt: 0 };
  const k = 6378137 * Math.PI / 180; // 1° 의 m
  assert.ok(Math.abs(lonDiff(enuToGps([2 * k, 0, 0], a).lon, -179)) < 1e-9);
  assert.ok(enuToGps([2 * k, 0, 0], a).lon < 0);
  assert.ok(enuToGps([-2 * k, 0, 0], { lat: 0, lon: -179, alt: 0 }).lon > 0);
  assert.equal(enuToGps([-359 * k, 0, 0], { lat: 0, lon: 179, alt: 0 }).lon, 180);
});

test('날짜변경선 두 분기와 경계 |Δλ|=180 (서버·클라이언트 동일)', () => {
  const half = Math.PI * 6378137 * Math.cos(20 * Math.PI / 180);
  for (const f of [gpsToEnu, gpsToEnuClient]) {
    const west = f({ lat: 20, lon: 179.9999, alt: 0 }, { lat: 20, lon: -179.9999, alt: 0 }); // −360 분기
    const east = f({ lat: 20, lon: -179.9999, alt: 0 }, { lat: 20, lon: 179.9999, alt: 0 }); // +360 분기
    assert.ok(west[0] < 0 && Math.abs(west[0]) < 100, `west ${west[0]}`);
    assert.ok(east[0] > 0 && east[0] < 100, `east ${east[0]}`);
    assert.ok(Math.abs(f({ lat: 20, lon: 180, alt: 0 }, { lat: 20, lon: 0, alt: 0 })[0] - half) < 1e-6);
    assert.ok(Math.abs(f({ lat: 20, lon: -180, alt: 0 }, { lat: 20, lon: 0, alt: 0 })[0] + half) < 1e-6);
    assert.ok(Math.abs(f({ lat: 20, lon: 170, alt: 0 }, { lat: 20, lon: -10, alt: 0 })[0] - half) < 1e-6);
  }
});

test('범위 안 1만 점: 서버·클라이언트 gpsToEnu 가 geo.ts 식과 0 m 차(감싸기 미발동 구간)', () => {
  const R = 6378137, D = Math.PI / 180, r = rng(1234);
  let worst = 0, n = 0;
  for (let i = 0; i < 10000; i++) {
    const a = { lat: (r() * 2 - 1) * 80, lon: (r() * 2 - 1) * 90, alt: r() * 100 };
    const g = { lat: a.lat + (r() - 0.5) * 0.2, lon: a.lon + (r() - 0.5) * 0.2, alt: r() * 100 };
    const ref = [(g.lon - a.lon) * D * R * Math.cos(a.lat * D), (g.lat - a.lat) * D * R, g.alt - a.alt];
    worst = Math.max(worst, maxAbs(gpsToEnu(g, a), ref), maxAbs(gpsToEnuClient(g, a), ref));
    n++;
  }
  assert.equal(n, 10000);
  assert.equal(worst, 0);
});
