// T13.T 후보 6: 모턴 등간격 솎기의 변형 세 가지. 새로 작성한 코드이며 외부 코드를 차용하지 않았다.
//   'jitter'  : 모턴 순을 k 개 구간으로 나누고 구간 안에서 결정적 의사난수 위치 하나를 뽑는다(층화 지터).
//   'hilbert' : 힐베르트 순(축당 10 비트)으로 늘어놓고 등간격으로 뽑는다.
//   'coarse'  : 모턴 키를 축당 coarseBits 비트로 줄인 거친 순서(같은 칸 안은 원래 색인 순)로 등간격 뽑는다.
// 어느 변형이든 고른 점은 원본의 부분집합이고, 돌려주는 색인은 항상 전체 모턴 순으로 정렬한다(codec 1 차분 유리, 정렬 비용 포함).
import { mortonOrder } from '../../codec/order/index.mjs';

const MAX_N = 1 << 23; // 거친/힐베르트 키 = 30 비트 키 * 2^23 + 색인 이 2^53 안에 들어가는 한계

function quantize(positions, n, bits) {
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
  const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const top = (1 << bits) - 1;
  const scale = span > 0 ? top / span : 0;
  const q = [new Uint16Array(n), new Uint16Array(n), new Uint16Array(n)];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) q[a][i] = Math.min(top, Math.floor((positions[3 * i + a] - min[a]) * scale));
  return q;
}

/** 3 차원 힐베르트 키(축당 b 비트, 결과 3b 비트). 좌표 변환 후 비트를 교차해 합친다. */
function hilbertKey(x0, x1, x2, b) {
  const X = [x0, x1, x2];
  const M = 1 << (b - 1);
  for (let Q = M; Q > 1; Q >>= 1) {
    const P = Q - 1;
    for (let i = 0; i < 3; i++) {
      if (X[i] & Q) X[0] ^= P;
      else { const t = (X[0] ^ X[i]) & P; X[0] ^= t; X[i] ^= t; }
    }
  }
  X[1] ^= X[0];
  X[2] ^= X[1];
  let t = 0;
  for (let Q = M; Q > 1; Q >>= 1) if (X[2] & Q) t ^= Q - 1;
  for (let i = 0; i < 3; i++) X[i] ^= t;
  let key = 0;
  for (let bit = b - 1; bit >= 0; bit--) for (let i = 0; i < 3; i++) key = key * 2 + ((X[i] >>> bit) & 1);
  return key;
}

/** 정수 두 개 → [0,1) 결정적 의사난수(32 비트 섞기). */
function hash01(j, seed) {
  let h = (Math.imul(j, 0x9e3779b1) ^ Math.imul(seed + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * @param {Float32Array} positions
 * @param {{mode?:'jitter'|'hilbert'|'coarse', coarseBits?:number, seed?:number}} [opts]
 * @returns {{count:number, select(k:number): Uint32Array}}  select 는 고른 원본 색인을 전체 모턴 순으로 돌려준다(k ≥ count 이면 전부)
 */
export function createStratThinner(positions, opts = {}) {
  if (!(positions instanceof Float32Array) || positions.length % 3 !== 0) throw new TypeError('positions 는 길이 3n 의 Float32Array');
  const mode = opts.mode ?? 'jitter';
  if (!['jitter', 'hilbert', 'coarse'].includes(mode)) throw new RangeError(`mode: ${mode}`);
  const coarseBits = opts.coarseBits ?? 8;
  const seed = opts.seed ?? 1;
  const n = positions.length / 3;
  if (n >= MAX_N) throw new RangeError(`점 수는 ${MAX_N} 미만`);
  let morton = null; // 전체 모턴 순
  let alt = null; // 등간격으로 뽑는 순서(jitter 는 morton 과 같다)
  let rank = null; // 원본 색인 → 모턴 순 위치
  const ensure = () => {
    if (morton) return;
    const q = quantize(positions, n, 16);
    morton = mortonOrder(q[0], q[1], q[2]);
    if (mode === 'jitter') { alt = morton; return; }
    const bits = mode === 'hilbert' ? 10 : coarseBits;
    const qc = quantize(positions, n, bits);
    const keys = new Float64Array(n);
    if (mode === 'hilbert') {
      for (let i = 0; i < n; i++) keys[i] = hilbertKey(qc[0][i], qc[1][i], qc[2][i], bits);
    } else {
      // 모턴 키를 축당 bits 비트로 줄인 키: 각 축 값을 비트별로 펼쳐 합친다.
      for (let i = 0; i < n; i++) {
        let key = 0;
        for (let bit = bits - 1; bit >= 0; bit--) for (let a = 0; a < 3; a++) key = key * 2 + ((qc[a][i] >>> bit) & 1);
        keys[i] = key;
      }
    }
    for (let i = 0; i < n; i++) keys[i] = keys[i] * MAX_N + i;
    keys.sort();
    alt = new Uint32Array(n);
    for (let i = 0; i < n; i++) alt[i] = keys[i] % MAX_N;
  };
  return {
    count: n,
    select(k) {
      if (!Number.isInteger(k) || k < 0) throw new RangeError(`k 는 0 이상 정수: ${k}`);
      ensure();
      if (k >= n) return morton.slice();
      const out = new Uint32Array(k);
      if (mode === 'jitter') {
        for (let j = 0; j < k; j++) {
          const lo = Math.floor((j * n) / k);
          const hi = Math.floor(((j + 1) * n) / k); // 구간 [lo, hi), 항상 비어 있지 않다(k < n)
          out[j] = morton[lo + Math.min(hi - lo - 1, Math.floor(hash01(j, seed) * (hi - lo)))];
        }
        return out;
      }
      if (!rank) { rank = new Uint32Array(n); for (let p = 0; p < n; p++) rank[morton[p]] = p; }
      for (let j = 0; j < k; j++) out[j] = rank[alt[Math.floor((j * n) / k)]];
      out.sort(); // 모턴 순 위치로 정렬
      for (let j = 0; j < k; j++) out[j] = morton[out[j]];
      return out;
    },
  };
}
