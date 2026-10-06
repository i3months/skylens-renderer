// T15.10e 지형 높이만 전송 형식(H32) 서버 인코더. 계약: contracts/tower_assets/terrain_h32.mjs.
// 머리 16 B(+ 양자화면 i32 kbase · f32 step 8 B) + 본문(f32 또는 u16), 모두 리틀 엔디언. 같은 입력이면 같은 바이트.
// 양자화는 전역 격자(계약 주석 참고). LOD 1~3 범위 초과 폴백 타일은 f32 본문에 같은 격자로 반올림한 값을 실어 이웃 가장자리와 비트를 맞춘다.
import {
  TERRAIN_H32_MAGIC, TERRAIN_H32_VERSION, TERRAIN_H32_HEADER_BYTES, TERRAIN_H32_QUANT_EXTRA_BYTES,
  TERRAIN_H32_FLAG_QUANTIZED, terrainH32Bytes, quantizeHeights, snapHeightsToGrid,
} from '../../../contracts/tower_assets/terrain_h32.mjs';
import { TowerAssetError } from '../../../contracts/tower_assets/index.mjs';

const I32_MIN = -0x80000000, I32_MAX = 0x7fffffff;

function checkTile(tile) {
  if (!tile || typeof tile !== 'object') throw new TowerAssetError('encodeTerrainTileH32: tile 이 객체가 아니다');
  const { tx, ty, lod, cells, heights } = tile;
  if (!Number.isInteger(lod) || lod < 0 || lod > 3) throw new TowerAssetError(`encodeTerrainTileH32: lod ${String(lod)} 는 0..3 정수여야 한다`);
  if (!Number.isInteger(tx) || tx < I32_MIN || tx > I32_MAX) throw new TowerAssetError(`encodeTerrainTileH32: tx ${String(tx)} 가 i32 정수가 아니다`);
  if (!Number.isInteger(ty) || ty < I32_MIN || ty > I32_MAX) throw new TowerAssetError(`encodeTerrainTileH32: ty ${String(ty)} 가 i32 정수가 아니다`);
  if (!Number.isInteger(cells) || cells < 2 || cells > 0xffff) throw new TowerAssetError(`encodeTerrainTileH32: cells ${String(cells)} 가 2..65535 정수가 아니다`);
  if (!(heights instanceof Float32Array)) throw new TowerAssetError('encodeTerrainTileH32: heights 가 Float32Array 가 아니다');
  if (heights.length !== cells * cells) throw new TowerAssetError(`encodeTerrainTileH32: heights 길이 ${heights.length} 가 cells² ${cells * cells} 와 다르다`);
  for (let k = 0; k < heights.length; k++) {
    if (!Number.isFinite(heights[k])) throw new TowerAssetError(`encodeTerrainTileH32: heights[${k}] 가 유한하지 않다`);
  }
}

/**
 * 지형 타일 하나를 H32 바이트로 인코딩한다.
 * @param {{ tx:number, ty:number, lod:number, cells:number, heights:Float32Array }} tile
 * @param {{ quantize?: boolean }} [opts] 기본: lod ≥ 1 이면 true. LOD 0 은 늘 원본 f32. 범위 초과면 격자 반올림 f32 로 폴백.
 *   lod ≥ 1 에서 quantize:false 면 원본 f32(같은 LOD 의 모든 타일에 같은 선택을 써야 가장자리가 맞는다).
 * @returns {Uint8Array}
 */
export function encodeTerrainTileH32(tile, opts) {
  checkTile(tile);
  if (opts !== undefined && (opts === null || typeof opts !== 'object')) throw new TowerAssetError('encodeTerrainTileH32: opts 가 객체가 아니다');
  if (opts?.quantize !== undefined && typeof opts.quantize !== 'boolean') throw new TowerAssetError('encodeTerrainTileH32: opts.quantize 가 boolean 이 아니다');
  const { tx, ty, lod, cells, heights } = tile;
  const want = (opts?.quantize ?? lod >= 1) && lod >= 1;
  const qz = want ? quantizeHeights(heights) : null;
  let body = heights;
  if (want && qz === null) {
    body = snapHeightsToGrid(heights);
    if (body === null) throw new TowerAssetError('encodeTerrainTileH32: 격자 반올림 폴백 값이 유한하지 않다');
  }

  const out = new Uint8Array(terrainH32Bytes(cells, qz !== null));
  const dv = new DataView(out.buffer);
  dv.setUint8(0, TERRAIN_H32_MAGIC);
  dv.setUint8(1, TERRAIN_H32_VERSION);
  dv.setUint8(2, lod);
  dv.setUint8(3, qz ? TERRAIN_H32_FLAG_QUANTIZED : 0);
  dv.setInt32(4, tx, true);
  dv.setInt32(8, ty, true);
  dv.setUint16(12, cells, true);
  dv.setUint16(14, 0, true);
  let off = TERRAIN_H32_HEADER_BYTES;
  if (qz) {
    dv.setInt32(off, qz.kbase, true);
    dv.setFloat32(off + 4, qz.step, true);
    off += TERRAIN_H32_QUANT_EXTRA_BYTES;
    for (let k = 0; k < qz.q.length; k++, off += 2) dv.setUint16(off, qz.q[k], true);
  } else {
    for (let k = 0; k < body.length; k++, off += 4) dv.setFloat32(off, body[k], true);
  }
  return out;
}
