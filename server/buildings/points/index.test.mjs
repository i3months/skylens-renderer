import test from 'node:test';
import assert from 'node:assert/strict';
import {
  samplesFor, sampleBuildingPoints, POINT_DENSITY_PER_M2, POINT_MIN_PER_BUILDING, POINT_MAX_PER_BUILDING,
} from './index.mjs';

// 시험용 프리즘: 직사각형(w×d) 바닥 z=0, 지붕 z=h, 위에서 볼 때 반시계. 원점 (x0,y0).
function prism(x0, y0, w, d, h, z0 = 0) {
  const positions = new Float32Array([
    x0, y0, z0, x0 + w, y0, z0, x0 + w, y0 + d, z0, x0, y0 + d, z0,
    x0, y0, z0 + h, x0 + w, y0, z0 + h, x0 + w, y0 + d, z0 + h, x0, y0 + d, z0 + h,
  ]);
  const indices = new Uint32Array([
    4, 5, 6, 4, 6, 7, // 지붕
    0, 2, 1, 0, 3, 2, // 바닥
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return { positions, indices };
}

// 점이 프리즘 표면 위인가: 상자 안이고 6면 중 하나에 1e-4 이내.
function onPrismSurface(x, y, z, x0, y0, w, d, h, tol = 1e-4) {
  const inside = x >= x0 - tol && x <= x0 + w + tol && y >= y0 - tol && y <= y0 + d + tol && z >= -tol && z <= h + tol;
  const near = [Math.abs(x - x0), Math.abs(x - x0 - w), Math.abs(y - y0), Math.abs(y - y0 - d), Math.abs(z), Math.abs(z - h)];
  return inside && Math.min(...near) <= tol;
}

test('규칙 상수 기준값', () => {
  assert.equal(POINT_DENSITY_PER_M2, 0.05);
  assert.equal(POINT_MIN_PER_BUILDING, 8);
  assert.equal(POINT_MAX_PER_BUILDING, 2000);
});

test('samplesFor: 기준 숫자', () => {
  // 100 m² 지붕, 높이 6: 벽 = 4·10·6 = 240, 합 340 × 0.05 = 17
  assert.equal(samplesFor(100, 6), 17);
  assert.equal(samplesFor(0, 0), 8); // 최소
  assert.equal(samplesFor(1e6, 30), 2000); // 최대
  assert.equal(samplesFor(101, 6), Math.ceil((101 + 4 * Math.sqrt(101) * 6) * 0.05));
  assert.equal(samplesFor(100, 6, { density: 1, min: 1, max: 50 }), 50);
  assert.throws(() => samplesFor(-1, 3));
  assert.throws(() => samplesFor(NaN, 3));
});

test('표본 수가 규칙과 일치', () => {
  // 10×10×6: 지붕 100, 높이 6 → 17
  assert.equal(sampleBuildingPoints(prism(0, 0, 10, 10, 6), 1).length, 17 * 3);
  // 1×1×1: 지붕 1, 벽 4 → 0.25 → ceil 1 → 최소 8
  assert.equal(sampleBuildingPoints(prism(0, 0, 1, 1, 1), 1).length, 8 * 3);
  // 200×200×30: 매우 큼 → 최대 2000
  assert.equal(sampleBuildingPoints(prism(0, 0, 200, 200, 30), 1).length, 2000 * 3);
  // 사용자 규칙
  assert.equal(sampleBuildingPoints(prism(0, 0, 10, 10, 6), 1, { density: 0.5, min: 1, max: 1000 }).length, 170 * 3);
});

test('모든 표본이 표면 위(1e-4 m)', () => {
  const [x0, y0, w, d, h] = [123.5, -47.25, 12, 8, 9];
  const pts = sampleBuildingPoints(prism(x0, y0, w, d, h), 77, { density: 1, min: 1, max: 5000 });
  assert.equal(pts.length / 3, samplesFor(w * d, h, { density: 1, min: 1, max: 5000 }));
  for (let i = 0; i < pts.length; i += 3) {
    assert.ok(onPrismSurface(pts[i], pts[i + 1], pts[i + 2], x0, y0, w, d, h), `점 ${i / 3} 가 표면 밖`);
  }
});

test('같은 id 같은 입력 → 같은 바이트, 다른 id → 다른 표본', () => {
  const m = prism(0, 0, 10, 10, 6);
  const a = sampleBuildingPoints(m, 5), b = sampleBuildingPoints(m, 5), c = sampleBuildingPoints(m, 6);
  assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
  assert.notDeepEqual(Buffer.from(a.buffer), Buffer.from(c.buffer));
  assert.equal(a.length, c.length);
});

test('삼각형 넓이 비례: 지붕 표본 비율', () => {
  // 10×10×10: 바닥 덮개(아래 향)는 표본에서 빠지므로 보이는 면 500 m², 지붕 100 → 약 1/5. 표본 5000 개로 ±0.03
  const pts = sampleBuildingPoints(prism(0, 0, 10, 10, 10), 3, { density: 100, min: 1, max: 5000 });
  let roof = 0;
  for (let i = 2; i < pts.length; i += 3) if (Math.abs(pts[i] - 10) < 1e-4) roof++;
  assert.ok(Math.abs(roof / 5000 - 1 / 5) < 0.03, `지붕 비율 ${roof / 5000}`);
});

test('잘못된 입력은 오류', () => {
  assert.throws(() => sampleBuildingPoints(null, 1));
  assert.throws(() => sampleBuildingPoints({ positions: new Float32Array(9), indices: new Uint32Array(0) }, 1));
});

test('바닥 덮개(아래 향 삼각형)에는 표본이 0 개', () => {
  const pts = sampleBuildingPoints(prism(0, 0, 10, 10, 10), 3, { density: 100, min: 1, max: 5000 });
  let floor = 0;
  for (let i = 2; i < pts.length; i += 3) if (Math.abs(pts[i]) < 1e-4) floor++;
  // 벽 아래 가장자리(z=0 선)는 확률 0 이라 사실상 0. 바닥 덮개가 살아 있으면 약 1/6 = 800 개 이상.
  assert.ok(floor <= 5, `바닥 표본 ${floor}`);
  // 바닥 덮개만 있는 메시는 보이는 면이 없다
  assert.throws(() => sampleBuildingPoints({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]), indices: new Uint32Array([0, 2, 1]) }, 1));
});

