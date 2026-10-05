// T15.1-A1 지형 메시 이음. 도착한 지형 타일(TerrainTile)들을 하나의 삼각형 메시로 이어 붙인다.
// 좌표: GeoAnchor 기준 ENU(x=동, y=북, z=위), 1 unit = 1 m.
// 정점 (i,j) 위치: x = 64·tx + i·64/(cells−1), y 도 같은 식(마지막 열/행은 (tx+1)·64 로 정확히), z = heights[j·cells+i].
// 칸마다 삼각형 2개, 대각선 (i,j)–(i+1,j+1), 위(+z)에서 볼 때 반시계(server terrainTileToMesh 와 같은 규약).
// 타일 사이 정점은 합치지 않는다(타일별 정점). 없는 타일은 메우지 않는다.
// 클라이언트 코드이므로 server/ 를 가져오지 않는다.

const TILE_SIZE_M = 64;

function fail(message) {
  return new RangeError(`terrain: ${message}`);
}

/** 입력 검증. 통과하면 공통 cells(빈 배열이면 0)를 돌려준다. */
function validate(tiles) {
  if (!Array.isArray(tiles)) throw fail('tiles 는 배열이어야 한다');
  const seen = new Set();
  let cells = 0;
  for (let n = 0; n < tiles.length; n++) {
    const t = tiles[n];
    if (!t || typeof t !== 'object') throw fail(`타일 ${n} 이 객체가 아니다`);
    if (!Number.isInteger(t.cells) || t.cells < 2) throw fail(`타일 ${n} 의 cells 는 2 이상 정수여야 한다`);
    if (!(t.heights instanceof Float32Array) || t.heights.length !== t.cells * t.cells) {
      throw fail(`타일 ${n} 의 heights 길이가 cells² 가 아니다`);
    }
    if (!Number.isInteger(t.tx) || !Number.isInteger(t.ty)) throw fail(`타일 ${n} 의 tx, ty 는 정수여야 한다`);
    for (let k = 0; k < t.heights.length; k++) {
      if (!Number.isFinite(t.heights[k])) throw fail(`타일 ${n} 의 heights[${k}] 가 유한수가 아니다`);
    }
    const key = `${t.tx},${t.ty}`;
    if (seen.has(key)) throw fail(`타일 (${t.tx},${t.ty}) 가 중복이다`);
    seen.add(key);
    if (n === 0) cells = t.cells;
    else if (t.cells !== cells) throw fail(`타일마다 cells 가 다르다(${cells} 와 ${t.cells})`);
  }
  return cells;
}

/**
 * 타일 배열 → 이어 붙인 메시.
 * tileOfTriangle[삼각형] = 그 삼각형이 속한 타일의 입력 배열 순서 번호.
 * @param {Array<{tx:number,ty:number,lod?:number,cells:number,heights:Float32Array}>} tiles
 * @returns {{ positions:Float32Array, indices:Uint32Array, tileOfTriangle:Int32Array }}
 */
export function buildLayerMesh(tiles) {
  const c = validate(tiles);
  const count = tiles.length;
  const vertsPerTile = c * c;
  const trisPerTile = (c - 1) * (c - 1) * 2;
  const positions = new Float32Array(count * vertsPerTile * 3);
  const indices = new Uint32Array(count * trisPerTile * 3);
  const tileOfTriangle = new Int32Array(count * trisPerTile);
  if (count === 0) return { positions, indices, tileOfTriangle };

  const step = TILE_SIZE_M / (c - 1);
  for (let n = 0; n < count; n++) {
    const t = tiles[n];
    const x0 = t.tx * TILE_SIZE_M;
    const y0 = t.ty * TILE_SIZE_M;
    const vBase = n * vertsPerTile;
    for (let j = 0; j < c; j++) {
      for (let i = 0; i < c; i++) {
        const k = (vBase + j * c + i) * 3;
        // 마지막 열/행은 다음 타일 원점과 같은 식으로 둔다(경계 좌표 비트 일치).
        positions[k] = i === c - 1 ? (t.tx + 1) * TILE_SIZE_M : x0 + i * step;
        positions[k + 1] = j === c - 1 ? (t.ty + 1) * TILE_SIZE_M : y0 + j * step;
        positions[k + 2] = t.heights[j * c + i];
      }
    }
    let p = n * trisPerTile * 3;
    for (let j = 0; j < c - 1; j++) {
      for (let i = 0; i < c - 1; i++) {
        const a = vBase + j * c + i, b = a + 1, d = a + c, e = d + 1;
        indices[p++] = a; indices[p++] = b; indices[p++] = e;
        indices[p++] = a; indices[p++] = e; indices[p++] = d;
      }
    }
    tileOfTriangle.fill(n, n * trisPerTile, (n + 1) * trisPerTile);
  }
  return { positions, indices, tileOfTriangle };
}
