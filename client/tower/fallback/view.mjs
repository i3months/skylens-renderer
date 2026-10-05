// 관제탑 폴백 지도 맞춤·화면 변환(T15.8). 계약: contracts/controlview/fallback.mjs TOWER_FALLBACK_FORMULA.fit·toScreen.
//   맞춤: 받은 모든 점의 (e,n) 경계 상자. center = 상자 중심, span = max(동서 폭, 남북 폭, minSpanM),
//         avail = max(min(width,height) − 2·marginPx, 1), metersPerPx = span/avail. 점이 없으면 null.
//   변환: x = width/2 + (e − centerE)/metersPerPx, y = height/2 − (n − centerN)/metersPerPx,
//         visible = 0 ≤ x < width 이고 0 ≤ y < height.
// 입력은 호출 쪽(validate.mjs)에서 이미 검사했으므로 여기서는 검사하지 않는다. 순회는 한 번이고
// 스프레드 인자 전개(Math.min(...arr))를 쓰지 않아 점이 아주 많아도 스택이 넘치지 않는다.

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
  const avail = Math.max(Math.min(size.width, size.height) - 2 * marginPx, 1);
  return { centerE: (minE + maxE) / 2, centerN: (minN + maxN) / 2, metersPerPx: span / avail };
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
