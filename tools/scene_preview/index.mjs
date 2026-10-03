// 장면 미리보기 렌더링 도구(T05.10). PNG 인코딩은 node:zlib 을 쓴다.
// 입력: Point27Cloud(format 1), GL 규약 시점(eye/target/up/fov_y_deg/width/height). 잘못된 입력은 'scene_preview:' Error.
// 출력: 렌더링된 이미지(rgb 색상, z-버퍼로 가장 가까운 점 우선)

import { deflateSync } from 'node:zlib';
import { cameraExtrinsics } from '../../bench/baseline/ref_images/index.mjs';

// 카메라 외부 행렬은 기준 이미지 생성기(bench/baseline/ref_images)의 cameraExtrinsics 를 그대로 쓴다(같은 제품 저장소,
// 읽기 전용 재사용). GL 오른손 규약: z_c = normalize(eye − target), x_c = normalize(up × z_c), y_c = z_c × x_c.
// 시선 forward = −z_c 로 쓰면 right = normalize(forward × up), upNorm = right × forward 와 같다.
// 투영·픽셀 매핑은 아래에 스칼라로 따로 적는다(시험이 ref_images projectCamera 와 독립 대조할 수 있도록).
//   d = −X_c.z, u = cx + f·X_c.x/d, v = cy − f·X_c.y/d, 픽셀 (floor(u), floor(v)) — 픽셀 (i,j) 는 [i,i+1)×[j,j+1).

const ERR = 'scene_preview:';

