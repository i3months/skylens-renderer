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

// 테스트용 독립 구현: 행렬 곱 형태의 ECEF 회전(상수는 리터럴)
const A = 6378137, F = 1 / 298.257223563;
function ecef(lat, lon, h) {
  const e2 = 2 * F - F * F, la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
  const n = A / Math.sqrt(1 - e2 * Math.sin(la) ** 2);
  return [(n + h) * Math.cos(la) * Math.cos(lo), (n + h) * Math.cos(la) * Math.sin(lo), (n * (1 - e2) + h) * Math.sin(la)];
}
function refEnu(g, a) {
  const p = ecef(g.lat, g.lon, g.alt), o = ecef(a.lat, a.lon, a.alt);
  const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  const la = (a.lat * Math.PI) / 180, lo = (a.lon * Math.PI) / 180;
  const R = [
    [-Math.sin(lo), Math.cos(lo), 0],
    [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)],
    [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)],
  ];
  return R.map((r) => r[0] * d[0] + r[1] * d[1] + r[2] * d[2]);
}
function randPoints(n, seed) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const anchor = { lat: -85 + r() * 170, lon: -180 + r() * 360, alt: -100 + r() * 3000 };
    // 앵커 주변 약 ±0.5° 안의 점
    const gps = {
      lat: Math.max(-90, Math.min(90, anchor.lat + (r() - 0.5))),
      lon: Math.max(-180, Math.min(180, anchor.lon + (r() - 0.5))),
      alt: -100 + r() * 3000,
    };
    out.push([gps, anchor]);
  }
  return out;
}
const maxDiff = (u, v) => Math.max(...u.map((x, i) => Math.abs(x - v[i])));

test('앵커 자신 → (0,0,0)', () => {
  const a = { lat: 37.5, lon: 127, alt: 50 };
  const e = gpsToEnuClient({ ...a }, a);
  for (const x of e) assert.ok(Math.abs(x) < 1e-9);
});

test('손계산 기준값(앵커 37.5N 127E 50m, 닫힌 식 값 고정)', () => {
  const a = { lat: 37.5, lon: 127, alt: 50 };
  const cases = [
    [{ lat: 37.5, lon: 127, alt: 150 }, [0, 0, 100]],
    [{ lat: 37.51, lon: 127, alt: 50 }, [0, 1109.8800302932882, -0.09685533189281159]],
    [{ lat: 37.4, lon: 127, alt: 300 }, [0, -11099.127492225489, 240.314208981481]],
    [{ lat: 37.5, lon: 127.01, alt: 50 }, [884.2613602624164, 0.04697590410359487, -0.06122019013996015]],
  ];
  for (const [g, want] of cases) {
    const got = gpsToEnuClient(g, a);
    assert.ok(maxDiff(got, want) < 1e-6, `${JSON.stringify(g)} -> ${got} vs ${want}`);
  }
});

test('무작위 1만 점: 독립 ECEF 회전행렬 구현과 1 mm 이내', () => {
  let worst = 0;
  for (const [g, a] of randPoints(10000, 20240607)) worst = Math.max(worst, maxDiff(gpsToEnuClient(g, a), refEnu(g, a)));
  console.log(`max diff vs reference: ${worst} m`);
  assert.ok(worst <= 1e-3);
});

test('비유한·범위 밖은 GeoError(range)', () => {
  const a = { lat: 0, lon: 0, alt: 0 };
  const bad = [
    { lat: NaN, lon: 0, alt: 0 }, { lat: 0, lon: Infinity, alt: 0 }, { lat: 0, lon: 0, alt: NaN },
    { lat: 90.1, lon: 0, alt: 0 }, { lat: -91, lon: 0, alt: 0 }, { lat: 0, lon: 180.5, alt: 0 }, { lat: 0, lon: -181, alt: 0 },
  ];
  for (const b of bad) {
    for (const f of [() => gpsToEnuClient(b, a), () => gpsToEnuClient(a, b)]) {
      assert.throws(f, (e) => e instanceof GeoError && e.code === 'range');
    }
  }
});

test('index.mjs 에 node: 모듈·Buffer 없음(소스 검사)', () => {
  const src = readFileSync(here('./index.mjs'), 'utf8');
  assert.ok(!/node:/.test(src));
  assert.ok(!/\bBuffer\b/.test(src));
});

const serverPath = here('../../server/geo/enu/index.mjs');
test('서버 gpsToEnu 와 무작위 1만 점 차 ≤ 1 mm', async (t) => {
  if (!existsSync(serverPath)) return t.skip('server/geo/enu/index.mjs 없음(T04.5 미병합)');
  const { gpsToEnu } = await import(pathToFileURL(serverPath).href);
  let worst = 0;
  for (const [g, a] of randPoints(10000, 777)) worst = Math.max(worst, maxDiff(gpsToEnuClient(g, a), gpsToEnu(g, a)));
  console.log(`max diff vs server: ${worst} m`);
  assert.ok(worst <= 1e-3);
});
