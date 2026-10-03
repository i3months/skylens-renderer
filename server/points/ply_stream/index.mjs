// T04.3 스트리밍 PLY 읽기: 바이트 청크를 받아 열 배열 조각을 내보낸다. 전체 파일을 모으지 않는다.
import { parsePlyHeader } from '../../../contracts/ply/index.mjs';
import { detectFormat, PointsError, FORMAT_POINT27 } from '../../../contracts/points/index.mjs';

const MAX_HEADER = 1 << 20; // 머리 상한(끝 표시 없이 무한히 쌓이는 것을 막는다)
const MARKER = Buffer.from('end_header\n');
const DEFAULT_CHUNK = 65536;

// 열 배열 한 조각 할당
function makeChunk(format, n) {
  if (format === FORMAT_POINT27) {
    return { format, count: n, positions: new Float32Array(3 * n), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n) };
  }
  return {
    format, count: n, positions: new Float32Array(3 * n), fdc: new Float32Array(3 * n), opacity: new Float32Array(n),
    scales: new Float32Array(3 * n), rotations: new Float32Array(4 * n),
  };
}

// 레코드 하나를 dv 의 o 위치에서 해독해 조각의 i 번째에 쓴다
function decode(format, c, i, dv, o) {
  if (format === FORMAT_POINT27) {
    for (let k = 0; k < 3; k++) {
      c.positions[3 * i + k] = dv.getFloat32(o + 4 * k, true);
      c.normals[3 * i + k] = dv.getFloat32(o + 12 + 4 * k, true);
      c.colors[3 * i + k] = dv.getUint8(o + 24 + k);
    }
  } else {
    for (let k = 0; k < 3; k++) {
      c.positions[3 * i + k] = dv.getFloat32(o + 4 * k, true);
      c.fdc[3 * i + k] = dv.getFloat32(o + 12 + 4 * k, true);
      c.scales[3 * i + k] = dv.getFloat32(o + 28 + 4 * k, true);
    }
    c.opacity[i] = dv.getFloat32(o + 24, true);
    for (let k = 0; k < 4; k++) c.rotations[4 * i + k] = dv.getFloat32(o + 40 + 4 * k, true);
  }
}

/**
 * @param {AsyncIterable<Uint8Array>|Iterable<Uint8Array>} source
 * @param {{chunkPoints?: number}} [opts]
 */
export async function* readPlyStream(source, opts = {}) {
  const chunkPoints = opts.chunkPoints ?? DEFAULT_CHUNK;
  if (!Number.isInteger(chunkPoints) || chunkPoints < 1) throw new PointsError('range', `chunkPoints ${chunkPoints}`);

  let head = Buffer.alloc(0); // 머리 누적(본문이 시작되면 버린다)
  let hdr = null;
  let format = 0;
  let total = 0; // 지금까지 해독한 점 수
  let cur = null; // 채우는 중인 조각
  let fill = 0;
  let part = null; // 레코드 중간에서 잘린 바이트
  let partDv = null;
  let partLen = 0;
  let extra = false;

  for await (const raw of source) {
    let bytes = raw;
    if (!hdr) {
      const prev = head.length;
      head = Buffer.concat([head, bytes]);
      const at = head.indexOf(MARKER, Math.max(0, prev - MARKER.length + 1));
      if (at < 0) {
        if (head.length > MAX_HEADER) throw new PointsError('header', 'end_header not found within limit');
        continue;
      }
      try { hdr = parsePlyHeader(head.subarray(0, at + MARKER.length)); } catch (e) { throw new PointsError('header', e.message); }
      format = detectFormat(hdr.properties);
      if (!format) throw new PointsError('format', 'unknown vertex layout');
      part = new Uint8Array(hdr.stride);
      partDv = new DataView(part.buffer);
      bytes = head.subarray(hdr.headerBytes);
      head = null;
    }
    if (bytes.length === 0) continue;

    const stride = hdr.stride;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 0;
    while (pos < bytes.length) {
      if (total >= hdr.vertexCount) { extra = true; break; }
      if (!cur) { cur = makeChunk(format, Math.min(chunkPoints, hdr.vertexCount - total)); fill = 0; }
      if (partLen > 0 || bytes.length - pos < stride) {
        // 레코드가 청크 경계에 걸림
        const take = Math.min(stride - partLen, bytes.length - pos);
        part.set(bytes.subarray(pos, pos + take), partLen);
        partLen += take; pos += take;
        if (partLen < stride) break;
        decode(format, cur, fill++, partDv, 0);
        partLen = 0; total++;
      } else {
        const n = Math.min(cur.count - fill, Math.floor((bytes.length - pos) / stride));
        for (let k = 0; k < n; k++) decode(format, cur, fill++, dv, pos + k * stride);
        pos += n * stride; total += n;
      }
      if (fill === cur.count) { const out = cur; cur = null; yield out; }
    }
    if (extra) break;
  }

  if (!hdr) throw new PointsError('header', 'stream ended before end_header');
  if (extra) throw new PointsError('size', 'extra bytes after vertex data');
  if (total < hdr.vertexCount || partLen > 0) throw new PointsError('truncated', `got ${total} of ${hdr.vertexCount} points`);
}
