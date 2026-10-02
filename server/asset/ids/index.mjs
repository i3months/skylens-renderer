// 구간·수준 식별자와 조각 키 인코딩 (명세 §10~§11). 계약: contracts/asset/stubs.mjs
import { AssetFormatError, LEVEL_STEPS, LEVEL_COUNT, SEGMENT_ID_LIMIT, LOD_MAX } from '../../../contracts/asset/index.mjs';

const I32_MIN = -(2 ** 31);
const I32_MAX = 2 ** 31 - 1;
const U32_MAX = 2 ** 32 - 1;

/** 범위 안의 정수가 아니면 던진다. */
function checkInt(name, v, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new AssetFormatError('field', `${name} ${v} not an integer in [${min}, ${max}]`);
  }
  return v;
}

/** @param {number} segmentId @param {number} level @returns {number} */
export function packSegLevel(segmentId, level) {
  checkInt('segmentId', segmentId, 0, SEGMENT_ID_LIMIT - 1);
  checkInt('level', level, 0, LEVEL_COUNT - 1);
  return segmentId * 4 + level;
}

/** @param {number} segLevel u32 */
export function unpackSegLevel(segLevel) {
  checkInt('segLevel', segLevel, 0, U32_MAX);
  return { segmentId: segLevel >>> 2, level: /** @type {0|1|2|3} */ (segLevel & 3) };
}

/** @param {number} step */
export function levelOfStep(step) {
  const i = LEVEL_STEPS.indexOf(step);
  if (i < 0) throw new AssetFormatError('field', `step ${step} is not one of ${LEVEL_STEPS.join(',')}`);
  return /** @type {0|1|2|3} */ (i);
}

/** @param {import('../../../contracts/asset/index.mjs').ChunkKey} key */
export function encodeChunkKey(key) {
  const { segmentId, level, tileX, tileY, lod, chunkIndex } = key;
  checkInt('segmentId', segmentId, 0, SEGMENT_ID_LIMIT - 1);
  checkInt('level', level, 0, LEVEL_COUNT - 1);
  checkInt('tileX', tileX, I32_MIN, I32_MAX);
  checkInt('tileY', tileY, I32_MIN, I32_MAX);
  checkInt('lod', lod, 0, LOD_MAX);
  checkInt('chunkIndex', chunkIndex, 0, U32_MAX);
  // -0 은 템플릿 문자열에서 '0' 이 되어 정규형이 유지된다.
  return `${segmentId}.${level}.${tileX}.${tileY}.${lod}.${chunkIndex}`;
}

const UNSIGNED = /^(0|[1-9][0-9]*)$/;
const SIGNED = /^(0|-?[1-9][0-9]*)$/;

/** 정규형 10진 문자열만 받는다. */
function field(name, s, re, min, max) {
  if (!re.test(s)) throw new AssetFormatError('field', `${name} not canonical: ${JSON.stringify(s)}`);
  return checkInt(name, Number(s), min, max);
}

/** @param {string} s @returns {import('../../../contracts/asset/index.mjs').ChunkKey} */
export function decodeChunkKey(s) {
  if (typeof s !== 'string') throw new AssetFormatError('field', 'chunk key is not a string');
  const p = s.split('.');
  if (p.length !== 6) throw new AssetFormatError('field', `chunk key needs 6 fields, got ${p.length}`);
  return {
    segmentId: field('segmentId', p[0], UNSIGNED, 0, SEGMENT_ID_LIMIT - 1),
    level: /** @type {0|1|2|3} */ (field('level', p[1], UNSIGNED, 0, LEVEL_COUNT - 1)),
    tileX: field('tileX', p[2], SIGNED, I32_MIN, I32_MAX),
    tileY: field('tileY', p[3], SIGNED, I32_MIN, I32_MAX),
    lod: field('lod', p[4], UNSIGNED, 0, LOD_MAX),
    chunkIndex: field('chunkIndex', p[5], UNSIGNED, 0, U32_MAX),
  };
}
