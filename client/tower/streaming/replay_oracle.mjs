// 관제탑 조각 요청(T15.7.4) 경로 재생용 독립 오라클. 계약: contracts/controlview/streaming.mjs.
// 구현(index.mjs·visible.mjs)과 코드를 나누지 않고 '보이는 타일' 집합을 따로 센다. 방법은 광선 표본이다:
//   - 화면 가로·세로에 grid=[gw,gh] 개씩 고르게 광선을 쏜다. 양 끝 광선은 화면 가장자리에서 EDGE_INSET(폭의 1e-4)만큼 안쪽이다
//     (가장자리를 거의 그대로 덮되, 경계 위 부동소수 오차로 구현의 닫힌 판정과 어긋나지 않게 한다).
//   - 광선 위 점은 카메라 깊이 s(카메라 z 축 성분)로 매긴다: X = pos + s·d, d = R_c2w·[(u−cx)/f, (v−cy)/f, 1].
//   - s 는 [nearM, maxDistM] 이고 지면 직육면체 slab(z ∈ zRangeM) 안이어야 한다.
//   - 그 구간 위 점들이 지나는 타일 (floor(x/64), floor(y/64)) 을 모은다. 표본은 구간을 타일 격자선 교차점으로 나눈 각 조각의
//     중점과 두 끝점이다. 이는 고정 간격(예: 64/8 m) 표본을 한없이 촘촘히 한 극한과 같은 집합이다(조각 안에서는 타일이 바뀌지 않는다).
// 표본이므로 결과는 참 '필요' 집합의 부분집합이다(모서리만 스치는 타일은 놓칠 수 있다). 그래서 오라클 ⊆ 구현 needed 는
// 보수적 구현이라면 반드시 성립해야 하는 단언이고, 실패하면 구현이 보이는 타일을 놓친 것이다.
// 카메라 규약: quat 는 카메라→ENU 회전(x,y,z,w), 카메라 축은 OpenCV(x 오른쪽, y 아래, z 앞). K 는 fy = (height/2)/tan(fovY/2), fx = fy,
// cx = width/2, cy = height/2 (overlay/view.mjs poseToView 와 같다). 회전 행렬은 여기서 따로 계산한다(구현 의존 없음).
import { TOWER_STREAMING_LIMITS } from '../../../contracts/controlview/streaming.mjs';
import { TERRAIN_TILE_SIZE_M } from '../../../contracts/tower_assets/index.mjs';

/** 오라클 기본값. 거리·높이 범위는 계약 기본값을 따른다. */
export const ORACLE_DEFAULTS = Object.freeze({
  maxDistM: TOWER_STREAMING_LIMITS.maxDistM,
  zRangeM: Object.freeze([TOWER_STREAMING_LIMITS.zMinM, TOWER_STREAMING_LIMITS.zMaxM]),
  nearM: TOWER_STREAMING_LIMITS.nearM,
  grid: Object.freeze([48, 27]),
});

/** 가장자리 광선을 화면 안쪽으로 들이는 비율(폭·높이 대비). */
const EDGE_INSET = 1e-4;

