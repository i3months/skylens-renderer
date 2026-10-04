// 현황판 카메라 동기(T13.4). skylens cameraSync.ts 의 역할: 관제·현황판 카메라 자세 하나로
// 클라이언트 래스터라이저 View(contracts/client_raster)와 서버로 보내는 VIEW_UPDATE(contracts/proto)를 동시에 만든다.
// 규약은 contracts/statusview STATUSVIEW_API.syncCamera 가 정본이다. 순수 JS, Math 만 사용.
//
//   pose.quat = 카메라→ENU 회전(x,y,z,w). 카메라 축은 contracts/raster 규약(OpenCV: x 오른쪽, y 아래, z 앞).
//   R_c2w = quatToMatrix(정규화한 quat), view.R = R_c2wᵀ(행 우선 9개, 세계→카메라), view.t = −R·pos.
//   K(CSS 픽셀 격자): fy = (height/2)/tan(fovY/2), fx = fy, cx = width/2, cy = height/2.
//   devicePixelRatio 는 size 에서 그대로 옮긴다(장치 픽셀 환산은 래스터라이저 scaleIntrinsics 한 곳에서만).
//
// 입력 규칙(검사가 모두 끝난 뒤에만 결과를 만든다. 던질 때 아무것도 만들지 않는다):
//   - pose·size 가 객체가 아니거나 pos·quat 가 길이 3·4 배열이 아니거나 원소·fovY 가 number 가 아니면 TypeError.
//   - pos·quat 원소가 유한하지 않으면 RangeError. quat 길이가 0 이거나 비유한이면 RangeError, 아니면 단위로 정규화.
//   - fovY 는 0<fovY<π 이고 float32 로 반올림한 값도 0<fovY<π 여야 한다(선 규약은 f32 로 실어 보내므로
//     π 에 아주 가까운 값이 f32 반올림으로 π 를 넘거나 아주 작은 값이 0 이 되면 encodeMessage 가 거부한다). 위반은 RangeError.
//   - pos 원소는 float32 로 유한해야 한다(|x| 가 f32 최대값을 넘으면 encodeMessage 가 거부하므로 RangeError).
//   - size 는 contracts/statusview assertViewport(양의 정수 width·height, 양의 유한 dpr).
//     더해서 width·height ≤ 65535: VIEW_UPDATE 의 width·height 는 u16 이라 그보다 큰 화면은 viewUpdate 를
//     만들 수 없다. view 만 따로 돌려주지 않고 둘 다 거부한다(RangeError). 두 출력은 언제나 같은 자세·같은 크기다.
//   - viewSeq 는 number 가 아니면 TypeError, 0..2^32−1 정수가 아니면 RangeError.
// viewUpdate 의 값은 f64 그대로 담는다(f32 반올림은 encodeMessage 가 한다). quat 는 정규화한 값이다.
import { assertViewport } from '../../../contracts/statusview/index.mjs';

const U32_MAX = 0xffffffff;
const U16_MAX = 65535;

/** −0 을 +0 으로(결과 비교를 깔끔하게). */
function z0(x) {
  return x === 0 ? 0 : x;
}

function numArray(v, n, name) {
  if (!Array.isArray(v) || v.length !== n) throw new TypeError(`${name} 는 길이 ${n} 배열이어야 한다`);
  for (let i = 0; i < n; i += 1) {
    if (typeof v[i] !== 'number') throw new TypeError(`${name}[${i}] 는 number 여야 한다`);
    if (!Number.isFinite(v[i])) throw new RangeError(`${name}[${i}] 는 유한해야 한다: ${String(v[i])}`);
  }
}

/**
 * 단위 쿼터니언(x,y,z,w) → 행 우선 3×3 회전 행렬(능동 회전, 열 j = 회전된 j 번째 축).
 * 입력이 단위라고 가정한다(normalizeQuat 를 먼저 거친다).
 * @param {number[]} q
 * @returns {number[]}
 */
export function quatToMatrix(q) {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/**
 * 쿼터니언을 단위로 정규화. 길이 0 이거나 비유한이면 RangeError.
 * @param {number[]} q
 * @returns {number[]}
 */
export function normalizeQuat(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(n > 0) || !Number.isFinite(n)) throw new RangeError(`quat 길이가 0 이거나 유한하지 않다: ${n}`);
  return [z0(q[0] / n), z0(q[1] / n), z0(q[2] / n), z0(q[3] / n)];
}

/**
 * 카메라 자세 → {view, viewUpdate}. 계약: contracts/statusview STATUSVIEW_API.syncCamera.
 * @param {{pos:number[], quat:number[], fovY:number}} pose
 * @param {{width:number, height:number, devicePixelRatio:number}} size
 * @param {number} viewSeq
 * @returns {{view: {R:number[], t:number[], K:{fx:number, fy:number, cx:number, cy:number}, width:number, height:number, devicePixelRatio:number},
 *            viewUpdate: {type:'VIEW_UPDATE', viewSeq:number, pos:number[], quat:number[], fovY:number, width:number, height:number}}}
 */
export function syncCamera(pose, size, viewSeq) {
  // ── 검사 ──
  if (pose === null || typeof pose !== 'object') throw new TypeError('pose 는 객체여야 한다');
  const { pos, quat, fovY } = pose;
  numArray(pos, 3, 'pos');
  numArray(quat, 4, 'quat');
  for (let i = 0; i < 3; i += 1) {
    if (!Number.isFinite(Math.fround(pos[i]))) throw new RangeError(`pos[${i}] 가 float32 범위를 넘는다: ${pos[i]}`);
  }
  if (typeof fovY !== 'number') throw new TypeError('fovY 는 number 여야 한다');
  const f32Fov = Math.fround(fovY);
  if (!(fovY > 0 && fovY < Math.PI) || !(f32Fov > 0 && f32Fov < Math.PI)) {
    throw new RangeError(`fovY 는 0<fovY<π 여야 한다(float32 반올림 후에도): ${String(fovY)}`);
  }
  assertViewport(size);
  const { width, height, devicePixelRatio } = size;
  if (width > U16_MAX || height > U16_MAX) {
    throw new RangeError(`width·height 는 VIEW_UPDATE u16 범위(≤ ${U16_MAX})여야 한다: ${width}×${height}`);
  }
  if (typeof viewSeq !== 'number') throw new TypeError('viewSeq 는 number 여야 한다');
  if (!Number.isInteger(viewSeq) || viewSeq < 0 || viewSeq > U32_MAX) throw new RangeError(`viewSeq 는 0..${U32_MAX} 정수여야 한다: ${viewSeq}`);
  const q = normalizeQuat(quat);

  // ── 결과 ──
  const C = quatToMatrix(q); // 카메라→ENU
  const R = [C[0], C[3], C[6], C[1], C[4], C[7], C[2], C[5], C[8]].map(z0); // 전치 = 세계→카메라
  const t = [0, 1, 2].map((i) => z0(-(R[i * 3] * pos[0] + R[i * 3 + 1] * pos[1] + R[i * 3 + 2] * pos[2])));
  const fy = (height / 2) / Math.tan(fovY / 2);
  const view = {
    R,
    t,
    K: { fx: fy, fy, cx: width / 2, cy: height / 2 },
    width,
    height,
    devicePixelRatio,
  };
  const viewUpdate = {
    type: 'VIEW_UPDATE',
    viewSeq,
    pos: [pos[0], pos[1], pos[2]],
    quat: q,
    fovY,
    width,
    height,
  };
  return { view, viewUpdate };
}
