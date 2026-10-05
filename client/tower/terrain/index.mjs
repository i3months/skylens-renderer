// 관제탑 지형 층(T15.1). 도착한 지형 타일만 CPU 래스터로 그린다(없는 곳은 빈 화소, 메우지 않는다).
// 수준(딜레이 0..3)은 교체이고 추월당한 수준은 건너뛴다(contracts/levels). 좌표: GeoAnchor 기준 ENU, 1 unit = 1 m.
// 계약: contracts/controlview/terrain.mjs. 이 파일은 조립만 한다(mesh·raster·shade·levels).
// 위치: 이 CPU 래스터 층은 기준(reference) 구현이자 실경로(real-path)다. README 의 관제탑 지형 항목과 같은 뜻이며, 여기서는 주석으로만 밝힌다.
// accept 계약:
//  - tiles 는 그 수준의 "화면 전체 완전 묶음"이다. 수준이 오르면 이전 묶음을 통째로 교체하고 누적·병합하지 않는다.
//    (이유: 수준마다 cells 가 다르고 타일 경계 정점을 공유하지 않아, 낮은 수준과 섞으면 이음에 틈·겹침이 생긴다.
//     지역별 수준 상태는 두지 않는다. 일부 지역만 보내면 나머지는 빈 화소가 된다.)
//  - 새 메시를 먼저 만들고 성공했을 때만 수준·타일 상태를 바꾼다(실패하면 던지고 상태는 그대로).
//  - 면 색은 accept 에서 한 번만 계산한다. render 는 셰이딩을 호출하지 않는다.
import { TERRAIN_DEFAULTS } from '../../../contracts/controlview/terrain.mjs';
import { assertCamera, emptyResult } from '../../../contracts/raster/index.mjs';
import { buildLayerMesh } from './mesh.mjs';
import { rasterizeTriangles } from './raster.mjs';
import { faceNormalEnu, shadeLambert } from './shade.mjs';
import { createTerrainState } from './levels.mjs';

/**
 * @param {{ lightDirEnu?:number[], baseRgb?:number[], ambient?:number, shade?:Function }|null} [opts]
 *   shade 는 시험용 주입(기본 shadeLambert). null/undefined 는 기본값을 쓴다.
 */
export function createTerrainLayer(opts) {
  const o = opts ?? {};
  const lightDir = o.lightDirEnu ?? TERRAIN_DEFAULTS.lightDirEnu;
  const baseRgb = o.baseRgb ?? TERRAIN_DEFAULTS.baseRgb;
  const ambient = o.ambient ?? TERRAIN_DEFAULTS.ambient;
  const shade = o.shade ?? shadeLambert;
  // 인자를 만드는 즉시 한 번 검사한다(잘못된 값은 render 가 아니라 생성에서 던진다).
  shadeLambert([0, 0, 1], lightDir, baseRgb, ambient);
  const state = createTerrainState();
  let mesh = buildLayerMesh([]);
  let colors = []; // 삼각형별 [r,g,b], accept 에서 한 번 계산

  return {
    /** @returns {'first'|'replace'|'skip'} skip 이면 상태·메시를 바꾸지 않는다. 던지면 상태는 그대로다. */
    accept(level, tiles) {
      if (state.peek(level) === 'skip') return state.accept(level, tiles); // 검증만 하고 상태는 그대로
      const next = buildLayerMesh(tiles); // 먼저 만든다(실패하면 여기서 던지고 상태 미변경)
      const triCount = next.indices.length / 3;
      const nextColors = new Array(triCount);
      for (let tri = 0; tri < triCount; tri++) nextColors[tri] = shade(faceNormalEnu(next.positions, next.indices, tri), lightDir, baseRgb, ambient);
      const action = state.accept(level, tiles);
      mesh = next;
      colors = nextColors;
      return action;
    },
    render(camera) {
      assertCamera(camera);
      // 호출자가 결과를 바꿔도 되도록 매 호출 새로 만든다(공유하면 별칭 문제). raster.mjs 는 건드리지 않는다.
      const out = emptyResult(camera.width, camera.height);
      if (mesh.indices.length === 0) return out;
      rasterizeTriangles(camera, mesh, (tri) => colors[tri], out);
      return out;
    },
    state() {
      return { level: state.level(), tileCount: state.tiles().length, triangleCount: mesh.indices.length / 3 };
    },
  };
}
