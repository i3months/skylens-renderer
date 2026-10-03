// 이진 PLY 전체 읽기(T04.1). 열 배열로 한 번에 채우고 점당 할당은 하지 않는다.
import { parsePlyHeader, PLY_HEADER_MAX_BYTES } from '../../../contracts/ply/index.mjs';
import { PointsError, detectFormat, FORMAT_POINT27, FORMAT_GAUSS56, RECORD_BYTES } from '../../../contracts/points/index.mjs';

/** @param {Uint8Array} bytes @returns {import('../../../contracts/points/index.mjs').Point27Cloud | import('../../../contracts/points/index.mjs').Gauss56Cloud} */
export function readPly(bytes) {
  let h;
  // 헤더 상한 view 만 넘겨 복사를 피한다
  try { h = parsePlyHeader(bytes.subarray(0, PLY_HEADER_MAX_BYTES)); } catch (e) { throw new PointsError('header', e.message); }
  const format = detectFormat(h.properties);
  if (format === null) throw new PointsError('format', 'unknown vertex layout');
  const stride = RECORD_BYTES[format];
  const n = h.vertexCount;
  const expected = h.headerBytes + stride * n;
  if (bytes.byteLength !== expected) throw new PointsError('size', `expected ${expected} bytes, got ${bytes.byteLength}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const base = h.headerBytes;

  if (format === FORMAT_POINT27) {
    const positions = new Float32Array(3 * n);
    const normals = new Float32Array(3 * n);
    const colors = new Uint8Array(3 * n);
    for (let i = 0, o = base; i < n; i++, o += 27) {
      const k = 3 * i;
      positions[k] = dv.getFloat32(o, true); positions[k + 1] = dv.getFloat32(o + 4, true); positions[k + 2] = dv.getFloat32(o + 8, true);
      normals[k] = dv.getFloat32(o + 12, true); normals[k + 1] = dv.getFloat32(o + 16, true); normals[k + 2] = dv.getFloat32(o + 20, true);
      colors[k] = dv.getUint8(o + 24); colors[k + 1] = dv.getUint8(o + 25); colors[k + 2] = dv.getUint8(o + 26);
    }
    return { format: FORMAT_POINT27, count: n, positions, normals, colors };
  }

  // 56 B 가우시안: x y z f_dc0..2 opacity scale0..2 rot0..3
  const positions = new Float32Array(3 * n);
  const fdc = new Float32Array(3 * n);
  const opacity = new Float32Array(n);
  const scales = new Float32Array(3 * n);
  const rotations = new Float32Array(4 * n);
  for (let i = 0, o = base; i < n; i++, o += 56) {
    const k = 3 * i, r = 4 * i;
    positions[k] = dv.getFloat32(o, true); positions[k + 1] = dv.getFloat32(o + 4, true); positions[k + 2] = dv.getFloat32(o + 8, true);
    fdc[k] = dv.getFloat32(o + 12, true); fdc[k + 1] = dv.getFloat32(o + 16, true); fdc[k + 2] = dv.getFloat32(o + 20, true);
    opacity[i] = dv.getFloat32(o + 24, true);
    scales[k] = dv.getFloat32(o + 28, true); scales[k + 1] = dv.getFloat32(o + 32, true); scales[k + 2] = dv.getFloat32(o + 36, true);
    rotations[r] = dv.getFloat32(o + 40, true); rotations[r + 1] = dv.getFloat32(o + 44, true);
    rotations[r + 2] = dv.getFloat32(o + 48, true); rotations[r + 3] = dv.getFloat32(o + 52, true);
  }
  return { format: FORMAT_GAUSS56, count: n, positions, fdc, opacity, scales, rotations };
}
