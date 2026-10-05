// 건물 층 참조 렌더러(T15.3.6). 래스터(raster_flat·raster_tex·lines·points)와 코드를 공유하지 않는 느린 정답 구현이다.
// 작은 해상도(예: 80×45)에서 비교 기준으로만 쓴다. 가속 구조 없이 화소마다 모든 삼각형을 검사한다.
// 좌표: GeoAnchor 기준 ENU(x 동, y 북, z 위), 1 unit = 1 m. 카메라: contracts/raster 규약(X_c = R·X_w + t, OpenCV 축).
//
// 면(black·aerial): 화소 중심 (px+0.5, py+0.5) 마다 광선 C + s·Rᵀ(xn, yn, 1) 하나를 쏜다. 이 매개변수 s 가 곧 카메라 z 깊이다.
//   Möller–Trumbore(양면)로 모든 묶음·모든 삼각형을 열거해 s > nearM 인 가장 가까운 교차를 고른다.
//   같은 s 면 먼저 나온 것(묶음 번호, 그다음 삼각형 번호가 작은 것)이 이긴다. depth = s, index = 묶음 번호.
// black: 면 색 faceRgb. opts.lines(기본 true)면 모서리 선을 화소별 거리 시험으로 덧그린다:
//   선분을 근평면(z > nearM)에서 자르고 화면에 투영한 뒤, 화소 중심에서 화면 선분까지 거리가 lineHalfWidthPx(기본 0.5) 이하면
//   그 가장 가까운 점의 깊이 z(1/z 를 화면 매개변수로 선형 보간)를 구하고, z − lineDepthBiasM ≤ 면 깊이(면이 없으면 통과)일 때
//   선이 이긴다. 선끼리는 z 가 작은 것. 선 화소의 depth = z(치우침 없는 값), index = 묶음 번호, 색 lineRgb.
//   주의: 선 화소 덮임 규칙은 계약이 정하지 않았으므로(래스터는 화소 걷기) 선이 있는 비교는 경계 화소 허용을 두어야 한다.
// aerial: 교차점의 무게중심 (1−b1−b2, b1, b2)(월드 공간이라 원근 보정과 같다)로 uv 를 섞는다. 지붕은 평면이고 uv 가 xy 의
//   아핀 함수이므로 이 선형 보간이 정답이다. 계약 관례(서버 aerial_uv 와 같음): v = 0 이 북쪽, 영상 행 0 = 북 → 연속 좌표 (u·W, v·H).
//   화소 중심(col+0.5, row+0.5) 기준 이중선형 표본, 가장자리는 가장자리 화소로 고정, 채널마다 반올림.
//   삼각형의 세 정점 중 하나라도 wallMask = 1 이면 벽·바닥으로 보고 faceRgb. image 가 null 이면 모든 면이 faceRgb.
// points: 점마다 X_c = R·X + t, d = X_c.z > nearM 이면 (floor(u), floor(v)) 칸 한 개. 깊이 시험(작은 d), 같은 d 는 먼저 온 점.
// 빈 화소는 메우지 않는다(색 0, 깊이 0, 번호 −1).
import { assertCamera, emptyResult } from '../../../contracts/raster/index.mjs';
import { DISPLAY_MODES } from '../../../contracts/tower_assets/index.mjs';
import { BUILDINGS_DEFAULTS } from '../../../contracts/controlview/buildings.mjs';

const BARY_EPS = 1e-9; // 공유 변 위 화소 중심이 새지 않도록 하는 무게중심 허용

/** 카메라 중심 C = −Rᵀt. */
function cameraCenter(R, t) {
  return [
    -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
    -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
    -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]),
  ];
}

/**
 * Möller–Trumbore 양면 교차. 맞으면 [s, b1, b2], 아니면 null.
 * @param {number[]} o 광선 시작
 * @param {number[]} d 광선 방향(정규화 불필요, s 는 d 배수)
 */
export function intersectTriangle(o, d, p0, p1, p2) {
  const e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2];
  const e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];
  const hx = d[1] * e2z - d[2] * e2y, hy = d[2] * e2x - d[0] * e2z, hz = d[0] * e2y - d[1] * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (det === 0) return null;
  const inv = 1 / det;
  const sx = o[0] - p0[0], sy = o[1] - p0[1], sz = o[2] - p0[2];
  const b1 = (sx * hx + sy * hy + sz * hz) * inv;
  if (b1 < -BARY_EPS || b1 > 1 + BARY_EPS) return null;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const b2 = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (b2 < -BARY_EPS || b1 + b2 > 1 + BARY_EPS) return null;
  const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return [s, b1, b2];
}

