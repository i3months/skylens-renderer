// T14.4 건물 LOD 검증. 외부 의존성 없음, 결정적(고정 시드 PRNG, 고정 시점 리터럴).
// extrude(T14.3)는 아직 없으므로 이 파일 안에 자체 프리즘 생성 헬퍼를 둔다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILDING_LOD_MIN_SSIM, TowerAssetError, buildingHeightM, signedArea } from '../../../contracts/tower_assets/index.mjs';
import {
  buildBuildingLod, BUILDING_LOD_FAR_DIST_M, BUILDING_LOD_MAX_ANGLE_RAD, BUILDING_LOD_CELL_M,
  BUILDING_LOD_REF_PIXEL_RAD, BUILDING_LOD_MAX_GAP_PX,
} from './index.mjs';

// ───────── 합성 도시 ─────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 귀 자르기 삼각분할(반시계 단순 다각형). 결과는 정점 번호 삼각형 목록(반시계).
function earClip(ring) {
  const idx = ring.map((_, i) => i);
  const out = [];
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inside = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      const a = ring[i0], b = ring[i1], c = ring[i2];
      if (cross(a, b, c) <= 1e-12) continue;
      let ok = true;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (inside(ring[j], a, b, c)) { ok = false; break; }
      }
      if (!ok) continue;
      out.push([i0, i1, i2]);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) throw new Error('earClip 실패');
  }
  out.push([idx[0], idx[1], idx[2]]);
  return out;
}

// 테스트용 프리즘: 바닥 z = 0, 지붕 z = buildingHeightM(floors). 벽(바깥에서 반시계) + 지붕(위에서 반시계), 바닥 없음.
function prism(ring0, floors) {
  const ring = signedArea(ring0) < 0 ? [...ring0].reverse() : ring0;
  const n = ring.length;
  const h = buildingHeightM(floors);
  const positions = new Float32Array(n * 2 * 3);
  ring.forEach(([x, y], i) => {
    positions.set([x, y, 0], i * 3);
    positions.set([x, y, h], (n + i) * 3);
  });
  const tri = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri.push(i, j, n + j, i, n + j, n + i);
  }
  for (const [a, b, c] of earClip(ring)) tri.push(n + a, n + b, n + c);
  return { positions, indices: Uint32Array.from(tri) };
}

const LOT_M = 40;
const GRID = 16; // 16 × 16 = 256 동

// 격자 필지(40 m)마다 한 동. 외곽형: 회전 직사각형 / 정다각형(원통형 탑, 12~24각) / L 자. 층 수 무작위(일부는 층 정보 없음 → 6 m).
function syntheticCity(seed = 20261004) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const cx = (gx - GRID / 2 + 0.5) * LOT_M, cy = (gy - GRID / 2 + 0.5) * LOT_M;
      const kind = Math.floor(rnd() * 3);
      let ring;
      if (kind === 0) {
        const w = 12 + rnd() * 10, d = 12 + rnd() * 10, a = rnd() * Math.PI / 2;
        const c = Math.cos(a), s = Math.sin(a);
        ring = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
      } else if (kind === 1) {
        const n = 12 + Math.floor(rnd() * 13), r = 7 + rnd() * 8;
        ring = [];
        for (let i = 0; i < n; i++) ring.push([cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
      } else {
        const w = 16 + rnd() * 12, d = 16 + rnd() * 12, nw = w * (0.3 + rnd() * 0.3), nd = d * (0.3 + rnd() * 0.3);
        const x0 = cx - w / 2, y0 = cy - d / 2;
        ring = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + d - nd], [x0 + w - nw, y0 + d - nd], [x0 + w - nw, y0 + d], [x0, y0 + d]];
      }
      const floors = rnd() < 0.1 ? null : 1 + Math.floor(rnd() * 30);
      out.push({ id: gy * GRID + gx + 1000, mesh: prism(ring, floors) });
    }
  }
  return out;
}

const CITY = syntheticCity();

const PARCEL_M = 20;
const DENSE_GRID = 32; // 32 × 32 = 1024 동, ±320 m
const DENSE_BLOCK = 4; // 4 × 4 필지 = 한 가구(80 m)

