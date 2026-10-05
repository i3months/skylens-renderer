// 지형 기준 렌더러(T15.1-A5). 래스터와 코드를 공유하지 않는 독립 광선-삼각형 교차 구현이다.
// 화소 중심 (x+0.5, y+0.5) 마다 광선 하나를 쏘아 Möller–Trumbore(양면)로 가장 가까운 삼각형을 찾는다.
// 좌표: GeoAnchor 기준 ENU(x 동, y 북, z 위), 1 unit = 1 m. 카메라: contracts/raster 규약(X_c = R·X_w + t, OpenCV 축).
// 가속: 삼각형을 xy 균일 격자 칸에 넣고, 광선의 xy 투영을 2D DDA 로 따라가며 처음 맞은 칸에서 멈춘다.
// 빈 화소는 메우지 않는다(색 0, 깊이 0, 번호 -1). 같은 거리면 번호가 작은 삼각형이 이긴다.
import { EMPTY_DEPTH, EMPTY_INDEX } from '../../../contracts/raster/index.mjs';

const NEAR_M = 0.01; // 근평면(m): 이보다 가까운 교차는 버린다
const BARY_EPS = 1e-9; // 변 위 화소가 새지 않도록 하는 무게중심 허용 오차

/** 삼각형의 면 법선(정규화 안 함, 감는 방향 기준: (p1-p0)×(p2-p0)) 을 단위벡터로. 퇴화면은 [0,0,0]. */
function triNormal(p, idx, tri) {
  const a = idx[3 * tri] * 3, b = idx[3 * tri + 1] * 3, c = idx[3 * tri + 2] * 3;
  const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
  const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const len = Math.hypot(nx, ny, nz);
  return len > 0 ? [nx / len, ny / len, nz / len] : [0, 0, 1];
}

/** xy 균일 격자 가속 구조. 칸마다 삼각형 번호 목록(CSR). */
function buildGrid(p, idx) {
  const nTri = idx.length / 3;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < minX) minX = p[i];
    if (p[i] > maxX) maxX = p[i];
    if (p[i + 1] < minY) minY = p[i + 1];
    if (p[i + 1] > maxY) maxY = p[i + 1];
  }
  const w = Math.max(maxX - minX, 1e-6), h = Math.max(maxY - minY, 1e-6);
  // 칸당 삼각형 약 2 개가 되도록 칸 크기를 정한다.
  const cell = Math.max(Math.sqrt((w * h) / Math.max(nTri / 2, 1)), 1e-6);
  const nx = Math.max(1, Math.min(4096, Math.ceil(w / cell)));
  const ny = Math.max(1, Math.min(4096, Math.ceil(h / cell)));
  const cw = w / nx, ch = h / ny;
  const count = new Int32Array(nx * ny + 1);
  const range = (tri) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = idx[3 * tri + k] * 3;
      if (p[v] < x0) x0 = p[v];
      if (p[v] > x1) x1 = p[v];
      if (p[v + 1] < y0) y0 = p[v + 1];
      if (p[v + 1] > y1) y1 = p[v + 1];
    }
    // 변 위 광선이 이웃 칸에서만 검사되는 일이 없게 한 칸 경계를 약간 넓힌다.
    const e = 1e-7 * Math.max(w, h);
    return [
      Math.max(0, Math.min(nx - 1, Math.floor((x0 - e - minX) / cw))),
      Math.max(0, Math.min(nx - 1, Math.floor((x1 + e - minX) / cw))),
      Math.max(0, Math.min(ny - 1, Math.floor((y0 - e - minY) / ch))),
      Math.max(0, Math.min(ny - 1, Math.floor((y1 + e - minY) / ch))),
    ];
  };
  for (let t = 0; t < nTri; t++) {
    const [a, b, c, d] = range(t);
    for (let j = c; j <= d; j++) for (let i = a; i <= b; i++) count[j * nx + i + 1]++;
  }
  for (let i = 0; i < nx * ny; i++) count[i + 1] += count[i];
  const fill = count.slice(0, nx * ny);
  const items = new Int32Array(count[nx * ny]);
  for (let t = 0; t < nTri; t++) { // 번호 오름차순으로 넣으므로 칸 안에서 번호가 작은 것이 먼저다
    const [a, b, c, d] = range(t);
    for (let j = c; j <= d; j++) for (let i = a; i <= b; i++) items[fill[j * nx + i]++] = t;
  }
  return { minX, minY, maxX: minX + w, maxY: minY + h, nx, ny, cw, ch, start: count, items };
}

/**
 * 메시를 카메라에서 광선으로 그린다.
 * @param {{width:number,height:number,K:{fx:number,fy:number,cx:number,cy:number},R:number[],t:number[]}} camera
 * @param {{positions:Float32Array, indices:Uint32Array, tileOfTriangle?:Int32Array}} mesh
 * @param {(normal:number[], tri:number) => number[]} shadeFn 면 법선(감는 방향 기준 단위벡터)·삼각형 번호 → [r,g,b] 0..255
 * @returns {{width:number,height:number,color:Uint8Array,depth:Float32Array,index:Int32Array}}
 *   depth = 카메라 z(m), index = tileOfTriangle[삼각형](없으면 삼각형 번호) 또는 -1
 */
