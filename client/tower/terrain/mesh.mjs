// T15.1-A1 지형 메시 이음. 도착한 지형 타일(TerrainTile)들을 하나의 삼각형 메시로 이어 붙인다.
// 좌표: GeoAnchor 기준 ENU(x=동, y=북, z=위), 1 unit = 1 m.
// 정점 (i,j) 위치: x = 64·tx + i·64/(cells−1), y 도 같은 식(마지막 열/행은 (tx+1)·64 로 정확히), z = heights[j·cells+i].
// 칸마다 삼각형 2개, 대각선 (i,j)–(i+1,j+1), 위(+z)에서 볼 때 반시계(server terrainTileToMesh 와 같은 규약).
// 타일 사이 정점은 합치지 않는다(타일별 정점). 없는 타일은 메우지 않는다.
// 정점 법선(normals, 선택 필드): 정점에 닿는 삼각형의 면 외적(정규화 전, 곧 면적 가중)을 더한 뒤 단위화한다.
//   타일 경계 정점은 위치 (x,y,z) 가 비트 단위로 같은 다른 타일 정점과 합을 공유한다(경계에서 음영이 끊기지 않게).
//   합이 0 이면(퇴화) [0,0,1]. 래스터는 이 필드가 있으면 화소마다 보간한 법선으로 음영한다(raster.mjs).
// 클라이언트 코드이므로 server/ 를 가져오지 않는다.

const TILE_SIZE_M = 64;

// 위치 절댓값 상한(m). Float32 가수는 24 비트라서 |x| ≤ 2^24 일 때까지만 1 m 간격 정수를 서로 구별할 수 있다.
// 이보다 크면 이웃 정점이 같은 Float32 값으로 붕괴해 오류 없이 빈 화면이 되므로 검증에서 거부한다.
export const MAX_ABS_POSITION_M = 2 ** 24;

// 한 변 정점 수 상한. 정점 간격 64/(cells−1) m 가 1 m 이상이어야 위 범위 상한이 맞다(cells ≤ 65).
// 간격에 맞춰 상한을 계산하는 대신 정수 상수로 둔다(서버가 만드는 {65,33,17,9} 가 모두 들어간다).
export const MAX_CELLS = TILE_SIZE_M + 1;

function fail(message) {
  return new RangeError(`terrain: ${message}`);
}

/**
 * 타일 하나의 모양 검증(cells·heights·tx·ty). levels.mjs 도 같은 검사를 쓰려고 내보낸다.
 * tx·ty 는 정수일 뿐 아니라 위치 |64·tx|, |64·(tx+1)| 가 MAX_ABS_POSITION_M 이하여야 한다(넘으면 Float32 정밀도 붕괴).
 */
export function assertTileShape(t, n) {
  if (!t || typeof t !== 'object') throw fail(`타일 ${n} 이 객체가 아니다`);
  if (!Number.isInteger(t.cells) || t.cells < 2) throw fail(`타일 ${n} 의 cells 는 2 이상 정수여야 한다`);
  if (t.cells > MAX_CELLS) throw fail(`타일 ${n} 의 cells 가 ${MAX_CELLS} 를 넘는다(정점 간격이 1 m 미만이면 Float32 로 이웃 정점이 붕괴한다)`);
  if (!(t.heights instanceof Float32Array) || t.heights.length !== t.cells * t.cells) {
    throw fail(`타일 ${n} 의 heights 길이가 cells² 가 아니다`);
  }
  if (!Number.isInteger(t.tx) || !Number.isInteger(t.ty)) throw fail(`타일 ${n} 의 tx, ty 는 정수여야 한다`);
  for (const [name, v] of [['tx', t.tx], ['ty', t.ty]]) {
    if (!(Math.abs(v * TILE_SIZE_M) <= MAX_ABS_POSITION_M) || !(Math.abs((v + 1) * TILE_SIZE_M) <= MAX_ABS_POSITION_M)) {
      throw fail(`타일 ${n} 의 ${name} 가 Float32 로 1 m 를 구별할 수 있는 범위(±${MAX_ABS_POSITION_M} m)를 넘는다`);
    }
  }
  for (let k = 0; k < t.heights.length; k++) {
    if (!Number.isFinite(t.heights[k])) throw fail(`타일 ${n} 의 heights[${k}] 가 유한수가 아니다`);
  }
}

