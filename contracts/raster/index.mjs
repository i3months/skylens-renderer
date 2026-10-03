// 참조 래스터라이저 계약(T06). CPU 에서 점군을 한 장의 영상으로 그린다. 이후 모든 화질 비교의 기준이다.
// 좌표·투영 규약은 renderer_basis §2 그대로다.
//   X_c = R·X_w + t          세계(GeoAnchor 기준 ENU, 1 unit = 1 m) → 카메라
//   깊이 d = X_c.z            카메라는 +z 를 본다(OpenCV 규약: x 오른쪽, y 아래, z 앞)
//   [u,v,1]ᵀ ∝ K·X_c         u = fx·X_c.x/d + cx, v = fy·X_c.y/d + cy
//   X_c = d·K⁻¹·[u,v,1]ᵀ     역투영
// 픽셀 (i,j) 는 [i,i+1)×[j,j+1) 칸이고 정수 좌표 (i,j) 는 칸의 왼쪽 위 모서리다(u=i+0.5 가 중심).
// GL 규약 시점(eye/target/up)과의 변환은 diag(1,−1,−1) 이며 tools/render_views 가 맡는다.

/**
 * @typedef {Object} Intrinsics
 * @property {number} fx 픽셀 단위 초점거리(>0)
 * @property {number} fy
 * @property {number} cx 주점 u
 * @property {number} cy 주점 v
 *
 * @typedef {Object} Camera
 * @property {number} width   픽셀(양의 정수)
 * @property {number} height
 * @property {Intrinsics} K
 * @property {number[]} R     3×3 회전, 행 우선 9개 (정규직교, det=+1, 허용 오차 1e-6)
 * @property {number[]} t     3-벡터(m)
 *
 * @typedef {Object} RenderResult
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} color  3·w·h rgb, 행 우선(위에서 아래). 빈 픽셀은 (0,0,0).
 * @property {Float32Array} depth w·h, 가까운 점의 깊이 d(m). 빈 픽셀은 0 (0 은 "점 없음" 표시이고 거리가 아니다).
 * @property {Int32Array} index  w·h, 그 픽셀을 차지한 점의 번호(입력 순서). 빈 픽셀은 −1.
 *
 * 빈 픽셀은 메우지 않는다(skylens 원칙: 도착하지 않은 것을 그리거나 메우지 않는다).
 * 같은 깊이면 먼저 온 점(번호 작은 점)이 이긴다.
 */

export const EMPTY_DEPTH = 0;
export const EMPTY_INDEX = -1;
/** 해상도 상한: width·height ≤ 2^26 (8192×8192). 넘으면 버퍼 할당 전에 'raster:' 오류로 거부한다. */
export const MAX_PIXELS = 2 ** 26;

/** 함수 서명(구현은 server/raster_ref/*, server/metrics/*). 이름과 모듈 위치는 이 표가 기준이다. */
export const RASTER_API = Object.freeze({
  project: { module: 'server/raster_ref/project/index.mjs', fn: 'project(camera, xw) -> {u, v, d}   d<=0 또는 d 가 극히 작으면 u,v 는 NaN' },
  unproject: { module: 'server/raster_ref/unproject/index.mjs', fn: 'unproject(camera, u, v, d) -> [xw, yw, zw]' },
  intrinsics: { module: 'server/raster_ref/intrinsics/index.mjs', fn: 'scaleIntrinsics(K, fromW, fromH, toW, toH) -> Intrinsics' },
  splat: { module: 'server/raster_ref/splat/index.mjs', fn: 'splatRadiusPx(camera, depth, sizeM) -> number  (= fx·sizeM/(2·d))' },
  zbuffer: { module: 'server/raster_ref/zbuffer/index.mjs', fn: 'renderPoints(camera, cloud, opts?) -> RenderResult  (opts.pointSizeM 기본 0.05)' },
  shade: { module: 'server/raster_ref/shade/index.mjs', fn: 'lambert(normalWorld, lightDirWorld, rgb) -> [r,g,b]' },
  no_fill: { module: 'server/raster_ref/no_fill/index.mjs', fn: 'countEmpty(result) -> number' },
  ssim: { module: 'server/metrics/ssim/index.mjs', fn: 'ssim(a, b, width, height, channels) -> number' },
  psnr: { module: 'server/metrics/psnr/index.mjs', fn: 'psnr(a, b) -> number ; emptyRatio(result) -> number' },
  render_views: { module: 'tools/render_views/index.mjs', fn: 'renderViews(cloud, viewpoints, opts?) -> RenderResult[]' },
});

