// T04.4 손상·불완전 PLY 방어 읽기. PointsError 외 예외·큰 할당 0.
import { PointsError, detectFormat, FORMAT_POINT27, FORMAT_GAUSS56 } from '../../../contracts/points/index.mjs';
import { parsePlyHeader } from '../../../contracts/ply/index.mjs';

const MAX_HEADER = 65536; // 머리 최대 길이(이보다 멀리 end_header 가 있으면 거부)

// 헤더 오류 메시지를 PointsError 코드로 옮긴다
function mapHeaderError(e) {
  const m = String(e && e.message);
  if (/unknown type|list property/.test(m)) return new PointsError('header', m);
  if (/unsupported format|property [xyz] missing|no properties/.test(m)) return new PointsError('format', m);
  if (/vertex missing/.test(m)) return new PointsError('size', m);
  return new PointsError('header', m);
}

/**
 * @param {Uint8Array} bytes
 * @returns {import('../../../contracts/points/index.mjs').Point27Cloud | import('../../../contracts/points/index.mjs').Gauss56Cloud}
 */
export function readPlySafe(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new PointsError('header', 'input is not a Uint8Array');
  // 머리만 잘라 넘긴다(전체 복사 방지)
  const head = bytes.subarray(0, Math.min(bytes.length, MAX_HEADER));
  let h;
  try { h = parsePlyHeader(head); } catch (e) { throw mapHeaderError(e); }

  const fmt = detectFormat(h.properties);
  if (fmt === null) throw new PointsError('format', 'unrecognized vertex property set');
  const n = h.vertexCount;
  if (!Number.isSafeInteger(n) || n > 2 ** 31 - 1) throw new PointsError('size', `vertex count out of range: ${n}`);

  // 할당 전에 본문 길이로 거른다
  const body = bytes.length - h.headerBytes;
  const need = h.stride * n;
  if (body < need) throw new PointsError('truncated', `body ${body} < ${need}`);
  if (body > need) throw new PointsError('size', `body ${body} > ${need}`);

  const dv = new DataView(bytes.buffer, bytes.byteOffset + h.headerBytes, need);
  const f32 = (o) => dv.getFloat32(o, true);
  if (fmt === FORMAT_POINT27) {
    const positions = new Float32Array(3 * n), normals = new Float32Array(3 * n), colors = new Uint8Array(3 * n);
    for (let i = 0, o = 0; i < n; i++, o += 27) {
      for (let k = 0; k < 3; k++) {
        positions[3 * i + k] = f32(o + 4 * k);
        normals[3 * i + k] = f32(o + 12 + 4 * k);
        colors[3 * i + k] = dv.getUint8(o + 24 + k);
      }
    }
    return { format: FORMAT_POINT27, count: n, positions, normals, colors };
  }
  const positions = new Float32Array(3 * n), fdc = new Float32Array(3 * n), opacity = new Float32Array(n);
  const scales = new Float32Array(3 * n), rotations = new Float32Array(4 * n);
  for (let i = 0, o = 0; i < n; i++, o += 56) {
    for (let k = 0; k < 3; k++) {
      positions[3 * i + k] = f32(o + 4 * k);
      fdc[3 * i + k] = f32(o + 12 + 4 * k);
      scales[3 * i + k] = f32(o + 28 + 4 * k);
    }
    opacity[i] = f32(o + 24);
    for (let k = 0; k < 4; k++) rotations[4 * i + k] = f32(o + 40 + 4 * k);
  }
  return { format: FORMAT_GAUSS56, count: n, positions, fdc, opacity, scales, rotations };
}
