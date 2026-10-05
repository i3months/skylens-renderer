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
// 구현식과 대수적으로 같은 식이라 이 함수만으로는 관례 오류를 못 잡는다 — 아래 '픽셀 중심' 시험이 반대 방향(픽셀 → ENU)으로 독립 검증한다.
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

test('벽·바닥 정점은 영상 UV 를 쓰지 않는다: wallMask 1, 지붕 정점은 0', () => {
  const bounds = { minX: -40, minY: 10, maxX: 60, maxY: 90 };
  const img = codedImage(8, 8, bounds);
  const ring = [[-10, 20], [30, 25], [20, 70], [-5, 60]];
  const { mesh, kind } = prism(ring, 15);
  const { uv, wallMask } = buildAerialUv(mesh, img);
  assert.ok(wallMask instanceof Uint8Array);
  assert.equal(wallMask.length, uv.length / 2);
  kind.forEach((k, i) => assert.equal(wallMask[i], k === 'wall' ? 1 : 0, `정점 ${i} (${k})`));
  // 지붕 정점 UV 는 그대로 평면 투영
  const r = ring.length * 4;
  assert.deepEqual([uv[2 * r], uv[2 * r + 1]], aerialUvOf(ring[0][0], ring[0][1], bounds).map(Math.fround));
});