// 실제로 합쳐지는 밀집 도시: 20 m 필지마다 한 동(틈 0.4~1.6 m), 가구(4 × 4 필지)마다 회전 0~3°(지적 외곽의 작은 기울기),
// 가구 안 한 줄(필지 4개)은 같은 층수(줄지은 연립). 가구 8개 중 1개 꼴로는 동마다 15~75° 로 크게 돌아간 건물을 섞고,
// 일부 필지에는 다각 원통을 둔다(방향 보호가 없으면 상자로 합쳐져 음영이 달라지는 대상).
function denseCity(seed = 307) {
  const rnd = mulberry32(seed);
  const out = [];
  const nb = DENSE_GRID / DENSE_BLOCK;
  for (let by = 0; by < nb; by++) {
    for (let bx = 0; bx < nb; bx++) {
      const rot = (rnd() * 3 * Math.PI) / 180;
      const wild = rnd() < 0.125;
      const bcx = (bx * DENSE_BLOCK - DENSE_GRID / 2 + DENSE_BLOCK / 2) * PARCEL_M;
      const bcy = (by * DENSE_BLOCK - DENSE_GRID / 2 + DENSE_BLOCK / 2) * PARCEL_M;
      const c = Math.cos(rot), s = Math.sin(rot);
      for (let j = 0; j < DENSE_BLOCK; j++) {
        const floors = 1 + Math.floor(rnd() * 12);
        const attached = rnd() < 0.5; // 맞벽 연립(줄 안 이웃과 틈 0)인 줄
        for (let i = 0; i < DENSE_BLOCK; i++) {
          const gx = bx * DENSE_BLOCK + i, gy = by * DENSE_BLOCK + j;
          const lx = (i - DENSE_BLOCK / 2 + 0.5) * PARCEL_M, ly = (j - DENSE_BLOCK / 2 + 0.5) * PARCEL_M;
          const g = () => 0.2 + rnd() * 0.6; // 필지 경계에서 물러난 거리(이웃과 틈 0.4~1.6 m)
          const h = PARCEL_M / 2;
          // 맞벽 줄은 줄 안쪽 옆면이 필지 경계에 붙고, 앞뒤 면은 집마다 0.2~0.8 m 들쭉날쭉하다.
          const x0 = lx - h + (attached && i > 0 ? 0 : g()), x1 = lx + h - (attached && i < DENSE_BLOCK - 1 ? 0 : g());
          const y0 = ly - h + g(), y1 = ly + h - g();
          let ring;
          if (rnd() < 0.04) {
            const n = 16, r = (h - 0.8) * 0.9;
            ring = [];
            for (let k = 0; k < n; k++) ring.push([lx + r * Math.cos((2 * Math.PI * k) / n), ly + r * Math.sin((2 * Math.PI * k) / n)]);
          } else if (wild) {
            const a = ((15 + rnd() * 60) * Math.PI) / 180, w = (h - 0.8) * 0.7;
            const ca = Math.cos(a), sa = Math.sin(a);
            ring = [[-w, -w], [w, -w], [w, w], [-w, w]].map(([x, y]) => [lx + x * ca - y * sa, ly + x * sa + y * ca]);
          } else {
            ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
          }
          ring = ring.map(([x, y]) => [bcx + x * c - y * s, bcy + x * s + y * c]);
          out.push({ id: 20000 + gy * DENSE_GRID + gx, mesh: prism(ring, floors) });
        }
      }
    }
  }
  return out;
}

const DENSE = denseCity();

function meshBounds(m) {
  const b = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (let i = 0; i < m.positions.length; i += 3) {
    const [x, y, z] = [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
    b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
    b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y);
    b.minZ = Math.min(b.minZ, z); b.maxZ = Math.max(b.maxZ, z);
  }
  return b;
}

// ───────── 시점과 타일 단위 LOD 적용 ─────────

// 고정 시점 8개(ENU m). 도시는 대략 ±320 m, 높이 ≤ 90 m.
const VIEWS = [
  { name: 'N-far', eye: [0, 2400, 150], at: [0, 0, 20] },
  { name: 'E-far', eye: [2600, 300, 200], at: [0, 0, 20] },
  { name: 'S-far-high', eye: [-400, -3000, 600], at: [0, 0, 0] },
  { name: 'W-far-low', eye: [-1800, -200, 60], at: [0, 0, 30] },
  { name: 'NE-mid', eye: [900, 900, 250], at: [0, 0, 0] },
  { name: 'SW-mid', eye: [-700, -800, 120], at: [0, 0, 30] },
  { name: 'S-near', eye: [0, -450, 80], at: [0, 0, 20] },
  { name: 'top-high', eye: [100, -300, 1800], at: [0, 0, 0] },
];

// 건물을 64 m 타일로 나누고, 타일마다 카메라에서 타일 상자(xy 타일 범위 × z [0, 최고 높이])까지 거리로 LOD 를 만든다.
function lodForView(city, eye) {
  const tiles = new Map();
  for (const b of city) {
    const bb = meshBounds(b.mesh);
    const key = `${Math.floor((bb.minX + bb.maxX) / 2 / BUILDING_LOD_CELL_M)},${Math.floor((bb.minY + bb.maxY) / 2 / BUILDING_LOD_CELL_M)}`;
    let t = tiles.get(key);
    if (!t) { const [tx, ty] = key.split(',').map(Number); t = { tx, ty, list: [], maxZ: 0 }; tiles.set(key, t); }
    t.list.push(b);
    t.maxZ = Math.max(t.maxZ, bb.maxZ);
  }
  const groups = [];
  for (const t of tiles.values()) {
    const s = BUILDING_LOD_CELL_M;
    const dx = Math.max(t.tx * s - eye[0], 0, eye[0] - (t.tx + 1) * s);
    const dy = Math.max(t.ty * s - eye[1], 0, eye[1] - (t.ty + 1) * s);
    const dz = Math.max(0 - eye[2], 0, eye[2] - t.maxZ);
    groups.push(...buildBuildingLod(t.list, Math.hypot(dx, dy, dz)));
  }
  return groups;
}

const triCount = (meshes) => meshes.reduce((n, m) => n + m.indices.length / 3, 0);

// ───────── 소프트웨어 투시 래스터 ─────────
// 깊이 버퍼(1/z_cam 를 화면 공간에서 선형 보간 → 원근 정확), 근평면 클리핑, 면 법선 단순 램버트 음영(양면, 카메라 쪽으로 뒤집음).
// 화면: 720 × 540, 세로 시야 30° → 한 픽셀 각 ≈ 9.7e-4 rad 로 LOD 기준 화면(60°/1080 px)과 같은 각 해상도.
const W = 720, H = 540, FOVY = Math.PI / 6, NEAR = 1;
const SKY = 235, GROUND = 120;
const LIGHT = (() => { const l = [0.35, 0.55, 0.76]; const n = Math.hypot(...l); return l.map((v) => v / n); })();

