// 관제탑 조각 요청(T15.7.1): 시점에서 보이는 지형 타일 번호. 계약: contracts/controlview/streaming.mjs TOWER_STREAMING_MODULES.visible.
// 정의: 타일 (tx,ty) 의 ENU 직육면체 [tx·64,(tx+1)·64]×[ty·64,(ty+1)·64]×zRangeM 이
//   시야 사각뿔(화면 사각형 좌우상하 4면) ∩ 근평면(깊이 ≥ nearM) ∩ 구(카메라로부터 거리 ‖X − pos‖ ≤ maxDistM) 와
//   만나면 결과에 넣는다. 판정은 보수적이다(과포함 허용, 누락 불허).
// 방법:
//   1) 구를 감싸는 볼록 다면체로 바꿔 둔다: 원평면(깊이 ≤ maxDistM)과 카메라 중심 xy 정사각 |dx|,|dy| ≤ maxDistM.
//      구는 둘 다의 안에 있으므로 이 바꿈은 영역을 넓히기만 한다(누락 없음).
//   2) 사각뿔 4면 + 근평면 + 원평면 + z 두 면 + 정사각 4면 = 반공간 12개의 교집합 P(유계 볼록 다면체)의 꼭짓점을
//      면 세 개씩 연립해 모두 구한다(C(12,3) = 220 조합, 시점마다 한 번).
//   3) P 는 z 판 안에 있으므로 "타일 직육면체 ∩ P ≠ ∅" ⇔ "타일 사각형 ∩ (P 의 xy 투영) ≠ ∅" 이다.
//      투영은 꼭짓점 투영들의 볼록 껍질이다. 타일 행(ty)마다 띠 y∈[ty·64, (ty+1)·64] 와 껍질의 교집합의 x 범위를 구해
//      그 범위와 겹치는 tx 를 후보로 삼는다(볼록이므로 정확).
//   4) 후보 중 직육면체와 카메라 사이 최소 거리가 maxDistM 을 넘는 것(구와 만나지 않는 것)을 버린다.
//      P 와 만나고 구와도 만나는 타일이 P ∩ 구와 만난다는 보장은 없으므로 여기서 과포함이 남을 수 있다(허용).
//   최적화(모두 결과 불변):
//           z 범위가 구 밖이면(dz > maxDistM) 빈 결과 반환 → 수백만 행 순회 회피.
//           구가 닿는 y 범위(camY ± √(D²−dz²)) 로 행(ty) 범위를 먼저 좁힌다.
//           3) 의 껍질(2차원 다각형)과 구의 xy 원판(반경 √(D²−dz²) + 2·64)의 교집합의 y 범위로 행 범위를 한 번 더 좁힌다.
//             반공간을 더해 꼭짓점을 다시 구하지 않고 껍질 변과 원의 교점을 직접 구한다(변 수에 비례, 반공간 수와 무관).
//           각 행에서 구가 닿는 x 범위(camX ± √(D²−dy²−dz²)) 로 열(tx) 범위를 좁혀 띠 범위와 교집합만 훑는다.
//   후보는 정사각 |dx|,|dy| ≤ maxDistM 안에서만 나오므로 계산량은 반경 정사각 격자 이하다.
//   4096 한도는 4) 를 거친 결과 수에 적용한다.
//   경계는 닫힌 집합으로 본다(맞닿기만 해도 포함). 부동소수 오차로 맞닿은 타일을 놓치지 않도록
//   x·y 범위와 거리 비교를 EDGE_EPS_M 만큼 넓힌다.
// 입력 view·opts 는 고치지 않는다. 네트워크·타이머를 쓰지 않는다.
import { TERRAIN_TILE_SIZE_M } from '../../../contracts/tower_assets/index.mjs';
import { TOWER_STREAMING_LIMITS } from '../../../contracts/controlview/streaming.mjs';

const S = TERRAIN_TILE_SIZE_M;

/**
 * 맞닿은 경계를 놓치지 않게 넓히는 폭(m). 좌표 크기와 무관한 고정값이다.
 * 근거: 좌표 상한 |x|,|y| ≤ 6.4e7 m 에서 배정밀도 한 단위(ulp)는 약 7.5e-9 m 라, 좌표 6.4e7 m 근처의 맞닿음 시험
 * (visible.test.mjs '좌표 상한 근처')에서도 카메라 위치(−Rᵀ·t)·꼭짓점·띠 교점의 오차가 이 폭 안에 든다.
 * 거리 비교는 D 에 2·EDGE_EPS_M 을 더한 D² 와 견주므로 D² 기준 여유가 4·D·EDGE_EPS_M 이다. 좌표에 비례하는 몫은 두지 않는다.
 */
