// T03.7 역변환: .skla 조각 → 원본 형식 필드·레코드. 명세 format/ASSET_FORMAT.md §4·§6·§8.
// 체크섬은 보지 않는다(verifyChecksum 별도). 손상 입력에는 AssetFormatError 만 던진다.
import {
  AssetFormatError, parseHeader, bodyLayout,
  FORMAT_POINT27, CODEC_RAW_PLANAR, QUANT_EXP_MIN, QUANT_EXP_MAX,
  SH_C0, SCALE_LOG_MIN, SCALE_LOG_STEPS_PER_UNIT, OCT_SNORM_MAX, ROT_COMPONENT_CENTER, ROT_COMPONENT_MAX,
  SOURCE_RECORD_BYTES,
} from '../../../contracts/asset/index.mjs';

/** @typedef {import('../../../contracts/asset/index.mjs').AssetHeader} AssetHeader */
/** @typedef {import('../../../contracts/asset/index.mjs').Point27Fields} Point27Fields */
/** @typedef {import('../../../contracts/asset/index.mjs').Gauss56Fields} Gauss56Fields */

const ROT_SCALE = ROT_COMPONENT_CENTER * Math.SQRT2;
const ALPHA_MIN = 1 / 510;
const ALPHA_MAX = 509 / 510;

// f32Toward 용 재사용 스크래치(호출마다 할당하지 않는다). 동기 함수라 재진입 없음.
const F32_SCRATCH = new Float32Array(1);
const I32_SCRATCH = new Int32Array(F32_SCRATCH.buffer);
const ROT_SCRATCH = new Float64Array(4);
const ROT_OUT = new Float64Array(4);

/**
 * f32 로 내리되 dir<0 이면 x 이하, dir>0 이면 x 이상인 가장 가까운 값을 고른다.
 * 저장 값 구간 [q−0.5, q+0.5) 은 아래 끝(동점, 원본 < 복원)이 닫혀 있어, 복원 값을 아래로 내리면
 * 동점 원본(예: f_dc 0, 로짓 0)의 오차가 §8 상한을 f32 반올림만큼 넘지 않는다.
 * @param {number} x 유한, 0 아님
 * @param {-1|1} dir
 */
function f32Toward(x, dir) {
  const f = Math.fround(x);
  if (dir < 0 ? f <= x : f >= x) return f;
  F32_SCRATCH[0] = f;
  // 크기 방향으로 한 ulp 옮긴다(f 와 x 는 같은 부호, 0 아님)
  I32_SCRATCH[0] += (f > 0) === (dir > 0) ? 1 : -1;
  return F32_SCRATCH[0];
}

/**
 * 팔면체 snorm8 법선 복원(명세 §6).
 * @param {number} qx −127..127
 * @param {number} qy −127..127
 * @returns {[number, number, number]}
 */
export function decodeOctNormal(qx, qy) {
  if (!Number.isInteger(qx) || !Number.isInteger(qy) || Math.abs(qx) > OCT_SNORM_MAX || Math.abs(qy) > OCT_SNORM_MAX) {
    throw new AssetFormatError('range', `oct normal (${qx}, ${qy}) not in ±${OCT_SNORM_MAX}`);
  }
  let u = qx / OCT_SNORM_MAX;
  let v = qy / OCT_SNORM_MAX;
  const z = 1 - Math.abs(u) - Math.abs(v);
  if (z < 0) {
    const su = u >= 0 ? 1 : -1;
    const sv = v >= 0 ? 1 : -1;
    [u, v] = [(1 - Math.abs(v)) * su, (1 - Math.abs(u)) * sv];
  }
  const len = Math.hypot(u, v, z);
  return [u / len, v / len, z / len];
}

/**
 * smallest-three 회전 복원(명세 §6).
 * @param {number} packed u32
 * @returns {[number, number, number, number]} (w, x, y, z)
 */
export function decodeRotation(packed) {
  const q = [0, 0, 0, 0];
  decodeRotationInto(packed, q, 0);
  return q;
}