/** 입력 검증. 통과하면 공통 cells(빈 배열이면 0)를 돌려준다. */
function validate(tiles) {
  if (!Array.isArray(tiles)) throw fail('tiles 는 배열이어야 한다');
  const seen = new Set();
  let cells = 0;
  for (let n = 0; n < tiles.length; n++) {
    const t = tiles[n];
    assertTileShape(t, n);
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
 * @returns {{ positions:Float32Array, indices:Uint32Array, tileOfTriangle:Int32Array, normals:Float32Array }}
 */
export function buildLayerMesh(tiles) {
  const c = validate(tiles);
  const count = tiles.length;
  const vertsPerTile = c * c;
  const trisPerTile = (c - 1) * (c - 1) * 2;
  const positions = new Float32Array(count * vertsPerTile * 3);
  const indices = new Uint32Array(count * trisPerTile * 3);
  const tileOfTriangle = new Int32Array(count * trisPerTile);
  if (count === 0) return { positions, indices, tileOfTriangle, normals: new Float32Array(0) };

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
  const normals = vertexNormals(positions, indices, count, c);
  return { positions, indices, tileOfTriangle, normals };
}

/**
 * 정점 법선(단위). 면 외적(면적 가중)의 합 → 타일 경계 정점은 같은 위치끼리 합을 공유 → 단위화.
 * 경계 공유는 각 타일의 가장자리 정점만 위치 키로 묶는다(안쪽 정점은 위치가 겹칠 수 없다).
 */
function vertexNormals(positions, indices, count, c) {
  const acc = new Float64Array(positions.length);
  for (let o = 0; o < indices.length; o += 3) {
    const a = 3 * indices[o], b = 3 * indices[o + 1], d = 3 * indices[o + 2];
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[d] - positions[a], vy = positions[d + 1] - positions[a + 1], vz = positions[d + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    acc[a] += nx; acc[a + 1] += ny; acc[a + 2] += nz;
    acc[b] += nx; acc[b + 1] += ny; acc[b + 2] += nz;
    acc[d] += nx; acc[d + 1] += ny; acc[d + 2] += nz;
  }
  if (count > 1) {
    // 가장자리 정점을 위치 키로 묶어 합을 더한 뒤 같은 값을 나눠 갖는다.
    const groups = new Map();
    for (let n = 0; n < count; n++) {
      const vBase = n * c * c;
      for (let j = 0; j < c; j++) {
        const edgeRow = j === 0 || j === c - 1;
        for (let i = 0; i < c; i += edgeRow ? 1 : c - 1) {
          const k = 3 * (vBase + j * c + i);
          const key = `${positions[k]},${positions[k + 1]},${positions[k + 2]}`;
          const g = groups.get(key);
          if (g) g.push(k); else groups.set(key, [k]);
        }
      }
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      let sx = 0, sy = 0, sz = 0;
      for (const k of g) { sx += acc[k]; sy += acc[k + 1]; sz += acc[k + 2]; }
      for (const k of g) { acc[k] = sx; acc[k + 1] = sy; acc[k + 2] = sz; }
    }
  }
  const normals = new Float32Array(positions.length);
  for (let k = 0; k < acc.length; k += 3) {
    const x = acc[k], y = acc[k + 1], z = acc[k + 2];
    const len = Math.hypot(x, y, z);
    if (len > 0 && Number.isFinite(len)) {
      normals[k] = x / len; normals[k + 1] = y / len; normals[k + 2] = z / len;
    } else {
      normals[k + 2] = 1;
    }
  }
  return normals;
}
