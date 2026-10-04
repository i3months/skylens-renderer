// 드론·마커 덧그리기(T13.5). 점 장면 위에 마커의 화면 위치(CSS 픽셀)를 계산해 돌려준다.
// 그리기는 클라이언트 2D 오버레이가 한다. 서버·래스터라이저는 마커를 그리지 않는다(이 모듈은 계산만 한다).
// 계약: contracts/statusview STATUSVIEW_API.projectMarkers·unprojectToEnu.
// 좌표: GeoAnchor 기준 ENU, 1 unit = 1 m. 카메라: OpenCV(x 오른쪽, y 아래, z 앞), X_c = R·X_w + t.
// 투영: u = fx·X_c.x/d + cx, v = fy·X_c.y/d + cy, d = X_c.z.
//
// View 검증: contracts/client_raster 는 View 검증 함수를 내보내지 않는다(finiteArray 는 모듈 내부). 그래서 여기서 직접 한다.
// 형식 위반(객체 아님·배열 길이·수가 아님·유한 아님)은 TypeError, 값 범위 위반(K 양수·width/height 양의 정수·R 회전 아님)은 RangeError.

/** R 이 회전 행렬인지 볼 때 쓰는 허용 오차(R·Rᵀ = I, det = +1). unprojectToEnu 가 R⁻¹ = Rᵀ 를 쓰므로 필요하다. */
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
    const visible = u >= 0 && u < width && v >= 0 && v < height;
    return { id: m.id, u, v, depth: d, visible };
  });
}

/**
 * 화면 좌표(u, v)와 깊이 d 를 ENU 로 되돌린다. X_c = d·K⁻¹[u,v,1]ᵀ, X_w = Rᵀ(X_c − t).
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
  return [
    R[0] * a + R[3] * b + R[6] * c,
    R[1] * a + R[4] * b + R[7] * c,
    R[2] * a + R[5] * b + R[8] * c,
  ];
}
