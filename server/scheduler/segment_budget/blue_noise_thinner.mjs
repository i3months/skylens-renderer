// T13.T 푸아송 원반 근사(블루노이즈) 솎기(결정 0065). 새로 작성한 코드이며 외부 코드를 차용하지 않았다.
//
// 점진 푸아송 원반 표본(progressive dart throwing):
//   - 반경을 r0 > r1 > … (비 shrink, 기본 0.9) 로 줄여 가며 탐욕 수락 패스를 돈다. 패스 i 는 아직 고르지 않은 점을 방문 순서로 훑고,
//     지금까지 수락한 모든 점(앞 패스 포함)과 거리가 모두 r_i 이상이면 수락한다. 그래서 앞 패스 점들 사이 최소 거리는 그 패스의 반경 이상이다.
//   - 이웃 검사는 칸 크기 r_i 의 복셀 해시 격자(열린 주소법, 가까운 칸부터 3×3×3)로 한다.
//   - 방문 순서는 모턴 순을 4096 점 블록으로 나눠 블록 안에서만 고정 시드로 섞은 것이다(해시 표 접근의 캐시 지역성 + 블록 안 무작위성).
//   - select(k): 누적 수락 수가 k 이상이 될 때까지 패스를 늘린다(필요할 때만, 결과는 보관). 마지막 패스 p 를 빼고 앞 패스는 전부 쓰고,
//     패스 p 의 수락점(수락 순서 = 대략 모턴 순)에서 등간격으로 모자란 수만큼 뽑는다 → 덜 뽑힌 자리가 공간에 고르게 흩어진다.
//   - 수락 0 인 패스는 기록하지 않고 반경만 더 줄인다(격자·양자화 좌표에서는 반경이 줄어도 실제 조건이 같아 수락 0 인 패스가 정상으로 생긴다).
//     수락 0 패스에서는 수락점 집합이 패스 동안 바뀌지 않으므로, 거절점마다 가장 가까운 수락점 거리를 구해 그 최댓값 d* 를 정확히 안다.
//     다음 반경은 min(r·shrink, d*·(1 − 1e-9)) 이다. d* 를 이룬 점은 그 반경에서 반드시 수락되므로 수락 0 패스는 연달아 생기지 않는다
//     (수락점과 아주 가까운 근접 중복점이 남아도 반경을 그 거리 아래로 한 번에 내린다, F-593).
//     남은 점을 방문 순서로 한꺼번에 받는 마지막 패스(반경 0)는 반경이 span·1e-9 아래로 내려갔을 때(d* = 0, 즉 남은 점이 모두 수락점과
//     같은 위치인 경우 포함)만 만든다.
//   - 첫 반경은 표면 가정(m ≈ span²/r² 근처)으로 kHint·firstFraction 을 수락하도록 잡는다. 첫 패스가 그 2배를 넘게 수락하면(체적형·촘촘한 격자)
//     반경을 키워 첫 패스를 다시 돈다. 키우는 상한은 체적 가정(m ≈ span³/r³) 반경이다. 다시 돌 패스는 2배를 넘는 순간 멈추고, 방문한 비율로
//     전체 수락 수를 어림해 반경을 키운다(끝까지 돌지 않아 체적 입력의 첫 select 가 빨라진다). 첫 패스보다 작은 k 는 첫 패스에서 등간격으로 뽑는다.
//   - 칸 해시 표는 패스 동안만 쓰고 ensure 가 끝나면 놓는다(다음 패스는 어차피 칸 크기를 바꿔 다시 짓는다). 찼을 때는 2배로 키운다.
//   - 고른 색인은 모턴 순(server/codec/order)으로 돌려준다(codec 1 차분이 작아진다). 점을 만들거나 옮기지 않는다.
//   - 결정적이다: 같은 입력에서 같은 k 를 처음 묻든 나중에 묻든 같은 결과가 나오도록 첫 반경은 생성 시(positions 만으로) 정한다.
// 장면 속성(위치)만 쓰며 시점 정보는 쓰지 않는다.

import { mortonOrder } from '../../codec/order/index.mjs';