/** decodeRotation 본체: out[o..o+3] 에 (w, x, y, z) 를 쓴다(할당 없음). */
function decodeRotationInto(packed, out, o) {
  if (!Number.isInteger(packed) || packed < 0 || packed > 0xffffffff) {
    throw new AssetFormatError('range', `rotation ${packed} not u32`);
  }
  const m = packed >>> 30;
  const a = [(packed >>> 20) & 1023, (packed >>> 10) & 1023, packed & 1023];
  const q = ROT_SCRATCH;
  q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 0;
  let sum = 0;
  let j = 0;
  for (let k = 0; k < 4; k++) {
    if (k === m) continue;
    if (a[j] > ROT_COMPONENT_MAX) throw new AssetFormatError('range', `rotation component ${a[j]} > ${ROT_COMPONENT_MAX}`);
    q[k] = (a[j] - ROT_COMPONENT_CENTER) / ROT_SCALE;
    sum += q[k] * q[k];
    j++;
  }
  q[m] = Math.sqrt(Math.max(0, 1 - sum));
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  out[o] = q[0] / len; out[o + 1] = q[1] / len; out[o + 2] = q[2] / len; out[o + 3] = q[3] / len;
  largestNonNegative(out, o);
}

/**
 * 반올림으로 다른 성분이 q_m 보다 커질 수 있어, 가장 큰 성분(같으면 작은 k)이 음수면 전체 부호를 뒤집는다(같은 회전).
 * @template {ArrayLike<number> & {[i: number]: number}} T
 * @param {T} q 길이 4 이상(o 부터 4개를 본다)
 * @param {number} [o] 시작 인덱스
 * @returns {T}
 */
function largestNonNegative(q, o = 0) {
  let m = o;
  for (let k = o + 1; k < o + 4; k++) if (Math.abs(q[k]) > Math.abs(q[m])) m = k;
  if (q[m] < 0) for (let k = o; k < o + 4; k++) q[k] = -q[k];
  return q;
}

/** 헤더·길이 검사 후 필수 평면 뷰를 준다. */
function readPlanes(fileBytes) {
  if (!(fileBytes instanceof Uint8Array)) throw new AssetFormatError('short', 'input is not bytes');
  const header = parseHeader(fileBytes);
  if (header.codec !== CODEC_RAW_PLANAR) throw new AssetFormatError('codec', `unknown codec ${header.codec}`);
  if (!Number.isInteger(header.quantExp) || header.quantExp < QUANT_EXP_MIN || header.quantExp > QUANT_EXP_MAX) {
    throw new AssetFormatError('field', `quantExp ${header.quantExp}`);
  }
  if (header.pointCount < 1) throw new AssetFormatError('field', 'pointCount 0');
  if (!header.bboxMin.every(Number.isFinite)) throw new AssetFormatError('bbox', 'bboxMin not finite');
  const n = header.pointCount;
  const layout = bodyLayout(header.format, n);
  if (header.bodyBytes < layout.requiredBytes) {
    throw new AssetFormatError('body', `bodyBytes ${header.bodyBytes} < required ${layout.requiredBytes}`);
  }
  if (header.headerSize + header.bodyBytes !== fileBytes.length) {
    throw new AssetFormatError('body', `headerSize + bodyBytes ${header.headerSize + header.bodyBytes} != file ${fileBytes.length}`);
  }
  const dv = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
  const base = header.headerSize;
  // 평면 값 읽기(정렬과 무관하게 DataView 로 읽는다)
  const planes = {};
  for (const p of layout.planes) {
    const o = base + p.offset;
    let arr;
    if (p.type === 'u16') { arr = new Uint16Array(n); for (let i = 0; i < n; i++) arr[i] = dv.getUint16(o + 2 * i, true); }
    else if (p.type === 'u8') arr = fileBytes.slice(o, o + n);
    else if (p.type === 'i8') { arr = new Int8Array(n); for (let i = 0; i < n; i++) arr[i] = dv.getInt8(o + i); }
    else { arr = new Uint32Array(n); for (let i = 0; i < n; i++) arr[i] = dv.getUint32(o + 4 * i, true); }
    planes[p.name] = arr;
  }
  return { header, planes, n };
}

/**
 * 조각을 원본 형식 필드로 되돌린다(명세 §6). codec 0 만 안다. 체크섬은 검사하지 않는다.
 * 의미 검사 범위: 헤더 파싱·codec·quantExp·pointCount≥1·bboxMin 유한·본문 길이만 본다.
 * lod·tileSizeM·bboxMax·타일/bbox 일치는 검사하지 않는다(필요하면 readHeaderStrict 로 먼저 검증).
 * @param {Uint8Array} fileBytes
 * @returns {{header: AssetHeader, fields: Point27Fields | Gauss56Fields}}
 */
