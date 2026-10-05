// 지형 음영(T15.1-A3) 시험: 면 법선, 램버트 식, server 참조 lambert 와의 일치, 오류 처리, 화소별 정점 법선 보간 음영(서술·정점 법선·래스터 경로).
import test from 'node:test';
import assert from 'node:assert/strict';
import { faceNormalEnu, shadeLambert } from './shade.mjs';
import { lambert } from '../../../server/raster_ref/shade/index.mjs';

const near = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// 간단한 선형 합동 난수(재현 가능).
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

test('평평한 지형의 법선은 [0,0,1]', () => {
  const pos = new Float32Array([0, 0, 5, 10, 0, 5, 10, 10, 5, 0, 10, 5]);
  const idx = new Uint32Array([0, 1, 2, 0, 2, 3]);
  assert.deepEqual(faceNormalEnu(pos, idx, 0), [0, 0, 1]);
  assert.deepEqual(faceNormalEnu(pos, idx, 1), [0, 0, 1]);
});

test('45도 경사(동쪽으로 오르막)의 법선은 [-√½, 0, √½]', () => {
  // z = x 평면: 동으로 1 m 가면 1 m 상승.
  const pos = new Float32Array([0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0]);
  const idx = new Uint32Array([0, 1, 2]);
  const n = faceNormalEnu(pos, idx, 0);
  const h = Math.SQRT1_2;
  near(n[0], -h); near(n[1], 0); near(n[2], h);
});

test('45도 경사(북쪽으로 오르막)의 법선은 [0, -√½, √½]', () => {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 1]);
  const idx = new Uint32Array([0, 1, 2]);
  const n = faceNormalEnu(pos, idx, 0);
  near(n[0], 0); near(n[1], -Math.SQRT1_2); near(n[2], Math.SQRT1_2);
});

test('삼각형 순서를 뒤집으면 법선이 반대(nz<0)', () => {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual(faceNormalEnu(pos, new Uint32Array([0, 1, 2]), 0), [0, 0, 1]);
  assert.deepEqual(faceNormalEnu(pos, new Uint32Array([0, 2, 1]), 0), [0, 0, -1]);
});

test('면적 0 삼각형은 [0,0,1]', () => {
  const pos = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 2, 2, 2]);
  assert.deepEqual(faceNormalEnu(pos, new Uint32Array([0, 1, 2]), 0), [0, 0, 1]);
  // 한 직선 위의 세 점
  assert.deepEqual(faceNormalEnu(pos, new Uint32Array([0, 3, 4]), 0), [0, 0, 1]);
});

test('tri 번호로 인덱스 버퍼의 해당 삼각형을 고른다', () => {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const idx = new Uint32Array([0, 1, 2, 0, 3, 1]);
  assert.deepEqual(faceNormalEnu(pos, idx, 0), [0, 0, 1]);
  assert.deepEqual(faceNormalEnu(pos, idx, 1), [0, 1, 0]);
});

test('평평한 면: 광원이 정확히 위면 base 그대로', () => {
  assert.deepEqual(shadeLambert([0, 0, 1], [0, 0, 5], [150, 160, 140], 0.3), [150, 160, 140]);
});

test('광원 반대쪽이면 ambient 만: 150·0.3=45, 160·0.3=48, 140·0.3=42', () => {
  assert.deepEqual(shadeLambert([0, 0, 1], [0, 0, -1], [150, 160, 140], 0.3), [45, 48, 42]);
  assert.deepEqual(shadeLambert([0, 0, 1], [1, 0, 0], [150, 160, 140], 0.3), [45, 48, 42]); // 수직(n·l=0)
});

test('45도 경사 해석값: n·l = √½ 일 때 I = 0.3+0.7·√½ = 0.79497', () => {
  const n = [-Math.SQRT1_2, 0, Math.SQRT1_2];
  // 광원이 천정: n·l = √½. 100·0.794975 = 79.4975 → 79, 200·… = 158.995 → 159.
  assert.deepEqual(shadeLambert(n, [0, 0, 1], [100, 200, 0], 0.3), [79, 159, 0]);
  // 광원이 법선 방향: I = 1.
  assert.deepEqual(shadeLambert(n, [-3, 0, 3], [100, 200, 255], 0.3), [100, 200, 255]);
});

test('lightDir 길이에 무관(정규화)', () => {
  const a = shadeLambert([0, 0, 1], [0.3, 0.2, 0.9], [150, 160, 140], 0.3);
  const b = shadeLambert([0, 0, 1], [30, 20, 90], [150, 160, 140], 0.3);
  assert.deepEqual(a, b);
});

test('결과는 0..255 정수로 클램프', () => {
  assert.deepEqual(shadeLambert([0, 0, 1], [0, 0, 1], [300, -10, 255], 0.3), [255, 0, 255]);
  for (const v of shadeLambert([0, 0, 1], [0, 0, 1], [1.4, 254.6, 0.5], 0)) assert.ok(Number.isInteger(v));
});