function render(meshes, view) {
  const img = new Float32Array(W * H).fill(SKY);
  const depth = new Float32Array(W * H); // 1/z, 0 = 무한대
  const mask = new Uint8Array(W * H); // 건물 픽셀 표시
  const [ex, ey, ez] = view.eye;
  let f = [view.at[0] - ex, view.at[1] - ey, view.at[2] - ez];
  const fl = Math.hypot(...f); f = f.map((v) => v / fl);
  let r = [f[1], -f[0], 0]; const rl = Math.hypot(...r); r = r.map((v) => v / rl); // right = f × up(Z)
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const focal = (H / 2) / Math.tan(FOVY / 2);
  const toCam = (x, y, z) => {
    const px = x - ex, py = y - ey, pz = z - ez;
    return [px * r[0] + py * r[1] + pz * r[2], px * u[0] + py * u[1] + pz * u[2], px * f[0] + py * f[1] + pz * f[2]];
  };

  const drawTri = (wa, wb, wc, shadeFixed, isBuilding) => {
    // 음영(월드 공간 면 법선)
    let shade = shadeFixed;
    if (shade === undefined) {
      const e1 = [wb[0] - wa[0], wb[1] - wa[1], wb[2] - wa[2]], e2 = [wc[0] - wa[0], wc[1] - wa[1], wc[2] - wa[2]];
      let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const nl = Math.hypot(...n);
      if (nl < 1e-12) return;
      n = n.map((v) => v / nl);
      if (n[0] * (ex - wa[0]) + n[1] * (ey - wa[1]) + n[2] * (ez - wa[2]) < 0) n = n.map((v) => -v);
      shade = 30 + 190 * Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
    }
    // 근평면 클리핑(Sutherland–Hodgman, z_cam ≥ NEAR)
    let poly = [toCam(...wa), toCam(...wb), toCam(...wc)];
    const clipped = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const pin = p[2] >= NEAR, qin = q[2] >= NEAR;
      if (pin) clipped.push(p);
      if (pin !== qin) {
        const t = (NEAR - p[2]) / (q[2] - p[2]);
        clipped.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), NEAR]);
      }
    }
    if (clipped.length < 3) return;
    poly = clipped.map(([x, y, z]) => [W / 2 + (focal * x) / z, H / 2 - (focal * y) / z, 1 / z]);
    for (let k = 1; k + 1 < poly.length; k++) rasterTri(poly[0], poly[k], poly[k + 1], shade, isBuilding);
  };

  const rasterTri = (a, b, c, shade, isBuilding) => {
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(area) < 1e-12) return;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    const inv = 1 / area;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const w0 = ((b[0] - px) * (c[1] - py) - (c[0] - px) * (b[1] - py)) * inv;
        const w1 = ((c[0] - px) * (a[1] - py) - (a[0] - px) * (c[1] - py)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const iz = w0 * a[2] + w1 * b[2] + w2 * c[2];
        const k = y * W + x;
        if (iz > depth[k]) { depth[k] = iz; img[k] = shade; mask[k] = isBuilding ? 1 : 0; }
      }
    }
  };

  // 지면(z = 0, 도시보다 넓은 정사각형). 건물 바닥과 같은 높이라 깊이 경합을 피하려 아주 살짝 내린다.
  const G = 600, gz = -0.05;
  drawTri([-G, -G, gz], [G, -G, gz], [G, G, gz], GROUND, false);
  drawTri([-G, -G, gz], [G, G, gz], [-G, G, gz], GROUND, false);
  for (const m of meshes) {
    const p = m.positions, idx = m.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      drawTri([p[a], p[a + 1], p[a + 2]], [p[b], p[b + 1], p[b + 2]], [p[c], p[c + 1], p[c + 2]], undefined, true);
    }
  }
  return { img, mask };
}

// 8×8 겹치지 않는 블록 SSIM(가우시안 창 대신 균등 블록 창). L = 255, C1 = (0.01L)², C2 = (0.03L)².
// buildingMean = 두 영상 중 하나라도 건물 픽셀이 있는 블록만의 평균(건물 영역, 단언 대상).
// mean = 전체 블록 평균(진단용). 먼 시점은 하늘·지면 블록(SSIM 1)이 대부분이라 전체 평균은 건물 LOD 결함을 가린다.
function blockSsim(A, B) {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let sum = 0, n = 0, bsum = 0, bn = 0;
  for (let by = 0; by + 8 <= H; by += 8) {
    for (let bx = 0; bx + 8 <= W; bx += 8) {
      let ma = 0, mb = 0, hasB = false;
      for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) {
        const k = y * W + x; ma += A.img[k]; mb += B.img[k];
        if (A.mask[k] || B.mask[k]) hasB = true;
      }
      ma /= 64; mb /= 64;
      let va = 0, vb = 0, cov = 0;
      for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) {
        const k = y * W + x; const da = A.img[k] - ma, db = B.img[k] - mb;
        va += da * da; vb += db * db; cov += da * db;
      }
      va /= 63; vb /= 63; cov /= 63;
      const s = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      sum += s; n++;
      if (hasB) { bsum += s; bn++; }
    }
  }
  return { mean: sum / n, buildingMean: bn ? bsum / bn : NaN, buildingBlocks: bn };
}

