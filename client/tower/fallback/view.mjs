// 관제탑 폴백 지도 맞춤·화면 변환(T15.8). 계약: contracts/controlview/fallback.mjs TOWER_FALLBACK_FORMULA.fit·toScreen.
//   맞춤: 받은 모든 점의 (e,n) 경계 상자. center = 상자 중심, span = max(동서 폭, 남북 폭, minSpanM),
//         m = min(max(marginPx, 1), min(width,height)/4), avail = max(min(width,height) − 2·m, 1),
//         metersPerPx = max(span/avail, minMetersPerPx). 점이 없으면 null.
//   하한 미만의 span/avail(언더플로 0 포함)은 minMetersPerPx 로 고정한다. 점은 더 안쪽에 놓일 뿐이라 여백 안에 드는 성질은 그대로다.
//   여백 m 은 최소 1px 이지만 한 변이 4px 미만이면 side/4 로 줄어든다(side/4 < 1). 그래서 marginPx=0 이어도
//   한 변 ≥ 4px 에서는 끝 점이 ≤ size−1 이고, 한 변 ≥ 2px 에서는 모든 점이 visible 이다(한 변 1px 은 끝 점이 x=width 에 놓일 수 있다).
//   작은 화면에서는 m 을 줄여(side < 4·max(marginPx,1) 이면 avail = side/2) 지도가 1px 로 붕괴하지 않고, 축척은 크기에 단조다.
//   변환: x = width/2 + (e − centerE)/metersPerPx, y = height/2 − (n − centerN)/metersPerPx,
//         visible = 0 ≤ x < width 이고 0 ≤ y < height.
// 입력은 호출 쪽(validate.mjs)에서 이미 검사했으므로 여기서는 검사하지 않는다. 순회는 한 번이고
// 스프레드 인자 전개(Math.min(...arr))를 쓰지 않아 점이 아주 많아도 스택이 넘치지 않는다.
import { TOWER_FALLBACK_LIMITS } from '../../../contracts/controlview/fallback.mjs';

/**
 * 점 목록에 지도를 맞춘다.
 * @param {number[][]} points [[e,n],...]
 * @param {{width:number, height:number}} size
 * @param {{minSpanM:number, marginPx:number}} opts
 * @returns {{centerE:number, centerN:number, metersPerPx:number}|null}
 */
export function fitView(points, size, { minSpanM, marginPx }) {
  if (points.length === 0) return null;
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const e = points[i][0], n = points[i][1];
    if (e < minE) minE = e;
    if (e > maxE) maxE = e;
    if (n < minN) minN = n;
    if (n > maxN) maxN = n;
  }
  const span = Math.max(maxE - minE, maxN - minN, minSpanM);
  const side = Math.min(size.width, size.height);
  const m = Math.min(Math.max(marginPx, 1), side / 4);
  const avail = Math.max(side - 2 * m, 1);
  // 하한 미만(언더플로로 0 이 되는 경우 포함)은 하한으로 고정한다. 던지지 않는다(입력은 검사를 통과한 값이다).
  const metersPerPx = Math.max(span / avail, TOWER_FALLBACK_LIMITS.minMetersPerPx);
  return { centerE: (minE + maxE) / 2, centerN: (minN + maxN) / 2, metersPerPx };
}

/**
 * ENU (e,n) 를 화면 픽셀로 옮긴다. 화면 밖이어도 x, y 는 계산값 그대로다.
 * @returns {{x:number, y:number, visible:boolean}}
 */
export function toScreen(view, size, e, n) {
  const x = size.width / 2 + (e - view.centerE) / view.metersPerPx;
  const y = size.height / 2 - (n - view.centerN) / view.metersPerPx;
  return { x, y, visible: x >= 0 && x < size.width && y >= 0 && y < size.height };
}