function isVec3(v) {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/**
 * 시점 입력을 검사한다. 틀리면 'scene_preview:' 로 시작하는 Error.
 * @param {Object} viewpoint
 */
export function assertPreviewViewpoint(viewpoint) {
  if (!viewpoint || typeof viewpoint !== 'object') throw new Error(`${ERR} 시점(viewpoint)이 객체가 아님`);
  const { eye, target, up, width, height, fov_y_deg } = viewpoint;
  for (const [name, v] of [['eye', eye], ['target', target], ['up', up]]) {
    if (!isVec3(v)) throw new Error(`${ERR} ${name} 는 유한한 3-벡터여야 함: ${JSON.stringify(v)}`);
  }
  for (const [name, v] of [['width', width], ['height', height]]) {
    if (!Number.isInteger(v) || v <= 0) throw new Error(`${ERR} ${name} 는 양의 정수여야 함: ${String(v)}`);
  }
  if (width * height * 3 > 0x7fffffff) throw new Error(`${ERR} 이미지가 너무 큼: ${width}×${height}`);
  if (typeof fov_y_deg !== 'number' || !Number.isFinite(fov_y_deg) || !(fov_y_deg > 0 && fov_y_deg < 180)) {
    throw new Error(`${ERR} fov_y_deg 는 0 초과 180 미만의 유한 수여야 함: ${String(fov_y_deg)}`);
  }
  const f = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const fl = Math.hypot(f[0], f[1], f[2]);
  if (!(fl > 1e-9)) throw new Error(`${ERR} eye 와 target 이 같음`);
  const ul = Math.hypot(up[0], up[1], up[2]);
  if (!(ul > 1e-9)) throw new Error(`${ERR} up 이 영벡터임`);
  const c = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
  // 시선과 up 사이 각의 사인 < 1e-6 이면 평행으로 본다(ref_images cameraExtrinsics 의 판정과 같은 문턱).
  if (!(Math.hypot(c[0], c[1], c[2]) >= 1e-6 * fl * ul)) throw new Error(`${ERR} up 이 시선과 평행함`);
}

/**
 * 점군 입력을 검사한다. 미리보기는 27 B(format 1, colors 필요) 만 받는다.
 * @param {Object} cloud
 */
export function assertPreviewCloud(cloud) {
  if (!cloud || typeof cloud !== 'object') throw new Error(`${ERR} 점군(cloud)이 객체가 아님`);
  if (!Number.isInteger(cloud.count) || cloud.count < 0) throw new Error(`${ERR} count 는 0 이상의 정수여야 함: ${String(cloud.count)}`);
  if (!(cloud.colors instanceof Uint8Array)) {
    throw new Error(`${ERR} colors(Uint8Array)가 없음 — 56 B(format 2) 점군은 미리보기할 수 없으니 format 1 로 생성할 것 (format ${String(cloud.format)})`);
  }
  if (!(cloud.positions instanceof Float32Array || cloud.positions instanceof Float64Array)) {
    throw new Error(`${ERR} positions 는 Float32Array 여야 함`);
  }
  if (cloud.positions.length < 3 * cloud.count) throw new Error(`${ERR} positions 길이 ${cloud.positions.length} < 3·count ${3 * cloud.count}`);
  if (cloud.colors.length < 3 * cloud.count) throw new Error(`${ERR} colors 길이 ${cloud.colors.length} < 3·count ${3 * cloud.count}`);
}

/**
 * 점군을 시점으로 렌더링한다(점 크기 1 px, z-버퍼로 가장 가까운 점, 같은 깊이면 먼저 온 점).
 * @param {import('../../contracts/scenes/index.mjs').Point27Cloud} cloud 27 B 점군
 * @param {Object} viewpoint 시점 정보 (GL 규약)
 * @param {[number, number, number]} viewpoint.eye 카메라 위치
 * @param {[number, number, number]} viewpoint.target 바라보는 점
 * @param {[number, number, number]} viewpoint.up 상향 벡터
 * @param {number} viewpoint.width 이미지 너비 (양의 정수)
 * @param {number} viewpoint.height 이미지 높이 (양의 정수)
 * @param {number} viewpoint.fov_y_deg 수직 FOV (도, 0 초과 180 미만)
 * @returns {{width: number, height: number, rgb: Uint8Array}} 렌더링된 이미지 (배경 검정)
 */
export function renderPreview(cloud, viewpoint) {
  assertPreviewViewpoint(viewpoint);
  assertPreviewCloud(cloud);
  const { eye, target, up, width, height, fov_y_deg } = viewpoint;

  const f = (height / 2) / Math.tan((fov_y_deg * Math.PI) / 360);
  const cx = width / 2;
  const cy = height / 2;
  const { R, t } = cameraExtrinsics({ eye, target, up });

  const rgb = new Uint8Array(width * height * 3);
  const zBuffer = new Float64Array(width * height).fill(Infinity);
  const { count: n, positions, colors } = cloud;

  for (let i = 0; i < n; i++) {
    const x = positions[3 * i];
    const y = positions[3 * i + 1];
    const z = positions[3 * i + 2];
    const d = -(R[6] * x + R[7] * y + R[8] * z + t[2]);
    if (!(d > 0)) continue; // 카메라 뒤(또는 비유한)
    const xc = R[0] * x + R[1] * y + R[2] * z + t[0];
    const yc = R[3] * x + R[4] * y + R[5] * z + t[1];
    const px = Math.floor(cx + (f * xc) / d);
    const py = Math.floor(cy - (f * yc) / d);
    if (!(px >= 0 && px < width && py >= 0 && py < height)) continue;
    const pixelIdx = py * width + px;
    if (d < zBuffer[pixelIdx]) {
      zBuffer[pixelIdx] = d;
      rgb[3 * pixelIdx] = colors[3 * i];
      rgb[3 * pixelIdx + 1] = colors[3 * i + 1];
      rgb[3 * pixelIdx + 2] = colors[3 * i + 2];
    }
  }

  return { width, height, rgb };
}

/**
 * PNG 파일로 인코딩한다 (node:zlib 사용, DEFLATE).
 * @param {number} width 이미지 너비
 * @param {number} height 이미지 높이
 * @param {Uint8Array} rgb RGB 색상 데이터 (3n 바이트)
 * @returns {Uint8Array} PNG 파일 바이트
 */
export function encodePng(width, height, rgb) {
  // PNG IHDR 의 너비·높이는 1 ~ 2^31−1 (PNG 명세 11.2.2). 스캔라인 버퍼는 JS 배열 한도 안이어야 한다.
  for (const [name, v] of [['width', width], ['height', height]]) {
    if (!Number.isInteger(v) || v <= 0 || v > 0x7fffffff) throw new Error(`${ERR} encodePng ${name} 는 1~2147483647 정수여야 함: ${String(v)}`);
  }
  if (height * (1 + width * 3) > 0x7fffffff) throw new Error(`${ERR} encodePng 이미지가 너무 큼: ${width}×${height}`);
  if (!(rgb instanceof Uint8Array)) throw new Error(`${ERR} encodePng rgb 는 Uint8Array 여야 함`);
  if (rgb.length !== width * height * 3) throw new Error(`${ERR} encodePng rgb 길이 ${rgb.length} ≠ width·height·3 = ${width * height * 3}`);
  // PNG 파일 구조:
  // 1. PNG 시그니처 (8 바이트)
  // 2. IHDR 청크 (이미지 정보)
  // 3. IDAT 청크 (이미지 데이터, DEFLATE 압축)
  // 4. IEND 청크 (파일 끝)

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR 청크: 너비, 높이, 비트 깊이, 색 타입, 등
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width, false); // 너비 (big-endian)
  ihdrView.setUint32(4, height, false); // 높이
  ihdrData[8] = 8; // 비트 깊이 (8)
  ihdrData[9] = 2; // 색 타입 (2 = RGB)
  ihdrData[10] = 0; // 압축 방식 (0 = DEFLATE)
  ihdrData[11] = 0; // 필터 방식 (0 = 기본)
  ihdrData[12] = 0; // 인터레이스 (0 = 없음)

  const ihdr = createChunk('IHDR', ihdrData);

  // IDAT 청크: 이미지 데이터 (필터 + 압축)
  // PNG는 각 스캔라인 앞에 필터 바이트(0 = 필터 안 함)를 붙인다
  const scanlines = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    scanlines[y * (1 + width * 3)] = 0; // 필터 바이트
    const src = rgb.subarray(y * width * 3, (y + 1) * width * 3);
    scanlines.set(src, y * (1 + width * 3) + 1);
  }

  const compressed = deflateSync(scanlines);
  const idat = createChunk('IDAT', compressed);

  // IEND 청크 (빈 데이터)
  const iend = createChunk('IEND', new Uint8Array(0));

  // 모든 청크 연결
  const result = new Uint8Array(signature.length + ihdr.length + idat.length + iend.length);
  let offset = 0;
  result.set(signature, offset); offset += signature.length;
  result.set(ihdr, offset); offset += ihdr.length;
  result.set(idat, offset); offset += idat.length;
  result.set(iend, offset);

  return result;
}