// ───────── 테스트 ─────────

const allIds = (groups) => groups.flatMap((g) => g.ids);

test('합성 도시: 200동 이상, 외곽형 3종', () => {
  assert.ok(CITY.length >= 200);
  assert.equal(new Set(CITY.map((b) => b.id)).size, CITY.length);
});

test('가까운 곳(거리 < 기준): 원본 메시 그대로, 한 동 한 그룹', () => {
  const out = buildBuildingLod(CITY, BUILDING_LOD_FAR_DIST_M - 1);
  assert.equal(out.length, CITY.length);
  out.forEach((g, i) => { assert.deepEqual(g.ids, [CITY[i].id]); assert.equal(g.mesh, CITY[i].mesh); });
});

test('먼 곳: 동 보존(모든 id 가 정확히 한 그룹), 면 수 감소, 상자는 원본 AABB 를 덮는다', () => {
  for (const dist of [BUILDING_LOD_FAR_DIST_M, 1500, 3000, 10000]) {
    const out = buildBuildingLod(CITY, dist);
    const ids = allIds(out);
    assert.equal(ids.length, CITY.length);
    assert.deepEqual([...ids].sort((a, b) => a - b), CITY.map((b) => b.id).sort((a, b) => a - b));
    const before = triCount(CITY.map((b) => b.mesh)), after = triCount(out.map((g) => g.mesh));
    assert.ok(after <= before, `${dist} m: ${after} > ${before}`);
    const byId = new Map(CITY.map((b) => [b.id, meshBounds(b.mesh)]));
    for (const g of out) {
      const gb = meshBounds(g.mesh);
      for (const id of g.ids) {
        const b = byId.get(id);
        assert.ok(gb.minX <= b.minX && gb.minY <= b.minY && gb.maxX >= b.maxX && gb.maxY >= b.maxY && gb.maxZ >= b.maxZ);
      }
    }
  }
  // 충분히 멀면 실제로 합쳐진다(다동 그룹 존재, 면 수 감소).
  // 40 m 필지라 이웃 틈이 12 m 이상이어서 군집 병합은 거의 없고, 감소는 주로 L 자(16 → 10 삼각형)에서 온다.
  // 다각 원통은 벽 방향이 여럿이라 상자 후보에서 빠진다(음영 보존). 실제 병합은 20 m 필지 밀집 장면(DENSE)에서 본다.
  const far = buildBuildingLod(CITY, 10000);
  assert.ok(far.some((g) => g.ids.length > 1));
  assert.ok(triCount(far.map((g) => g.mesh)) < triCount(CITY.map((b) => b.mesh)));
});

test('허용 오차를 넘는 건물·벽 방향이 여럿인 건물은 먼 곳이어도 원본 유지', () => {
  // 반지름 15 m 원통: AABB 모서리 오차 ≈ 15(√2 − 1) ≈ 6.2 m. 500 m 에서 tol ≈ 0.97 m → 원본 유지.
  const ring = [];
  for (let i = 0; i < 24; i++) ring.push([15 * Math.cos((2 * Math.PI * i) / 24), 15 * Math.sin((2 * Math.PI * i) / 24)]);
  const b = { id: 7, mesh: prism(ring, 10) };
  const near = buildBuildingLod([b], BUILDING_LOD_FAR_DIST_M);
  assert.equal(near[0].mesh, b.mesh);
  const tolNeeded = 15 * (Math.SQRT2 - 1);
  // 다각 원통은 벽 방향이 7.5° 이상씩 흩어져 있어 기하 오차가 허용 안이어도(tol = 3 × 필요량) 상자로 바꾸지 않는다(음영 보존).
  for (const k of [1.01, 3, 10]) {
    const far = buildBuildingLod([b], (tolNeeded * k) / BUILDING_LOD_MAX_ANGLE_RAD);
    assert.equal(far[0].mesh, b.mesh, `tol = ${k} × 필요량에서 원통이 상자로 바뀜`);
  }
  // 두 축 방향이 섞인 평면(0° 날개와 30° 날개가 붙은 건물)도 원본 유지.
  const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
  const wing = [[0, 0], [20, 0], [20 + 10 * c30, 10 * s30], [20 + 10 * c30 - 10 * s30, 10 * s30 + 10 * c30], [20, 10], [0, 10]];
  const w = { id: 9, mesh: prism(wing, 4) };
  assert.equal(buildBuildingLod([w], 50000)[0].mesh, w.mesh);
  // 축 정렬 L 자: 홈 대각선 오차 미만 거리에서는 원본, 표본 상한 여유(≤ tol/(2√2))를 더해도 넘는 거리에서는 상자.
  const L = { id: 8, mesh: prism([[0, 0], [30, 0], [30, 10], [20, 10], [20, 20], [0, 20]], 4) };
  const need = 10; // 홈 모서리 (30,20) 에서 가장 가까운 L 점은 (30,10)·(20,20), 거리 10 m
  assert.equal(buildBuildingLod([L], (need * 0.99) / BUILDING_LOD_MAX_ANGLE_RAD)[0].mesh, L.mesh);
  assert.equal(buildBuildingLod([L], (need * 1.6) / BUILDING_LOD_MAX_ANGLE_RAD)[0].mesh.indices.length / 3, 10);
});