const BLOCK = 4096;

/** 칸 좌표 해시(곱 섞기 뒤 마무리 섞기로 하위 비트를 고르게). */
function cellHash(x, y, z) {
  let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(z, 0xc2b2ae3d);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  return h;
}

// 가까운 칸부터 검사(같은 칸에서 대부분 거절된다).
const OFFS = [];
for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) OFFS.push([dx, dy, dz]);
OFFS.sort((a, b) => a[0] ** 2 + a[1] ** 2 + a[2] ** 2 - (b[0] ** 2 + b[1] ** 2 + b[2] ** 2));
const OX = Int32Array.from(OFFS, (o) => o[0]);
const OY = Int32Array.from(OFFS, (o) => o[1]);
const OZ = Int32Array.from(OFFS, (o) => o[2]);

/** 칸 해시 표(칸마다 수락점 연결 목록). 부하 0.5 를 넘으면 부르는 쪽이 두 배 용량으로 다시 짓는다. */
class CellTable {
  constructor(n, capHint) {
    this.next = new Int32Array(n); // 수락점(방문 칸 번호) → 같은 칸의 다음 수락점
    this.alloc(Math.max(1024, capHint));
  }
  alloc(minCap) {
    let cap = 1;
    while (cap < 2 * minCap) cap <<= 1;
    this.cap = cap; this.mask = cap - 1; this.used = 0;
    this.kx = new Int32Array(cap); this.ky = new Int32Array(cap); this.kz = new Int32Array(cap);
    this.head = new Int32Array(cap).fill(-1);
  }
  slot(cx, cy, cz) {
    const { head, kx, ky, kz, mask } = this;
    let h = cellHash(cx, cy, cz) & mask;
    while (head[h] !== -1 && !(kx[h] === cx && ky[h] === cy && kz[h] === cz)) h = (h + 1) & mask;
    return h;
  }
  insert(j, cx, cy, cz) {
    let h = this.slot(cx, cy, cz);
    if (this.head[h] === -1) {
      if (2 * (this.used + 1) > this.cap) return false;
      this.used++;
      this.kx[h] = cx; this.ky[h] = cy; this.kz[h] = cz;
    }
    this.next[j] = this.head[h];
    this.head[h] = j;
    return true;
  }
}

/** shrink 상한. 1 에 가까우면 수락이 있는 패스도 몇 점씩만 받아 O(n) 패스가 끝없이 늘어나므로 막는다. */
export const MAX_SHRINK = 0.99;

/**
 * @param {Float32Array} positions  길이 3n
 * @param {object} [_attrs]  쓰지 않는다(계약 호환)
 * @param {{seed?:number, shrink?:number, firstFraction?:number, kHint?:number}} [opts]
 *   shrink: 패스마다 반경에 곱하는 비, (0, MAX_SHRINK = 0.99]
 *   firstFraction: 첫 패스가 수락할 kHint 의 비율, (0, 1]
 *   kHint: 첫 반경을 정할 기준 점 수(기본 n·0.13, 결과가 첫 요청 순서에 좌우되지 않도록 생성 시 고정), 0 보다 큰 유한수
 *   범위를 벗어나거나 NaN 이면 RangeError.
 * @returns {{count:number, select(k:number): Uint32Array, stats():object}}
 *   stats(): { passes, radii, passEnd, zeroPasses(지금까지 돈 수락 0 패스 수, 기록하지 않은 패스) }
 *
 * 수명·비용(실측: node 22, 4 vCPU 컨테이너, ArrayBuffer 사용량 기준):
 *   상주 — 반환한 객체는 버릴 때까지 positions 와 별도로 점당 37 B(방문 순서 좌표 Float64 ×3, 모턴 순·방문 순·수락 순 Uint32 ×3,
 *   수락 표시 Uint8)와 보관한 결과(최근 2개 k, k 당 4k B)를 상주시킨다. 250만 점 균일 체적에서 k = 50% 를 고른 뒤 약 98 MB(점당 39 B).
 *   일시 — 패스 동안만 칸 해시 표(칸 연결 Int32 n 개 + 수락 칸 수의 2~8배 슬롯 × 16 B)를, select 마다 Uint8Array(n) 를 쓰고 놓는다.
 *   시간 — 첫 select 는 bbox·모턴 정렬과 첫 패스를, 더 큰 k 의 select 는 모자란 패스를 동기로 돈다(패스마다 O(n)).
 *   250만 점 균일 체적: 13% 첫 select 약 4.5 s(정렬 약 0.8 s + 패스 6번, 그중 2번은 중간에 멈춘 재시도), 50% 첫 select 약 12 s.
 *   1 cm 평면 400×400: select(n − 1) 약 0.6 s. 같은 평면 + x 로 3 µm 옮긴 사본(32만 점): select(200000) 약 1.0~1.2 s.
 * 결과는 최근 2개 k 만 보관한다(같은 k 를 다시 물으면 사본만 만든다).
 */
