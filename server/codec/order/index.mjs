// T09.4 모턴(Z 순서) 키와 재배치 순열.
// 키 비트 배치: 3i 번 = qe 의 i 번 비트, 3i+1 번 = qn 의 i 번 비트, 3i+2 번 = qu 의 i 번 비트 (i = 0..15).
// JS 비트 연산은 32 비트라서 하위 8 비트씩(→ 24 비트)과 상위 8 비트씩(→ 24 비트)을 따로 만들고
// key = hi * 2^24 + lo 로 합친다. 결과는 0 ≤ key < 2^48 인 정확한 정수(Number, 2^53 미만).
import { CodecError } from '../../../contracts/codec/index.mjs';

const TWO24 = 16777216;

// 8 비트 값 b 의 i 번 비트를 3i 번 위치로 펼친 표(최대 비트 21).
const SPREAD8 = new Uint32Array(256);
for (let b = 0; b < 256; b++) {
  let v = 0;
  for (let i = 0; i < 8; i++) if (b & (1 << i)) v |= 1 << (3 * i);
  SPREAD8[b] = v;
}

/** 0..65535 정수인지 검사한다. 아니면 CodecError('stream'). */
function checkU16(v, what) {
  if (!Number.isInteger(v) || v < 0 || v > 65535) {
    throw new CodecError('stream', `${what} 값이 0..65535 정수가 아니다: ${v}`);
  }
}

/** 하위 24 비트 부분(각 좌표의 0..7 비트). */
function loPart(e, n, u) {
  return (SPREAD8[e & 255] | (SPREAD8[n & 255] << 1) | (SPREAD8[u & 255] << 2)) >>> 0;
}

/** 상위 24 비트 부분(각 좌표의 8..15 비트). */
function hiPart(e, n, u) {
  return (SPREAD8[e >>> 8] | (SPREAD8[n >>> 8] << 1) | (SPREAD8[u >>> 8] << 2)) >>> 0;
}

/**
 * 양자화 좌표 하나의 모턴 키.
 * @param {number} qe @param {number} qn @param {number} qu  각각 0..65535 정수
 * @returns {number} 0 ≤ key < 2^48
 */
export function mortonKey(qe, qn, qu) {
  checkU16(qe, 'qe');
  checkU16(qn, 'qn');
  checkU16(qu, 'qu');
  return hiPart(qe, qn, qu) * TWO24 + loPart(qe, qn, qu);
}

/**
 * 모턴 키 오름차순 정렬 순열. 키가 같으면 원래 인덱스 오름차순(안정 정렬). 결정적.
 * 구현: 상·하 24 비트를 Uint32Array 에 담고 16·8·16·8 비트 자릿수로 LSD 기수 정렬 4 회(안정).
 * @param {Uint16Array} qe @param {Uint16Array} qn @param {Uint16Array} qu  길이 같음
 * @returns {Uint32Array} order[k] = k 번째로 오는 원래 인덱스
 */
export function mortonOrder(qe, qn, qu) {
  if (qe == null || qn == null || qu == null || typeof qe.length !== 'number') {
    throw new CodecError('stream', '입력 배열이 없다');
  }
  const n = qe.length;
  if (qn.length !== n || qu.length !== n) {
    throw new CodecError('stream', `길이 불일치: ${n}, ${qn.length}, ${qu.length}`);
  }
  const lo = new Uint32Array(n);
  const hi = new Uint32Array(n);
  const typed = qe instanceof Uint16Array && qn instanceof Uint16Array && qu instanceof Uint16Array;
  for (let i = 0; i < n; i++) {
    const e = qe[i], nn = qn[i], u = qu[i];
    if (!typed) {
      checkU16(e, 'qe');
      checkU16(nn, 'qn');
      checkU16(u, 'qu');
    }
    lo[i] = loPart(e, nn, u);
    hi[i] = hiPart(e, nn, u);
  }

  let src = new Uint32Array(n);
  for (let i = 0; i < n; i++) src[i] = i;
  if (n < 2) return src;
  let dst = new Uint32Array(n);
  const count = new Uint32Array(65536);

  // (배열, 시프트, 마스크) 순서: lo 하위 16, lo 상위 8, hi 하위 16, hi 상위 8.
  const passes = [
    [lo, 0, 0xffff],
    [lo, 16, 0xff],
    [hi, 0, 0xffff],
    [hi, 16, 0xff],
  ];
  for (const [arr, shift, mask] of passes) {
    count.fill(0, 0, mask + 1);
    for (let i = 0; i < n; i++) count[(arr[src[i]] >>> shift) & mask]++;
    let sum = 0;
    for (let d = 0; d <= mask; d++) {
      const c = count[d];
      count[d] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) {
      const idx = src[i];
      dst[count[(arr[idx] >>> shift) & mask]++] = idx;
    }
    const t = src;
    src = dst;
    dst = t;
  }
  return src;
}