test('결정적: 같은 입력 → 같은 바이트', () => {
  const a = buildBuildingLod(CITY, 2000), b = buildBuildingLod(syntheticCity(), 2000);
  assert.equal(a.length, b.length);
  a.forEach((g, i) => {
    assert.deepEqual(g.ids, b[i].ids);
    assert.deepEqual(Buffer.from(g.mesh.positions.buffer), Buffer.from(b[i].mesh.positions.buffer));
    assert.deepEqual(Buffer.from(g.mesh.indices.buffer), Buffer.from(b[i].mesh.indices.buffer));
  });
});

test('잘못된 입력은 TowerAssetError', () => {
  assert.throws(() => buildBuildingLod(null, 1000), TowerAssetError);
  assert.throws(() => buildBuildingLod(CITY, NaN), TowerAssetError);
  assert.throws(() => buildBuildingLod(CITY, -1), TowerAssetError);
  assert.throws(() => buildBuildingLod([CITY[0], CITY[0]], 1000), TowerAssetError);
  assert.throws(() => buildBuildingLod([{ id: 1, mesh: { positions: [0, 0, 0], indices: [0, 0, 0] } }], 1000), TowerAssetError);
  assert.throws(() => buildBuildingLod([{ id: 1, mesh: { positions: new Float32Array(3), indices: Uint32Array.of(0, 1, 0) } }], 1000), TowerAssetError);
});

// 8시점마다 원본과 LOD 를 렌더해 건물 영역 SSIM 과 면 수 감소율을 잰다.
function viewRows(city, t) {
  const origMeshes = city.map((b) => b.mesh);
  const origTris = triCount(origMeshes);
  const rows = [];
  for (const view of VIEWS) {
    const groups = lodForView(city, view.eye);
    const ids = allIds(groups);
    assert.equal(ids.length, city.length, `${view.name}: 동 수`);
    assert.equal(new Set(ids).size, city.length, `${view.name}: id 중복`);
    const lodTris = triCount(groups.map((g) => g.mesh));
    const A = render(origMeshes, view);
    const s = blockSsim(A, render(groups.map((g) => g.mesh), view));
    const coverage = A.mask.reduce((n, v) => n + v, 0) / (W * H);
    const reduction = 1 - lodTris / origTris;
    rows.push({ view: view.name, ssim: s.mean, ssimBuildingBlocks: s.buildingMean, buildingBlocks: s.buildingBlocks, origTris, lodTris, reduction });
    t.diagnostic(`${view.name}: SSIM ${s.mean.toFixed(4)} (건물 블록 ${s.buildingBlocks}개만 ${s.buildingMean.toFixed(4)}), 삼각형 ${origTris} → ${lodTris}, 감소율 ${(reduction * 100).toFixed(1)}%, 건물 화소 비율 ${(coverage * 100).toFixed(1)}%`);
  }
  for (const r of rows) {
    assert.ok(r.buildingBlocks > 0, `${r.view}: 건물 블록이 없다(건물 영역 SSIM 이 아무것도 재지 않는다)`);
    assert.ok(r.ssimBuildingBlocks >= BUILDING_LOD_MIN_SSIM, `${r.view}: 건물 영역 SSIM ${r.ssimBuildingBlocks} < ${BUILDING_LOD_MIN_SSIM}`);
  }
  return rows;
}

test(`8시점 렌더 건물 영역 SSIM ≥ ${BUILDING_LOD_MIN_SSIM} (원본 vs LOD), 면 수 감소율 기록 — 40 m 필지 혼합 도시`, (t) => {
  viewRows(CITY, t);
});

test(`8시점 실제 병합 장면(20 m 필지 밀집, 회전 0~3° 섞음): 시점마다 감소율 > 0 이고 건물 영역 SSIM ≥ ${BUILDING_LOD_MIN_SSIM}`, (t) => {
  for (const r of viewRows(DENSE, t)) {
    assert.ok(r.lodTris < r.origTris, `${r.view}: 면 수 감소 없음 (${r.origTris} → ${r.lodTris})`);
    assert.ok(r.reduction > 0);
  }
});

// ───────── 군집 오차 직접 검사 ─────────

// 축 정렬 직사각형 프리즘.
const rectPrism = (x0, y0, x1, y1, floors) => prism([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], floors);

// 점에서 원본 건물들의 xy 투영까지 거리(촘촘한 격자로 상자 위 최댓값을 잰다, 시험용 독립 구현: 축 정렬 직사각형 합집합 가정 없이 삼각형 거리).
function segD(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}
function distToMeshes(px, py, meshes) {
  let best = Infinity;
  for (const m of meshes) {
    const p = m.positions, idx = m.indices;
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
      const ax = p[a], ay = p[a + 1], bx = p[b], by = p[b + 1], cx = p[c], cy = p[c + 1];
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(area) > 1e-9) {
        const s = Math.sign(area);
        if (((bx - ax) * (py - ay) - (px - ax) * (by - ay)) * s >= 0 && ((cx - bx) * (py - by) - (px - bx) * (cy - by)) * s >= 0
          && ((ax - cx) * (py - cy) - (px - cx) * (ay - cy)) * s >= 0) return 0;
      }
      best = Math.min(best, segD(px, py, ax, ay, bx, by), segD(px, py, bx, by, cx, cy), segD(px, py, cx, cy, ax, ay));
    }
  }
  return best;
}