/** 영상 이중선형 표본(계약 uv 관례). 결과는 반올림한 [r,g,b]. */
export function sampleAerial(image, u, v) {
  const { width: W, height: H, rgb } = image;
  const fx = u * W - 0.5, fy = v * H - 0.5;
  const i0 = Math.floor(fx), j0 = Math.floor(fy);
  const tx = fx - i0, ty = fy - j0;
  const ci = (i) => Math.min(W - 1, Math.max(0, i));
  const cj = (j) => Math.min(H - 1, Math.max(0, j));
  const a = 3 * (cj(j0) * W + ci(i0)), b = 3 * (cj(j0) * W + ci(i0 + 1));
  const c = 3 * (cj(j0 + 1) * W + ci(i0)), e = 3 * (cj(j0 + 1) * W + ci(i0 + 1));
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const top = rgb[a + k] * (1 - tx) + rgb[b + k] * tx;
    const bot = rgb[c + k] * (1 - tx) + rgb[e + k] * tx;
    out[k] = Math.round(top * (1 - ty) + bot * ty);
  }
  return out;
}

function vertex(pos, i) { return [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]; }

function toCam(R, t, p) {
  return [
    R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0],
    R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1],
    R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2],
  ];
}

/** 모서리 선분을 근평면에서 자르고 화면에 투영한 목록 [{u0,v0,z0,u1,v1,z1,g}]. */
function projectedSegments(camera, groups, nearM) {
  const { K, R, t } = camera;
  const segs = [];
  groups.forEach((g, gi) => {
    const L = g.edgeLines;
    for (let k = 0; k + 5 < L.length; k += 6) {
      let a = toCam(R, t, [L[k], L[k + 1], L[k + 2]]);
      let b = toCam(R, t, [L[k + 3], L[k + 4], L[k + 5]]);
      if (a[2] <= nearM && b[2] <= nearM) continue;
      // 근평면 바로 안쪽(nearM 의 1e-9 상대만큼 앞)으로 자른다.
      const zc = nearM * (1 + 1e-9);
      if (a[2] <= nearM) { const f = (zc - a[2]) / (b[2] - a[2]); a = [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), zc]; }
      else if (b[2] <= nearM) { const f = (zc - b[2]) / (a[2] - b[2]); b = [b[0] + f * (a[0] - b[0]), b[1] + f * (a[1] - b[1]), zc]; }
      segs.push({
        u0: K.fx * a[0] / a[2] + K.cx, v0: K.fy * a[1] / a[2] + K.cy, z0: a[2],
        u1: K.fx * b[0] / b[2] + K.cx, v1: K.fy * b[1] / b[2] + K.cy, z1: b[2], g: gi,
      });
    }
  });
  return segs;
}

function traceFaces(camera, groups, nearM, onHit) {
  const { width, height, K, R } = camera;
  const C = cameraCenter(R, camera.t);
  // 삼각형을 미리 꺼내 둔다(배정밀도). 순서: 묶음 번호, 삼각형 번호.
  const tris = [];
  groups.forEach((g, gi) => {
    const pos = g.mesh.positions, idx = g.mesh.indices;
    for (let ti = 0; ti + 2 < idx.length; ti += 3) {
      tris.push({ gi, ti: ti / 3, a: idx[ti], b: idx[ti + 1], c: idx[ti + 2], p0: vertex(pos, idx[ti]), p1: vertex(pos, idx[ti + 1]), p2: vertex(pos, idx[ti + 2]) });
    }
  });
  for (let py = 0; py < height; py++) {
    const yn = (py + 0.5 - K.cy) / K.fy;
    for (let px = 0; px < width; px++) {
      const xn = (px + 0.5 - K.cx) / K.fx;
      const d = [R[0] * xn + R[3] * yn + R[6], R[1] * xn + R[4] * yn + R[7], R[2] * xn + R[5] * yn + R[8]];
      let best = null, bestHit = null;
      for (const tr of tris) {
        const hit = intersectTriangle(C, d, tr.p0, tr.p1, tr.p2);
        if (!hit || !(hit[0] > nearM)) continue;
        if (best === null || hit[0] < bestHit[0]) { best = tr; bestHit = hit; }
      }
      if (best) onHit(py * width + px, best, bestHit);
    }
  }
}

/**
 * 건물 묶음을 한 가지 표시 옵션으로 그린다(느린 참조).
 * @param {object} camera contracts/raster Camera
 * @param {{groups:Array<{ids:number[],mesh:{positions:Float32Array,indices:Uint32Array},edgeLines:Float32Array,uv:Float32Array,wallMask:Uint8Array,points:Float32Array}>, image:{width:number,height:number,rgb:Uint8Array}|null}} bundle
 * @param {'points'|'black'|'aerial'} mode
 * @param {{ lines?:boolean, faceRgb?:number[], lineRgb?:number[], pointRgb?:number[], lineDepthBiasM?:number, lineHalfWidthPx?:number, nearM?:number }} [opts]
 *   lines 는 black 에서만 쓴다(기본 true).
 * @returns {{width:number,height:number,color:Uint8Array,depth:Float32Array,index:Int32Array}} RenderResult
 */
