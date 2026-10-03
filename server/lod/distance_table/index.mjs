// T07.3 단계 거리표. 계약: contracts/lod/index.mjs 머리 주석의 "거리 근거" 와 LOD_API.distance_table.
//
// 근거(renderer_basis §3-7, SPEC §3): 깊이 d, 기선 b, 초점 f(px) 에서 1 px 시차가 뜻하는 깊이 변화는 Δd ≈ d²/(f·b).
// 이를 화면 공간 오차로 옮기면, 카메라에서 거리 d 에 있는 한 변 edgeM 칸은 화면에서 f·edgeM/d 픽셀이다.
// 그 크기가 허용 오차 τ(thresholdPx) 이하이면 그 단계로 충분하다.
//
//   edgeM(l)        = edge0M · 2^l
//   maxDistanceM(l) = f · edgeM(l) / τ        (계약의 정의를 그대로 따른다)
//   levelForDistance(d) = f·edgeM(l)/d ≤ τ 를 만족하는 가장 큰 l
//                       ⇔ d ≥ maxDistanceM(l) 인 가장 큰 l
//
// 해석 주의: 선택 규칙으로 보면 maxDistanceM(l) 은 "단계 l 을 쓰기 시작하는 거리"(그 거리부터 칸이 τ 픽셀 이하)다.
//   단계 l 이 실제로 쓰이는 구간은 [maxDistanceM(l), maxDistanceM(l+1)) 이고, 경계 d = maxDistanceM(l) 은 단계 l 에 속한다.
//   d < maxDistanceM(0) 이면 만족하는 l 이 없지만, 단계 0 은 원본 전부이므로 더 고운 단계가 없다 → 0 을 돌려준다.
//
// 마지막 단계의 maxDistanceM 을 Infinity 로 두지 않는다(결정):
//   계약은 maxDistanceM(l) = f·edgeM(l)/τ 로 모든 단계에 같은 식을 준다. 위 선택 규칙에서 maxDistanceM 은 하한 경계로 쓰이므로
//   마지막 값을 Infinity 로 바꾸면 d ≥ Infinity 가 불가능해져 마지막 단계가 영영 선택되지 않는다(규칙 위반).
//   마지막 단계 위쪽은 이미 열려 있다: d ≥ maxDistanceM(마지막) 인 모든 거리는 마지막 단계를 쓴다.
//
// edge0M 하한(minEdge0M): 원본 점은 촬영 깊이 d_c 에서 깊이 방향으로 Δd(d_c, b) = d_c²/(f·b) 보다 정밀하지 않다.
//   따라서 edge0M 을 Δd 보다 촘촘하게 둘 이유가 없다. 이 값을 그대로 돌려주는 것이 minEdge0M 이다(계약 머리 주석).

import { assertLevelParams, edgeOfLevel } from '../../../contracts/lod/index.mjs';

const ERR = 'lod:';

/** 양의 유한수가 아니면 던진다. */
function positive(name, v) {
  if (!(typeof v === 'number' && Number.isFinite(v) && v > 0)) throw new Error(`${ERR} ${name} 는 양의 유한수: ${String(v)}`);
  return v;
}

/**
 * 단계 거리표를 만든다.
 * @param {{fx:number, thresholdPx:number, edge0M:number, levelCount:number}} opts
 *   fx 초점거리(px), thresholdPx 허용 화면 오차 τ(px), edge0M 단계 0 칸 한 변(m), levelCount 단계 수(1..MAX_LEVELS)
 * @returns {{fx:number, thresholdPx:number, edge0M:number, levels:{level:number, edgeM:number, maxDistanceM:number}[]}}
 */
export function buildDistanceTable(opts) {
  if (!opts || typeof opts !== 'object') throw new Error(`${ERR} 옵션이 객체가 아님`);
  const { fx, thresholdPx, edge0M, levelCount } = opts;
  positive('fx', fx);
  positive('thresholdPx', thresholdPx);
  assertLevelParams(edge0M, levelCount);
  const levels = [];
  for (let level = 0; level < levelCount; level++) {
    const edgeM = edgeOfLevel(edge0M, level);
    // 마지막 단계도 같은 식(Infinity 아님, 머리 주석의 결정 참조)
    levels.push(Object.freeze({ level, edgeM, maxDistanceM: (fx * edgeM) / thresholdPx }));
  }
  return Object.freeze({ fx, thresholdPx, edge0M, levels: Object.freeze(levels) });
}

/**
 * 거리 d(m) 에 쓸 단계: f·edgeM(l)/d ≤ τ 인 가장 큰 l. 경계 d = maxDistanceM(l) 은 단계 l 에 포함.
 * 만족하는 l 이 없으면(d < maxDistanceM(0)) 원본인 단계 0.
 * @param {ReturnType<typeof buildDistanceTable>} table @param {number} d @returns {number}
 */
export function levelForDistance(table, d) {
  if (!table || !Array.isArray(table.levels) || table.levels.length < 1) throw new Error(`${ERR} 거리표가 아님`);
  positive('d', d);
  const { levels } = table;
  let chosen = 0;
  // maxDistanceM 은 단계가 오를수록 커지므로 처음 어긋나는 곳에서 멈춘다.
  for (let i = 0; i < levels.length; i++) {
    if (d >= levels[i].maxDistanceM) chosen = levels[i].level;
    else break;
  }
  return chosen;
}

/**
 * 깊이 해상도 Δd = d²/(f·b) (renderer_basis §3-7): 1 px 시차가 뜻하는 깊이 변화(m).
 * @param {number} d 깊이(m) @param {number} fx 초점거리(px) @param {number} baselineM 기선(m) @returns {number}
 */
export function depthResolutionM(d, fx, baselineM) {
  positive('d', d);
  positive('fx', fx);
  positive('baselineM', baselineM);
  return (d * d) / (fx * baselineM);
}

/**
 * edge0M 의 정당한 하한: 촬영 깊이 dCapture 에서의 깊이 해상도. 이보다 촘촘한 단계 0 칸은 원본 정밀도를 넘는다.
 * @param {number} dCapture 촬영 깊이(m) @param {number} fx 초점거리(px) @param {number} baselineM 기선(m) @returns {number} m
 */
export function minEdge0M(dCapture, fx, baselineM) {
  return depthResolutionM(dCapture, fx, baselineM);
}