// LOD 그룹 메시의 상자 하나(정점 8개 o..o+23)를 방향 상자로 읽는다: 바닥 꼭짓점 0 이 원점, 0→1 이 u 축, 0→3 이 v 축.
function readBox(p, o) {
  const x0 = p[o], y0 = p[o + 1];
  const lu = Math.hypot(p[o + 3] - x0, p[o + 4] - y0), lv = Math.hypot(p[o + 9] - x0, p[o + 10] - y0);
  const u = [(p[o + 3] - x0) / lu, (p[o + 4] - y0) / lu], v = [(p[o + 9] - x0) / lv, (p[o + 10] - y0) / lv];
  return { x0, y0, u, v, lu, lv, minZ: p[o + 2], maxZ: p[o + 14] };
}

// LOD 그룹 메시를 상자(정점 8개, 삼각형 10개)로 나눠, 각 상자 위 촘촘한 격자(0.5 m 이하 간격, 상자 자체 방향)에서
// 상자 안에 든 원본 건물까지 최대 거리 + 높이 차를 잰다.
function boxErrors(group, byId) {
  const p = group.mesh.positions;
  if (group.ids.length === 1 && group.mesh === byId.get(group.ids[0])) return []; // 원본 유지 그룹
  const errs = [];
  for (let o = 0; o < p.length; o += 24) {
    const box = readBox(p, o);
    const inside = group.ids.map((id) => byId.get(id)).filter((b) => {
      for (let i = 0; i < b.positions.length; i += 3) {
        const dx = b.positions[i] - box.x0, dy = b.positions[i + 1] - box.y0;
        const s = dx * box.u[0] + dy * box.u[1], t = dx * box.v[0] + dy * box.v[1];
        if (s < -1e-3 || s > box.lu + 1e-3 || t < -1e-3 || t > box.lv + 1e-3) return false;
      }
      return true;
    });
    assert.ok(inside.length > 0, '상자 안에 원본 건물이 없다');
    let err = 0;
    for (const b of inside) err = Math.max(err, box.maxZ - meshBounds(b).maxZ);
    const nu = Math.max(2, Math.ceil(box.lu) * 2 + 1), nv = Math.max(2, Math.ceil(box.lv) * 2 + 1);
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const s = (box.lu * i) / (nu - 1), t = (box.lv * j) / (nv - 1);
      err = Math.max(err, distToMeshes(box.x0 + s * box.u[0] + t * box.v[0], box.y0 + s * box.u[1] + t * box.v[1], inside));
    }
    errs.push(err);
  }
  return errs;
}

test('군집 상자마다 오차 ≤ tol (독립 촘촘 표본으로 직접 확인)', () => {
  const byId = new Map(CITY.map((b) => [b.id, b.mesh]));
  // 축 정렬 건물만 있는 밀집 도시(틈이 좁아 합쳐지기 쉽다)도 함께 본다.
  const rnd = mulberry32(7);
  const dense = [];
  for (let i = 0; i < 24; i++) {
    const x0 = (i % 6) * 20 + rnd() * 4, y0 = Math.floor(i / 6) * 20 + rnd() * 4;
    dense.push({ id: 5000 + i, mesh: rectPrism(x0, y0, x0 + 10 + rnd() * 6, y0 + 10 + rnd() * 6, 3 + Math.floor(rnd() * 2)) });
  }
  for (const b of dense) byId.set(b.id, b.mesh);
  // 실제로 합쳐지는 회전 밀집 장면(맞벽 줄, 0~3° 회전)의 한 사분면.
  const denseQ = DENSE.filter((b) => { const bb = meshBounds(b.mesh); return bb.maxX < 0 && bb.maxY < 0; });
  for (const b of denseQ) byId.set(b.id, b.mesh);
  let merged = 0;
  for (const dist of [BUILDING_LOD_FAR_DIST_M, 1500, 2200, 3000, 6000]) {
    const tol = dist * BUILDING_LOD_MAX_ANGLE_RAD;
    for (const set of [CITY, dense, denseQ]) {
      for (const g of buildBuildingLod(set, dist)) {
        const errs = boxErrors(g, byId);
        if (errs.length && errs.length < g.ids.length) merged++;
        for (const e of errs) assert.ok(e <= tol + 1e-3, `${dist} m: 상자 오차 ${e} > tol ${tol}`);
      }
    }
  }
  assert.ok(merged > 0, '여러 동이 한 상자로 합쳐진 그룹이 없다(검사가 병합을 재지 않는다)');
});

test('틈 사례: 틈이 1/4 px 를 넘는 두 건물은 합치지 않는다(틈을 메우면 지면 선이 통째로 사라진다)', () => {
  // x∈[0,32]·[44,72]: 틈 12 m(틈 중점 기하 오차 6 m, tol 이 되는 거리 ≈ 3094 m). 12 m 가 1/4 px 가 되는 거리 ≈ 49.5 km
  // 미만에서는 기하 오차가 tol 안이어도 합치지 않는다.
  const a = { id: 1, mesh: rectPrism(0, 0, 32, 20, 5) }, b = { id: 2, mesh: rectPrism(44, 0, 72, 20, 5) };
  const boxes = (d) => buildBuildingLod([a, b], d)[0].mesh.indices.length / 3 / 10;
  for (const d of [2200, 3089, 10000, 40000, 49000]) assert.equal(boxes(d), 2, `${d} m 에서 합쳐짐`);
  const gapPxDist = 12 / (BUILDING_LOD_REF_PIXEL_RAD * BUILDING_LOD_MAX_GAP_PX);
  assert.equal(boxes(gapPxDist * 1.01), 1);
});