export function unpackChunk(fileBytes) {
  const { header, planes, n } = readPlanes(fileBytes);
  // 위치: f64 로 복원한 뒤 f32 로 반올림(최근접 짝수)
  const step = 2 ** -header.quantExp;
  const positions = new Float32Array(3 * n);
  const posPlanes = [planes.pos_e, planes.pos_n, planes.pos_u];
  for (let a = 0; a < 3; a++) {
    const min = header.bboxMin[a];
    const qa = posPlanes[a];
    for (let i = 0; i < n; i++) positions[3 * i + a] = min + qa[i] * step;
  }
  const cr = planes.color_r, cg = planes.color_g, cb = planes.color_b;

  if (header.format === FORMAT_POINT27) {
    const colors = new Uint8Array(3 * n);
    const normals = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      colors[3 * i] = cr[i]; colors[3 * i + 1] = cg[i]; colors[3 * i + 2] = cb[i];
      const nv = decodeOctNormal(planes.normal_oct_x[i], planes.normal_oct_y[i]);
      normals[3 * i] = nv[0]; normals[3 * i + 1] = nv[1]; normals[3 * i + 2] = nv[2];
    }
    return { header, fields: { positions, normals, colors } };
  }

  // 형식 2(56 B 가우시안). parseHeader 가 다른 형식을 거부한다
  const fdc = new Float32Array(3 * n);
  const opacity = new Float32Array(n);
  const scales = new Float32Array(3 * n);
  const rotations = new Float32Array(4 * n);
  const sp = [planes.scale_0, planes.scale_1, planes.scale_2];
  const cp = [cr, cg, cb];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      fdc[3 * i + k] = f32Toward((cp[k][i] / 255 - 0.5) / SH_C0, -1);
      scales[3 * i + k] = sp[k][i] / SCALE_LOG_STEPS_PER_UNIT + SCALE_LOG_MIN;
    }
    const q = planes.opacity[i];
    const alpha = Math.min(ALPHA_MAX, Math.max(ALPHA_MIN, q / 255));
    const logit = Math.log(alpha / (1 - alpha));
    // q=255 는 복원 α(509/510)가 구간 아래 끝이라 위로, 나머지는 아래로 내린다
    opacity[i] = f32Toward(logit, q === 255 ? 1 : -1);
    // f64 로 복원·부호 정리한 뒤 f32 로 옮긴다(decodeRotation 과 같은 순서)
    decodeRotationInto(planes.rotation[i], ROT_OUT, 0);
    rotations[4 * i] = ROT_OUT[0]; rotations[4 * i + 1] = ROT_OUT[1]; rotations[4 * i + 2] = ROT_OUT[2]; rotations[4 * i + 3] = ROT_OUT[3];
    // f32 로 내린 뒤 크기 순서가 바뀔 수 있어 한 번 더 맞춘다(부호 반전은 f32 에서 정확)
    largestNonNegative(rotations, 4 * i);
  }
  return { header, fields: { positions, fdc, opacity, scales, rotations } };
}

/**
 * 조각을 원본 PLY 정점 레코드 바이트열로 되돌린다. little-endian, 점 순서 = 본문 순서.
 * @param {Uint8Array} fileBytes
 * @returns {Uint8Array} pointCount × 27 또는 × 56
 */
export function toSourceRecords(fileBytes) {
  const { header, fields } = unpackChunk(fileBytes);
  const n = header.pointCount;
  const rec = SOURCE_RECORD_BYTES[header.format];
  const out = new Uint8Array(n * rec);
  const dv = new DataView(out.buffer);
  if (header.format === FORMAT_POINT27) {
    const { positions, normals, colors } = /** @type {Point27Fields} */ (fields);
    for (let i = 0; i < n; i++) {
      const o = i * rec;
      for (let a = 0; a < 3; a++) {
        dv.setFloat32(o + 4 * a, positions[3 * i + a], true);
        dv.setFloat32(o + 12 + 4 * a, normals[3 * i + a], true);
        out[o + 24 + a] = colors[3 * i + a];
      }
    }
    return out;
  }
  const { positions, fdc, opacity, scales, rotations } = /** @type {Gauss56Fields} */ (fields);
  for (let i = 0; i < n; i++) {
    const o = i * rec;
    for (let a = 0; a < 3; a++) {
      dv.setFloat32(o + 4 * a, positions[3 * i + a], true);
      dv.setFloat32(o + 12 + 4 * a, fdc[3 * i + a], true);
      dv.setFloat32(o + 28 + 4 * a, scales[3 * i + a], true);
    }
    dv.setFloat32(o + 24, opacity[i], true);
    for (let k = 0; k < 4; k++) dv.setFloat32(o + 40 + 4 * k, rotations[4 * i + k], true);
  }
  return out;
}