export function traceMesh(camera, mesh, shadeFn) {
  const { width, height, K, R, t } = camera;
  const p = mesh.positions, idx = mesh.indices;
  const nTri = idx.length / 3;
  const color = new Uint8Array(3 * width * height);
  const depth = new Float32Array(width * height).fill(EMPTY_DEPTH);
  const index = new Int32Array(width * height).fill(EMPTY_INDEX);
  if (nTri === 0) return { width, height, color, depth, index };

  // 카메라 중심 C = -Rᵀ t. 월드 방향 = Rᵀ·(xn, yn, 1) → 매개변수 s 가 곧 카메라 z 깊이다.
  const cx0 = -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]);
  const cy0 = -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]);
  const cz0 = -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]);

  const grid = buildGrid(p, idx);
  const { nx, ny, cw, ch, minX, minY, maxX, maxY, start, items } = grid;
  const normals = new Float64Array(nTri * 3);
  for (let i = 0; i < nTri; i++) {
    const n = triNormal(p, idx, i);
    normals[3 * i] = n[0]; normals[3 * i + 1] = n[1]; normals[3 * i + 2] = n[2];
  }

  for (let py = 0; py < height; py++) {
    const yn = (py + 0.5 - K.cy) / K.fy;
    for (let px = 0; px < width; px++) {
      const xn = (px + 0.5 - K.cx) / K.fx;
      const dx = R[0] * xn + R[3] * yn + R[6];
      const dy = R[1] * xn + R[4] * yn + R[7];
      const dz = R[2] * xn + R[5] * yn + R[8];

      // 격자 xy 범위와 광선의 xy 투영이 만나는 구간 [sIn, sOut] (s >= NEAR_M)
      let sIn = NEAR_M, sOut = Infinity;
      let ok = true;
      for (const [o, d, lo, hi] of [[cx0, dx, minX, maxX], [cy0, dy, minY, maxY]]) {
        if (d === 0) { if (o < lo || o > hi) ok = false; continue; }
        let s0 = (lo - o) / d, s1 = (hi - o) / d;
        if (s0 > s1) { const tmp = s0; s0 = s1; s1 = tmp; }
        if (s0 > sIn) sIn = s0;
        if (s1 < sOut) sOut = s1;
      }
      if (!ok || sIn > sOut) continue;

      // 2D DDA
      const gx = cx0 + dx * sIn - minX, gy = cy0 + dy * sIn - minY;
      let ci = Math.max(0, Math.min(nx - 1, Math.floor(gx / cw)));
      let cj = Math.max(0, Math.min(ny - 1, Math.floor(gy / ch)));
      const stepI = dx > 0 ? 1 : -1, stepJ = dy > 0 ? 1 : -1;
      let sNextX = dx === 0 ? Infinity : (minX + (dx > 0 ? ci + 1 : ci) * cw - cx0) / dx;
      let sNextY = dy === 0 ? Infinity : (minY + (dy > 0 ? cj + 1 : cj) * ch - cy0) / dy;
      const dsX = dx === 0 ? Infinity : cw / Math.abs(dx);
      const dsY = dy === 0 ? Infinity : ch / Math.abs(dy);

      let bestS = Infinity, bestTri = -1;
      for (;;) {
        const sExit = Math.min(sNextX, sNextY, sOut);
        const cell = cj * nx + ci;
        for (let q = start[cell]; q < start[cell + 1]; q++) {
          const tri = items[q];
          const a = idx[3 * tri] * 3, b = idx[3 * tri + 1] * 3, c = idx[3 * tri + 2] * 3;
          const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
          const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
          const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
          const det = e1x * hx + e1y * hy + e1z * hz;
          if (det === 0) continue; // 양면: 부호 무관, 평행만 버린다
          const inv = 1 / det;
          const sx = cx0 - p[a], sy = cy0 - p[a + 1], sz = cz0 - p[a + 2];
          const u = (sx * hx + sy * hy + sz * hz) * inv;
          if (u < -BARY_EPS || u > 1 + BARY_EPS) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < -BARY_EPS || u + v > 1 + BARY_EPS) continue;
          const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (s < NEAR_M) continue;
          if (s < bestS || (s === bestS && tri < bestTri)) { bestS = s; bestTri = tri; }
        }
        // 삼각형이 여러 칸에 걸치므로, 맞은 지점이 이 칸 안일 때만 멈춘다(다음 칸에 더 가까운 것은 없다).
        if (bestTri >= 0 && bestS <= sExit) break;
        if (sExit >= sOut) break;
        if (sNextX < sNextY) { ci += stepI; sNextX += dsX; if (ci < 0 || ci >= nx) break; }
        else { cj += stepJ; sNextY += dsY; if (cj < 0 || cj >= ny) break; }
      }
      if (bestTri < 0) continue;
      const o = py * width + px;
      const rgb = shadeFn([normals[3 * bestTri], normals[3 * bestTri + 1], normals[3 * bestTri + 2]], bestTri);
      color[3 * o] = rgb[0]; color[3 * o + 1] = rgb[1]; color[3 * o + 2] = rgb[2];
      depth[o] = bestS;
      index[o] = mesh.tileOfTriangle ? mesh.tileOfTriangle[bestTri] : bestTri;
    }
  }
  return { width, height, color, depth, index };
}