test('엇갈린 맞붙은 두 상자: 합친 상자의 바깥 모서리 오차(8 m)가 tol 을 넘으면 합치지 않는다', () => {
  // A [0,20]×[0,20], B [20.2,40]×[8,28]: 합친 상자 모서리 (0,28)·(40,0) 은 원본에서 8 m. 틈 0.2 m 는 1/4 px 이하.
  const a = { id: 1, mesh: rectPrism(0, 0, 20, 20, 5) }, b = { id: 2, mesh: rectPrism(20.2, 8, 40, 28, 5) };
  const boxes = (d) => buildBuildingLod([a, b], d)[0].mesh.indices.length / 3 / 10;
  const need = 8 / BUILDING_LOD_MAX_ANGLE_RAD; // ≈ 8251 m
  for (const d of [3000, need * 0.99]) assert.equal(boxes(d), 2, `${d} m 에서 합쳐짐`);
  assert.equal(boxes(need * 1.6), 1);
});

// (cx, cy) 둘레로 deg 돌린 프리즘. 기본 중심 (32, 32) 은 64 m 칸 [0,64]² 의 가운데라 돌려도 같은 칸에 남는다.
const rotatePrism = (ring, deg, floors, cx = 32, cy = 32) => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return prism(ring.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]), floors);
};
// 20 × 20 m 상자 두 개, 틈 1 m, 칸 가운데에 나란히.
const SQ_A = [[11.5, 22], [31.5, 22], [31.5, 42], [11.5, 42]], SQ_B = [[32.5, 22], [52.5, 22], [52.5, 42], [32.5, 42]];

test('회전 쌍: 20 m 상자 두 개(틈 1 m)를 함께 0.01°~60° 돌려도 5 km 에서 상자 하나로 합쳐진다', () => {
  for (const deg of [0, 0.01, 0.2, 0.5, 1, 2, 3, 17, 30, 45, 60]) {
    const out = buildBuildingLod([{ id: 1, mesh: rotatePrism(SQ_A, deg, 5) }, { id: 2, mesh: rotatePrism(SQ_B, deg, 5) }], 5000);
    assert.equal(out.length, 1);
    assert.equal(triCount(out.map((g) => g.mesh)), 10, `${deg}°: 합쳐지지 않음`);
  }
});

test('회전이 다른 쌍: 차이가 작으면(0.01°~1°) 5 km 에서 합쳐지고, 0° 와 30° 는 아무리 멀어도 합치지 않는다', () => {
  for (const deg of [0.01, 0.2, 0.5, 1]) {
    const out = buildBuildingLod([{ id: 1, mesh: rotatePrism(SQ_A, 0, 5) }, { id: 2, mesh: rotatePrism(SQ_B, deg, 5, 32.5, 22) }], 5000);
    assert.equal(triCount(out.map((g) => g.mesh)), 10, `0° + ${deg}°: 합쳐지지 않음`);
  }
  // 30° 돌린 상자는 벽 법선이 30° 달라 한 상자로 합치면 음영이 바뀐다. 기하 오차가 허용 안인 아주 먼 곳에서도 상자 두 개.
  for (const dist of [5000, 50000, 200000]) {
    const out = buildBuildingLod([{ id: 1, mesh: rotatePrism(SQ_A, 0, 5) }, { id: 2, mesh: rotatePrism(SQ_B, 30, 5, 32.5, 22) }], dist);
    assert.equal(triCount(out.map((g) => g.mesh)), 20, `${dist} m: 0° 와 30° 상자가 합쳐짐`);
    // 각 상자의 벽 방향은 자기 원본과 같다(축 정렬 상자 하나는 0°, 다른 하나는 30°).
    const p = out[0].mesh.positions;
    const dirs = [0, 24].map((o) => (Math.atan2(p[o + 4] - p[o + 1], p[o + 3] - p[o]) * 180) / Math.PI).map((d) => ((d % 90) + 90) % 90);
    assert.ok(dirs.some((d) => Math.min(d, 90 - d) < 1e-3) && dirs.some((d) => Math.abs(d - 30) < 1e-3), `방향 ${dirs}`);
  }
});