/**
 * PNG 청크를 생성한다.
 * 형식: 길이(4) | 타입(4) | 데이터 | CRC32(4)
 * @param {string} type 청크 타입 (예: 'IHDR', 'IDAT')
 * @param {Uint8Array} data 청크 데이터
 * @returns {Uint8Array} 전체 청크
 */
function createChunk(type, data) {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);

  // 길이 (big-endian)
  view.setUint32(0, data.length, false);

  // 타입
  chunk[4] = type.charCodeAt(0);
  chunk[5] = type.charCodeAt(1);
  chunk[6] = type.charCodeAt(2);
  chunk[7] = type.charCodeAt(3);

  // 데이터
  chunk.set(data, 8);

  // CRC32 계산 및 쓰기
  const crc = calculateCrc32(chunk, 4, 8 + data.length);
  view.setUint32(8 + data.length, crc, false);

  return chunk;
}

/**
 * CRC32 계산 (PNG용).
 * @param {Uint8Array} data 데이터
 * @param {number} start 시작 오프셋
 * @param {number} end 끝 오프셋
 * @returns {number} CRC32 값
 */
function calculateCrc32(data, start, end) {
  let crc = 0xffffffff;
  const table = getCrc32Table();

  for (let i = start; i < end; i++) {
    const byte = data[i];
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  }

  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * CRC32 테이블 캐시
 */
let crc32Table = null;

function getCrc32Table() {
  if (crc32Table) return crc32Table;

  crc32Table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let k = 0; k < 8; k++) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    crc32Table[i] = crc >>> 0;
  }

  return crc32Table;
}
