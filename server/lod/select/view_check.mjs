// 시야 판정 공용 함수. select·budget·progressive 가 같은 규칙을 쓰도록 여기 한 곳에 둔다(F-100 ⑨).
//
// 카메라 좌표 X_c = R·X_w + t, 시야는 다음 5 반공간의 교집합이다(u = fx·x/z + cx ∈ [0, W], v ∈ [0, H]).
//   앞      z > 0
//   왼쪽    fx·x + cx·z ≥ 0          오른쪽  fx·x + (cx − W)·z ≤ 0
//   위      fy·y + cy·z ≥ 0          아래    fy·y + (cy − H)·z ≤ 0
// 경계 규칙(가장 보수적인 쪽으로 통일): 앞은 z > 0 (z = 0 과 뒤쪽만 밖, 1e-6 같은 하한을 두지 않는다), 좌·우·위·아래는
// 경계 위(등호)를 안으로 본다. 상자 8 꼭짓점이 모두 한 반공간의 밖일 때만 '밖'이며, 그 외에는 보이는 것으로 본다.
// 여러 평면에 걸쳐 밖인 모서리 상자는 안으로 남을 수 있으나, 보여야 할 리프를 버리는 일은 없다.

/** 상자(월드, mn·mx)가 시야 사각뿔과 겹칠 수 있으면 true(확실히 밖일 때만 false). */
export function boxMayBeVisible(camera, mn, mx) {
  const { R, t, K, width: W, height: H } = camera;
  const { fx, fy, cx, cy } = K;
  let anyFront = false, anyLeft = false, anyRight = false, anyTop = false, anyBottom = false;
  for (let c = 0; c < 8; c++) {
    const X = c & 1 ? mx[0] : mn[0];
    const Y = c & 2 ? mx[1] : mn[1];
    const Z = c & 4 ? mx[2] : mn[2];
    const x = R[0] * X + R[1] * Y + R[2] * Z + t[0];
    const y = R[3] * X + R[4] * Y + R[5] * Z + t[1];
    const z = R[6] * X + R[7] * Y + R[8] * Z + t[2];
    if (z > 0) anyFront = true;
    if (fx * x + cx * z >= 0) anyLeft = true;
    if (fx * x + (cx - W) * z <= 0) anyRight = true;
    if (fy * y + cy * z >= 0) anyTop = true;
    if (fy * y + (cy - H) * z <= 0) anyBottom = true;
  }
  return anyFront && anyLeft && anyRight && anyTop && anyBottom;
}