test('상자 면 감김: 모든 상자 삼각형의 법선이 상자 바깥을 향한다(회전 상자 포함)', () => {
  const sets = [
    [{ id: 1, mesh: rectPrism(0, 0, 20, 10, 4) }],
    [{ id: 1, mesh: rotatePrism(SQ_A, 0, 5) }, { id: 2, mesh: rotatePrism(SQ_B, 0, 5) }],
    [{ id: 1, mesh: rotatePrism(SQ_A, 23, 5) }],
    [{ id: 1, mesh: rotatePrism(SQ_A, 0, 5) }, { id: 2, mesh: rotatePrism(SQ_B, 30, 5, 32.5, 22) }],
  ];
  let checked = 0;
  for (const set of sets) {
    for (const g of buildBuildingLod(set, 5000)) {
      const p = g.mesh.positions, idx = g.mesh.indices;
      assert.equal(idx.length % 30, 0);
      for (let t = 0; t < idx.length; t += 3) {
        const box = Math.floor(idx[t] / 8) * 8; // 이 삼각형이 속한 상자의 첫 정점
        let cx = 0, cy = 0, cz = 0;
        for (let k = 0; k < 8; k++) { cx += p[(box + k) * 3] / 8; cy += p[(box + k) * 3 + 1] / 8; cz += p[(box + k) * 3 + 2] / 8; }
        const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
        const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const m = [(p[a] + p[b] + p[c]) / 3 - cx, (p[a + 1] + p[b + 1] + p[c + 1]) / 3 - cy, (p[a + 2] + p[b + 2] + p[c + 2]) / 3 - cz];
        assert.ok(n[0] * m[0] + n[1] * m[1] + n[2] * m[2] > 0, `삼각형 ${t / 3} 법선이 안쪽을 향한다`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 40, `상자 삼각형 ${checked}개만 검사함`);
});

test('격자 칸: 다른 64 m 칸의 후보는 붙어 있어도 다른 그룹(합치지 않는다)', () => {
  // A 중심 x = 52 (칸 0), B 중심 x = 76.1 (칸 1). 맞붙어 있어(틈 0.1 m) 같은 칸이면 5 km 에서 합쳐진다.
  const a = { id: 1, mesh: rectPrism(40, 0, 64, 20, 5) }, b = { id: 2, mesh: rectPrism(64.1, 0, 88.1, 20, 5) };
  const out = buildBuildingLod([a, b], 5000);
  assert.deepEqual(out.map((g) => g.ids), [[1], [2]]);
  assert.equal(triCount(out.map((g) => g.mesh)), 20);
  // 같은 칸 안으로 옮기면 합쳐진다(위 결과가 칸 경계 때문임을 확인).
  const a2 = { id: 1, mesh: rectPrism(0, 0, 24, 20, 5) }, b2 = { id: 2, mesh: rectPrism(24.1, 0, 48.1, 20, 5) };
  const out2 = buildBuildingLod([a2, b2], 5000);
  assert.deepEqual(out2.map((g) => g.ids), [[1, 2]]);
  assert.equal(triCount(out2.map((g) => g.mesh)), 10);
});

// 한 64 m 칸에 k 동(4.4 m 피치 격자, 틈 0~0.3 m, 회전 0~2°, 층수 1~2 섞음).
function denseCell(k, seed) {
  const rnd = mulberry32(seed);
  const out = [];
  const n = Math.ceil(Math.sqrt(k));
  const pitch = 60 / n;
  for (let i = 0; i < k; i++) {
    const x0 = 2 + (i % n) * pitch, y0 = 2 + Math.floor(i / n) * pitch;
    const g = rnd() * 0.3, deg = rnd() * 2;
    const ring = [[x0, y0], [x0 + pitch - g, y0], [x0 + pitch - g, y0 + pitch - g], [x0, y0 + pitch - g]];
    out.push({ id: 90000 + i, mesh: rotatePrism(ring, deg, 1 + Math.floor(rnd() * 2), x0, y0) });
  }
  return out;
}

test('밀집 칸 성능: 한 칸 k = 200 동 병합이 1 s 안(목표 100 ms), 결과 결정적', (t) => {
  for (const [dist, seed] of [[1000, 1], [5000, 2], [20000, 3]]) {
    const cell = denseCell(200, seed);
    buildBuildingLod(cell, dist); // 준비 실행(JIT)
    const t0 = performance.now();
    const a = buildBuildingLod(cell, dist);
    const ms = performance.now() - t0;
    const b = buildBuildingLod(denseCell(200, seed), dist);
    assert.equal(a.length, 1, '한 칸이면 상자 후보 전체가 한 그룹');
    assert.equal(a[0].ids.length, 200);
    assert.deepEqual(Buffer.from(a[0].mesh.positions.buffer), Buffer.from(b[0].mesh.positions.buffer));
    assert.deepEqual(Buffer.from(a[0].mesh.indices.buffer), Buffer.from(b[0].mesh.indices.buffer));
    const boxes = a[0].mesh.indices.length / 30;
    t.diagnostic(`k=200, ${dist} m: ${ms.toFixed(1)} ms, 상자 ${boxes}개`);
    assert.ok(ms < 1000, `${dist} m: ${ms} ms`);
    assert.ok(boxes < 200, `${dist} m: 합쳐지지 않음`);
  }
});

test('먼 곳 기준 경계: 축 정렬 직사각형(오차 0)은 499 m 원본, 500 m 상자', () => {
  const b = { id: 3, mesh: rectPrism(0, 0, 20, 10, 4) };
  // 원본과 구분되도록 꼭짓점을 하나 더 넣는다(같은 직사각형, 오차 0, 원본 삼각형 수 ≠ 10).
  const b2 = { id: 4, mesh: prism([[0, 0], [10, 0], [20, 0], [20, 10], [0, 10]], 4) };
  for (const x of [b, b2]) {
    const near = buildBuildingLod([x], BUILDING_LOD_FAR_DIST_M - 1);
    assert.equal(near[0].mesh, x.mesh);
    const far = buildBuildingLod([x], BUILDING_LOD_FAR_DIST_M);
    assert.notEqual(far[0].mesh, x.mesh);
    assert.equal(far[0].mesh.indices.length / 3, 10);
  }
  assert.equal(BUILDING_LOD_FAR_DIST_M, 500);
});
