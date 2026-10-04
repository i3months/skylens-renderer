// 하위 작업별 공개 함수 서명. 구현은 각자의 소유 경로 index.mjs 가 이 이름으로 export 한다.
// 소유 경로 밖은 고치지 않는다. 계약(index.mjs)을 고쳐야 하면 고치지 말고 보고한다.
import { TowerAssetError } from './index.mjs';

const todo = (n) => () => { throw new TowerAssetError(`${n}: 미구현`); };

/** T14.1 server/terrain/mesh_lod/index.mjs — (dem: Dem, tx, ty, lod) → TerrainTile. 원본 대비 오차 ≤ TERRAIN_LOD_MAX_ERROR_M[lod]. */
export const buildTerrainTile = todo('buildTerrainTile');
/** T14.1 — (dem, tile: TerrainTile) → { maxErrorM } mesh surface(같은 대각선 삼각형) 대비 최대 오차. */
export const measureTerrainError = todo('measureTerrainError');
/** T14.1 — (tile: TerrainTile) → Mesh. */
export const terrainTileToMesh = todo('terrainTileToMesh');
/** T14.2 server/terrain/drape/index.mjs — (image: {width,height,rgb,bounds: Bounds}, tx, ty, mip) → DrapeTile. */
export const buildDrapeTile = todo('buildDrapeTile');
/** T14.2 — (image, tile: DrapeTile) → { maxMisalignPx } 좌표 정합 오차. */
export const measureDrapeAlignment = todo('measureDrapeAlignment');
/** T14.3 server/buildings/extrude/index.mjs — (fp: Footprint) → Mesh. 바닥 z = 0, 지붕 z = buildingHeightM(fp.floors). 벽 + 지붕(삼각분할). */
export const extrudeBuilding = todo('extrudeBuilding');
/** T14.3 — (fps: Footprint[]) → Array<{ id, mesh: Mesh }> 입력 순서·동 수 보존. */
export const extrudeAll = todo('extrudeAll');
/** T14.4 server/buildings/lod/index.mjs — (buildings: Array<{id, mesh}>, cameraDistM: number) → Array<{ ids:number[], mesh: Mesh }> 먼 곳은 상자 합침. */
export const buildBuildingLod = todo('buildBuildingLod');
/** T14.5 server/buildings/points/index.mjs — (mesh: Mesh, id: number, rule?) → Float32Array xyz 표본. 동별 표본 수 규칙은 구현이 export 하는 samplesFor(areaM2, heightM) 와 일치. */
export const sampleBuildingPoints = todo('sampleBuildingPoints');
/** T14.6 server/buildings/black/index.mjs — (mesh: Mesh) → { mesh: Mesh, edgeLines: Float32Array }. 모서리 선(xyz 쌍 연속) 수 = 정답. */
export const buildBlackBuilding = todo('buildBlackBuilding');
/** T14.7 server/buildings/aerial_uv/index.mjs — (mesh: Mesh, image: {width,height,rgb,bounds: Bounds}) → { uv: Float32Array(정점당 2), wallMask: Uint8Array(정점당 1) }, 값 ∈ [0,1]. wallMask=1 인 정점(벽·바닥)은 영상이 없는 면이라 uv 가 무의미하고 검정으로 그린다(결정 0044 §6). */
export const buildAerialUv = todo('buildAerialUv');
/** T14.8 server/terrain/tile_index/index.mjs — (bounds: Bounds, items: Array<{ id, bounds }>) → { query(x, y): number[], tilesIn(b: Bounds): Array<{tx,ty}> }. */
export const buildTileIndex = todo('buildTileIndex');
/** T14.10 server/terrain/offline/index.mjs — (fn: () => Promise|any) → { result, networkCalls: number } 실행 중 네트워크 호출 수. */
export const runOffline = todo('runOffline');
