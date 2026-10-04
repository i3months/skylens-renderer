// 드론·마커 덧그리기(T13.5). 점 장면 위에 마커의 화면 위치(CSS 픽셀)를 계산해 돌려준다.
// 그리기는 클라이언트 2D 오버레이가 한다. 서버·래스터라이저는 마커를 그리지 않는다(이 모듈은 계산만 한다).
// 계약: contracts/statusview STATUSVIEW_API.projectMarkers·unprojectToEnu.
// 좌표: GeoAnchor 기준 ENU, 1 unit = 1 m. 카메라: OpenCV(x 오른쪽, y 아래, z 앞), X_c = R·X_w + t.
// 투영: u = fx·X_c.x/d + cx, v = fy·X_c.y/d + cy, d = X_c.z.
//
// View 검증: contracts/client_raster 는 View 검증 함수를 내보내지 않는다(finiteArray 는 모듈 내부). 그래서 여기서 직접 한다.
// 형식 위반(객체 아님·배열 길이·수가 아님·유한 아님)은 TypeError, 값 범위 위반(K 양수·width/height 양의 정수·R 회전 아님)은 RangeError.

/**
 * R 이 회전 행렬인지 볼 때 쓰는 허용 오차(R·Rᵀ = I, det = +1). client/raster/camera ROT_TOL 과 같은 1e-6 이라
 * 래스터라이저가 받는 View 는 여기서도 받는다. 이 허용 오차 안의 R 은 Rᵀ 가 R⁻¹ 과 최대 약 1e-6 만큼 달라서
 * Rᵀ 로 되돌리면 |X_w| 1e4 m 에서 왕복 오차가 1 cm 를 넘을 수 있다. 그래서 unprojectToEnu 는 Rᵀ 가 아니라
 * R 의 실제 역행렬(수반 행렬 / det)을 쓴다. 정확한 회전이면 둘은 같다.
 */
const ROTATION_TOL = 1e-6;

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function finiteVector(name, a, len) {
  if (!(Array.isArray(a) || ArrayBuffer.isView(a)) || a.length !== len) throw new TypeError(`${name} 는 길이 ${len} 배열이어야 한다`);
  for (let i = 0; i < len; i += 1) {
    if (!isFiniteNumber(a[i])) throw new TypeError(`${name}[${i}] 는 유한 수여야 한다: ${String(a[i])}`);
  }
}

function assertView(view) {
  if (view === null || typeof view !== 'object') throw new TypeError('view 는 객체여야 한다');
  const { R, t, K, width, height } = view;
  finiteVector('view.R', R, 9);
  finiteVector('view.t', t, 3);
  if (K === null || typeof K !== 'object') throw new TypeError('view.K 는 객체여야 한다');
  for (const n of ['fx', 'fy', 'cx', 'cy']) {
    if (!isFiniteNumber(K[n])) throw new TypeError(`view.K.${n} 는 유한 수여야 한다: ${String(K[n])}`);
  }
  if (!(K.fx > 0) || !(K.fy > 0)) throw new RangeError(`view.K.fx·fy 는 양수여야 한다: ${K.fx}, ${K.fy}`);
  for (const [n, x] of [['width', width], ['height', height]]) {
    if (typeof x !== 'number') throw new TypeError(`view.${n} 는 수여야 한다: ${String(x)}`);
    if (!Number.isInteger(x) || x <= 0) throw new RangeError(`view.${n} 는 양의 정수여야 한다: ${String(x)}`);
  }
  // R·Rᵀ = I
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      const s = R[3 * i] * R[3 * j] + R[3 * i + 1] * R[3 * j + 1] + R[3 * i + 2] * R[3 * j + 2];
      if (Math.abs(s - (i === j ? 1 : 0)) > ROTATION_TOL) throw new RangeError('view.R 는 회전 행렬(직교)이어야 한다');
    }
  }
  const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
  if (Math.abs(det - 1) > ROTATION_TOL) throw new RangeError('view.R 의 행렬식은 +1 이어야 한다');
}

