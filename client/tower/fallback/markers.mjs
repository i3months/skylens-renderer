// 관제탑 폴백 마커 계산(T15.8). 계약: contracts/controlview/fallback.mjs TOWER_FALLBACK_MODULES.markers,
// TOWER_FALLBACK_FORMULA.toScreen.
// 수식(view.mjs 를 부르지 않고 여기서 직접 계산한다):
//   x = width/2 + (e − centerE)/metersPerPx,  y = height/2 − (n − centerN)/metersPerPx,
//   visible = 0 ≤ x < width 이고 0 ≤ y < height(경계 x = width 는 밖). 화면 밖이어도 x, y 는 계산값 그대로.
// yaw 는 ENU 방위(0=북, 시계 방향 +, rad)이고 그대로 돌려준다. 화면 방향은 (sin yaw, −cos yaw), 그릴 때 시계 방향 양의 회전이면 +yaw(계약 참조).
// 높이(u)는 지도에서 쓰지 않는다. 받은 위치만 옮기며 보간·외삽은 없다.
// 입력 검사는 overlay 검사(checkDrones·checkDetections)가 이미 끝낸 형태를 받는다.
// 입력 순서·개수·id 를 지키고 입력을 바꾸지 않는다. 결과는 새 객체다.

/**
 * 항목 목록을 지도 화면(CSS 픽셀)의 마커로 바꾼다.
 * @param {{centerE:number, centerN:number, metersPerPx:number}} view
 * @param {{width:number, height:number}} size
 * @param {{id:string, enu:number[], yaw?:number, kind?:string, confidence?:number}[]} items
 * @param {boolean} withKind false 면 드론 형태({id,x,y,visible,yaw?}), true 면 탐지 형태({id,x,y,visible,kind,confidence?})
 * @returns {{id:string, x:number, y:number, visible:boolean}[]}
 */
export function buildMarkers(view, size, items, withKind) {
  const { centerE, centerN, metersPerPx } = view;
  const { width, height } = size;
  return items.map((it) => {
    const x = width / 2 + (it.enu[0] - centerE) / metersPerPx;
    const y = height / 2 - (it.enu[1] - centerN) / metersPerPx;
    const out = { id: it.id, x, y, visible: x >= 0 && x < width && y >= 0 && y < height };
    if (withKind) {
      out.kind = it.kind === undefined ? 'detection' : it.kind;
      if (it.confidence !== undefined) out.confidence = it.confidence;
    } else if (it.yaw !== undefined) {
      out.yaw = it.yaw;
    }
    return out;
  });
}
