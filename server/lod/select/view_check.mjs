// 시야 판정 공용 함수. select·budget·progressive 가 같은 규칙을 쓰도록 여기 한 곳에 둔다(F-100 ⑨).
//
// 카메라 좌표 X_c = R·X_w + t, 시야는 다음 5 반공간의 교집합이다(u = fx·x/z + cx ∈ [0, W], v ∈ [0, H]).
//   앞      z > 0
//   왼쪽    fx·x + cx·z ≥ 0          오른쪽  fx·x + (cx − W)·z ≤ 0
//   위      fy·y + cy·z ≥ 0          아래    fy·y + (cy − H)·z ≤ 0
// 경계 규칙(가장 보수적인 쪽으로 통일): 앞은 z > 0 (z = 0 과 뒤쪽만 밖, 1e-6 같은 하한을 두지 않는다), 좌·우·위·아래는
// 경계 위(등호)를 안으로 본다. 상자 8 꼭짓점이 모두 한 반공간의 밖일 때만 '밖'이며, 그 외에는 보이는 것으로 본다.
// 여러 평면에 걸쳐 밖인 모서리 상자는 안으로 남을 수 있으나, 보여야 할 리프를 버리는 일은 없다.
//
// 점 원판 여유(F-116): 참조 래스터(server/raster_ref/zbuffer)는 점을 반경 r = fx·sizeM/(2z) px 원판으로 그리고
// u + r < 0, v + r < 0, u − r > W, v − r > H 일 때만 건너뛴다(위·아래도 반경은 fx 로 잰다). z > 0 에서 양변에 z 를 곱하면
//   왼쪽    fx·x + cx·z + m ≥ 0      오른쪽  fx·x + (cx − W)·z − m ≤ 0      m = fx·sizeM/2
//   위      fy·y + cy·z + m ≥ 0      아래    fy·y + (cy − H)·z − m ≤ 0
// 이 되어 여전히 X_c 의 1차식(아핀)이다. 아핀 함수의 상자 위 최댓값은 꼭짓점에서 나오므로 8 꼭짓점 판정이 그대로 정확한
// 보수 판정이 된다(리프 최소 깊이에서 r_max 를 쓰는 근사가 필요 없다). 각 평면을 깊이 z 에서 그 깊이의 원판 반경만큼 바깥으로 민 것과 같다.
// boxMayBeVisible(3 인자)은 m = 0(원판 중심만 봄)인 기존 규칙이며 LOD(select·budget·progressive)가 쓴다.
// 컬링은 boxMayBeVisibleSplat 을 쓴다. 결정 0023 참조.

function boxTest(camera, mn, mx, m, lateral) {
  const { R, t, K, width: W, height: H } = camera;
  const { fx, fy, cx, cy } = K;
  let anyFront = false, anyLeft = !lateral, anyRight = !lateral, anyTop = !lateral, anyBottom = !lateral;
  for (let c = 0; c < 8; c++) {
    const X = c & 1 ? mx[0] : mn[0];
    const Y = c & 2 ? mx[1] : mn[1];
    const Z = c & 4 ? mx[2] : mn[2];
    const x = R[0] * X + R[1] * Y + R[2] * Z + t[0];
    const y = R[3] * X + R[4] * Y + R[5] * Z + t[1];
    const z = R[6] * X + R[7] * Y + R[8] * Z + t[2];
    if (z > 0) anyFront = true;
    if (!lateral) continue;
    if (fx * x + cx * z + m >= 0) anyLeft = true;
    if (fx * x + (cx - W) * z - m <= 0) anyRight = true;
    if (fy * y + cy * z + m >= 0) anyTop = true;
    if (fy * y + (cy - H) * z - m <= 0) anyBottom = true;
  }
  return anyFront && anyLeft && anyRight && anyTop && anyBottom;
}

/** 상자(월드, mn·mx)가 시야 사각뿔과 겹칠 수 있으면 true(확실히 밖일 때만 false). 원판 중심만 본다(LOD 용). */
export function boxMayBeVisible(camera, mn, mx) {
  return boxTest(camera, mn, mx, 0, true);
}

/**
 * 컬링용: 지름 pointSizeM(m) 원판으로 그려지는 점을 담은 상자가 화면에 걸칠 수 있으면 true.
 * 좌·우·위·아래 평면을 원판 반경만큼 바깥으로 민다(위 주석의 m = fx·pointSizeM/2).
 * pointSizeM 이 undefined·null 이면 원판 크기를 모르므로 좌·우·위·아래로는 아무것도 버리지 않는다(앞 z > 0 만 본다).
 * pointSizeM 은 0 이상의 유한 수여야 한다(0 이면 boxMayBeVisible 과 같다). 검사는 호출자 몫이다.
 */
export function boxMayBeVisibleSplat(camera, mn, mx, pointSizeM) {
  if (pointSizeM === undefined || pointSizeM === null) return boxTest(camera, mn, mx, 0, false);
  return boxTest(camera, mn, mx, 0.5 * camera.K.fx * pointSizeM, true);
}
