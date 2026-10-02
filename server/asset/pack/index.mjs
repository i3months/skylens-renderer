// 조각 쓰기(packer). 명세 format/ASSET_FORMAT.md §4~§5, §7, §12 의 식을 직접 구현한다.
import { crc32 } from 'node:zlib';
import {
  FORMAT_POINT27, FORMAT_GAUSS56, CODEC_RAW_PLANAR, VERSION_MAJOR, VERSION_MINOR, HEADER_SIZE, TILE_SIZE_M,
  POSITION_Q_MAX, SH_C0, SCALE_LOG_MIN, SCALE_LOG_STEPS_PER_UNIT, OCT_SNORM_MAX, ROT_COMPONENT_CENTER,
  ROT_COMPONENT_MAX, OFFSETS, AssetFormatError, bodyLayout, serializeHeader,
} from '../../../contracts/asset/index.mjs';

// 명세 §5.0 반올림(0.5 는 올림)
const round = (x) => Math.floor(x + 0.5);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** @param {ArrayLike<unknown>} vals @param {string} what */
function assertFinite(vals, what) {
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new AssetFormatError('field', `${what} not finite`);
  }
}

/**
 * 팔면체 snorm8 법선 부호화(§5.3). 길이 0·비유한은 던진다.
 * @param {number} x @param {number} y @param {number} z
 * @returns {[number, number]}
 */
export function encodeOctNormal(x, y, z) {
  assertFinite([x, y, z], 'normal');
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z);
  if (!(l1 > 0) || !Number.isFinite(l1)) throw new AssetFormatError('field', 'normal has zero or overflowing length');
  let u = x / l1;
  let v = y / l1;
  if (z < 0) {
    const su = u >= 0 ? 1 : -1;
    const sv = v >= 0 ? 1 : -1;
    [u, v] = [(1 - Math.abs(v)) * su, (1 - Math.abs(u)) * sv];
  }
  return [
    clamp(round(u * OCT_SNORM_MAX), -OCT_SNORM_MAX, OCT_SNORM_MAX),
    clamp(round(v * OCT_SNORM_MAX), -OCT_SNORM_MAX, OCT_SNORM_MAX),
  ];
}

/**
 * smallest-three 회전 부호화(§5.4). 입력 (w, x, y, z), 정규화 전이어도 된다. 길이 0 은 던진다.
 * @param {number} w @param {number} x @param {number} y @param {number} z
 * @returns {number} u32
 */
export function encodeRotation(w, x, y, z) {
  assertFinite([w, x, y, z], 'rotation');
  const len = Math.hypot(w, x, y, z);
  if (!(len > 0) || !Number.isFinite(len)) throw new AssetFormatError('field', 'rotation has zero or overflowing length');
  let q = [w / len, x / len, y / len, z / len];
  let m = 0;
  for (let k = 1; k < 4; k++) if (Math.abs(q[k]) > Math.abs(q[m])) m = k;
  if (q[m] < 0) q = q.map((c) => -c);
  const rest = [];
  for (let k = 0; k < 4; k++) {
    if (k !== m) rest.push(clamp(round(q[k] * Math.SQRT2 * ROT_COMPONENT_CENTER) + ROT_COMPONENT_CENTER, 0, ROT_COMPONENT_MAX));
  }
  return ((m << 30) | (rest[0] << 20) | (rest[1] << 10) | rest[2]) >>> 0;
}

/** 형식별 필드 길이를 검사하고 점 수를 돌려준다. */
function pointCountOf(format, f) {
  if (!f || !(f.positions instanceof Float32Array) || f.positions.length % 3 !== 0) {
    throw new AssetFormatError('field', 'positions must be a Float32Array of length 3n');
  }
  const n = f.positions.length / 3;
  if (n < 1) throw new AssetFormatError('field', 'no points');
  const need = format === FORMAT_POINT27
    ? [['normals', f.normals, 3 * n, Float32Array], ['colors', f.colors, 3 * n, Uint8Array]]
    : [['fdc', f.fdc, 3 * n, Float32Array], ['opacity', f.opacity, n, Float32Array],
       ['scales', f.scales, 3 * n, Float32Array], ['rotations', f.rotations, 4 * n, Float32Array]];
  for (const [name, arr, len, T] of need) {
    if (!(arr instanceof T) || arr.length !== len) throw new AssetFormatError('field', `${name} must be ${T.name}(${len})`);
  }
  return n;
}

/**
 * 원본 필드로 조각 파일 한 개를 만든다(헤더 + 본문, 체크섬 채움). 점 순서는 입력 그대로.
 * @param {Parameters<typeof import('../../../contracts/asset/stubs.mjs').packChunk>[0]} input
 * @returns {Uint8Array}
 */
