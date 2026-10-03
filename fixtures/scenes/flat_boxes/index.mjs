// 장면 flat_boxes: 평지(200x200 m) 위에 상자 건물 12동. 새로 작성한 코드(차용 없음).
// 좌표: ENU, x=동, y=위, z=−북, 1 unit = 1 m.
import { mulberry32, subSeed, makeResult, FORMAT_POINT27 } from '../../../contracts/scenes/index.mjs';

const HALF = 100; // 바닥 반폭(m)
const N_BUILDINGS = 12;
const DEFAULT_COUNT = 200000;
const GAP = 2; // 건물 사이 최소 간격(m)
const LIMIT = 92; // 건물이 놓일 수 있는 최대 |x|,|z|

// 고정 시점(fixtures/viewpoints/synthetic.json)이 바라보는 곳 근처에 두는 앵커 건물 중심.
// 시점 1,2,3,4,7 -> 원점, 5 -> (20,20), 6 -> (0,-20), 8 -> (40,-40) 부근.
const ANCHORS = [[0, 0], [22, 22], [0, -26], [40, -40]];
// 시점 눈 위치: 건물 안에 들어가지 않도록 피한다.
const EYES = [[0, 90], [30, 45], [-60, 70], [-95, 95]]; // 높이가 건물보다 낮은 눈(시점 4,5,7,8)

function hsv(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(v)));

function placeBuildings(rng) {
  const out = [];
  const ok = (b) => {
    if (b.min[0] < -LIMIT || b.max[0] > LIMIT || b.min[2] < -LIMIT || b.max[2] > LIMIT) return false;
    for (const o of out) {
      if (b.min[0] < o.max[0] + GAP && b.max[0] > o.min[0] - GAP && b.min[2] < o.max[2] + GAP && b.max[2] > o.min[2] - GAP) return false;
    }
    for (const [ex, ez] of EYES) {
      if (ex > b.min[0] - 1 && ex < b.max[0] + 1 && ez > b.min[2] - 1 && ez < b.max[2] + 1) return false;
    }
    return true;
  };
  for (let i = 0; i < N_BUILDINGS; i++) {
    const anchor = i < ANCHORS.length;
    for (let tries = 0; ; tries++) {
      if (tries > 10000) throw new Error('flat_boxes: 건물 배치 실패');
      const sw = anchor ? 8 + rng() * 6 : 8 + rng() * 17;
      const sd = anchor ? 8 + rng() * 6 : 8 + rng() * 17;
      const h = anchor ? 12 + rng() * 28 : 6 + rng() * 34;
      let cx, cz;
      if (anchor) { cx = ANCHORS[i][0] + (rng() - 0.5) * 3; cz = ANCHORS[i][1] + (rng() - 0.5) * 3; }
      else { cx = (rng() * 2 - 1) * LIMIT; cz = (rng() * 2 - 1) * LIMIT; }
      const b = { min: [cx - sw / 2, 0, cz - sd / 2], max: [cx + sw / 2, h, cz + sd / 2], height: h };
      if (ok(b)) { out.push(b); break; }
    }
  }
  return out;
}

// 면 정의: o 원점, u·v 축(단위), lu·lv 길이, n 바깥 법선, kind: 'wall'|'roof'
function buildFaces(b, hueBase) {
  const [x0, , z0] = b.min, [x1, h, z1] = b.max;
  const w = x1 - x0, d = z1 - z0;
  const f = [];
  // +z(남), −z(북), +x(동), −x(서) 벽
  f.push({ kind: 'wall', o: [x0, 0, z1], u: [1, 0, 0], v: [0, 1, 0], lu: w, lv: h, n: [0, 0, 1], hue: hueBase });
  f.push({ kind: 'wall', o: [x1, 0, z0], u: [-1, 0, 0], v: [0, 1, 0], lu: w, lv: h, n: [0, 0, -1], hue: hueBase + 90 });
  f.push({ kind: 'wall', o: [x1, 0, z1], u: [0, 0, -1], v: [0, 1, 0], lu: d, lv: h, n: [1, 0, 0], hue: hueBase + 180 });
  f.push({ kind: 'wall', o: [x0, 0, z0], u: [0, 0, 1], v: [0, 1, 0], lu: d, lv: h, n: [-1, 0, 0], hue: hueBase + 270 });
  f.push({ kind: 'roof', o: [x0, h, z0], u: [1, 0, 0], v: [0, 0, 1], lu: w, lv: d, n: [0, 1, 0], hue: hueBase + 45 });
  return f;
}

function cellHash(i, j, s) {
  let t = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  t = Math.imul(t ^ (t >>> 15), 0x85ebca6b); t ^= t >>> 13;
  return ((t >>> 0) % 1000) / 1000;
}

