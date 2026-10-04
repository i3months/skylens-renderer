// 건물 LOD 검증용 합성 장면·렌더·SSIM 공용 모듈(lod.test.mjs 와 tools/lod_seed_sweep.mjs 가 함께 쓴다).
// 외부 의존성 없음, 결정적(고정 시드 PRNG, 고정 시점 리터럴).
import { buildingHeightM, signedArea } from '../../../contracts/tower_assets/index.mjs';
import { buildBuildingLod } from './index.mjs';

export function mulberry32(seed) {
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
export function earClip(ring) {
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
export function prism(ring0, floors) {
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

export const PARCEL_M = 20;
export const DENSE_GRID = 32; // 32 × 32 = 1024 동, ±320 m
export const DENSE_BLOCK = 4; // 4 × 4 필지 = 한 가구(80 m)

// 실제로 합쳐지는 밀집 도시: 20 m 필지마다 한 동(틈 0.4~1.6 m), 가구(4 × 4 필지)마다 회전 0~3°(지적 외곽의 작은 기울기),
// 가구 안 한 줄(필지 4개)은 같은 층수(줄지은 연립). 가구 8개 중 1개 꼴로는 동마다 15~75° 로 크게 돌아간 건물을 섞고,
// 일부 필지에는 다각 원통을 둔다(방향 보호가 없으면 상자로 합쳐져 음영이 달라지는 대상).
export function denseCity(seed = 307) {
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

export function meshBounds(m) {
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
export const VIEWS = [
  { name: 'N-far', eye: [0, 2400, 150], at: [0, 0, 20] },
  { name: 'E-far', eye: [2600, 300, 200], at: [0, 0, 20] },
  { name: 'S-far-high', eye: [-400, -3000, 600], at: [0, 0, 0] },
  { name: 'W-far-low', eye: [-1800, -200, 60], at: [0, 0, 30] },
  { name: 'NE-mid', eye: [900, 900, 250], at: [0, 0, 0] },
  { name: 'SW-mid', eye: [-700, -800, 120], at: [0, 0, 30] },
  { name: 'S-near', eye: [0, -450, 80], at: [0, 0, 20] },
  { name: 'top-high', eye: [100, -300, 1800], at: [0, 0, 0] },
];

// 시험 타일 크기. 일부러 구현 상수 BUILDING_LOD_CELL_M 을 import 하지 않고 리터럴로 둔다(F-333): 구현의 칸 키를 상수화·변경하는
// 변이가 시험 장면의 타일 분할까지 따라 바뀌어 가려지는 일이 없게 한다. 구현 칸 크기와 같은지는 lod.test.mjs 의 단위 시험이 따로 본다.
export const TILE_M = 64;

// 먼 시점 5개의 시드 합계 면 수 감소율 하한(F-332). 시드·시점마다가 아니라 합계에 거는 이유: 이 장면은 시드에 따라 감소가 작은 시점이
// 있다. 하한 근거 = 시드 1..300 스윕(2026-10-04, 원 코드, `node tools/lod_seed_sweep.mjs 1-300`)에서 시드 한 개짜리 시점별 최저 감소율의
// 절반(어떤 시드 부분집합의 합계도 시드별 최저 이상이므로 정상 코드는 항상 통과한다):
//   N-far 7.6%→3.8%, E-far 9.1%→4.5%, S-far-high 11.6%→5.8%, W-far-low 3.9%→1.9%, top-high 3.6%→1.8%.
// 측정 시드별 최저 감소율(N-far·E-far·S-far-high·W-far-low·top-high 순): 하한 근거 커밋 0266bba 시점 7.6·9.1·11.6·3.9·3.6 %,
// 현재 코드 8.8·9.7·11.9·5.5·5.6 % (모두 하한의 2배 이상이라 여유가 있다).
// 이 값은 측정 당시 정한 것이며 이후 측정에 맞춰 낮추지 않는다(낮추려면 LOD 알고리즘 회귀를 먼저 의심한다).
// 칸 90% LOD 끔 변이는 합계가 N-far 0.9%·S-far-high 1.5% 로 떨어져 이 하한에서 실패한다. S-near·NE-mid·SW-mid 는 하한 없이 시드 합계 감소 > 0 만 단언한다(고정 시드 조합 합계: NE-mid 5.0%, SW-mid 4.0%, S-near 0.5%).
export const FAR_VIEW_MIN_REDUCTION = {
  'N-far': 0.038, 'E-far': 0.045, 'S-far-high': 0.058, 'W-far-low': 0.019, 'top-high': 0.018,
};

// 건물을 64 m 타일로 나누고, 타일마다 카메라에서 타일 상자(xy 타일 범위 × z [0, 최고 높이])까지 거리로 LOD 를 만든다.
export function lodForView(city, eye) {
  const tiles = new Map();
  for (const b of city) {
    const bb = meshBounds(b.mesh);
    const key = `${Math.floor((bb.minX + bb.maxX) / 2 / TILE_M)},${Math.floor((bb.minY + bb.maxY) / 2 / TILE_M)}`;
    let t = tiles.get(key);
    if (!t) { const [tx, ty] = key.split(',').map(Number); t = { tx, ty, list: [], maxZ: 0 }; tiles.set(key, t); }
    t.list.push(b);
    t.maxZ = Math.max(t.maxZ, bb.maxZ);
  }
  const groups = [];
  for (const t of tiles.values()) {
    const s = TILE_M;
    const dx = Math.max(t.tx * s - eye[0], 0, eye[0] - (t.tx + 1) * s);
    const dy = Math.max(t.ty * s - eye[1], 0, eye[1] - (t.ty + 1) * s);
    const dz = Math.max(0 - eye[2], 0, eye[2] - t.maxZ);
    groups.push(...buildBuildingLod(t.list, Math.hypot(dx, dy, dz)));
  }
  return groups;
}

export const triCount = (meshes) => meshes.reduce((n, m) => n + m.indices.length / 3, 0);

// ───────── 소프트웨어 투시 래스터 ─────────
// 깊이 버퍼(1/z_cam 를 화면 공간에서 선형 보간 → 원근 정확), 근평면 클리핑, 면 법선 단순 램버트 음영(양면, 카메라 쪽으로 뒤집음).
// 화면: 720 × 540, 세로 시야 30° → 한 픽셀 각 ≈ 9.7e-4 rad 로 LOD 기준 화면(60°/1080 px)과 같은 각 해상도.
export const W = 720, H = 540, FOVY = Math.PI / 6, NEAR = 1;
const SKY = 235, GROUND = 120;
const LIGHT = (() => { const l = [0.35, 0.55, 0.76]; const n = Math.hypot(...l); return l.map((v) => v / n); })();

export function render(meshes, view) {
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
export function blockSsim(A, B) {
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
