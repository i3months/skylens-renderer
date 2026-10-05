// 관제탑 오버레이 투영·역투영(T15.6.4). 계약: contracts/controlview/overlay.mjs TOWER_OVERLAY_MODULES.project,
// TOWER_OVERLAY_FORMULA.project·unproject·enuMatch.
// 수식은 현황판 덧그리기(client/status/overlay projectMarkers·unprojectToEnu)와 같으므로 그것을 감싼다(한 곳에서만 계산).
//   투영:   X_c = R·X_w + t, d = X_c.z, u = fx·X_c.x/d + cx, v = fy·X_c.y/d + cy.
//           d ≤ 0 이거나 d·u·v 가 유한하지 않으면(넘침) 던지지 않고 visible = false, u = v = 0.
//           그 밖에는 visible = 0 ≤ u < width 이고 0 ≤ v < height(화면 밖이어도 u, v 는 투영값 그대로).
//   역투영: X_c = d·K⁻¹[u,v,1]ᵀ, X_w = R⁻¹(X_c − t). R⁻¹ 은 Rᵀ 가 아니라 실제 역행렬이다
//           (float32 쿼터니언에서 온 근사 회전이어도 |X_w| 1e4 m 왕복이 1 cm 안에 든다).
//           depth 는 양의 유한 수. 결과가 넘치면 RangeError.
// 검사: view 형식 위반 TypeError, 값 범위 위반 RangeError. 검사는 계산 전에 끝난다(던지면 아무것도 돌려주지 않는다).
// 입력 순서·개수·id 를 지키고 입력을 바꾸지 않는다. 결과는 새 객체다.
import { projectMarkers, unprojectToEnu } from '../../status/overlay/index.mjs';

/**
 * 점 목록을 화면(CSS 픽셀)으로 투영한다.
 * @param {{R:number[], t:number[], K:{fx:number, fy:number, cx:number, cy:number}, width:number, height:number}} view
 * @param {{id:string, enu:number[]}[]} items 다른 필드는 읽지 않는다
 * @returns {{id:string, u:number, v:number, depth:number, visible:boolean}[]}
 */
export function projectPoints(view, items) {
  return projectMarkers(view, items);
}

/**
 * 화면 좌표(u, v)와 깊이를 ENU 로 되돌린다.
 * @returns {number[]} [동, 북, 위] (m), 언제나 유한하다
 */
export function unprojectPoint(view, u, v, depth) {
  return unprojectToEnu(view, u, v, depth);
}
