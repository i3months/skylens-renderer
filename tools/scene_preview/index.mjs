// 장면 미리보기 렌더링 도구(T05.10). PNG 인코딩은 node:zlib 을 쓴다.
// 입력: Point27Cloud, GL 규약 시점(eye/target/up/fov_y_deg/width/height)
// 출력: 렌더링된 이미지(rgb 색상, z-버퍼로 가장 가까운 점 우선)

import { deflateSync } from 'node:zlib';

/**
 * 3D 점 하나를 카메라 공간으로 변환하고 투영한다.
 * @param {[number, number, number]} point 월드 공간 점 (x, y, z)
 * @param {[number, number, number]} eye 카메라 위치 (GL 규약)
 * @param {[number, number, number][]} basis [right, up, backward] 카메라 기저 벡터 (정규화됨)
 * @returns {{u: number, v: number, d: number} | null} 화면 좌표 및 깊이, 또는 null (카메라 뒤)
 */
function projectPoint(point, eye, basis, focalLength, cx, cy) {
  const [px, py, pz] = point;
  const [ex, ey, ez] = eye;

  // 월드→카메라 공간: 상대 위치를 기저로 표현
  const relx = px - ex;
  const rely = py - ey;
  const relz = pz - ez;

  const [right, up, backward] = basis;

  // 카메라 공간 좌표
  // right, up은 이미 정규화됨
  const camx = relx * right[0] + rely * right[1] + relz * right[2];
  const camy = relx * up[0] + rely * up[1] + relz * up[2];
  const camz = relx * backward[0] + rely * backward[1] + relz * backward[2];

  // z > 0은 카메라가 바라보는 방향이므로 투영
  // z <= 0은 카메라 뒤에 있으므로 투영하지 않음
  if (camz <= 0) return null;

  // 투시 투영: u = cx + f*x/z, v = cy - f*y/z (GL: y 상향)
  const u = cx + focalLength * camx / camz;
  const v = cy - focalLength * camy / camz;

  return { u, v, d: camz };
}

/**
 * 세 벡터의 외적을 계산한다: a × b
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {[number, number, number]}
 */
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * 벡터의 정규화
 * @param {[number, number, number]} v
 * @returns {[number, number, number]}
 */
function normalize(v) {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len === 0) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * 카메라 기저 벡터 계산 (GL 규약: y-up, 카메라는 -z 바라봄)
 * backward: eye에서 target으로의 방향 (카메라가 보는 방향의 반대)
 * @param {[number, number, number]} eye
 * @param {[number, number, number]} target
 * @param {[number, number, number]} up
 * @returns {[number, number, number][]} [right, up_norm, backward]
 */
function computeBasis(eye, target, up) {
  // forward: eye에서 target으로의 방향
  const forward = [
    target[0] - eye[0],
    target[1] - eye[1],
    target[2] - eye[2],
  ];
  const forwardNorm = normalize(forward);

  // right = up × forward
  const right = cross(normalize(up), forwardNorm);
  const rightNorm = normalize(right);

  // up_norm = forward × right
  const upNorm = cross(forwardNorm, rightNorm);

  // backward = forward (카메라 공간의 z축, 양수가 카메라 앞)
  const backward = forwardNorm;

  return [rightNorm, upNorm, backward];
}

/**
 * 점군을 시점으로 렌더링한다.
 * @param {import('../../contracts/scenes/index.mjs').Point27Cloud | import('../../contracts/scenes/index.mjs').Gauss56Cloud} cloud 점군
 * @param {Object} viewpoint 시점 정보
 * @param {[number, number, number]} viewpoint.eye 카메라 위치
 * @param {[number, number, number]} viewpoint.target 바라보는 점
 * @param {[number, number, number]} viewpoint.up 상향 벡터
 * @param {number} viewpoint.width 이미지 너비
 * @param {number} viewpoint.height 이미지 높이
 * @param {number} viewpoint.fov_y_deg 수직 FOV (도)
 * @returns {{width: number, height: number, rgb: Uint8Array}} 렌더링된 이미지
 */
export function renderPreview(cloud, viewpoint) {
  const { eye, target, up, width, height, fov_y_deg } = viewpoint;

  // 카메라 파라미터
  const fovRad = fov_y_deg * Math.PI / 180;
  const focalLength = (height / 2) / Math.tan(fovRad / 2);
  const cx = width / 2;
  const cy = height / 2;

  // 카메라 기저
  const basis = computeBasis(eye, target, up);

  // RGB 이미지 버퍼 (각 픽셀 3 바이트)
  const rgb = new Uint8Array(width * height * 3);

  // Z-버퍼 (각 픽셀 깊이)
  const zBuffer = new Float32Array(width * height).fill(Infinity);

  // 모든 점을 투영하고 렌더링
  const n = cloud.count;
  const positions = cloud.positions;
  const colors = cloud.colors;

  for (let i = 0; i < n; i++) {
    const point = [
      positions[3 * i],
      positions[3 * i + 1],
      positions[3 * i + 2],
    ];

    const proj = projectPoint(point, eye, basis, focalLength, cx, cy);
    if (proj === null) continue; // 카메라 뒤에 있음

    const { u, v, d } = proj;

    // 화면 범위 체크
    const px = Math.round(u);
    const py = Math.round(v);

    if (px < 0 || px >= width || py < 0 || py >= height) continue;

    const pixelIdx = py * width + px;

    // Z-버퍼 테스트 (가장 가까운 점만 유지)
    if (d < zBuffer[pixelIdx]) {
      zBuffer[pixelIdx] = d;

      // RGB 색상 쓰기
      const colorIdx = 3 * i;
      rgb[3 * pixelIdx] = colors[colorIdx];
      rgb[3 * pixelIdx + 1] = colors[colorIdx + 1];
      rgb[3 * pixelIdx + 2] = colors[colorIdx + 2];
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