const ERR = 'raster:';

/** 해상도가 양의 정수이고 상한(MAX_PIXELS) 이내인지 검사한다. */
function assertResolution(width, height) {
  for (const [n, v] of [['width', width], ['height', height]]) {
    if (!Number.isInteger(v) || v <= 0) throw new Error(`${ERR} ${n} 는 양의 정수여야 함: ${String(v)}`);
  }
  if (width * height > MAX_PIXELS) throw new Error(`${ERR} 해상도 ${width}×${height} 가 상한 ${MAX_PIXELS} 픽셀을 넘음`);
}

/** 카메라가 계약대로인지 검사한다. 틀리면 'raster:' 로 시작하는 Error. */
export function assertCamera(camera) {
  if (!camera || typeof camera !== 'object') throw new Error(`${ERR} 카메라가 객체가 아님`);
  const { width, height, K, R, t } = camera;
  assertResolution(width, height);
  if (!K || typeof K !== 'object') throw new Error(`${ERR} K 가 객체가 아님`);
  for (const n of ['fx', 'fy']) {
    if (typeof K[n] !== 'number' || !Number.isFinite(K[n]) || !(K[n] > 0)) throw new Error(`${ERR} K.${n} 는 양의 유한 수여야 함: ${String(K[n])}`);
  }
  for (const n of ['cx', 'cy']) {
    if (typeof K[n] !== 'number' || !Number.isFinite(K[n])) throw new Error(`${ERR} K.${n} 는 유한 수여야 함: ${String(K[n])}`);
  }
  if (!Array.isArray(R) || R.length !== 9 || !R.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new Error(`${ERR} R 은 유한한 9개 수여야 함`);
  }
  if (!Array.isArray(t) || t.length !== 3 || !t.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new Error(`${ERR} t 는 유한한 3-벡터여야 함`);
  }
  // 정규직교: R·Rᵀ = I, det = +1
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      let s = 0;
      for (let k = 0; k < 3; k += 1) s += R[i * 3 + k] * R[j * 3 + k];
      if (Math.abs(s - (i === j ? 1 : 0)) > 1e-6) throw new Error(`${ERR} R 이 정규직교가 아님`);
    }
  }
  const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
  if (Math.abs(det - 1) > 1e-6) throw new Error(`${ERR} R 의 행렬식이 +1 이 아님: ${det}`);
}

/** 렌더 결과를 만든다(빈 영상). */
export function emptyResult(width, height) {
  assertResolution(width, height);
  return { width, height, color: new Uint8Array(3 * width * height), depth: new Float32Array(width * height), index: new Int32Array(width * height).fill(EMPTY_INDEX) };
}

/** 렌더 결과가 계약대로인지 검사한다. */
export function assertRenderResult(r) {
  if (!r || typeof r !== 'object') throw new Error(`${ERR} 결과가 객체가 아님`);
  const { width, height, color, depth, index } = r;
  assertResolution(width, height);
  const n = width * height;
  if (!(color instanceof Uint8Array) || color.length !== 3 * n) throw new Error(`${ERR} color 길이 ${n * 3} 이어야 함`);
  if (!(depth instanceof Float32Array) || depth.length !== n) throw new Error(`${ERR} depth 길이 ${n} 이어야 함`);
  if (!(index instanceof Int32Array) || index.length !== n) throw new Error(`${ERR} index 길이 ${n} 이어야 함`);
  for (let i = 0; i < n; i += 1) {
    const empty = index[i] === EMPTY_INDEX;
    if (index[i] < EMPTY_INDEX) throw new Error(`${ERR} 픽셀 ${i}: 점 번호는 −1(빈 칸) 또는 0 이상이어야 함: ${index[i]}`);
    if (empty !== (depth[i] === EMPTY_DEPTH)) throw new Error(`${ERR} 픽셀 ${i}: 빈 깊이와 빈 번호가 어긋남`);
    if (!empty && !(depth[i] > 0 && Number.isFinite(depth[i]))) throw new Error(`${ERR} 픽셀 ${i}: 깊이는 양의 유한 수여야 함`);
    if (empty && (color[3 * i] | color[3 * i + 1] | color[3 * i + 2]) !== 0) throw new Error(`${ERR} 픽셀 ${i}: 빈 픽셀 색은 (0,0,0)`);
  }
}
