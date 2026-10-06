// T13.T 후보 1: 수준별 점 배분. 새로 작성한 코드이며 외부 코드를 차용하지 않았다.
// 낮은 수준(마지막 수준 제외)은 원본의 일정 비율 frac(또는 수준별 비율)만 보장하고, 남는 예산을 최고 수준(마지막)에 몰아준다.
// 최고 수준이 원본보다 많이 받을 수 없으면 남는 예산을 낮은 수준에 다시 나눈다. 계약: 합 ≤ total, 각 수준 1 이상 원본 이하.

/**
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

/**
 * 수준 k 에 가중 w^(n-1-k) 를 곱한 원본 비례 배분: 낮은 수준일수록 w(<1)배씩 덜 받는다. w=1 이면 기본(원본 비례)과 같다.
 * @param {number} w  (0, 1]
 */
export function makeWeightedAllocate(w) {
  if (!(w > 0 && w <= 1)) throw new RangeError(`w 는 (0, 1]: ${w}`);
  return (counts, total) => {
    if (!Array.isArray(counts) || counts.length < 1 || !counts.every((c) => Number.isInteger(c) && c >= 1)) throw new RangeError('counts 는 1 이상 정수 배열');
    if (!Number.isInteger(total) || total < counts.length) throw new RangeError(`total 은 수준 수 이상 정수: ${total}`);
    const n = counts.length;
    const sum = counts.reduce((s, c) => s + c, 0);
    if (total >= sum) return counts.slice();
    const out = new Array(n).fill(1);
    const wt = counts.map((c, i) => c * Math.pow(w, n - 1 - i));
    // 상한(원본 수)에 닿는 수준을 고정하고 나머지에 다시 나누는 반복.
    const fixed = new Array(n).fill(false);
    let budget = total;
    for (let it = 0; it < n; it++) {
      const ws = wt.reduce((s, x, i) => (fixed[i] ? s : s + x), 0);
      let hit = false;
      for (let i = 0; i < n; i++) {
        if (fixed[i]) continue;
        const t = Math.floor((budget * wt[i]) / ws);
        if (t >= counts[i]) { out[i] = counts[i]; fixed[i] = true; budget -= counts[i]; hit = true; }
      }
      if (!hit) { for (let i = 0; i < n; i++) if (!fixed[i]) out[i] = Math.max(1, Math.floor((budget * wt[i]) / ws)); break; }
    }
    let ex = out.reduce((s, t) => s + t, 0) - total;
    for (let i = n - 1; i >= 0 && ex > 0; i--) { const c = Math.min(ex, out[i] - 1); out[i] -= c; ex -= c; }
    return out;
  };
}