test('ambient 경계 0 과 1', () => {
  assert.deepEqual(shadeLambert([0, 0, 1], [0, 0, -1], [150, 160, 140], 0), [0, 0, 0]);
  assert.deepEqual(shadeLambert([0, 0, 1], [0, 0, -1], [150, 160, 140], 1), [150, 160, 140]);
});

test('잘못된 입력은 던진다', () => {
  const ok = [0, 0, 1], b = [1, 2, 3];
  assert.throws(() => shadeLambert(ok, [0, 0, 0], b, 0.3), RangeError);
  assert.throws(() => shadeLambert(ok, [NaN, 0, 1], b, 0.3), TypeError);
  assert.throws(() => shadeLambert(ok, [Infinity, 0, 1], b, 0.3), TypeError);
  assert.throws(() => shadeLambert(ok, [0, 1], b, 0.3), TypeError);
  assert.throws(() => shadeLambert([0, 0, 0], ok, b, 0.3), RangeError);
  assert.throws(() => shadeLambert(ok, ok, b, -0.01), RangeError);
  assert.throws(() => shadeLambert(ok, ok, b, 1.01), RangeError);
  assert.throws(() => shadeLambert(ok, ok, b, NaN), RangeError);
  assert.throws(() => shadeLambert(ok, ok, [1, 2], 0.3), TypeError);
  assert.throws(() => shadeLambert(ok, ok, [1, 2, 3, 4], 0.3), TypeError);
  assert.throws(() => shadeLambert(ok, ok, [1, NaN, 3], 0.3), TypeError);
});

test('server 참조 lambert 와 랜덤 법선·광원 500개에서 같은 결과', () => {
  const r = rng(20260101);
  const rv = () => [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
  let lit = 0, dark = 0;
  for (let k = 0; k < 500; k += 1) {
    const n = rv(), l = rv();
    const scale = 0.5 + r() * 20;
    const base = [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256)];
    const ambient = k % 5 === 0 ? [0, 1][(k / 5) % 2] : r();
    const got = shadeLambert(n, l.map((x) => x * scale), base, ambient);
    const want = lambert(n, l, base, { ambient });
    assert.deepEqual(got, want, `k=${k}`);
    const d = (n[0] * l[0] + n[1] * l[1] + n[2] * l[2]);
    if (d > 0) lit += 1; else dark += 1;
  }
  assert.ok(lit > 100 && dark > 100, `양쪽 분포 확인 lit=${lit} dark=${dark}`);
});

// ---- 화소별 정점 법선 보간 음영(결정 0046 선택지 D) ----
// shade.mjs 의 음영 서술(lambert 속성), mesh.mjs 의 정점 법선, raster.mjs 의 화소별 음영 경로를 함께 본다.

test('shadeLambert 결과의 lambert 서술: 열거되지 않고 단위 광원·base·ambient 를 담는다', () => {
  const c = shadeLambert([0, 0, 1], [0, 3, 4], [150, 160, 140], 0.3);
  assert.deepEqual(c, [150, 160, 140].map((v) => Math.round(v * (0.3 + 0.7 * 0.8))));
  assert.deepEqual(Object.keys(c), ['0', '1', '2']);
  assert.equal(JSON.stringify(c), JSON.stringify([...c]));
  const m = c.lambert;
  assert.ok(Object.isFrozen(m));
  assert.ok(Math.abs(m.l[0]) < 1e-15 && Math.abs(m.l[1] - 0.6) < 1e-15 && Math.abs(m.l[2] - 0.8) < 1e-15);
  assert.deepEqual([...m.baseRgb], [150, 160, 140]);
  assert.equal(m.ambient, 0.3);
  // 같은 인자면 같은 서술 객체, 다르면 새 서술
  assert.equal(shadeLambert([1, 0, 0], [0, 3, 4], [150, 160, 140], 0.3).lambert, m);
  assert.notEqual(shadeLambert([1, 0, 0], [0, 3, 4], [150, 160, 141], 0.3).lambert, m);
});

