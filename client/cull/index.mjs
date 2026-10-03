// 클라이언트 절두체 컬링(T08.7). 서버 frustumCull(= boxMayBeVisible 규칙)과 같은 마스크를 독립 구현으로 낸다.
// 브라우저에서도 돌아야 하므로 node: 내장 모듈·서버 모듈을 import 하지 않는다(순수 ESM, 의존성 없음).
// 규칙: 앞 z > 0, 좌·우·위·아래는 등호를 안으로 본다. 상자 8 꼭짓점이 모두 한 반공간 밖일 때만 제거(보수적).
// F-116 원판 여유: 점은 반경 r = fx·pointSizeM/(2z) px 원판으로 그려진다(위·아래도 fx). 좌·우·위·아래 평면에
//   m = fx·pointSizeM/2 를 더해 바깥으로 민다: fx·x + cx·z + m ≥ 0, fx·x + (cx − W)·z − m ≤ 0, fy·y + cy·z + m ≥ 0,
//   fy·y + (cy − H)·z − m ≤ 0. X_c 의 1차식이라 8 꼭짓점 판정이 정확하다.
// opts.pointSizeM 이 없으면 원판 크기를 모르므로 좌·우·위·아래로는 아무것도 버리지 않는다(앞 z > 0 만 판정).
// 퇴화 시점(NaN·Infinity, 해상도·초점거리 ≤ 0, R 이 회전 아님)이면 던지지 않고 전부 0 을 돌려준다.
// 입력 오류(leafBoxes 형식)는 'cull:' 오류.
const ERR = 'cull:';
const ROT_TOL = 1e-6;

/** 카메라가 퇴화 시점이면 true. 던지지 않는다. */
export function isDegenerateViewClient(camera) {
  if (!camera || typeof camera !== 'object') return true;
  const { R, t, K, width: W, height: H } = camera;
  if (!K || !R || !t || R.length !== 9 || t.length !== 3) return true;
  const { fx, fy, cx, cy } = K;
  for (const v of [W, H, fx, fy, cx, cy]) if (typeof v !== 'number' || !Number.isFinite(v)) return true;
  for (let i = 0; i < 9; i++) if (typeof R[i] !== 'number' || !Number.isFinite(R[i])) return true;
  for (let i = 0; i < 3; i++) if (typeof t[i] !== 'number' || !Number.isFinite(t[i])) return true;
  if (!(W > 0) || !(H > 0) || !(fx > 0) || !(fy > 0)) return true;
  // 정규직교(R·Rᵀ = I)와 det = +1
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const d = R[3 * i] * R[3 * j] + R[3 * i + 1] * R[3 * j + 1] + R[3 * i + 2] * R[3 * j + 2];
    if (Math.abs(d - (i === j ? 1 : 0)) > ROT_TOL) return true;
  }
  const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
  return !(Math.abs(det - 1) <= ROT_TOL);
}

/** 팔진 트리에서 리프 번호 순서의 상자를 모은다(순수 함수). octree: {leafCount, leafIndex, boxMin, boxMax}. */
export function leafBoxesOf(octree) {
  const { leafCount, leafIndex, boxMin, boxMax } = octree;
  const mn = new Float32Array(3 * leafCount), mx = new Float32Array(3 * leafCount);
  const seen = new Uint8Array(leafCount);
  for (let node = 0; node < leafIndex.length; node++) {
    const k = leafIndex[node];
    if (k < 0) continue;
    if (k >= leafCount) throw new Error(`${ERR} leafIndex[${node}] = ${k} 가 leafCount(${leafCount}) 이상`);
    mn.set(boxMin.subarray(3 * node, 3 * node + 3), 3 * k);
    mx.set(boxMax.subarray(3 * node, 3 * node + 3), 3 * k);
    seen[k] = 1;
  }
  for (let k = 0; k < leafCount; k++) if (!seen[k]) throw new Error(`${ERR} 리프 ${k} 의 노드를 찾지 못함`);
  return { boxMin: mn, boxMax: mx };
}

/** 리프 상자 목록과 카메라로 마스크(1 = 남김, 0 = 제거)를 만든다. opts.pointSizeM = 원판 지름(m), 없으면 좌·우·위·아래 제거 없음. */
export function clientFrustumCull(leafBoxes, camera, opts) {
  let pointSizeM;
  if (opts !== undefined && opts !== null) {
    if (typeof opts !== 'object') throw new Error(`${ERR} opts 는 객체여야 함`);
    pointSizeM = opts.pointSizeM ?? undefined;
    if (pointSizeM !== undefined && !(typeof pointSizeM === 'number' && Number.isFinite(pointSizeM) && pointSizeM >= 0)) throw new Error(`${ERR} pointSizeM 은 0 이상의 유한 수여야 함: ${String(pointSizeM)}`);
  }
  const lateral = pointSizeM !== undefined;
  if (!leafBoxes || !(leafBoxes.boxMin instanceof Float32Array) || !(leafBoxes.boxMax instanceof Float32Array)) throw new Error(`${ERR} leafBoxes 는 {boxMin, boxMax: Float32Array}`);
  const { boxMin, boxMax } = leafBoxes;
  if (boxMin.length % 3 !== 0 || boxMin.length !== boxMax.length) throw new Error(`${ERR} boxMin·boxMax 는 같은 길이의 3의 배수여야 함`);
  const n = boxMin.length / 3;
  const out = new Uint8Array(n);
  if (isDegenerateViewClient(camera)) return out;
  const { R, t, K, width: W, height: H } = camera;
  const { fx, fy, cx, cy } = K;
  const m = lateral ? 0.5 * fx * pointSizeM : 0;
  for (let k = 0; k < n; k++) {
    const b = 3 * k;
    let front = false, left = !lateral, right = !lateral, top = !lateral, bottom = !lateral;
    for (let c = 0; c < 8; c++) {
      const X = c & 1 ? boxMax[b] : boxMin[b];
      const Y = c & 2 ? boxMax[b + 1] : boxMin[b + 1];
      const Z = c & 4 ? boxMax[b + 2] : boxMin[b + 2];
      const x = R[0] * X + R[1] * Y + R[2] * Z + t[0];
      const y = R[3] * X + R[4] * Y + R[5] * Z + t[1];
      const z = R[6] * X + R[7] * Y + R[8] * Z + t[2];
      if (z > 0) front = true;
      if (!lateral) continue;
      if (fx * x + cx * z + m >= 0) left = true;
      if (fx * x + (cx - W) * z - m <= 0) right = true;
      if (fy * y + cy * z + m >= 0) top = true;
      if (fy * y + (cy - H) * z - m <= 0) bottom = true;
    }
    out[k] = front && left && right && top && bottom ? 1 : 0;
  }
  return out;
}
