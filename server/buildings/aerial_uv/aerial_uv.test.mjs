import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAerialUv, aerialUvOf } from './index.mjs';
import { TowerAssetError, ALIGN_TOLERANCE_PX, buildingHeightM } from '../../../contracts/tower_assets/index.mjs';

// 시험 전용 프리즘 생성기(다른 하위 작업 코드를 쓰지 않는다).
// 벽: 변마다 정점 4개(아래 2, 위 2) 별도. 지붕: 볼록 다각형 부채꼴 삼각분할, 정점 별도.
// 반환: mesh 와 정점별 종류('wall' | 'roof').
function prism(ring, heightM) {
  const pos = [];
  const idx = [];
  const kind = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    const b = pos.length / 3;
    pos.push(x0, y0, 0, x1, y1, 0, x1, y1, heightM, x0, y0, heightM);
    kind.push('wall', 'wall', 'wall', 'wall');
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const r = pos.length / 3;
  for (const [x, y] of ring) { pos.push(x, y, heightM); kind.push('roof'); }
  for (let i = 1; i + 1 < n; i++) idx.push(r, r + i, r + i + 1);
  return { mesh: { positions: new Float32Array(pos), indices: new Uint32Array(idx) }, kind };
}

// 결정적 의사난수(LCG).
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// 픽셀마다 고유 색: r = col 하위 8비트, g = row 하위 8비트, b = (col 상위 4비트) | (row 상위 4비트)<<4.
function codedImage(width, height, bounds) {
  const rgb = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const k = (row * width + col) * 3;
      rgb[k] = col & 255;
      rgb[k + 1] = row & 255;
      rgb[k + 2] = ((col >> 8) & 15) | (((row >> 8) & 15) << 4);
    }
  }
  return { width, height, rgb, bounds };
}

// UV 로 최근접 샘플 → 색 → 픽셀 좌표 복원.
function sampleDecoded(img, u, v) {
  const col = Math.min(Math.floor(u * img.width), img.width - 1);
  const row = Math.min(Math.floor(v * img.height), img.height - 1);
  const k = (row * img.width + col) * 3;
  const r = img.rgb[k], g = img.rgb[k + 1], b = img.rgb[k + 2];
  return { col: r | ((b & 15) << 8), row: g | ((b >> 4) << 8) };
}

// 정답 픽셀: 정점 ENU 위치에서 독립적으로 계산(행 0 = 북쪽 끝).
function truthPixel(img, x, y) {
  const { minX, minY, maxX, maxY } = img.bounds;
  const col = Math.min(Math.floor(((x - minX) / (maxX - minX)) * img.width), img.width - 1);
  const row = Math.min(Math.floor(((maxY - y) / (maxY - minY)) * img.height), img.height - 1);
  return { col, row };
}

function randomPrisms(bounds, count, seed) {
  const rnd = lcg(seed);
  const out = [];
  const w = bounds.maxX - bounds.minX, h = bounds.maxY - bounds.minY;
  for (let i = 0; i < count; i++) {
    const cx = bounds.minX + w * (0.1 + 0.8 * rnd());
    const cy = bounds.minY + h * (0.1 + 0.8 * rnd());
    const rad = Math.min(w, h) * 0.08 * (0.2 + rnd());
    const sides = 3 + Math.floor(rnd() * 6);
    const ring = [];
    for (let s = 0; s < sides; s++) {
      const a = (2 * Math.PI * s) / sides + rnd() * 0.3;
      ring.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
    }
    out.push(prism(ring, buildingHeightM(1 + Math.floor(rnd() * 20))));
  }
  return out;
}

test('기준 숫자: 지붕·벽 UV 리터럴', () => {
  const img = codedImage(4, 2, { minX: 0, minY: 0, maxX: 100, maxY: 50 });
  const { mesh } = prism([[25, 10], [75, 10], [75, 40], [25, 40]], 9);
  const { uv } = buildAerialUv(mesh, img);
  assert.ok(uv instanceof Float32Array);
  assert.equal(uv.length, 20 * 2);
  // 첫 벽 (25,10,0)-(75,10,0)-(75,10,9)-(25,10,9)
  assert.deepEqual([...uv.slice(0, 8)], [0.25, 0.800000011920929, 0.75, 0.800000011920929, 0.75, 0.800000011920929, 0.25, 0.800000011920929]);
  // 지붕 4정점 (25,10)(75,10)(75,40)(25,40)
  assert.deepEqual([...uv.slice(32, 40)], [0.25, 0.800000011920929, 0.75, 0.800000011920929, 0.75, 0.20000000298023224, 0.25, 0.20000000298023224]);
  // 모서리: 북서 (0,50) → (0,0), 남동 (100,0) → (1,1)
  assert.deepEqual(aerialUvOf(0, 50, img.bounds), [0, 0]);
  assert.deepEqual(aerialUvOf(100, 0, img.bounds), [1, 1]);
});

test('벽은 바닥 외곽 위치를 수직으로 늘려 샘플: 위·아래 정점 UV 동일, 지붕 모서리와도 동일', () => {
  const bounds = { minX: -40, minY: 10, maxX: 60, maxY: 90 };
  const img = codedImage(8, 8, bounds);
  const ring = [[-10, 20], [30, 25], [20, 70], [-5, 60]];
  const { mesh } = prism(ring, 15);
  const { uv } = buildAerialUv(mesh, img);
  for (let e = 0; e < ring.length; e++) {
    const b = e * 4;
    assert.deepEqual([uv[2 * b], uv[2 * b + 1]], [uv[2 * (b + 3)], uv[2 * (b + 3) + 1]]);
    assert.deepEqual([uv[2 * (b + 1)], uv[2 * (b + 1) + 1]], [uv[2 * (b + 2)], uv[2 * (b + 2) + 1]]);
    const r = ring.length * 4 + e;
    assert.deepEqual([uv[2 * b], uv[2 * b + 1]], [uv[2 * r], uv[2 * r + 1]]);
  }
});

