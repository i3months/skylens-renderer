// 초기 묶음(T11.5): 첫 프레임에 보이는 최소 조각만 골라 한 번에 보낼 묶음을 만든다.
//   - 담는 것: 수준 0(level 0) 이고, 그 타일(segmentId, tileX, tileY)에서 가장 거친 lod(번호 최대) 인 조각, 그리고 시야 원뿔 안.
//     더 높은 수준·더 세밀한 lod 는 이후 일반 송출이 맡는다(딜레이 패턴: 도착하지 않은 것은 메우지 않는다).
//   - 시야 판정: 카메라 앞쪽 원뿔 근사. 카메라는 contracts/raster 와 같이 카메라 좌표 +z 를 본다.
//     quat(x,y,z,w, 단위) 는 카메라 → 월드(ENU) 회전이고, 앞 방향 = quat·(0,0,1). 원뿔 반각 = fovY/2 를 가로세로비
//     ASPECT_GUARD 만큼 넓힌 값(가로 시야각을 모르므로 보수적). 상자는 외접구로 근사(구가 원뿔에 걸리면 시야 안).
//   - 순서: 상자까지의 거리가 가까운 순(같으면 입력 순서). 예산(≤ 15 MB(15,000,000 B), 웹소켓으로 나가는 프레임 바이트 기준 — 조각당 PIECE 머리와 ws 머리 포함)을 넘기는 항목은 건너뛰고 다음 것을 계속 본다.
//   - droppedCount: 위 조건을 모두 만족했지만 예산 때문에 빠진 항목 수. 시야 밖·수준 0 아님·덜 거친 lod 는 세지 않는다.
export const INITIAL_BUDGET_BYTES = 15_000_000;
// 조각 하나를 보낼 때 .skla 바이트 위에 붙는 프레임 머리의 상한(F-202): PIECE 머리 28 B + ws 머리 최대 10 B(서버→클라이언트, 마스크 없음, 64 KiB 이상).
export const PIECE_HEADER_BYTES = 28;
export const WS_HEADER_MAX_BYTES = 10;
export const PIECE_FRAME_OVERHEAD_BYTES = PIECE_HEADER_BYTES + WS_HEADER_MAX_BYTES;
// F-209: SPEC §4 의 '연결 → 첫 프레임' 은 WELCOME 과 LEVEL_ARRIVED 도 포함하므로 예산에서 먼저 떼어 둔다.
//   WELCOME 은 항상 1개, LEVEL_ARRIVED 는 담긴 (segmentId, level) 마다 1개. 둘 다 본문 9 B + 프레임 머리 4 B + ws 머리 상한.
export const FRAME_HEADER_BYTES = 4;
export const WELCOME_FRAME_BYTES = FRAME_HEADER_BYTES + 9 + WS_HEADER_MAX_BYTES;
export const LEVEL_ARRIVED_FRAME_BYTES = FRAME_HEADER_BYTES + 9 + WS_HEADER_MAX_BYTES;
const ASPECT_GUARD = 2;

function forwardOf(q) {
  const [x, y, z, w] = q;
  // 회전된 (0,0,1)
  return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
}

function inView(pos, fwd, halfAngle, bbox) {
  const c = [0, 1, 2].map((i) => (bbox.min[i] + bbox.max[i]) / 2);
  const r = Math.hypot(bbox.max[0] - c[0], bbox.max[1] - c[1], bbox.max[2] - c[2]);
  const v = [c[0] - pos[0], c[1] - pos[1], c[2] - pos[2]];
  const d = Math.hypot(v[0], v[1], v[2]);
  if (d <= r) return true; // 카메라가 구 안
  const along = (v[0] * fwd[0] + v[1] * fwd[1] + v[2] * fwd[2]);
  if (along + r <= 0) return false; // 전부 카메라 뒤
  const angle = Math.acos(Math.min(1, Math.max(-1, along / d)));
  return angle <= halfAngle + Math.asin(Math.min(1, r / d));
}

function boxDistance(pos, bbox) {
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const g = Math.max(bbox.min[i] - pos[i], 0, pos[i] - bbox.max[i]);
    s += g * g;
  }
  return Math.sqrt(s);
}

/**
 * @param {{pose:{pos:number[],quat:number[],fovY:number},
 *          catalog:{key:{segmentId:number,level:number,lod:number,chunkIndex:number,tileX:number,tileY:number},bytes:number,bbox:{min:number[],max:number[]},lod?:number}[],
 *          budgetBytes?:number}} input
 * @returns {{items:object[], totalBytes:number, frameBytes:number, droppedCount:number}} totalBytes = 담긴 .skla 바이트 합,
 *   frameBytes = WELCOME·LEVEL_ARRIVED 프레임과 조각당 프레임 머리 상한을 더한 송출 바이트 상한(예산 판정 대상, 항상 ≤ budgetBytes)
 */
export function buildInitialBundle({ pose, catalog, budgetBytes = INITIAL_BUDGET_BYTES }) {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) throw new RangeError(`budgetBytes 는 양의 정수여야 한다: ${budgetBytes}`);
  for (const it of catalog) {
    if (!Number.isSafeInteger(it.bytes) || it.bytes < 0) throw new RangeError(`bytes 는 0 이상의 정수여야 한다: ${it.bytes}`);
  }
  const { pos, quat, fovY } = pose;
  const fwd = forwardOf(quat);
  const half = Math.min(Math.PI / 2, Math.atan(Math.tan(fovY / 2) * ASPECT_GUARD));

  // 타일별 가장 거친 lod (수준 0 항목 중)
  const coarsest = new Map();
  const tileOf = (k) => `${k.segmentId}/${k.tileX}/${k.tileY}`;
  for (const it of catalog) {
    if (it.key.level !== 0) continue;
    const t = tileOf(it.key);
    if (!(coarsest.get(t) >= it.key.lod)) coarsest.set(t, it.key.lod);
  }

  const cand = [];
  catalog.forEach((it, idx) => {
    if (it.key.level !== 0 || it.key.lod !== coarsest.get(tileOf(it.key))) return;
    if (!inView(pos, fwd, half, it.bbox)) return;
    cand.push({ it, idx, dist: boxDistance(pos, it.bbox) });
  });
  cand.sort((a, b) => a.dist - b.dist || a.idx - b.idx);

  const items = [];
  let totalBytes = 0;
  let frameBytes = WELCOME_FRAME_BYTES;
  let droppedCount = 0;
  const levels = new Set();
  for (const { it } of cand) {
    const lv = `${it.key.segmentId}/${it.key.level}`;
    const frame = it.bytes + PIECE_FRAME_OVERHEAD_BYTES + (levels.has(lv) ? 0 : LEVEL_ARRIVED_FRAME_BYTES);
    if (frameBytes + frame <= budgetBytes) {
      items.push(it);
      levels.add(lv);
      totalBytes += it.bytes;
      frameBytes += frame;
    } else droppedCount++;
  }
  return { items, totalBytes, frameBytes, droppedCount };
}