function faceColor(face, a, b, id, rng) {
  let s = 0.55, v = 0.75;
  if (face.kind === 'wall') {
    // 창 격자(3 x 3.5 m 칸, 칸 안쪽이 어둡고 푸른 창) + 층 줄무늬
    const ci = Math.floor(a / 3), cj = Math.floor(b / 3.5);
    const fa = a / 3 - ci, fb = b / 3.5 - cj;
    const window = fa > 0.2 && fa < 0.8 && fb > 0.25 && fb < 0.8;
    if (window) { s = 0.35; v = 0.3 + 0.3 * cellHash(ci, cj, id); return hsv(210, s, v).map((c) => clamp8(c + (rng() - 0.5) * 16)); }
    v = 0.7 + (cj % 2 === 0 ? 0.08 : -0.05);
  } else {
    // 지붕 체크 2 m
    const chk = (Math.floor(a / 2) + Math.floor(b / 2)) & 1;
    v = chk ? 0.85 : 0.55; s = 0.4;
  }
  return hsv(face.hue, s, v).map((c) => clamp8(c + (rng() - 0.5) * 16));
}

function groundColor(x, z, rng) {
  const chk = (Math.floor((x + HALF) / 4) + Math.floor((z + HALF) / 4)) & 1;
  const n = cellHash(Math.floor((x + HALF) * 2), Math.floor((z + HALF) * 2), 7);
  const base = chk ? 120 : 92;
  const g = base + (n - 0.5) * 30 + (rng() - 0.5) * 10;
  return [clamp8(g * 0.85), clamp8(g), clamp8(g * 0.7)];
}

/** 면적 비례 배분 후 나머지를 소수부가 큰 순서로 1씩 준다(합이 정확히 total). */
function allocate(areas, total) {
  const sum = areas.reduce((a, b) => a + b, 0);
  const raw = areas.map((a) => (a / sum) * total);
  const cnt = raw.map(Math.floor);
  let rest = total - cnt.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - cnt[i], i]).sort((p, q) => q[0] - p[0] || p[1] - q[1]);
  for (let k = 0; rest > 0; k++, rest--) cnt[order[k % order.length][1]]++;
  return cnt;
}

export function generate(opts = {}) {
  const seed = opts.seed >>> 0;
  const count = opts.count ?? DEFAULT_COUNT;
  const rngLayout = mulberry32(subSeed(seed, 0));
  const rng = mulberry32(subSeed(seed, 1));

  const buildings = placeBuildings(rngLayout);
  const hues = buildings.map(() => rngLayout() * 360);
  const faces = [];
  buildings.forEach((b, bi) => buildFaces(b, hues[bi]).forEach((f) => faces.push({ ...f, id: bi * 8 + faces.length % 5 })));

  const footprint = buildings.reduce((s, b) => s + (b.max[0] - b.min[0]) * (b.max[2] - b.min[2]), 0);
  const groundArea = (2 * HALF) ** 2 - footprint;
  const areas = [groundArea, ...faces.map((f) => f.lu * f.lv)];
  const cnt = allocate(areas, count);

  const positions = new Float32Array(3 * count);
  const normals = new Float32Array(3 * count);
  const colors = new Uint8Array(3 * count);
  let p = 0;
  const put = (x, y, z, n, c) => {
    positions[3 * p] = x; positions[3 * p + 1] = y; positions[3 * p + 2] = z;
    normals[3 * p] = n[0]; normals[3 * p + 1] = n[1]; normals[3 * p + 2] = n[2];
    colors[3 * p] = c[0]; colors[3 * p + 1] = c[1]; colors[3 * p + 2] = c[2];
    p++;
  };

  // 바닥: 건물 밑면 안쪽은 건너뛴다(정확히 cnt[0] 개)
  for (let k = 0; k < cnt[0]; ) {
    const x = rng() * 2 * HALF - HALF, z = rng() * 2 * HALF - HALF;
    if (buildings.some((b) => x > b.min[0] && x < b.max[0] && z > b.min[2] && z < b.max[2])) continue;
    put(x, 0, z, [0, 1, 0], groundColor(x, z, rng));
    k++;
  }
  faces.forEach((f, fi) => {
    for (let k = 0; k < cnt[fi + 1]; k++) {
      const a = rng() * f.lu, b = rng() * f.lv;
      const x = f.o[0] + a * f.u[0] + b * f.v[0];
      const y = f.o[1] + a * f.u[1] + b * f.v[1];
      const z = f.o[2] + a * f.u[2] + b * f.v[2];
      put(x, y, z, f.n, faceColor(f, a, b, f.id, rng));
    }
  });

  const maxH = Math.max(...buildings.map((b) => b.height));
  const truth = {
    bounds: { min: [-HALF, 0, -HALF], max: [HALF, maxH + 1e-3, HALF] },
    ground: { size: 2 * HALF },
    buildings: buildings.map((b) => ({ min: [...b.min], max: [...b.max], height: b.height })),
  };
  return makeResult('flat_boxes', seed, opts.format ?? FORMAT_POINT27, { format: FORMAT_POINT27, count, positions, normals, colors }, truth);
}
