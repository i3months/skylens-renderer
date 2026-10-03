// T04.3 스트리밍 PLY 읽기: 바이트 청크를 받아 열 배열 조각을 내보낸다. 전체 파일을 모으지 않는다.
import { parsePlyHeader } from '../../../contracts/ply/index.mjs';
import { detectFormat, PointsError, FORMAT_POINT27 } from '../../../contracts/points/index.mjs';

const MAX_HEADER = 1 << 20; // 머리 상한(끝 표시 없이 무한히 쌓이는 것을 막는다)
const MARKER = Buffer.from('end_header\n');
// KMP 실패 함수
const FAIL = (() => {
  const f = new Uint8Array(MARKER.length);
  for (let i = 1, k = 0; i < MARKER.length; i++) {
    while (k > 0 && MARKER[i] !== MARKER[k]) k = f[k - 1];
    if (MARKER[i] === MARKER[k]) k++;
    f[i] = k;
  }
  return f;
})();
const BLOCK = 4096; // 머리 누적 블록 크기
const DEFAULT_CHUNK = 65536;
const MAX_CHUNK_POINTS = 1 << 20; // 조각 하나의 점 수 상한(열 배열 할당 크기를 묶는다)
const MAX_VERTEX_COUNT = 2 ** 30; // 머리가 선언할 수 있는 점 수 상한

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
export async function* readPlyStream(source, opts) {
  const chunkPoints = (opts ?? {}).chunkPoints ?? DEFAULT_CHUNK;
  if (!Number.isInteger(chunkPoints) || chunkPoints < 1 || chunkPoints > MAX_CHUNK_POINTS) throw new PointsError('range', `chunkPoints ${chunkPoints}`);
  if (source == null || (typeof source[Symbol.asyncIterator] !== 'function' && typeof source[Symbol.iterator] !== 'function')) {
    throw new PointsError('header', 'source is not iterable');
  }

  let headParts = []; // 머리 청크 목록(끝 표시를 찾은 뒤에 한 번만 합친다)
  let headLen = 0;
  let block = Buffer.allocUnsafe(BLOCK);
  let blockLen = 0;
  let m = 0; // 끝 표시와 지금까지 일치한 길이(KMP 상태)
  let hdr = null;
  let format = 0;
  let total = 0; // 지금까지 해독한 점 수
  let cur = null; // 채우는 중인 조각
  let fill = 0;
  let part = null; // 레코드 중간에서 잘린 바이트
  let partDv = null;
  let partLen = 0;
  let extra = false;

  // 청크 하나를 처리하는 동기 제너레이터(동기 소스에서 청크마다 await 하지 않으려고 분리)
  function* consume(raw) {
    // source 는 Uint8Array만 허용한다(Buffer는 instanceof 검사에서 엔진마다 다를 수 있음)
    if (!(raw instanceof Uint8Array)) throw new PointsError('header', 'chunk is not a Uint8Array');
    let bytes = raw;
    if (!hdr) {
      // 끝 표시를 바이트 단위 KMP 로 찾는다(할당 없이 청크 경계를 넘어 이어 간다)
      // 머리 상한 안에서만 찾는다: 이미 쌓인 길이를 뺀 남은 칸 밖은 훑지도 복사하지도 않는다
      const room = MAX_HEADER - headLen;
      const scanEnd = Math.min(raw.length, room);
      let found = -1;
      for (let j = 0; j < scanEnd; j++) {
        const c = raw[j];
        while (m > 0 && c !== MARKER[m]) m = FAIL[m - 1];
        if (c === MARKER[m]) m++;
        if (m === MARKER.length) { found = j; break; }
      }
      if (found < 0) {
        if (raw.length > room) throw new PointsError('header', 'end_header not found within limit');
        // 작은 청크는 4 KiB 블록에 모아 복사한다(호출자가 버퍼를 재사용해도 안전하고 객체 수도 줄어든다)
        if (raw.length > BLOCK - blockLen) {
          if (blockLen > 0) { headParts.push(block.subarray(0, blockLen)); block = Buffer.allocUnsafe(BLOCK); blockLen = 0; }
          if (raw.length >= BLOCK) headParts.push(Buffer.from(raw));
          else { block.set(raw, 0); blockLen = raw.length; }
        } else { block.set(raw, blockLen); blockLen += raw.length; }
        headLen += raw.length;
        return;
      }
      // 머리는 표시 끝까지만 합치고, 본문은 복사 없이 뷰로 넘긴다
      const end = headLen + found + 1;
      const head = Buffer.concat([...headParts, block.subarray(0, blockLen), raw.subarray(0, found + 1)], end);
      headParts = null; block = null;
      try { hdr = parsePlyHeader(head); } catch (e) { throw new PointsError('header', e.message); }
      if (!(hdr.vertexCount <= MAX_VERTEX_COUNT)) throw new PointsError('range', `vertexCount ${hdr.vertexCount}`);
      format = detectFormat(hdr.properties);
      if (!format) throw new PointsError('format', 'unknown vertex layout');
      part = new Uint8Array(hdr.stride);
      partDv = new DataView(part.buffer);
      bytes = raw.subarray(found + 1);
    }
    if (bytes.length === 0) return;

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
  }

  if (typeof source[Symbol.asyncIterator] === 'function') {
    for await (const raw of source) { for (const out of consume(raw)) yield out; if (extra) break; }
  } else {
    for (const raw of source) { for (const out of consume(raw)) yield out; if (extra) break; }
  }

  // 헤더 끝 표시("end_header\n")를 찾지 못함(CRLF 헤더면 "\r\n" 때문에 실패할 수 있음)
  if (!hdr) throw new PointsError('header', 'stream ended before end_header');
  if (extra) throw new PointsError('size', 'extra bytes after vertex data');
  if (total < hdr.vertexCount || partLen > 0) throw new PointsError('truncated', `got ${total} of ${hdr.vertexCount} points`);
}
