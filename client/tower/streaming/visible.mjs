// 관제탑 조각 요청(T15.7.1): 시점에서 보이는 지형 타일 번호. 계약: contracts/controlview/streaming.mjs TOWER_STREAMING_MODULES.visible.
// 정의: 타일 (tx,ty) 의 ENU 직육면체 [tx·64,(tx+1)·64]×[ty·64,(ty+1)·64]×zRangeM 이
//   시야 사각뿔(화면 사각형 좌우상하 4면) ∩ 근평면(깊이 ≥ nearM) ∩ 구(카메라로부터 거리 ‖X − pos‖ ≤ maxDistM) 와
//   만나면 결과에 넣는다. 판정은 보수적이다(과포함 허용, 누락 불허).
// 방법:
//   1) 구를 감싸는 볼록 다면체로 바꿔 둔다: 원평면(깊이 ≤ maxDistM)과 카메라 중심 xy 정사각 |dx|,|dy| ≤ maxDistM.
//      구는 둘 다의 안에 있으므로 이 바꿈은 영역을 넓히기만 한다(누락 없음).
//   2) 사각뿔 4면 + 근평면 + 원평면 + 정사각 4면 + z 두 면 = 반공간 12개의 교집합 P(유계 볼록 다면체)의 꼭짓점을
//      면 세 개씩 연립해 모두 구한다(최대 220 조합, 시점마다 한 번).
//   3) P 는 z 판 안에 있으므로 "타일 직육면체 ∩ P ≠ ∅" ⇔ "타일 사각형 ∩ (P 의 xy 투영) ≠ ∅" 이다.
//      투영은 꼭짓점 투영들의 볼록 껍질이다. 타일 행(ty)마다 띠 y∈[ty·64, (ty+1)·64] 와 껍질의 교집합의 x 범위를 구해
//      그 범위와 겹치는 tx 를 후보로 삼는다(볼록이므로 정확).
//   4) 후보 중 직육면체와 카메라 사이 최소 거리가 maxDistM 을 넘는 것(구와 만나지 않는 것)을 버린다.
//      P 와 만나고 구와도 만나는 타일이 P ∩ 구와 만난다는 보장은 없으므로 여기서 과포함이 남을 수 있다(허용).
//   후보는 정사각 |dx|,|dy| ≤ maxDistM 안에서만 나오므로 계산량은 반경 정사각 격자 이하다.
//   4096 한도는 4) 를 거친 결과 수에 적용한다.
//   경계는 닫힌 집합으로 본다(맞닿기만 해도 포함). 부동소수 오차로 맞닿은 타일을 놓치지 않도록
//   x·y 범위와 거리 비교를 EDGE_EPS_M 만큼 넓힌다.
// 입력 view·opts 는 고치지 않는다. 네트워크·타이머를 쓰지 않는다.
import { TERRAIN_TILE_SIZE_M } from '../../../contracts/tower_assets/index.mjs';
import { TOWER_STREAMING_LIMITS } from '../../../contracts/controlview/streaming.mjs';

const S = TERRAIN_TILE_SIZE_M;

/** 맞닿은 경계를 놓치지 않게 넓히는 폭(m). 좌표 크기에 비례하는 몫은 rangeEps 가 더한다. */
export const EDGE_EPS_M = 1e-6;

function rangeEps(v) {
  return EDGE_EPS_M + Math.abs(v) * 1e-12;
}

function finite(v, name) {
  if (typeof v !== 'number') throw new TypeError(`${name} 는 number 여야 한다`);
  if (!Number.isFinite(v)) throw new RangeError(`${name} 가 유한하지 않다: ${v}`);
}

function checkArgs(view, opts) {
  if (view === null || typeof view !== 'object') throw new TypeError('view 는 객체여야 한다');
  if (!Array.isArray(view.R) || view.R.length !== 9) throw new TypeError('view.R 는 길이 9 배열이어야 한다');
  if (!Array.isArray(view.t) || view.t.length !== 3) throw new TypeError('view.t 는 길이 3 배열이어야 한다');
  view.R.forEach((v, i) => finite(v, `view.R[${i}]`));
  view.t.forEach((v, i) => finite(v, `view.t[${i}]`));
  if (view.K === null || typeof view.K !== 'object') throw new TypeError('view.K 는 객체여야 한다');
  for (const k of ['fx', 'fy', 'cx', 'cy']) finite(view.K[k], `view.K.${k}`);
  if (!(view.K.fx > 0) || !(view.K.fy > 0)) throw new RangeError('view.K.fx·fy 는 양수여야 한다');
  finite(view.width, 'view.width');
  finite(view.height, 'view.height');
  if (!(view.width > 0) || !(view.height > 0)) throw new RangeError('view.width·height 는 양수여야 한다');
  if (opts === null || typeof opts !== 'object') throw new TypeError('opts 는 객체여야 한다');
  finite(opts.maxDistM, 'opts.maxDistM');
  finite(opts.nearM, 'opts.nearM');
  if (!Array.isArray(opts.zRangeM) || opts.zRangeM.length !== 2) throw new TypeError('opts.zRangeM 는 길이 2 배열이어야 한다');
  finite(opts.zRangeM[0], 'opts.zRangeM[0]');
  finite(opts.zRangeM[1], 'opts.zRangeM[1]');
  if (!(opts.nearM > 0)) throw new RangeError(`opts.nearM 는 양수여야 한다: ${opts.nearM}`);
  if (!(opts.maxDistM > opts.nearM)) throw new RangeError(`opts.maxDistM 는 nearM 보다 커야 한다: ${opts.maxDistM}`);
  if (!(opts.zRangeM[0] <= opts.zRangeM[1])) throw new RangeError(`opts.zRangeM 는 [min ≤ max] 여야 한다: ${opts.zRangeM}`);
}