test('알려진 색 블록: 지붕·벽 정점이 자기 블록 색을 샘플', () => {
  // 4×4 블록(블록당 16×16 px), 블록 색 = (bx·60, by·60, 200). 영상 범위 0..80 m × 0..80 m, 블록 = 20 m.
  const bounds = { minX: 0, minY: 0, maxX: 80, maxY: 80 };
  const W = 64, H = 64;
  const rgb = new Uint8Array(W * H * 3);
  for (let row = 0; row < H; row++) for (let col = 0; col < W; col++) {
    const k = (row * W + col) * 3;
    rgb[k] = (col >> 4) * 60; rgb[k + 1] = (row >> 4) * 60; rgb[k + 2] = 200;
  }
  const img = { width: W, height: H, rgb, bounds };
  // 블록 (bx=2, by=0 행 기준 → 북쪽 줄) 안: x ∈ (40,60), y ∈ (60,80)
  const { mesh } = prism([[44, 64], [56, 64], [56, 76], [44, 76]], 6);
  const { uv } = buildAerialUv(mesh, img);
  for (let i = 0; i < uv.length / 2; i++) {
    const col = Math.floor(uv[2 * i] * W), row = Math.floor(uv[2 * i + 1] * H);
    const k = (row * W + col) * 3;
    assert.deepEqual([rgb[k], rgb[k + 1], rgb[k + 2]], [120, 0, 200]);
  }
});

const RESOLUTIONS = [
  [64, 64], [333, 257], [1024, 768], [4000, 3000],
];
const ALIGN_BOUNDS = { minX: -1234.5, minY: 987.25, maxX: -234.5, maxY: 1737.25 }; // 1000 m × 750 m

for (const [W, H] of RESOLUTIONS) {
  test(`정합 ${W}×${H}: UV 샘플 픽셀 − ENU 정답 픽셀 ≤ ${ALIGN_TOLERANCE_PX} px`, () => {
    const img = codedImage(W, H, ALIGN_BOUNDS);
    const prisms = randomPrisms(ALIGN_BOUNDS, 40, 7 + W);
    let maxErr = 0, verts = 0;
    for (const { mesh } of prisms) {
      const { uv } = buildAerialUv(mesh, img);
      const p = mesh.positions;
      for (let i = 0; i < p.length / 3; i++) {
        const u = uv[2 * i], v = uv[2 * i + 1];
        assert.ok(u >= 0 && u <= 1 && v >= 0 && v <= 1);
        const got = sampleDecoded(img, u, v);
        const want = truthPixel(img, p[3 * i], p[3 * i + 1]);
        maxErr = Math.max(maxErr, Math.abs(got.col - want.col), Math.abs(got.row - want.row));
        // 연속 좌표 오차도 본다.
        const { minX, minY, maxX, maxY } = img.bounds;
        const cx = ((p[3 * i] - minX) / (maxX - minX)) * W, cy = ((maxY - p[3 * i + 1]) / (maxY - minY)) * H;
        assert.ok(Math.abs(u * W - cx) < 0.01 && Math.abs(v * H - cy) < 0.01);
        verts++;
      }
    }
    assert.ok(verts > 0);
    assert.ok(maxErr <= ALIGN_TOLERANCE_PX, `maxErr ${maxErr}`);
    console.log(`# align ${W}x${H}: vertices=${verts} maxErrPx=${maxErr}`);
  });
}

test('영상 밖 정점은 잘라 채우지 않고 TowerAssetError', () => {
  const img = codedImage(8, 8, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
  assert.throws(() => buildAerialUv(prism([[1, 1], [11, 1], [11, 5]], 6).mesh, img), TowerAssetError);
  assert.throws(() => buildAerialUv(prism([[1, -0.5], [5, 1], [5, 5]], 6).mesh, img), TowerAssetError);
  assert.throws(() => buildAerialUv(prism([[1, 1], [5, 1], [5, 10.001]], 6).mesh, img), TowerAssetError);
  assert.throws(() => buildAerialUv(prism([[1, 1], [NaN, 1], [5, 5]], 6).mesh, img), TowerAssetError);
  // 경계 위는 허용
  const { uv } = buildAerialUv(prism([[0, 0], [10, 0], [10, 10]], 6).mesh, img);
  assert.equal(Math.min(...uv), 0);
  assert.equal(Math.max(...uv), 1);
});

test('입력 검증', () => {
  const ok = codedImage(2, 2, { minX: 0, minY: 0, maxX: 1, maxY: 1 });
  const { mesh } = prism([[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]], 3);
  assert.throws(() => buildAerialUv(mesh, { ...ok, width: 0 }), TowerAssetError);
  assert.throws(() => buildAerialUv(mesh, { ...ok, rgb: new Uint8Array(3) }), TowerAssetError);
  assert.throws(() => buildAerialUv(mesh, { ...ok, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 1 } }), TowerAssetError);
  assert.throws(() => buildAerialUv({ positions: new Float32Array(4), indices: new Uint32Array(0) }, ok), TowerAssetError);
  assert.equal(buildAerialUv({ positions: new Float32Array(0), indices: new Uint32Array(0) }, ok).uv.length, 0);
});

test('결정적: 같은 입력 → 같은 바이트', () => {
  const img = codedImage(333, 257, ALIGN_BOUNDS);
  const [{ mesh }] = randomPrisms(ALIGN_BOUNDS, 1, 42);
  const a = buildAerialUv(mesh, img).uv, b = buildAerialUv(mesh, img).uv;
  assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
});