export function packChunk(input) {
  const { format, segmentId, level, lod, chunkIndex, anchor, fields } = input;
  if (format !== FORMAT_POINT27 && format !== FORMAT_GAUSS56) throw new AssetFormatError('format', `unknown format ${format}`);
  const n = pointCountOf(format, fields);
  const pos = fields.positions;
  assertFinite(pos, 'positions');
  if (format === FORMAT_POINT27) assertFinite(fields.normals, 'normals');
  else for (const k of ['fdc', 'opacity', 'scales', 'rotations']) assertFinite(fields[k], k);

  // 점에서 bbox 계산
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const v = pos[3 * i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  const tileX = Math.floor(min[0] / TILE_SIZE_M);
  const tileY = Math.floor(min[1] / TILE_SIZE_M);
  if (Math.floor(max[0] / TILE_SIZE_M) !== tileX || Math.floor(max[1] / TILE_SIZE_M) !== tileY) {
    throw new AssetFormatError('tile', 'points span more than one tile');
  }
  // 10 → 9 → 8 중 가장 큰 k
  let qexp = 0;
  for (const k of [10, 9, 8]) {
    if ([0, 1, 2].every((a) => (max[a] - min[a]) * 2 ** k <= POSITION_Q_MAX)) { qexp = k; break; }
  }
  if (!qexp) throw new AssetFormatError('range', 'position extent exceeds 65535 * 2^-8 m; split the chunk');

  const layout = bodyLayout(format, n);
  // segmentId·level 등 자료형 범위는 serializeHeader 가 검사한다
  const header = serializeHeader({
    versionMajor: VERSION_MAJOR, versionMinor: VERSION_MINOR, headerSize: HEADER_SIZE, format, codec: CODEC_RAW_PLANAR,
    segmentId, level, pointCount: n, tileX, tileY, tileSizeM: TILE_SIZE_M, lod, quantExp: qexp, chunkIndex,
    bodyBytes: layout.requiredBytes, bboxMin: min, bboxMax: max, anchor, checksum: 0,
  });
  const file = new Uint8Array(HEADER_SIZE + layout.requiredBytes);
  file.set(header, 0);
  const dv = new DataView(file.buffer);
  const scale = 2 ** qexp;
  const q = (i, a) => clamp(round((pos[3 * i + a] - min[a]) * scale), 0, POSITION_Q_MAX);

  /** @type {Record<string, (i: number) => number>} */
  const get = { pos_e: (i) => q(i, 0), pos_n: (i) => q(i, 1), pos_u: (i) => q(i, 2) };
  if (format === FORMAT_POINT27) {
    ['r', 'g', 'b'].forEach((c, k) => { get[`color_${c}`] = (i) => fields.colors[3 * i + k]; });
    const oct = new Int8Array(2 * n);
    for (let i = 0; i < n; i++) {
      const [qx, qy] = encodeOctNormal(fields.normals[3 * i], fields.normals[3 * i + 1], fields.normals[3 * i + 2]);
      oct[2 * i] = qx;
      oct[2 * i + 1] = qy;
    }
    get.normal_oct_x = (i) => oct[2 * i];
    get.normal_oct_y = (i) => oct[2 * i + 1];
  } else {
    ['r', 'g', 'b'].forEach((c, k) => {
      get[`color_${c}`] = (i) => clamp(round((0.5 + SH_C0 * fields.fdc[3 * i + k]) * 255), 0, 255);
    });
    get.opacity = (i) => clamp(round(255 / (1 + Math.exp(-fields.opacity[i]))), 0, 255);
    for (let k = 0; k < 3; k++) {
      get[`scale_${k}`] = (i) => clamp(round((fields.scales[3 * i + k] - SCALE_LOG_MIN) * SCALE_LOG_STEPS_PER_UNIT), 0, 255);
    }
    const r = fields.rotations;
    get.rotation = (i) => encodeRotation(r[4 * i], r[4 * i + 1], r[4 * i + 2], r[4 * i + 3]);
  }
  for (const p of layout.planes) {
    const base = HEADER_SIZE + p.offset;
    const f = get[p.name];
    for (let i = 0; i < n; i++) {
      const v = f(i);
      if (p.type === 'u16') dv.setUint16(base + 2 * i, v, true);
      else if (p.type === 'u8') dv.setUint8(base + i, v);
      else if (p.type === 'i8') dv.setInt8(base + i, v);
      else dv.setUint32(base + 4 * i, v, true);
    }
  }
  // 체크섬은 필드가 0 인 상태로 계산해 마지막에 채운다(§7)
  dv.setUint32(OFFSETS.checksum, crc32(file), true);
  return file;
}
