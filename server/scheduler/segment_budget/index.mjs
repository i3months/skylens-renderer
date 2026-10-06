// 구간 송출 바이트 예산(T13.B, SPEC S6 구간당 ≤ 3 MB). 새로 작성한 코드이며 외부 코드를 차용하지 않았다.
//
// 한 구간의 4수준 송출 바이트 합이 maxBytes 를 넘으면 수준마다 원본 점의 부분집합만 보낸다(점 예산).
//   - 점을 새로 만들거나 옮기거나 메우지 않는다. 고른 점의 위치·법선·색은 원본 그대로다(RULES §1.2, renderer_basis §7-3).
//   - 수준 사이 관계를 가정하지 않는다: 각 수준은 자기 점군에서 따로 고른다(낮은 수준이 높은 수준의 부분집합일 필요 없음).
//     송출 단위는 여전히 수준 하나 전체이며 교체·건너뛰기 규칙(RULES §1.1)은 바뀌지 않는다.
//   - 수준별 점 수는 원본 수준 점 수에 비례해 나눈다(수준 사이 점 수 비를 유지, 각 수준 최소 1 점).
//   - 고르는 방식은 공간 균일 솎기: 점을 모턴 순(server/codec/order)으로 늘어놓고 등간격으로 뽑는다. 결정적이다.
//     고른 색인은 모턴 순 그대로 돌려준다. 호출자가 이 순서로 조각(최대 점 수 단위)을 자르면 조각 하나가 공간적으로 모여
//     codec 1 차분이 작아진다(합성 250만 점 구간에서 같은 점 수 기준 약 5.3 → 4.7 B/점, 실험 노트 t13b-s6).
//
// 바이트는 호출자가 실제 송출 경로(조각 분할·부호화·프레임)로 재서 돌려준다(measure 콜백). 이 모듈은 숫자를 추정하지 않고,
// 돌려받은 실제 바이트가 maxBytes 이하인 구성만 결과로 낸다.

import { mortonOrder } from '../../codec/order/index.mjs';

/**
 * 점군 위치(Float32Array 3n)로 공간 균일 솎기 도구를 만든다. 모턴 순은 한 번만 계산한다.
 * 양자화는 점군 bbox 의 가장 긴 변을 65535 칸으로 나눈 등방 격자다(축마다 같은 칸 크기).
 * @param {Float32Array} positions
 * @returns {{count:number, select(k:number): Uint32Array}}  select 는 고른 원본 색인을 모턴 순으로 돌려준다(k ≥ count 이면 전부)
 */
export function createSpatialThinner(positions) {
  if (!(positions instanceof Float32Array) || positions.length % 3 !== 0) throw new TypeError('positions 는 길이 3n 의 Float32Array');
  const n = positions.length / 3;
  let order = null;
  const ensureOrder = () => {
    if (order) return order;
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
    const scale = span > 0 ? 65535 / span : 0;
    const q = [new Uint16Array(n), new Uint16Array(n), new Uint16Array(n)];
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < 3; a++) q[a][i] = Math.min(65535, Math.floor((positions[3 * i + a] - min[a]) * scale));
    }
    order = mortonOrder(q[0], q[1], q[2]);
    return order;
  };
  return {
    count: n,
    select(k) {
      if (!Number.isInteger(k) || k < 0) throw new RangeError(`k 는 0 이상 정수: ${k}`);
      const ord = ensureOrder();
      if (k >= n) return ord.slice();
      const out = new Uint32Array(k);
      for (let j = 0; j < k; j++) out[j] = ord[Math.floor((j * n) / k)];
      return out;
    },
  };
}

/**
 * 구간 전체 점 예산 total 을 수준별로 나눈다. 원본 수준 점 수 counts 에 비례(내림), 각 수준 최소 1, 원본 수 이하, 합은 total 이하.
 * total 이 원본 합 이상이면 counts 그대로다.
 * @param {number[]} counts  수준별 원본 점 수(1 이상 정수)
 * @param {number} total     구간 점 예산(수준 수 이상 정수)
 * @returns {number[]}
 */
