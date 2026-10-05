// 관제탑 지형 층(T15.1). 도착한 지형 타일만 CPU 래스터로 그린다(없는 곳은 빈 화소, 메우지 않는다).
// 수준(딜레이 0..3)은 교체이고 추월당한 수준은 건너뛴다(contracts/levels). 좌표: GeoAnchor 기준 ENU, 1 unit = 1 m.
// 계약: contracts/controlview/terrain.mjs. 이 파일은 조립만 한다(mesh·raster·shade·levels).
import { TERRAIN_DEFAULTS } from '../../../contracts/controlview/terrain.mjs';
import { assertCamera, emptyResult } from '../../../contracts/raster/index.mjs';
import { buildLayerMesh } from './mesh.mjs';
import { rasterizeTriangles } from './raster.mjs';
import { faceNormalEnu, shadeLambert } from './shade.mjs';
import { createTerrainState } from './levels.mjs';

/**
 * @param {{ lightDirEnu?:number[], baseRgb?:number[], ambient?:number }} [opts]
 */
export function createTerrainLayer(opts = {}) {
  const lightDir = opts.lightDirEnu ?? TERRAIN_DEFAULTS.lightDirEnu;
  const baseRgb = opts.baseRgb ?? TERRAIN_DEFAULTS.baseRgb;
  const ambient = opts.ambient ?? TERRAIN_DEFAULTS.ambient;
  // 인자를 만드는 즉시 한 번 검사한다(잘못된 값은 render 가 아니라 생성에서 던진다).
  shadeLambert([0, 0, 1], lightDir, baseRgb, ambient);
  const state = createTerrainState();
  let mesh = buildLayerMesh([]);

  return {
    /** @returns {'first'|'replace'|'skip'} skip 이면 상태·메시를 바꾸지 않는다. */
    accept(level, tiles) {
      const action = state.accept(level, tiles);
      if (action !== 'skip') mesh = buildLayerMesh(state.tiles());
      return action;
    },
    render(camera) {
      assertCamera(camera);
      const out = emptyResult(camera.width, camera.height);
      if (mesh.indices.length === 0) return out;
      rasterizeTriangles(camera, mesh, (tri) => shadeLambert(faceNormalEnu(mesh.positions, mesh.indices, tri), lightDir, baseRgb, ambient), out);
      return out;
    },
    state() {
      return { level: state.level(), tileCount: state.tiles().length, triangleCount: mesh.indices.length / 3 };
    },
  };
}
