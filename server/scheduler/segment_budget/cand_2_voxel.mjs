// T13.T 후보 2: 복셀 격자 솎기. 새로 작성한 코드이며 외부 코드를 차용하지 않았다.
//
// select(k) 는 원본 점의 부분집합 k 개(원본 색인)를 모턴 순으로 돌려준다. 점을 만들거나 옮기지 않는다(RULES §1.2).
//   1. 점군 bbox 최솟값을 원점으로 하는 등방 격자(칸 크기 s)를 놓고, 칸마다 점 최대 1 개를 고른다.
//      칸 대표는 칸 중심에 가장 가까운 점(거리 같으면 원본 색인이 작은 점)이라 결정적이다.
//   2. s 는 bbox 와 k 로 정한 탐색 범위 [가장 긴 변/2^20, 가장 긴 변·2] 에서 로그 척도 이분 탐색으로 정한다:
//      점유 칸 수 ≤ k 인 가장 작은 s(탐색 정밀도 안에서). 시점 정보는 쓰지 않는다.
//   3. 점유 칸 수가 k 보다 적으면 모자란 만큼 고르지 않은 점을 모턴 순 등간격으로 채워 정확히 k 개로 맞춘다.
//   4. 결과는 모턴 순(codec 1 차분이 작아지도록)이다.
// allocate 는 기존 수준 비례 배분(levelPointTargets)을 그대로 쓴다.

import { mortonOrder } from '../../codec/order/index.mjs';
import { levelPointTargets } from './index.mjs';

const GRID_BITS = 20; // 가장 작은 칸 = 가장 긴 변 / 2^20 → 축마다 칸 번호 < 2^21
const SEARCH_TOL = 1e-3; // 로그 척도(log2) 이분 탐색을 멈추는 폭: 칸 크기 약 0.07% 정밀도(약 15 회)

/**
 * @param {Float32Array} positions  길이 3n
 * @returns {{count:number, select(k:number): Uint32Array}}
 */
export function createVoxelThinner(positions) {
  if (!(positions instanceof Float32Array) || positions.length % 3 !== 0) throw new TypeError('positions 는 길이 3n 의 Float32Array');
  const n = positions.length / 3;
  let prep = null;

  const prepare = () => {
    if (prep) return prep;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < 3; a++) {
        const v = positions[3 * i + a];
        if (!Number.isFinite(v)) throw new RangeError(`positions[${3 * i + a}] 가 유한수가 아니다`);
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    const span = n > 0 ? Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) : 0;
    // 모턴 순: 기존 공간 솎기와 같은 등방 16 비트 양자화.
    const scale = span > 0 ? 65535 / span : 0;
    const q = [new Uint16Array(n), new Uint16Array(n), new Uint16Array(n)];
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < 3; a++) q[a][i] = Math.min(65535, Math.floor((positions[3 * i + a] - min[a]) * scale));
    }
    const order = mortonOrder(q[0], q[1], q[2]);
    let cap = 1;
    while (cap < 2 * n) cap <<= 1;
    prep = {
      min, span, order,
      cap,
      kx: new Int32Array(cap), ky: new Int32Array(cap), kz: new Int32Array(cap),
      best: new Int32Array(cap), bestD: new Float64Array(cap),
      occCache: new Map(),
    };
    return prep;
  };

  // 칸 크기 s 로 칸을 채운다. 점유 칸 수를 돌려주고, 표(best)에 칸별 대표 색인을 남긴다.
  const fill = (p, s) => {
    const { min, cap, kx, ky, kz, best, bestD } = p;
    const mask = cap - 1;
    best.fill(-1);
    const inv = 1 / s;
    let occ = 0;
    for (let i = 0; i < n; i++) {
      const fx = (positions[3 * i] - min[0]) * inv;
      const fy = (positions[3 * i + 1] - min[1]) * inv;
      const fz = (positions[3 * i + 2] - min[2]) * inv;
      const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
      const dx = fx - ix - 0.5, dy = fy - iy - 0.5, dz = fz - iz - 0.5;
      const d = dx * dx + dy * dy + dz * dz;
      let h = (Math.imul(ix, 0x9e3779b1) ^ Math.imul(iy, 0x85ebca77) ^ Math.imul(iz, 0xc2b2ae3d)) >>> 0;
      h = (h ^ (h >>> 15)) & mask;
      for (;;) {
        const b = best[h];
        if (b < 0) {
          kx[h] = ix; ky[h] = iy; kz[h] = iz; best[h] = i; bestD[h] = d; occ++;
          break;
        }
        if (kx[h] === ix && ky[h] === iy && kz[h] === iz) {
          // 색인 오름차순으로 훑으므로 거리가 엄격히 작을 때만 바꾸면 동률은 작은 색인이 남는다.
          if (d < bestD[h]) { best[h] = i; bestD[h] = d; }
          break;
        }
        h = (h + 1) & mask;
      }
    }
    return occ;
  };

  const occupancy = (p, s) => {
    let o = p.occCache.get(s);
    if (o === undefined) { o = fill(p, s); p.occCache.set(s, o); }
    return o;
  };

  // 점유 칸 수 ≤ k 인 가장 작은 칸 크기(탐색 정밀도 안).
  const findCell = (p, k) => {
    let lo = Math.log2(p.span) - GRID_BITS;
    let hi = Math.log2(p.span) + 1; // 칸 ≥ 2·span → 점유 1 칸
    if (occupancy(p, 2 ** lo) <= k) return 2 ** lo;
    while (hi - lo > SEARCH_TOL) {
      const mid = (lo + hi) / 2;
      if (occupancy(p, 2 ** mid) <= k) hi = mid; else lo = mid;
    }
    return 2 ** hi;
  };

  const thinner = {
    count: n,
    /** 마지막 select 의 진단: 칸 크기, 점유 칸 수(칸 대표 점 수), 모턴 등간격으로 채운 점 수. */
    lastStats: null,
    select(k) {
      if (!Number.isInteger(k) || k < 0) throw new RangeError(`k 는 0 이상 정수: ${k}`);
      const p = prepare();
      const ord = p.order;
      if (k >= n) return ord.slice();
      if (k === 0) return new Uint32Array(0);
      const chosen = new Uint8Array(n);
      let got = 0;
      let cellSize = 0;
      if (p.span > 0) {
        const s = (cellSize = findCell(p, k));
        fill(p, s);
        const { best, cap } = p;
        for (let h = 0; h < cap; h++) if (best[h] >= 0) { chosen[best[h]] = 1; got++; }
      }
      // 모자란 만큼: 고르지 않은 점을 모턴 순으로 늘어놓고 등간격으로 채운다.
      const need = k - got;
      if (need > 0) {
        const m = n - got;
        let j = 0; // 고르지 않은 점 중 순번
        let t = 0; // 다음 채울 번호
        let next = 0; // floor(t*m/need)
        for (let r = 0; r < n && t < need; r++) {
          const i = ord[r];
          if (chosen[i]) continue;
          if (j === next) {
            chosen[i] = 2;
            t++;
            next = Math.floor((t * m) / need);
          }
          j++;
        }
      }
      thinner.lastStats = { cell: cellSize, voxels: got, filled: Math.max(0, need) };
      const out = new Uint32Array(k);
      let w = 0;
      for (let r = 0; r < n; r++) if (chosen[ord[r]]) out[w++] = ord[r];
      return out;
    },
  };
  return thinner;
}

/** 수준별 점 배분: 기존 수준 비례(levelPointTargets) 그대로. */
export const allocateVoxel = levelPointTargets;