test('지붕과 벽이 정점을 공유하면 지붕으로 친다(mask 0), 아래 향 면만 쓰는 정점은 mask 1', () => {
  const img = codedImage(4, 4, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
  // 정점 0..2 = 지붕(z=5, 위 향), 정점 3..5 = 바닥(z=0), 정점 6 = 어느 삼각형에도 안 쓰이는 정점.
  // 바닥 삼각형 (3,5,4) 는 아래 향이라 mask 에 기여하지 않는다.
  // 벽 삼각형 (0,3,4) 는 수직 면이고 정점 0 을 지붕과 공유한다 → 0 은 지붕으로 쳐서 mask 0, 3·4 는 바닥·벽만 써서 mask 1.
  const positions = new Float32Array([1, 1, 5, 6, 1, 5, 1, 6, 5, 1, 1, 0, 6, 1, 0, 1, 6, 0, 9, 9, 0]);
  const indices = new Uint32Array([0, 1, 2, 3, 5, 4, 0, 3, 4]); // 지붕(위), 바닥(아래), 벽(수직)
  const { wallMask } = buildAerialUv({ positions, indices }, img);
  assert.deepEqual([...wallMask], [0, 0, 0, 1, 1, 1, 1]);
});

test('수직(벽) 면 정점에는 영상 UV 를 주지 않는다: 벽만 있는 메시는 전 정점 wallMask 1 (RULES 1.2)', () => {
  const img = codedImage(4, 4, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
  // x=2 평면의 수직 사각형(법선 ±x): 어느 방향 순서든 영상 UV 를 받아선 안 된다.
  const positions = new Float32Array([2, 1, 0, 2, 5, 0, 2, 5, 6, 2, 1, 6]);
  for (const indices of [[0, 1, 2, 0, 2, 3], [0, 2, 1, 0, 3, 2]]) {
    const { wallMask } = buildAerialUv({ positions, indices: new Uint32Array(indices) }, img);
    assert.deepEqual([...wallMask], [1, 1, 1, 1]);
  }
  // 프리즘의 벽 정점은 모두 mask 1(지붕 정점만 0).
  const { mesh, kind } = prism([[2, 2], [8, 2], [8, 8], [2, 8]], 7);
  const { wallMask } = buildAerialUv(mesh, img);
  kind.forEach((k, i) => { if (k === 'wall') assert.equal(wallMask[i], 1, `벽 정점 ${i}`); });
});

test('비스듬한 면: 아래 향이면 |nz| 비율이 커도 지붕이 아니다(법선 z 의 부호를 본다)', () => {
  const img = codedImage(4, 4, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
  // 정점 (1,1,0) (1,5,0) (5,1,2): u=(0,4,0), v=(4,0,2) → u×v = (8, 0, -16): nz < 0 (아래 향), |nz|/len = 16/√320 ≈ 0.894 (> 0.5).
  const positions = new Float32Array([1, 1, 0, 1, 5, 0, 5, 1, 2]);
  assert.deepEqual([...buildAerialUv({ positions, indices: new Uint32Array([0, 1, 2]) }, img).wallMask], [1, 1, 1]);
  // 순서를 뒤집으면 법선 (-8, 0, 16): 위 향, 같은 비율 → 지붕.
  assert.deepEqual([...buildAerialUv({ positions, indices: new Uint32Array([0, 2, 1]) }, img).wallMask], [0, 0, 0]);
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

test('독립 정답: 픽셀 (col, row) 중심의 ENU 위치에 선 정점은 그 픽셀을 샘플한다(행 0 = 북)', () => {
  // 영상 5×3 px, 폭 50 m × 높이 30 m → 픽셀 한 변 10 m. 픽셀 중심 ENU 는 구현식과 무관하게 손으로 만든다:
  //   동쪽으로 col 이 늘고(x = minX + 10·col + 5), 남쪽으로 row 가 는다(y = maxY − 10·row − 5). 행 0 = 북쪽 끝.
  const bounds = { minX: 100, minY: -20, maxX: 150, maxY: 10 };
  const img = codedImage(5, 3, bounds);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) {
    const x = 100 + 10 * col + 5, y = 10 - 10 * row - 5;
    const { uv } = buildAerialUv({ positions: new Float32Array([x, y, 0]), indices: new Uint32Array(0) }, img);
    assert.deepEqual(sampleDecoded(img, uv[0], uv[1]), { col, row }, `픽셀 (${col},${row})`);
  }
  // 북쪽 끝 y = maxY 는 행 0, 남쪽 끝 y = minY 는 마지막 행
  assert.equal(aerialUvOf(125, 10, bounds)[1], 0);
  assert.equal(aerialUvOf(125, -20, bounds)[1], 1);
});

test('Float32 정점이 double 경계 밖으로 반올림돼도 fround(경계)까지는 허용', () => {
  // fround(0.1) > 0.1, fround(-0.1) < -0.1
  assert.ok(Math.fround(0.1) > 0.1 && Math.fround(-0.1) < -0.1);
  const img = codedImage(4, 4, { minX: -0.1, minY: -0.1, maxX: 0.1, maxY: 0.1 });
  const tri = (x, y) => ({ positions: new Float32Array([x, y, 0, 0, 0, 0, 0, 0, 0]), indices: new Uint32Array(0) });
  for (const [x, y] of [[0.1, 0.1], [-0.1, -0.1], [0.1, -0.1], [-0.1, 0.1]]) {
    const { uv } = buildAerialUv(tri(x, y), img);
    for (const c of uv) assert.ok(c >= 0 && c <= 1);
  }
  // 한 Float32 단계 더 밖은 여전히 거부
  assert.throws(() => buildAerialUv(tri(Math.fround(0.1) * 1.001, 0), img), TowerAssetError);
});

test('aerialUvOf: bounds 검증', () => {
  assert.throws(() => aerialUvOf(0, 0, undefined), TowerAssetError);
  assert.throws(() => aerialUvOf(0, 0, { minX: 0, minY: 0, maxX: 0, maxY: 1 }), TowerAssetError);
  assert.throws(() => aerialUvOf(0, 0, { minX: 0, minY: 0, maxX: NaN, maxY: 1 }), TowerAssetError);
  assert.throws(() => aerialUvOf(0, 0, { minX: 0, minY: 1, maxX: 1, maxY: 0 }), TowerAssetError);
});

test('가파른 경사면(법선 z 비율 < 0.5, 위 향)은 지붕이 아니다: 법선 길이는 3성분 전체로 잰다', () => {
  const img = codedImage(4, 4, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
  // 정점 0,1,2: x 방향 4 m 에 z 가 +8 m 오르는 경사 (법선 ∝ (-2·.., 0, 1)): 법선 z 비율 = 1/√5 ≈ 0.447 (< 0.5), nz > 0.
  const steep = new Float32Array([1, 1, 0, 1, 5, 0, 5, 1, 8]);
  // 위 향 순서 확인: (b-a)×(c-a) 의 z > 0
  const a = steep, ux = a[3] - a[0], uy = a[4] - a[1], vx = a[6] - a[0], vy = a[7] - a[1];
  const nz = ux * vy - uy * vx;
  const idx = nz > 0 ? [0, 1, 2] : [0, 2, 1];
  assert.ok(nz !== 0);
  const { wallMask } = buildAerialUv({ positions: steep, indices: new Uint32Array(idx) }, img);
  assert.deepEqual([...wallMask], [1, 1, 1]);
  // y 방향 경사도 같다: (1,1,0) (5,1,0) (1,5,8) 순서 (0,1,2) → 법선 (0, -32, 16): 위 향, z 비율 0.447 (< 0.5)
  const steepY = new Float32Array([1, 1, 0, 5, 1, 0, 1, 5, 8]);
  const { wallMask: my } = buildAerialUv({ positions: steepY, indices: new Uint32Array([0, 1, 2]) }, img);
  assert.deepEqual([...my], [1, 1, 1]);
  // 완만한 경사(z 비율 > 0.5)는 지붕
  const gentle = new Float32Array([1, 1, 0, 1, 5, 0, 5, 1, 2]);
  const { wallMask: m2 } = buildAerialUv({ positions: gentle, indices: new Uint32Array(idx) }, img);
  assert.deepEqual([...m2], [0, 0, 0]);
});

// Float32 에서 다음(위) / 이전(아래) 표현 가능한 값.
function stepF32(x, dir) {
  const f = new Float32Array([x]), u = new Uint32Array(f.buffer);
  if (x === 0) return dir > 0 ? 1.401298464324817e-45 : -1.401298464324817e-45;
  u[0] += (x > 0) === (dir > 0) ? 1 : -1;
  return f[0];
}

test('Float32 경계 허용은 정확히 fround(경계) 까지: 다음 Float32 값은 위·아래 모두 거부', () => {
  const tri = (x, y) => ({ positions: new Float32Array([x, y, 0]), indices: new Uint32Array(0) });
  // 경계가 Float32 로 표현되는 경우(10)와 안 되는 경우(0.1) 모두.
  for (const [lo, hi] of [[0, 10], [-0.1, 0.1]]) {
    const img = codedImage(4, 4, { minX: lo, minY: lo, maxX: hi, maxY: hi });
    const hiOk = Math.max(hi, Math.fround(hi)), loOk = Math.min(lo, Math.fround(lo));
    const hiBad = stepF32(Math.fround(hiOk), +1), loBad = stepF32(Math.fround(loOk), -1);
    assert.ok(hiBad > hiOk && loBad < loOk);
    assert.doesNotThrow(() => buildAerialUv(tri(Math.fround(hi), Math.fround(hi)), img));
    assert.doesNotThrow(() => buildAerialUv(tri(Math.fround(lo), Math.fround(lo)), img));
    assert.throws(() => buildAerialUv(tri(hiBad, 0), img), TowerAssetError, `maxX 다음 값 ${hiBad}`);
    assert.throws(() => buildAerialUv(tri(0, hiBad), img), TowerAssetError, `maxY 다음 값 ${hiBad}`);
    assert.throws(() => buildAerialUv(tri(loBad, 0), img), TowerAssetError, `minX 이전 값 ${loBad}`);
    assert.throws(() => buildAerialUv(tri(0, loBad), img), TowerAssetError, `minY 이전 값 ${loBad}`);
  }
});

test('음수·비정수 인덱스는 TowerAssetError', () => {
  const img = codedImage(2, 2, { minX: 0, minY: 0, maxX: 1, maxY: 1 });
  const positions = new Float32Array([0.1, 0.1, 0, 0.5, 0.1, 0, 0.5, 0.5, 0]);
  for (const bad of [-1, 0.5, NaN]) {
    assert.throws(() => buildAerialUv({ positions, indices: [0, 1, bad] }, img), TowerAssetError, String(bad));
  }
  assert.throws(() => buildAerialUv({ positions, indices: [0, 1, 3] }, img), TowerAssetError);
  // 첫째·둘째 자리, 다른 배열 형태, 무한대도 같다
  assert.throws(() => buildAerialUv({ positions, indices: [-1, 1, 2] }, img), TowerAssetError);
  assert.throws(() => buildAerialUv({ positions, indices: [0, 1.5, 2] }, img), TowerAssetError);
  assert.throws(() => buildAerialUv({ positions, indices: new Float32Array([0, 1, -2]) }, img), TowerAssetError);
  assert.throws(() => buildAerialUv({ positions, indices: [0, 1, Infinity] }, img), TowerAssetError);
  assert.doesNotThrow(() => buildAerialUv({ positions, indices: [0, 1, 2] }, img));
});
