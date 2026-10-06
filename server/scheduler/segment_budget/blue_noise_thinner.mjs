// T13.T 푸아송 원반 근사(블루노이즈) 솎기(결정 0065). 새로 작성한 코드이며 외부 코드를 차용하지 않았다.
//
// 점진 푸아송 원반 표본(progressive dart throwing):
//   - 반경을 r0 > r1 > … (비 shrink, 기본 0.9) 로 줄여 가며 탐욕 수락 패스를 돈다. 패스 i 는 아직 고르지 않은 점을 방문 순서로 훑고,
//     지금까지 수락한 모든 점(앞 패스 포함)과 거리가 모두 r_i 이상이면 수락한다. 그래서 앞 패스 점들 사이 최소 거리는 그 패스의 반경 이상이다.
//   - 이웃 검사는 칸 크기 r_i 의 복셀 해시 격자(열린 주소법, 가까운 칸부터 3×3×3)로 한다.
//   - 방문 순서는 모턴 순을 4096 점 블록으로 나눠 블록 안에서만 고정 시드로 섞은 것이다(해시 표 접근의 캐시 지역성 + 블록 안 무작위성).
//   - select(k): 누적 수락 수가 k 이상이 될 때까지 패스를 늘린다(필요할 때만, 결과는 보관). 마지막 패스 p 를 빼고 앞 패스는 전부 쓰고,
//     패스 p 의 수락점(수락 순서 = 대략 모턴 순)에서 등간격으로 모자란 수만큼 뽑는다 → 덜 뽑힌 자리가 공간에 고르게 흩어진다.
//   - 첫 반경은 표면 가정(m ≈ span²/r² 근처)으로 첫 요청 k 의 약 절반을 수락하도록 잡는다. 첫 패스보다 작은 k 는 첫 패스에서 등간격으로 뽑는다.
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

/** 칸 해시 표(칸마다 수락점 연결 목록). 부하 0.5 를 넘으면 두 배로 키운다. */
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

/**
 * @param {Float32Array} positions  길이 3n
 * @param {object} [_attrs]  쓰지 않는다(계약 호환)
 * @param {{seed?:number, shrink?:number, firstFraction?:number, kHint?:number}} [opts]
 *   kHint: 첫 반경을 정할 기준 점 수(기본 n·0.13, 결과가 첫 요청 순서에 좌우되지 않도록 생성 시 고정)
 * @returns {{count:number, select(k:number): Uint32Array, stats():object}}
 */
export function createBlueNoiseThinner(positions, _attrs, opts = {}) {
  if (!(positions instanceof Float32Array) || positions.length % 3 !== 0) throw new TypeError('positions 는 길이 3n 의 Float32Array');
  const n = positions.length / 3;
  const seed = opts.seed ?? 0x2545f491;
  const shrink = opts.shrink ?? 0.9;
  const firstFraction = opts.firstFraction ?? 0.35;
  const kHint = Math.max(1, Math.round(opts.kHint ?? n * 0.13));
  if (!(shrink > 0 && shrink < 1)) throw new RangeError(`shrink 는 (0, 1): ${shrink}`);

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

  const runPass = (r) => {
    const inv = 1 / r;
    const r2 = r * r;
    const build = (capHint) => {
      if (!table) table = new CellTable(n, capHint);
      else table.alloc(capHint);
      for (let a = 0; a < total; a++) {
        const t = accepted[a];
        table.insert(t, Math.floor(px[t] * inv), Math.floor(py[t] * inv), Math.floor(pz[t] * inv));
      }
    };
    build(Math.max(2 * total, 4096));
    for (let j = 0; j < n; j++) {
      if (taken[j]) continue;
      const x = px[j], y = py[j], z = pz[j];
      const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
      let ok = true;
      const { head, kx, ky, kz, mask, next } = table;
      for (let q = 0; q < 27 && ok; q++) {
        const xx = cx + OX[q], yy = cy + OY[q], zz = cz + OZ[q];
        let h = cellHash(xx, yy, zz) & mask;
        while (head[h] !== -1 && !(kx[h] === xx && ky[h] === yy && kz[h] === zz)) h = (h + 1) & mask;
        for (let t = head[h]; t !== -1; t = next[t]) {
          const ex = px[t] - x, ey = py[t] - y, ez = pz[t] - z;
          if (ex * ex + ey * ey + ez * ez < r2) { ok = false; break; }
        }
      }
      if (!ok) continue;
      taken[j] = 1;
      accepted[total++] = j;
      if (!table.insert(j, cx, cy, cz)) build(4 * table.cap); // 표가 찼다: 키워서 다시 넣는다(방금 점 포함)
    }
    radii.push(r);
    passEnd.push(total);
  };

  const ensure = (k) => {
    if (passEnd.length === 0) {
      // 표면 가정: 반경 r 에서 수락 수 ≈ (span/r)²(대략). 첫 패스가 kHint 의 firstFraction 쯤 수락하도록 잡는다.
      const r0 = span > 0 ? span / Math.sqrt(kHint * firstFraction) : 0;
      if (r0 > 0) runPass(r0);
      else { for (let j = 0; j < n; j++) accepted[j] = j; total = n; radii.push(0); passEnd.push(n); }
    }
    while (total < k) {
      const prevTotal = total;
      runPass(radii[radii.length - 1] * shrink);
      // 반경이 아주 작아져 늘지 않으면(중복점 등) 남은 점을 방문 순서로 한 패스에 다 넣는다.
      if (total === prevTotal || radii[radii.length - 1] < span * 1e-9) {
        for (let j = 0; j < n; j++) if (!taken[j]) { taken[j] = 1; accepted[total++] = j; }
        radii.push(0); passEnd.push(total);
      }
    }
  };

  const cache = new Map();
  return {
    count: n,
    stats: () => ({ passes: radii.length, radii: radii.slice(), passEnd: passEnd.slice() }),
    select(k) {
      if (!Number.isInteger(k) || k < 0) throw new RangeError(`k 는 0 이상 정수: ${k}`);
      prepare();
      if (k >= n) return order.slice();
      if (k === 0) return new Uint32Array(0);
      const hit = cache.get(k);
      if (hit) return hit.slice();
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
      return out.slice();
    },
  };
}

/** 계약용 공장: createThinner(positions, attrs) */
export function createThinner(positions, attrs) {
  return createBlueNoiseThinner(positions, attrs);
}