export function levelPointTargets(counts, total) {
  if (!Array.isArray(counts) || counts.length < 1 || !counts.every((c) => Number.isInteger(c) && c >= 1)) {
    throw new RangeError('counts 는 1 이상 정수 배열');
  }
  if (!Number.isInteger(total) || total < counts.length) throw new RangeError(`total 은 수준 수(${counts.length}) 이상 정수: ${total}`);
  const sum = counts.reduce((s, c) => s + c, 0);
  if (total >= sum) return counts.slice();
  const out = counts.map((c) => Math.min(c, Math.max(1, Math.floor((total * c) / sum))));
  // 최소 1 보정으로 합이 total 을 넘을 수 있다(예: [1000000,1,1,1], 4 → 합 6). 넘친 만큼 큰 수준부터 1 까지 덜어 합 ≤ total 을 지킨다.
  let excess = out.reduce((s, t) => s + t, 0) - total;
  if (excess > 0) {
    const byDesc = out.map((_, i) => i).sort((a, b) => out[b] - out[a] || a - b);
    for (const i of byDesc) {
      const cut = Math.min(excess, out[i] - 1);
      out[i] -= cut;
      excess -= cut;
      if (excess === 0) break;
    }
  }
  return out;
}

/**
 * 수준별 점 배분(T13.T, 결정 0065): 최고 수준(마지막)을 뺀 낮은 수준은 원본의 frac 만 보장하고 남는 예산을 최고 수준에 준다.
 * 정상 상태에 보이는 수준이 최고 수준이라 화질(8시점 SSIM)에 유리하다. 최고 수준이 원본에 닿으면 남는 예산은 낮은 수준에 돌린다.
 * @param {number|number[]} frac  낮은 수준 보장 비율(수) 또는 수준별 비율(길이 = 수준 수 - 1)
 * @returns {(counts:number[], total:number) => number[]}
 */
export function makeFloorAllocate(frac) {
  return (counts, total) => {
    if (!Array.isArray(counts) || counts.length < 1 || !counts.every((c) => Number.isInteger(c) && c >= 1)) throw new RangeError('counts 는 1 이상 정수 배열');
    if (!Number.isInteger(total) || total < counts.length) throw new RangeError(`total 은 수준 수 이상 정수: ${total}`);
    const n = counts.length;
    const sum = counts.reduce((s, c) => s + c, 0);
    if (total >= sum) return counts.slice();
    const top = n - 1;
    const f = (i) => (Array.isArray(frac) ? frac[i] ?? frac[frac.length - 1] : frac);
    const out = counts.map((c, i) => (i === top ? 1 : Math.min(c, Math.max(1, Math.floor(c * f(i))))));
    // 보장 합이 total 을 넘으면 비례로 줄인다(최소 1).
    let low = out.slice(0, top).reduce((s, t) => s + t, 0);
    if (low + 1 > total) {
      const room = Math.max(0, total - 1);
      for (let i = 0; i < top; i++) out[i] = Math.max(1, Math.floor((out[i] * room) / low));
      low = out.slice(0, top).reduce((s, t) => s + t, 0);
      let ex = low + 1 - total;
      for (let i = top - 1; i >= 0 && ex > 0; i--) { const c = Math.min(ex, out[i] - 1); out[i] -= c; ex -= c; }
    }
    out[top] = Math.min(counts[top], total - out.slice(0, top).reduce((s, t) => s + t, 0));
    // 최고 수준이 원본에 닿아 남은 예산은 낮은 수준에 빈 만큼 채운다(낮은 수준 큰 쪽부터 아닌 낮은 번호부터).
    let rest = total - out.reduce((s, t) => s + t, 0);
    for (let i = 0; i < top && rest > 0; i++) { const add = Math.min(rest, counts[i] - out[i]); out[i] += add; rest -= add; }
    return out;
  };
}

// S6 송출 구성의 낮은 수준 보장 비율(결정 0065): 수준 0..2 는 원본의 2%(250만 점 구간에서 6,250 / 12,500 / 25,000 점).
export const S6_LOW_LEVEL_FLOOR = 0.02;