export const EDGE_EPS_M = 1e-6;

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
  // R 직교성: R·Rᵀ 의 각 원소가 단위행렬 원소와 고정 허용오차 1e-9 안에서 같아야 한다.
  // 직교 행렬의 원소는 |값| ≤ 1 이라 R·Rᵀ 원소도 크기 1 이하이므로 값에 비례하는 몫은 두지 않는다.
  const tol = 1e-9;
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) sum += view.R[3 * i + k] * view.R[3 * j + k];
      const expected = i === j ? 1 : 0;
      if (Math.abs(sum - expected) > tol) throw new RangeError(`view.R 가 직교하지 않다`);
    }
  }
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
function vertices(planes, stats) {
  const pts = [];
  const m = planes.length;
  for (let i = 0; i < m; i += 1) {
    for (let j = i + 1; j < m; j += 1) {
      for (let k = j + 1; k < m; k += 1) {
        if (stats && typeof stats.combos === 'number') stats.combos += 1; // 실제로 연립한 조합만 센다(공식으로 미리 계산하지 않는다)
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
 * 볼록 다각형 poly ∩ 원판(중심 (cx,cy), 반경 r) 의 y 범위 [lo, hi]. 비면 null.
 * 극값 후보는 원판 안 꼭짓점, 변과 원의 교점, 다각형 안에 든 원의 맨 아래·맨 위 점이다.
 * 원에 거의 접하는 변·꼭짓점은 부동소수 오차로 빠질 수 있으나, 그런 점은 원에서 오차 폭 안에 있으므로
 * 반경을 조금 줄인 원판과 poly 의 교집합은 늘 [lo, hi] 안에 든다(호출부가 반경에 64 m 여유를 둔다).
 */
function discYRange(poly, cx, cy, r) {
  let lo = Infinity;
  let hi = -Infinity;
  const take = (y) => { if (y < lo) lo = y; if (y > hi) hi = y; };
  const r2 = r * r;
  const n = poly.length;
  for (let i = 0; i < n; i += 1) {
    const [x, y] = poly[i];
    const dx = x - cx;
    const dy = y - cy;
    const c = dx * dx + dy * dy - r2;
    if (c <= 0) take(y);
    if (n < 2) continue;
    const [xb, yb] = poly[(i + 1) % n];
    const ex = xb - x;
    const ey = yb - y;
    const a = ex * ex + ey * ey;
    if (!(a > 0)) continue;
    // |(dx,dy) + s·(ex,ey)|² = r² 의 근 s ∈ [0,1]
    const b = dx * ex + dy * ey;
    const disc = b * b - a * c;
    if (disc < 0) continue;
    const q = Math.sqrt(disc);
    for (const s of [(-b - q) / a, (-b + q) / a]) if (s >= 0 && s <= 1) take(y + ey * s);
  }
  if (n >= 3) {
    // 원의 맨 아래·맨 위 점이 다각형 안(반시계, 경계 포함)이면 그 y 가 극값이다
    for (const py of [cy - r, cy + r]) {
      let inside = true;
      for (let i = 0; i < n && inside; i += 1) {
        const [x, y] = poly[i];
        const [xb, yb] = poly[(i + 1) % n];
        const cr = (xb - x) * (py - y) - (yb - y) * (cx - x);
        if (cr < -1e-9 * (Math.abs(xb - x) + Math.abs(yb - y)) * (1 + Math.abs(py - y) + Math.abs(cx - x))) inside = false;
      }
      if (inside) take(py);
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * 시점에서 보이는 타일 번호.
 * @param {{R:number[], t:number[], K:{fx:number, fy:number, cx:number, cy:number}, width:number, height:number}} view  poseToView 결과
 * @param {{maxDistM:number, zRangeM:number[], nearM:number}} opts
 * @param {{rows:number, cells:number, combos?:number, edges?:number}} [stats] 시험용 작업량 계수기. 행·칸 방문 수를 rows·cells 에 더하고,
 *   combos·edges 가 숫자로 있으면 vertices 안 i/j/k 루프가 실제로 푼 연립 조합 수·원판 교차에서 본 다각형 변 수도 더한다. 읽고 더하기만 하므로 결과에는 영향이 없다.
 * @returns {{tx:number, ty:number}[]} 카메라 (x,y) 에서 타일 중심까지 거리 오름차순, 같으면 (tx,ty) 사전순
 */
export function tilesInView(view, opts, stats) {
  checkArgs(view, opts);
  const limit = TOWER_STREAMING_LIMITS.maxTilesPerUpdate;

  // 카메라 위치(세계) = −Rᵀ·t
  const { R, t } = view;
  const cam0 = [0, 1, 2].map((j) => -(R[j] * t[0] + R[3 + j] * t[1] + R[6 + j] * t[2]));
  const [camX, camY, camZ] = cam0;

  // 직육면체-구 판정: 최소 거리² ≤ (maxDistM + 여유)²
  const D = opts.maxDistM + 2 * EDGE_EPS_M;
  const D2 = D * D;
  const [zMin, zMax] = opts.zRangeM;
  const gap = (c, lo, hi) => (c < lo ? lo - c : c > hi ? c - hi : 0);
  const dz = gap(camZ, zMin, zMax);
  // z 판이 구 밖이면 어떤 타일도 구와 만나지 않는다(빈 행을 수백만 번 도는 일을 막는다)
  if (dz > D) return [];
  const planes = halfSpaces(view, opts, cam0);
  const poly = hull(vertices(planes, stats));
  if (poly.length === 0) return [];

  // 행 범위 좁히기(결과 불변): 행이 타일을 내려면 그 행 띠(±여유) 안에 껍질 점 q 가 있고 |q.x − camX| ≤ hx 여야 한다.
  // 행의 hx 는 띠에서 카메라에 가장 가까운 y 로 잡으므로 hx² + dy² = hy² 이고, q 와 그 y 의 차는 한 행(S) 이하다 →
  // |q − cam|_xy ≤ hy + S(+여유). 반경 hy + 2S 원판과 껍질의 교집합 y 범위를 구하고 위아래로 한 행씩 더 두면 그 밖 행은 늘 빈 행이다.
  const hy = Math.sqrt(Math.max(0, D2 - dz * dz));
  if (stats && typeof stats.edges === 'number') stats.edges += poly.length;
  const narrow = discYRange(poly, camX, camY, hy + 2 * S + EDGE_EPS_M);
  // 교집합이 비면 어떤 행도 타일을 내지 못한다
  if (narrow === null) return [];

  let ymin = Infinity;
  let ymax = -Infinity;
  for (const [, y] of poly) { if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
  const IMAX = TOWER_STREAMING_LIMITS.tileIndexMax;
  // 범위 방어: 한 칸 이내의 넘침(경계 여유)은 자르고, 그보다 크면 던진다. 루프 전에 검사한다.
  const clampIdx = (v, name) => {
    if (!(Math.abs(v) <= IMAX + 1)) throw new RangeError(`${name} 가 ±tileIndexMax(${IMAX}) 를 벗어난다: ${v}`);
    return Math.min(IMAX, Math.max(-IMAX, v));
  };
  let ty0 = clampIdx(Math.floor((ymin - EDGE_EPS_M) / S), 'ty');
  let ty1 = clampIdx(Math.floor((ymax + EDGE_EPS_M) / S), 'ty');

  // 구가 닿는 y 는 camY ± √(D²−dz²) 뿐이므로 행 범위를 먼저 좁힌다
  ty0 = Math.max(ty0, clampIdx(Math.floor((camY - hy - EDGE_EPS_M) / S), 'ty'));
  ty1 = Math.min(ty1, clampIdx(Math.floor((camY + hy + EDGE_EPS_M) / S), 'ty'));

  ty0 = Math.max(ty0, Math.floor((narrow[0] - S - EDGE_EPS_M) / S));
  ty1 = Math.min(ty1, Math.floor((narrow[1] + S + EDGE_EPS_M) / S));

  const out = [];
  for (let ty = ty0; ty <= ty1; ty += 1) {
    if (stats) stats.rows += 1;
    const y0 = ty * S;
    const y1 = (ty + 1) * S;
    const r = stripRange(poly, y0 - EDGE_EPS_M, y1 + EDGE_EPS_M);
    if (r === null) continue;
    const dy = gap(camY, y0, y1);
    const rem = D2 - dy * dy - dz * dz;
    if (rem < 0) continue;
    // 이 행에서 구가 닿는 x 는 camX ± √(D²−dy²−dz²) 이므로 띠 범위와 교집합만 훑는다
    const hx = Math.sqrt(rem);
    const lo = Math.max(r[0], camX - hx);
    const hi = Math.min(r[1], camX + hx);
    if (lo - EDGE_EPS_M > hi + EDGE_EPS_M) continue;
    const tx0 = clampIdx(Math.floor((lo - EDGE_EPS_M) / S), 'tx');
    const tx1 = clampIdx(Math.floor((hi + EDGE_EPS_M) / S), 'tx');
    for (let tx = tx0; tx <= tx1; tx += 1) {
      if (stats) stats.cells += 1;
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