/**
 * 세계 좌표 반공간 목록 {a:[3], b} (a·X ≥ b, |a| = 1).
 * 카메라 좌표 반공간 n·X_c ≥ c 는 X_c = R·X + t 를 넣으면 (Rᵀn)·X ≥ c − n·t 이다.
 */
function halfSpaces(view, opts, cam0) {
  const { R, t, K, width, height } = view;
  const cam = [
    [[K.fx, 0, K.cx], 0], // 왼쪽: u ≥ 0
    [[-K.fx, 0, width - K.cx], 0], // 오른쪽: u ≤ width
    [[0, K.fy, K.cy], 0], // 위: v ≥ 0
    [[0, -K.fy, height - K.cy], 0], // 아래: v ≤ height
    [[0, 0, 1], opts.nearM], // 근평면: 깊이 ≥ nearM
    [[0, 0, -1], -opts.maxDistM], // 원평면: 깊이 ≤ maxDistM (구를 감싼다)
  ];
  const out = [];
  for (const [n, c] of cam) {
    const a = [0, 1, 2].map((j) => R[j] * n[0] + R[3 + j] * n[1] + R[6 + j] * n[2]);
    const nt = n[0] * t[0] + n[1] * t[1] + n[2] * t[2];
    const len = Math.hypot(a[0], a[1], a[2]);
    out.push({ a: a.map((v) => v / len), b: (c - nt) / len });
  }
  out.push({ a: [0, 0, 1], b: opts.zRangeM[0] });
  out.push({ a: [0, 0, -1], b: -opts.zRangeM[1] });
  // 카메라 중심 xy 정사각 |dx|,|dy| ≤ maxDistM (구를 감싼다)
  const D = opts.maxDistM;
  out.push({ a: [1, 0, 0], b: cam0[0] - D });
  out.push({ a: [-1, 0, 0], b: -(cam0[0] + D) });
  out.push({ a: [0, 1, 0], b: cam0[1] - D });
  out.push({ a: [0, -1, 0], b: -(cam0[1] + D) });
  return out;
}

/** 반공간 교집합의 꼭짓점(세 면 연립). 허용 오차 안에서 모든 반공간을 만족하는 것만. */
function vertices(planes) {
  const pts = [];
  const m = planes.length;
  for (let i = 0; i < m; i += 1) {
    for (let j = i + 1; j < m; j += 1) {
      for (let k = j + 1; k < m; k += 1) {
        const p = planes[i].a; const q = planes[j].a; const r = planes[k].a;
        // q×r, r×p, p×q 로 크라메르 공식
        const qr = [q[1] * r[2] - q[2] * r[1], q[2] * r[0] - q[0] * r[2], q[0] * r[1] - q[1] * r[0]];
        const rp = [r[1] * p[2] - r[2] * p[1], r[2] * p[0] - r[0] * p[2], r[0] * p[1] - r[1] * p[0]];
        const pq = [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
        const det = p[0] * qr[0] + p[1] * qr[1] + p[2] * qr[2];
        if (Math.abs(det) < 1e-12) continue; // 평행·공선 조합은 꼭짓점을 만들지 않는다
        const bi = planes[i].b; const bj = planes[j].b; const bk = planes[k].b;
        const X = [0, 1, 2].map((d) => (bi * qr[d] + bj * rp[d] + bk * pq[d]) / det);
        if (!X.every(Number.isFinite)) continue;
        const tol = 1e-9 * (1 + Math.abs(X[0]) + Math.abs(X[1]) + Math.abs(X[2]));
        let ok = true;
        for (let h = 0; h < m && ok; h += 1) {
          const { a, b } = planes[h];
          if (a[0] * X[0] + a[1] * X[1] + a[2] * X[2] < b - tol) ok = false;
        }
        if (ok) pts.push([X[0], X[1]]);
      }
    }
  }
  return pts;
}

/** 2차원 볼록 껍질(단조 사슬). 반시계, 중복·공선 점 제거. 점이 1~2 개뿐이면 그대로. */
function hull(points) {
  const p = points.slice().sort((u, v) => (u[0] - v[0]) || (u[1] - v[1]));
  if (p.length <= 2) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i -= 1) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  const h = lower.concat(upper);
  return h.length > 0 ? h : [p[0]];
}