/** 행 우선 3×3 역행렬(수반 행렬 / det). assertView 를 거친 R 은 det ≈ 1 이라 나눗셈이 안전하다. */
function inverse3(M) {
  const [a, b, c, d, e, f, g, h, i] = M;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

function assertMarker(m, i) {
  if (m === null || typeof m !== 'object') throw new TypeError(`markers[${i}] 는 객체여야 한다`);
  if (typeof m.id !== 'string') throw new TypeError(`markers[${i}].id 는 문자열이어야 한다`);
  if (!Array.isArray(m.enu) || m.enu.length !== 3 || !m.enu.every(isFiniteNumber)) {
    throw new TypeError(`markers[${i}].enu 는 유한 수 3개 배열이어야 한다`);
  }
}

/**
 * 마커 ENU 를 화면(CSS 픽셀)으로 투영한다. 입력 순서·개수를 지키고 입력을 바꾸지 않는다.
 * depth ≤ 0(카메라 뒤·카메라 평면)이면 나눗셈이 뜻이 없으므로 u = 0, v = 0 으로 두고 visible = false 다
 * (NaN·null 을 내보내지 않는다. 호출자는 visible 만 보고 그린다).
 * depth > 0 이면 u, v 는 화면 밖이어도 투영값 그대로이고 visible = 0 ≤ u < width 이고 0 ≤ v < height.
 * 단 depth·u·v 중 하나라도 유한하지 않으면(넘침) depth ≤ 0 과 같이 u = 0, v = 0, visible = false 다.
 * 검사는 전부 계산 전에 끝낸다(던지면 아무것도 돌려주지 않는다).
 * @param {object} view contracts/client_raster View
 * @param {{id:string, enu:number[]}[]} markers
 * @returns {{id:string, u:number, v:number, depth:number, visible:boolean}[]}
 */
export function projectMarkers(view, markers) {
  assertView(view);
  if (!Array.isArray(markers)) throw new TypeError('markers 는 배열이어야 한다');
  markers.forEach(assertMarker);
  const { R, t, K, width, height } = view;
  return markers.map((m) => {
    const [x, y, z] = m.enu;
    const xc = R[0] * x + R[1] * y + R[2] * z + t[0];
    const yc = R[3] * x + R[4] * y + R[5] * z + t[1];
    const d = R[6] * x + R[7] * y + R[8] * z + t[2];
    if (!(d > 0)) return { id: m.id, u: 0, v: 0, depth: d, visible: false };
    const u = (K.fx * xc) / d + K.cx;
    const v = (K.fy * yc) / d + K.cy;
    // 아주 큰 좌표(예: 1e308)는 유한한 입력에서도 X_c·u·v 가 넘쳐 Infinity·NaN 이 된다. 비유한 u·v 는 내보내지 않는다.
    if (!Number.isFinite(d) || !Number.isFinite(u) || !Number.isFinite(v)) return { id: m.id, u: 0, v: 0, depth: d, visible: false };
    const visible = u >= 0 && u < width && v >= 0 && v < height;
    return { id: m.id, u, v, depth: d, visible };
  });
}

/**
 * 화면 좌표(u, v)와 깊이 d 를 ENU 로 되돌린다. X_c = d·K⁻¹[u,v,1]ᵀ, X_w = R⁻¹(X_c − t).
 * R⁻¹ 은 수반 행렬 / det 로 구한 실제 역이다(정확한 회전이면 Rᵀ 와 같다. ROTATION_TOL 설명 참조).
 * depth 는 양의 유한 수여야 한다(depth ≤ 0 은 projectMarkers 에서 u,v 가 투영값이 아니므로 되돌릴 수 없다).
 * @returns {number[]} [동, 북, 위] (m)
 */
export function unprojectToEnu(view, u, v, depth) {
  assertView(view);
  for (const [n, x] of [['u', u], ['v', v], ['depth', depth]]) {
    if (!isFiniteNumber(x)) throw new TypeError(`${n} 는 유한 수여야 한다: ${String(x)}`);
  }
  if (!(depth > 0)) throw new RangeError(`depth 는 양수여야 한다: ${depth}`);
  const { R, t, K } = view;
  const a = ((u - K.cx) / K.fx) * depth - t[0];
  const b = ((v - K.cy) / K.fy) * depth - t[1];
  const c = depth - t[2];
  const Ri = inverse3(R);
  return [
    Ri[0] * a + Ri[1] * b + Ri[2] * c,
    Ri[3] * a + Ri[4] * b + Ri[5] * c,
    Ri[6] * a + Ri[7] * b + Ri[8] * c,
  ];
}
