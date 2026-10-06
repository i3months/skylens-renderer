// T15.10e 지형 높이만 전송 형식(H32) 서버 인코더. 계약: contracts/tower_assets/terrain_h32.mjs.
// 머리 16 B(+ 양자화면 8 B) + 본문(f32 또는 u16), 모두 리틀 엔디언. 같은 입력이면 같은 바이트.
import {
  TERRAIN_H32_MAGIC, TERRAIN_H32_VERSION, TERRAIN_H32_HEADER_BYTES, TERRAIN_H32_QUANT_EXTRA_BYTES,
  TERRAIN_H32_FLAG_QUANTIZED, terrainH32Bytes, quantizeHeights,
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
 * @param {{ quantize?: boolean }} [opts] 기본: lod ≥ 1 이면 true. LOD 0 은 늘 비양자화, 범위 초과면 f32 로 폴백.
 * @returns {Uint8Array}
 */
export function encodeTerrainTileH32(tile, opts) {
  checkTile(tile);
  if (opts !== undefined && (opts === null || typeof opts !== 'object')) throw new TowerAssetError('encodeTerrainTileH32: opts 가 객체가 아니다');
  if (opts?.quantize !== undefined && typeof opts.quantize !== 'boolean') throw new TowerAssetError('encodeTerrainTileH32: opts.quantize 가 boolean 이 아니다');
  const { tx, ty, lod, cells, heights } = tile;
  const want = (opts?.quantize ?? lod >= 1) && lod >= 1;
  const qz = want ? quantizeHeights(heights) : null;

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
    dv.setFloat32(off, qz.base, true);
    dv.setFloat32(off + 4, qz.step, true);
    off += TERRAIN_H32_QUANT_EXTRA_BYTES;
    for (let k = 0; k < qz.q.length; k++, off += 2) dv.setUint16(off, qz.q[k], true);
  } else {
    for (let k = 0; k < heights.length; k++, off += 4) dv.setFloat32(off, heights[k], true);
  }
  return out;
}