/**
 * 구간 송출 바이트가 maxBytes 이하가 되는 가장 큰(찾은 범위에서) 점 예산을 고른다.
 * measure(targets) 는 수준별 점 수 targets 로 실제 송출 경로를 돌려 구간 바이트 합(정수)을 돌려줘야 한다.
 * 절차: 원본 그대로가 맞으면 끝. 아니면 초기 추정 점 예산에서 시작해 실제 바이트 비로 예산을 고치고(안전 계수 safety),
 *       maxBytes 이하이면서 tolerance 안(≥ (1-tolerance)·maxBytes)이면 멈춘다. maxIter 안에 못 맞추면 그때까지 맞은 것 중
 *       가장 큰 예산을 쓰고, 맞은 것이 하나도 없으면 예산을 줄여 가며 맞을 때까지 잰다.
 * @param {{counts:number[], maxBytes:number, measure:(targets:number[]) => number,
 *   bytesPerPointGuess?:number, safety?:number, tolerance?:number, maxIter?:number,
 *   allocate?:(counts:number[], total:number) => number[]}} opts  allocate 는 구간 점 예산을 수준별로 나누는 함수(기본 levelPointTargets)
 * @returns {{budgetPoints:number, targets:number[], bytes:number, thinned:boolean, tries:{points:number, bytes:number}[]}}
 */
export function fitSegmentBudget(opts) {
  const { counts, maxBytes, measure } = opts;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError(`maxBytes 는 1 이상 정수: ${maxBytes}`);
  if (typeof measure !== 'function') throw new TypeError('measure 는 함수');
  const safety = opts.safety ?? 0.98;
  const tolerance = opts.tolerance ?? 0.05;
  if (!(safety > 0 && safety <= 1)) throw new RangeError(`safety 는 (0, 1]: ${safety}`);
  if (!(tolerance >= 0 && tolerance < 1)) throw new RangeError(`tolerance 는 [0, 1): ${tolerance}`);
  const maxIter = opts.maxIter ?? 6;
  const guess = opts.bytesPerPointGuess ?? 5;
  if (!Number.isInteger(maxIter) || maxIter < 1) throw new RangeError(`maxIter 는 1 이상 정수: ${maxIter}`);
  if (!(Number.isFinite(guess) && guess > 0)) throw new RangeError(`bytesPerPointGuess 는 0 보다 큰 유한수: ${guess}`);
  levelPointTargets(counts, counts.length); // counts 검사
  const sum = counts.reduce((s, c) => s + c, 0);
  const tries = [];
  const run = (points) => {
    const targets = (opts.allocate ?? levelPointTargets)(counts, points);
    const bytes = measure(targets);
    if (!Number.isInteger(bytes) || bytes < 0) throw new TypeError(`measure 는 0 이상 정수를 돌려줘야 한다: ${bytes}`);
    tries.push({ points, bytes });
    return { budgetPoints: points, targets, bytes };
  };
  const finish = (r) => ({ ...r, thinned: r.budgetPoints < sum, tries });

  let points = Math.min(sum, Math.max(counts.length, Math.floor(maxBytes / guess)));
  if (points >= sum) {
    const full = run(sum);
    if (full.bytes <= maxBytes) return finish(full);
    points = Math.max(counts.length, Math.floor((sum * maxBytes * safety) / full.bytes));
  }
  let best = null;
  for (let it = 0; it < maxIter; it++) {
    const r = run(points);
    if (r.bytes <= maxBytes) {
      if (!best || r.budgetPoints > best.budgetPoints) best = r;
      if (r.bytes >= (1 - tolerance) * maxBytes || points >= sum) break;
    }
    const next = Math.min(sum, Math.max(counts.length, Math.floor((points * maxBytes * safety) / Math.max(1, r.bytes))));
    if (next === points || tries.some((t) => t.points === next)) break;
    points = next;
  }
  if (best) return finish(best);
  // 맞는 구성을 아직 못 찾았다: 맞을 때까지 줄인다. 수준마다 1 점(최소 구성)도 넘으면 그 사실을 던진다.
  for (points = Math.floor(Math.min(...tries.map((t) => t.points)) * 0.9); ; points = Math.floor(points * 0.9)) {
    points = Math.max(counts.length, points);
    const r = run(points);
    if (r.bytes <= maxBytes) return finish(r);
    if (points === counts.length) throw new RangeError(`최소 구성(수준마다 1 점)도 ${r.bytes} B > maxBytes ${maxBytes}`);
  }
}