/** 단위화한 카메라→ENU 쿼터니언(x,y,z,w) → 행 우선 3×3(열 j = 카메라 j 축의 ENU 방향). */
function rotationOf(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  const x = q[0] / n, y = q[1] / n, z = q[2] / n, w = q[3] / n;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** 타일 번호 비교((tx,ty) 사전순). */
export function compareTile(a, b) {
  return a.tx - b.tx || a.ty - b.ty;
}

/** 타일 키 문자열. 시험이 집합 비교에 쓴다. */
export function tileKey(tx, ty) {
  return `${tx},${ty}`;
}

/** 점 (x,y) 가 든 타일을 seen 에 더한다. 키는 수(문자열보다 빠르다). |tx|,|ty| < 2^20 이면 겹치지 않는다. */
function add(seen, x, y, tile) {
  const tx = Math.floor(x / tile), ty = Math.floor(y / tile);
  const key = (tx + 1048576) * 2097152 + (ty + 1048576);
  if (!seen.has(key)) seen.set(key, { tx, ty });
}

/** i 번째(0..n−1) 광선의 화면 좌표(0..len). 양 끝은 EDGE_INSET 만큼 안쪽, n = 1 이면 가운데. */
function rayAt(i, n, len) {
  if (n === 1) return len / 2;
  return len * (EDGE_INSET + ((1 - 2 * EDGE_INSET) * i) / (n - 1));
}

/** p + s·d 가 격자선 k·tile 을 지나는 s 값(s0 < s < s1, 오름차순). */
function crossings(p, d, s0, s1, tile) {
  const out = [];
  if (d === 0) return out;
  const a = p + s0 * d, b = p + s1 * d;
  if (d > 0) {
    for (let k = Math.floor(a / tile) + 1; k * tile < b; k += 1) out.push((k * tile - p) / d);
  } else {
    for (let k = Math.ceil(a / tile) - 1; k * tile > b; k -= 1) out.push((k * tile - p) / d);
  }
  return out;
}

/** 오름차순 두 배열을 합친다. */
function mergeSorted(a, b) {
  const out = new Array(a.length + b.length);
  let i = 0, j = 0, k = 0;
  while (i < a.length && j < b.length) out[k++] = a[i] <= b[j] ? a[i++] : b[j++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

/**
 * 시점 하나에서 광선 표본으로 본 타일 집합.
 * @param {{pos:number[], quat:number[], fovY:number}} pose
 * @param {{width:number, height:number}} size
 * @param {{maxDistM?:number, zRangeM?:number[], nearM?:number, grid?:number[]}} [opts]
 * @returns {{tx:number, ty:number}[]} (tx,ty) 사전순 새 배열
 */
export function oracleTiles(pose, size, opts = {}) {
  const o = { ...ORACLE_DEFAULTS, ...opts };
  const [zMin, zMax] = o.zRangeM;
  const [gw, gh] = o.grid;
  const tile = TERRAIN_TILE_SIZE_M;
  const M = rotationOf(pose.quat);
  const [px, py, pz] = pose.pos;
  const f = (size.height / 2) / Math.tan(pose.fovY / 2);
  const cx = size.width / 2, cy = size.height / 2;
  const seen = new Map();

  for (let j = 0; j < gh; j += 1) {
    const b = (rayAt(j, gh, size.height) - cy) / f;
    for (let i = 0; i < gw; i += 1) {
      const a = (rayAt(i, gw, size.width) - cx) / f;
      // 카메라 방향 [a, b, 1] 을 ENU 로. z 성분이 1 이므로 매개변수 s 가 곧 카메라 깊이다.
      const dx = M[0] * a + M[1] * b + M[2];
      const dy = M[3] * a + M[4] * b + M[5];
      const dz = M[6] * a + M[7] * b + M[8];
      let s0 = o.nearM, s1 = o.maxDistM;
      // slab 높이 범위로 자른다.
      if (Math.abs(dz) < 1e-12) {
        if (pz < zMin || pz > zMax) continue;
      } else {
        const sa = (zMin - pz) / dz, sb = (zMax - pz) / dz;
        s0 = Math.max(s0, Math.min(sa, sb));
        s1 = Math.min(s1, Math.max(sa, sb));
      }
      if (!(s1 >= s0)) continue;
      // 구간 [s0,s1] 을 타일 격자선(x = k·64, y = k·64) 교차점으로 자르고, 각 조각의 중점과 두 끝점을 표본한다.
      // 고정 간격(예: 64/8 m) 표본을 한없이 촘촘히 한 극한과 같은 집합이고, 고정 간격보다 빠르다.
      const ss = mergeSorted(crossings(px, dx, s0, s1, tile), crossings(py, dy, s0, s1, tile));
      ss.unshift(s0);
      ss.push(s1);
      add(seen, px + s0 * dx, py + s0 * dy, tile);
      add(seen, px + s1 * dx, py + s1 * dy, tile);
      for (let k = 0; k + 1 < ss.length; k += 1) {
        const s = (ss[k] + ss[k + 1]) / 2;
        add(seen, px + s * dx, py + s * dy, tile);
      }
    }
  }
  return [...seen.values()].sort(compareTile);
}