test('buildLayerMesh 정점 법선: 평면은 면 법선과 같고, 타일 경계 정점은 이웃 타일과 같은 법선이다', async () => {
  const { buildLayerMesh } = await import('./mesh.mjs');
  // 평면 z = 2 + 0.25x − 0.5y (타일 2개, cells 5)
  const cells = 5;
  const tile = (tx, ty) => {
    const h = new Float32Array(cells * cells);
    for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
      const x = 64 * tx + (i * 64) / (cells - 1), y = 64 * ty + (j * 64) / (cells - 1);
      h[j * cells + i] = 2 + 0.25 * x - 0.5 * y;
    }
    return { tx, ty, lod: 2, cells, heights: h };
  };
  const m = buildLayerMesh([tile(0, 0), tile(1, 0)]);
  assert.equal(m.normals.length, m.positions.length);
  const want = [-0.25, 0.5, 1].map((v) => v / Math.hypot(0.25, 0.5, 1));
  for (let k = 0; k < m.normals.length; k += 3) {
    for (let a = 0; a < 3; a++) assert.ok(Math.abs(m.normals[k + a] - want[a]) < 1e-5, `정점 ${k / 3} 성분 ${a}: ${m.normals[k + a]}`);
  }
  assert.equal(buildLayerMesh([]).normals.length, 0);

  // 경계를 따라 꺾인 지붕: 타일 (0,0) 은 z = x/64·8(오르막), 타일 (1,0) 은 z = 8 − (x−64)/64·8(내리막).
  const roof = (tx) => {
    const h = new Float32Array(cells * cells);
    for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) h[j * cells + i] = tx === 0 ? (i / (cells - 1)) * 8 : 8 - (i / (cells - 1)) * 8;
    return { tx, ty: 0, lod: 2, cells, heights: h };
  };
  const r = buildLayerMesh([roof(0), roof(1)]);
  const vN = cells * cells;
  for (let j = 0; j < cells; j++) {
    const a = 3 * (j * cells + cells - 1); // 타일 0 의 오른쪽 열
    const b = 3 * (vN + j * cells); // 타일 1 의 왼쪽 열(같은 위치)
    assert.deepEqual([r.positions[a], r.positions[a + 1], r.positions[a + 2]], [r.positions[b], r.positions[b + 1], r.positions[b + 2]]);
    assert.deepEqual([r.normals[a], r.normals[a + 1], r.normals[a + 2]], [r.normals[b], r.normals[b + 1], r.normals[b + 2]], `행 ${j}`);
    assert.ok(Math.abs(r.normals[a]) < 0.2, `용마루 법선 x 성분 ${r.normals[a]}`); // 양쪽 경사가 상쇄
  }
  // 안쪽 정점은 자기 면 법선(오르막 → x 성분 음수)
  assert.ok(r.normals[3 * (2 * cells + 1)] < -0.1);
});

test('rasterizeTriangles 화소별 음영: 평면은 면 음영과 같고, 정점 법선이 다르면 화소 사이에서 색이 연속으로 변한다', async () => {
  const { rasterizeTriangles } = await import('./raster.mjs');
  const { emptyResult } = await import('../../../contracts/raster/index.mjs');
  const cam = { width: 32, height: 32, K: { fx: 30, fy: 30, cx: 16, cy: 16 }, R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [0, 0, 10] };
  const positions = new Float32Array([-6, -6, 0, 6, -6, 0, 6, 6, 0, -6, 6, 0]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const tileOfTriangle = new Int32Array([0, 0]);
  const L = [0.3, -0.2, 0.9], base = [200, 180, 160];
  const shadeFace = (tri) => shadeLambert(faceNormalEnu(positions, indices, tri), L, base, 0.25);
  // (1) 정점 법선이 모두 면 법선이면 면 음영과 화소마다 같다
  const up = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const a = emptyResult(32, 32), b = emptyResult(32, 32);
  rasterizeTriangles(cam, { positions, indices, tileOfTriangle }, shadeFace, a);
  rasterizeTriangles(cam, { positions, indices, tileOfTriangle, normals: up }, shadeFace, b);
  assert.deepEqual(b.color, a.color);
  assert.ok(a.index.some((v) => v === 0));
  // (2) 왼쪽 정점은 서쪽으로, 오른쪽 정점은 동쪽으로 기운 법선: 같은 행에서 x 에 따라 색이 단조롭게 변하고 인접 화소 차가 작다
  const s = Math.SQRT1_2;
  const tilt = new Float32Array([-s, 0, s, s, 0, s, s, 0, s, -s, 0, s]);
  const c = emptyResult(32, 32);
  rasterizeTriangles(cam, { positions, indices, tileOfTriangle, normals: tilt }, (tri) => shadeLambert([0, 0, 1], [1, 0, 1], base, 0.25), c);
  const row = 16, vals = [];
  for (let x = 0; x < 32; x++) if (c.index[row * 32 + x] === 0) vals.push(c.color[3 * (row * 32 + x)]);
  assert.ok(vals.length > 20, `칠한 화소 ${vals.length}`);
  for (let k = 1; k < vals.length; k++) {
    assert.ok(vals[k] >= vals[k - 1], `단조 증가 아님: ${vals}`);
    assert.ok(vals[k] - vals[k - 1] <= 8, `인접 차 큼: ${vals}`);
  }
  assert.ok(vals[vals.length - 1] - vals[0] > 50, `양끝 차 ${vals[0]}..${vals[vals.length - 1]}`);
  // (3) normals:'face' 이면 정점 법선을 무시한다
  const d = emptyResult(32, 32);
  rasterizeTriangles(cam, { positions, indices, tileOfTriangle, normals: tilt }, shadeFace, d, { normals: 'face' });
  assert.deepEqual(d.color, a.color);
  // (4) 길이가 틀린 normals·비유한 법선은 던진다
  assert.throws(() => rasterizeTriangles(cam, { positions, indices, tileOfTriangle, normals: new Float32Array(3) }, shadeFace, emptyResult(32, 32)), TypeError);
  const bad = Float32Array.from(up); bad[4] = NaN;
  assert.throws(() => rasterizeTriangles(cam, { positions, indices, tileOfTriangle, normals: bad }, shadeFace, emptyResult(32, 32)), TypeError);
});
