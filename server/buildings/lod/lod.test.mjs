// T14.4 건물 LOD 검증. 외부 의존성 없음, 결정적(고정 시드 PRNG, 고정 시점 리터럴).
// extrude(T14.3)는 아직 없으므로 이 파일 안에 자체 프리즘 생성 헬퍼를 둔다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILDING_LOD_MIN_SSIM, TowerAssetError, buildingHeightM, signedArea } from '../../../contracts/tower_assets/index.mjs';
import {
  buildBuildingLod, BUILDING_LOD_FAR_DIST_M, BUILDING_LOD_MAX_ANGLE_RAD, BUILDING_LOD_CELL_M,
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
// mean = 전체 블록 평균(단언 대상), buildingMean = 두 영상 중 하나라도 건물 픽셀이 있는 블록만의 평균(기록용, 더 엄격).
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
  return { mean: sum / n, buildingMean: bn ? bsum / bn : 1 };
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
  // 충분히 멀면 실제로 합쳐진다(다동 그룹 존재, 면 수 절반 이하).
  const far = buildBuildingLod(CITY, 10000);
  assert.ok(far.some((g) => g.ids.length > 1));
  assert.ok(triCount(far.map((g) => g.mesh)) <= triCount(CITY.map((b) => b.mesh)) / 2);
});

test('허용 오차를 넘는 건물은 먼 곳이어도 원본 유지', () => {
  // 반지름 15 m 원통: AABB 모서리 오차 ≈ 15(√2 − 1) ≈ 6.2 m. 500 m 에서 tol ≈ 0.97 m → 원본 유지.
  const ring = [];
  for (let i = 0; i < 24; i++) ring.push([15 * Math.cos((2 * Math.PI * i) / 24), 15 * Math.sin((2 * Math.PI * i) / 24)]);
  const b = { id: 7, mesh: prism(ring, 10) };
  const near = buildBuildingLod([b], BUILDING_LOD_FAR_DIST_M);
  assert.equal(near[0].mesh, b.mesh);
  const tolNeeded = 15 * (Math.SQRT2 - 1);
  const far = buildBuildingLod([b], (tolNeeded * 1.01) / BUILDING_LOD_MAX_ANGLE_RAD);
  assert.equal(far[0].mesh.indices.length / 3, 10);
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

test(`8시점 렌더 SSIM ≥ ${BUILDING_LOD_MIN_SSIM} (원본 vs LOD), 면 수 감소율 기록`, (t) => {
  const origMeshes = CITY.map((b) => b.mesh);
  const origTris = triCount(origMeshes);
  const rows = [];
  for (const view of VIEWS) {
    const groups = lodForView(CITY, view.eye);
    const ids = allIds(groups);
    assert.equal(ids.length, CITY.length, `${view.name}: 동 수`);
    assert.equal(new Set(ids).size, CITY.length, `${view.name}: id 중복`);
    const lodTris = triCount(groups.map((g) => g.mesh));
    const A = render(origMeshes, view);
    const s = blockSsim(A, render(groups.map((g) => g.mesh), view));
    const coverage = A.mask.reduce((n, v) => n + v, 0) / (W * H);
    const reduction = 1 - lodTris / origTris;
    rows.push({ view: view.name, ssim: s.mean, ssimBuildingBlocks: s.buildingMean, origTris, lodTris, reduction });
    t.diagnostic(`${view.name}: SSIM ${s.mean.toFixed(4)} (건물 블록만 ${s.buildingMean.toFixed(4)}), 삼각형 ${origTris} → ${lodTris}, 감소율 ${(reduction * 100).toFixed(1)}%, 건물 화소 비율 ${(coverage * 100).toFixed(1)}%`);
  }
  for (const r of rows) assert.ok(r.ssim >= BUILDING_LOD_MIN_SSIM, `${r.view}: SSIM ${r.ssim} < ${BUILDING_LOD_MIN_SSIM}`);
});