export function createBlueNoiseThinner(positions, _attrs, opts = {}) {
  if (!(positions instanceof Float32Array) || positions.length % 3 !== 0) throw new TypeError('positions 는 길이 3n 의 Float32Array');
  const n = positions.length / 3;
  const seed = opts.seed ?? 0x2545f491;
  const shrink = opts.shrink ?? 0.9;
  const firstFraction = opts.firstFraction ?? 0.35;
  if (!(shrink > 0 && shrink <= MAX_SHRINK)) throw new RangeError(`shrink 는 (0, ${MAX_SHRINK}]: ${shrink}`);
  if (!(firstFraction > 0 && firstFraction <= 1)) throw new RangeError(`firstFraction 은 (0, 1]: ${firstFraction}`);
  if (opts.kHint !== undefined && !(opts.kHint > 0 && Number.isFinite(opts.kHint))) throw new RangeError(`kHint 는 0 보다 큰 유한수: ${opts.kHint}`);
  const kHint = Math.max(1, Math.round(opts.kHint ?? n * 0.13));

  let order = null; // 모턴 순 원본 색인
  let visit = null; // 방문 칸 j → 원본 색인
  let px = null, py = null, pz = null; // 방문 순서로 늘어놓은 좌표(bbox 최소 기준)
  let span = 0;
  const prepare = () => {
    if (order) return;
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
    span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const scale = span > 0 ? 65535 / span : 0;
    const q = [new Uint16Array(n), new Uint16Array(n), new Uint16Array(n)];
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < 3; a++) q[a][i] = Math.min(65535, Math.floor((positions[3 * i + a] - min[a]) * scale));
    }
    order = mortonOrder(q[0], q[1], q[2]);
    visit = order.slice();
    let s = seed >>> 0 || 1;
    for (let b = 0; b < n; b += BLOCK) {
      const e = Math.min(n, b + BLOCK);
      for (let i = e - 1; i > b; i--) {
        s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
        const j = b + (s % (i - b + 1));
        const t = visit[i]; visit[i] = visit[j]; visit[j] = t;
      }
    }
    px = new Float64Array(n); py = new Float64Array(n); pz = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      const i = visit[j];
      px[j] = positions[3 * i] - min[0]; py[j] = positions[3 * i + 1] - min[1]; pz[j] = positions[3 * i + 2] - min[2];
    }
  };

  // 점진 패스 상태
  const taken = new Uint8Array(n); // 방문 칸 j 가 수락됐는가
  const accepted = new Uint32Array(n); // 수락 순서대로 방문 칸 번호
  const passEnd = []; // 패스 i 까지의 누적 수락 수
  const radii = [];
  let total = 0;
  let table = null;
  let zeroPasses = 0;
  let zeroRun = 0; // 지금 이어지는 수락 0 패스 수
  let maxConsecutiveZeroPasses = 0; // 연달아 돈 수락 0 패스의 최대(수락 있는 패스가 끼면 끊긴다)
  let lastDStar = 0; // 마지막 runPass 가 수락 0 이었을 때: 남은 점의 가장 가까운 수락점 거리 최댓값 d*
  let lastVisited = 0; // 마지막 runPass 가 훑은 방문 칸 수(중간에 멈췄으면 그 자리까지)

  /**
   * 반경 r 로 한 패스를 돌고 이번에 수락한 수를 돌려준다(기록은 부르는 쪽이 한다). 끝나면 표는 칸 크기 r 로 모든 수락점을 담는다.
   * 이번 패스 수락이 stopAbove 를 넘으면 그 자리에서 멈춘다(첫 패스 재시도 어림용).
   * 이번 패스에서 아직 수락이 없는 동안에는 거절점의 가장 가까운 수락점 거리를 구해 최댓값을 lastDStar 에 둔다. 그때까지의 최댓값 이하인
   * 거리를 찾은 점은 최댓값을 바꿀 수 없으므로 거기서 그친다(최댓값은 그대로 정확하다).
   * 패스가 수락 0 으로 끝나면 그동안 수락점 집합이 그대로였으므로 이 값은 남은 점 전체에 대한 정확한 d* 이다.
   * (가장 가까운 수락점이 r 안에 있으면 칸 크기 r 의 3×3×3 칸 안에 있으므로 27 칸만 보면 된다.)
   */
  const runPass = (r, stopAbove = Infinity) => {
    const before = total;
    const inv = 1 / r;
    const r2 = r * r;
    const build = (capHint) => {
      table = new CellTable(n, capHint);
      for (let a = 0; a < total; a++) {
        const t = accepted[a];
        table.insert(t, Math.floor(px[t] * inv), Math.floor(py[t] * inv), Math.floor(pz[t] * inv));
      }
    };
    build(Math.max(2 * total, 4096));
    let dStar2 = 0;
    let j = 0;
    for (; j < n; j++) {
      if (taken[j]) continue;
      const x = px[j], y = py[j], z = pz[j];
      const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
      // 이번 패스 첫 수락 전(full)이면 가장 가까운 거리를 구한다. 다만 지금까지의 d*² 이하인 거리를 하나라도 찾으면 이 점은
      // 최댓값을 키울 수 없고(d*² < r² 라 거절도 확정) 더 볼 필요가 없다. 수락이 생긴 뒤에는 r² 안의 점 하나로 거절한다.
      const lim2 = total === before ? dStar2 : r2;
      const strict = total !== before;
      let best = Infinity;
      let stop = false;
      const { head, kx, ky, kz, mask, next } = table;
      for (let q = 0; q < 27 && !stop; q++) {
        const xx = cx + OX[q], yy = cy + OY[q], zz = cz + OZ[q];
        let h = cellHash(xx, yy, zz) & mask;
        while (head[h] !== -1 && !(kx[h] === xx && ky[h] === yy && kz[h] === zz)) h = (h + 1) & mask;
        for (let t = head[h]; t !== -1; t = next[t]) {
          const ex = px[t] - x, ey = py[t] - y, ez = pz[t] - z;
          const d2 = ex * ex + ey * ey + ez * ez;
          if (d2 < best) {
            best = d2;
            if (strict ? d2 < lim2 : d2 <= lim2) { stop = true; break; }
          }
        }
      }
      if (best < r2) { if (!strict && best > dStar2) dStar2 = best; continue; }
      taken[j] = 1;
      accepted[total++] = j;
      if (!table.insert(j, cx, cy, cz)) build(table.cap); // 표가 찼다: 2배 용량으로 다시 짓는다(방금 점 포함)
      if (total - before > stopAbove) { j++; break; }
    }
    lastVisited = j;
    lastDStar = Math.sqrt(dStar2);
    return total - before;
  };

  /** 남은 점을 방문 순서로 한 패스(반경 0)에 다 넣는다. */
  const takeRest = () => {
    for (let j = 0; j < n; j++) if (!taken[j]) { taken[j] = 1; accepted[total++] = j; }
    radii.push(0); passEnd.push(total);
  };

  let rCur = 0; // 마지막으로 돈 패스의 반경(수락 0 이라 기록하지 않은 패스 포함)
  let rJump = Infinity; // 수락 0 패스 뒤 다음 반경 상한 d*·(1 − 1e-9)
  const ensure = (k) => {
    if (passEnd.length === 0) {
      if (!(span > 0)) { takeRest(); return; }
      // 표면 가정: 반경 r 에서 수락 수 ≈ (span/r)²(대략). 첫 패스가 kHint 의 firstFraction 쯤 수락하도록 잡는다.
      // 그 2배를 넘게 수락하면 반경을 키워 다시 돈다. 수락 수 ∝ r^-d(d = 2..3)로 보고 d = 3 쪽으로 키우며, 체적 가정 반경에서 멈춘다.
      const target = kHint * firstFraction;
      const rVol = span / Math.cbrt(target);
      let r = span / Math.sqrt(target);
      for (;;) {
        // 체적 가정 반경보다 작으면 2배를 넘는 순간 멈춘다(어차피 다시 돈다).
        const got = runPass(r, r < rVol ? 2 * target : Infinity);
        if (got <= 2 * target || r >= rVol) break;
        // 방문 순서는 모턴 블록 순이라 앞부분은 공간의 한 조각이다: 훑은 비율로 전체 수락 수를 어림한다.
        const est = (got * n) / Math.max(1, lastVisited);
        for (let a = 0; a < total; a++) taken[accepted[a]] = 0;
        total = 0;
        r = Math.min(rVol, r * Math.max(1 / shrink, Math.cbrt(est / target)));
      }
      rCur = r;
      radii.push(r); passEnd.push(total);
    }
    while (total < k) {
      rCur = Math.min(rCur * shrink, rJump);
      rJump = Infinity;
      if (rCur < span * 1e-9) { takeRest(); break; }
      if (runPass(rCur) > 0) { radii.push(rCur); passEnd.push(total); zeroRun = 0; }
      else {
        // 수락 0: 남은 점 가운데 수락점에서 가장 먼 점(거리 d*)이 다음 패스에서 반드시 수락되도록 반경을 d* 바로 아래로 내린다.
        // d* = 0(남은 점이 모두 수락점과 같은 위치)이면 다음 반복에서 takeRest 로 간다.
        zeroPasses++;
        if (++zeroRun > maxConsecutiveZeroPasses) maxConsecutiveZeroPasses = zeroRun;
        rJump = lastDStar * (1 - 1e-9);
      }
    }
    table = null; // 표는 다음 패스가 칸 크기를 바꿔 다시 짓는다: 상주시키지 않는다
  };

  // 최근 2개 k 의 결과만 보관한다(삽입 순서 = 최근 사용 순서).
  const CACHE_KEEP = 2;
  const cache = new Map();
  return {
    count: n,
    stats: () => ({ passes: radii.length, radii: radii.slice(), passEnd: passEnd.slice(), zeroPasses, maxConsecutiveZeroPasses, cacheSize: cache.size }),
    select(k) {
      if (!Number.isInteger(k) || k < 0) throw new RangeError(`k 는 0 이상 정수: ${k}`);
      prepare();
      if (k >= n) return order.slice();
      if (k === 0) return new Uint32Array(0);
      const hit = cache.get(k);
      if (hit) { cache.delete(k); cache.set(k, hit); return hit.slice(); }
      ensure(k);
      // k 를 넘는 첫 패스 p
      let p = 0;
      while (passEnd[p] < k) p++;
      const start = p === 0 ? 0 : passEnd[p - 1];
      const len = passEnd[p] - start;
      const want = k - start;
      const mark = new Uint8Array(n);
      for (let a = 0; a < start; a++) mark[visit[accepted[a]]] = 1;
      for (let j = 0; j < want; j++) mark[visit[accepted[start + Math.floor(((j + 0.5) * len) / want)]]] = 1;
      const out = new Uint32Array(k);
      let o = 0;
      for (let i = 0; i < n; i++) { const s = order[i]; if (mark[s]) out[o++] = s; }
      cache.set(k, out);
      if (cache.size > CACHE_KEEP) cache.delete(cache.keys().next().value);
      return out.slice();
    },
  };
}

/** 계약용 공장: createThinner(positions, attrs) */
export function createThinner(positions, attrs) {
  return createBlueNoiseThinner(positions, attrs);
}