export function refRenderBuildings(camera, bundle, mode, opts = {}) {
  assertCamera(camera);
  if (!DISPLAY_MODES.includes(mode)) throw new RangeError(`ref_trace: mode 는 ${DISPLAY_MODES.join('|')} 중 하나: ${String(mode)}`);
  const faceRgb = opts.faceRgb ?? BUILDINGS_DEFAULTS.faceRgb;
  const lineRgb = opts.lineRgb ?? BUILDINGS_DEFAULTS.lineRgb;
  const pointRgb = opts.pointRgb ?? BUILDINGS_DEFAULTS.pointRgb;
  const bias = opts.lineDepthBiasM ?? BUILDINGS_DEFAULTS.lineDepthBiasM;
  const halfW = opts.lineHalfWidthPx ?? 0.5;
  const nearM = opts.nearM ?? BUILDINGS_DEFAULTS.nearM;
  const groups = bundle.groups;
  const out = emptyResult(camera.width, camera.height);
  const put = (o, rgb, z, gi) => {
    out.color[3 * o] = rgb[0]; out.color[3 * o + 1] = rgb[1]; out.color[3 * o + 2] = rgb[2];
    out.depth[o] = z; out.index[o] = gi;
  };

  if (mode === 'points') {
    const { width, height, K, R, t } = camera;
    groups.forEach((g, gi) => {
      const P = g.points;
      for (let k = 0; k + 2 < P.length; k += 3) {
        const c = toCam(R, t, [P[k], P[k + 1], P[k + 2]]);
        if (!(c[2] > nearM)) continue;
        const col = Math.floor(K.fx * c[0] / c[2] + K.cx), row = Math.floor(K.fy * c[1] / c[2] + K.cy);
        if (col < 0 || col >= width || row < 0 || row >= height) continue;
        const o = row * width + col;
        if (out.index[o] === -1 || c[2] < out.depth[o]) put(o, pointRgb, c[2], gi);
      }
    });
    return out;
  }

  // 면은 배정밀도 깊이로 따로 들고 있다가 마지막에 Float32 로 넣는다(선 깊이 시험을 배정밀도로 하려고).
  const faceDepth = new Float64Array(camera.width * camera.height);
  const image = bundle.image;
  traceFaces(camera, groups, nearM, (o, tr, hit) => {
    const [s, b1, b2] = hit;
    let rgb = faceRgb;
    if (mode === 'aerial' && image) {
      const g = groups[tr.gi];
      const m = g.wallMask;
      if (!(m[tr.a] || m[tr.b] || m[tr.c])) {
        const w0 = 1 - b1 - b2, uv = g.uv;
        const u = w0 * uv[2 * tr.a] + b1 * uv[2 * tr.b] + b2 * uv[2 * tr.c];
        const v = w0 * uv[2 * tr.a + 1] + b1 * uv[2 * tr.b + 1] + b2 * uv[2 * tr.c + 1];
        rgb = sampleAerial(image, u, v);
      }
    }
    faceDepth[o] = s;
    put(o, rgb, s, tr.gi);
  });

  if (mode === 'black' && (opts.lines ?? true)) {
    const segs = projectedSegments(camera, groups, nearM);
    const { width, height } = camera;
    for (let py = 0; py < height; py++) {
      const y = py + 0.5;
      for (let px = 0; px < width; px++) {
        const x = px + 0.5;
        let bestZ = Infinity, bestG = -1;
        for (const sg of segs) {
          const ex = sg.u1 - sg.u0, ey = sg.v1 - sg.v0;
          const len2 = ex * ex + ey * ey;
          let tau = len2 > 0 ? ((x - sg.u0) * ex + (y - sg.v0) * ey) / len2 : 0;
          tau = Math.min(1, Math.max(0, tau));
          const qx = sg.u0 + tau * ex - x, qy = sg.v0 + tau * ey - y;
          if (Math.hypot(qx, qy) > halfW) continue;
          const z = 1 / ((1 - tau) / sg.z0 + tau / sg.z1); // 화면 매개변수에서 1/z 가 선형
          if (z < bestZ) { bestZ = z; bestG = sg.g; }
        }
        if (bestG < 0) continue;
        const o = py * width + px;
        const fd = faceDepth[o];
        if (fd === 0 || bestZ - bias <= fd) put(o, lineRgb, bestZ, bestG);
      }
    }
  }
  return out;
}