/**
 * 볼록 다각형(꼭짓점 목록) ∩ 띠 y∈[y0,y1] 의 x 범위. 비면 null.
 * 극값은 띠 안 꼭짓점이거나 변이 y=y0·y=y1 과 만나는 점이다.
 */
function stripRange(poly, y0, y1) {
  let lo = Infinity;
  let hi = -Infinity;
  const n = poly.length;
  const take = (x) => { if (x < lo) lo = x; if (x > hi) hi = x; };
  for (let i = 0; i < n; i += 1) {
    const [x, y] = poly[i];
    if (y >= y0 && y <= y1) take(x);
    if (n < 2) continue;
    const [xb, yb] = poly[(i + 1) % n];
    for (const c of [y0, y1]) {
      if ((y < c && yb > c) || (y > c && yb < c)) take(x + (xb - x) * ((c - y) / (yb - y)));
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * 시점에서 보이는 타일 번호.
 * @param {{R:number[], t:number[], K:{fx:number, fy:number, cx:number, cy:number}, width:number, height:number}} view  poseToView 결과
 * @param {{maxDistM:number, zRangeM:number[], nearM:number}} opts
 * @returns {{tx:number, ty:number}[]} 카메라 (x,y) 에서 타일 중심까지 거리 오름차순, 같으면 (tx,ty) 사전순
 */
export function tilesInView(view, opts) {
  checkArgs(view, opts);
  const limit = TOWER_STREAMING_LIMITS.maxTilesPerUpdate;

  // 카메라 위치(세계) = −Rᵀ·t
  const { R, t } = view;
  const cam0 = [0, 1, 2].map((j) => -(R[j] * t[0] + R[3 + j] * t[1] + R[6 + j] * t[2]));
  const [camX, camY, camZ] = cam0;

  const poly = hull(vertices(halfSpaces(view, opts, cam0)));
  if (poly.length === 0) return [];

  let ymin = Infinity;
  let ymax = -Infinity;
  for (const [, y] of poly) { if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
  const IMAX = TOWER_STREAMING_LIMITS.tileIndexMax;
  // 범위 방어: 한 칸 이내의 넘침(경계 여유)은 자르고, 그보다 크면 던진다. 루프 전에 검사한다.
  const clampIdx = (v, name) => {
    if (!(Math.abs(v) <= IMAX + 1)) throw new RangeError(`${name} 가 ±tileIndexMax(${IMAX}) 를 벗어난다: ${v}`);
    return Math.min(IMAX, Math.max(-IMAX, v));
  };
  const ty0 = clampIdx(Math.floor((ymin - rangeEps(ymin)) / S), 'ty');
  const ty1 = clampIdx(Math.floor((ymax + rangeEps(ymax)) / S), 'ty');

  // 직육면체-구 판정: 최소 거리² ≤ (maxDistM + 여유)²
  const D = opts.maxDistM + rangeEps(opts.maxDistM) + rangeEps(Math.hypot(camX, camY, camZ));
  const D2 = D * D;
  const [zMin, zMax] = opts.zRangeM;
  const gap = (c, lo, hi) => (c < lo ? lo - c : c > hi ? c - hi : 0);
  const dz = gap(camZ, zMin, zMax);

  const out = [];
  for (let ty = ty0; ty <= ty1; ty += 1) {
    const y0 = ty * S;
    const y1 = (ty + 1) * S;
    const r = stripRange(poly, y0 - rangeEps(y0), y1 + rangeEps(y1));
    if (r === null) continue;
    const dy = gap(camY, y0, y1);
    const tx0 = clampIdx(Math.floor((r[0] - rangeEps(r[0])) / S), 'tx');
    const tx1 = clampIdx(Math.floor((r[1] + rangeEps(r[1])) / S), 'tx');
    for (let tx = tx0; tx <= tx1; tx += 1) {
      const dx = gap(camX, tx * S, (tx + 1) * S);
      if (dx * dx + dy * dy + dz * dz > D2) continue; // 구와 만나지 않는다
      if (out.length >= limit) throw new RangeError('maxTilesPerUpdate');
      const cx = (tx + 0.5) * S - camX;
      const cy = (ty + 0.5) * S - camY;
      out.push({ tx, ty, d: cx * cx + cy * cy });
    }
  }
  out.sort((a, b) => (a.d - b.d) || (a.tx - b.tx) || (a.ty - b.ty));
  return out.map(({ tx, ty }) => ({ tx, ty }));
}