test('지붕 면 4분할 칸별 표본 수 균등(삼각형 안 균일, 꼭짓점 쏠림 없음)', () => {
  const N = 20000;
  const pts = sampleBuildingPoints(prism(0, 0, 10, 10, 10), 9, { density: 1e9, min: N, max: N });
  assert.equal(pts.length / 3, N);
  const q = [0, 0, 0, 0];
  let roof = 0;
  for (let i = 0; i < pts.length; i += 3) {
    if (Math.abs(pts[i + 2] - 10) > 1e-4) continue;
    roof++;
    q[(pts[i] >= 5 ? 1 : 0) + (pts[i + 1] >= 5 ? 2 : 0)]++;
  }
  assert.ok(roof > 3000);
  for (let k = 0; k < 4; k++) assert.ok(Math.abs(q[k] / roof - 0.25) < 0.03, `칸 ${k}: ${q[k] / roof}`);
});

test('바닥 높이(zMin)와 무관: z0=100 프리즘 표본 수 = z0=0, 표본 z 는 [100,106]', () => {
  const a = sampleBuildingPoints(prism(0, 0, 10, 10, 6, 0), 1);
  const b = sampleBuildingPoints(prism(0, 0, 10, 10, 6, 100), 1);
  assert.equal(a.length, 17 * 3);
  assert.equal(b.length, a.length);
  for (let i = 2; i < b.length; i += 3) assert.ok(b[i] >= 100 - 1e-4 && b[i] <= 106 + 1e-4);
});

test('규칙·입력 검증: rule {}·NaN density·min>max·Infinity 위치는 throw', () => {
  const m = prism(0, 0, 10, 10, 6);
  assert.throws(() => sampleBuildingPoints(m, 1, {}));
  assert.throws(() => sampleBuildingPoints(m, 1, { density: NaN, min: 1, max: 5 }));
  assert.throws(() => sampleBuildingPoints(m, 1, { density: 1, min: 10, max: 5 }));
  assert.throws(() => samplesFor(100, 6, {}));
  assert.throws(() => samplesFor(100, 6, { density: 1, min: 10, max: 5 }));
  const inf = prism(0, 0, 10, 10, 6);
  inf.positions[3] = Infinity;
  assert.throws(() => sampleBuildingPoints(inf, 1));
  assert.throws(() => sampleBuildingPoints({ positions: m.positions, indices: new Uint32Array([0, 1, 99]) }, 1));
});
