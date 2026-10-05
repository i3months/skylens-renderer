// 관제탑 지형 그리기(T15.1) 계약. 구현은 client/tower/terrain/. 서명·자료형·기준 수치만 둔다.
// 좌표: GeoAnchor 기준 ENU(x=동, y=북, z=위), 1 unit = 1 m. 카메라: contracts/raster 규약(X_c = R·X_w + t, 월드 = ENU, OpenCV 축).
// 원칙: 도착한 타일만 그린다(없는 곳은 빈 화소, 메우지 않는다). 수준은 교체(누적 아님)이고 추월당한 수준은 건너뛴다(contracts/levels decideArrival).
// 이 층의 '수준'은 지형 LOD 가 아니라 contracts/levels 의 딜레이 수준 0..3 이다: 도착한 수준의 타일 묶음이 이전 묶음을 통째로 바꾼다.
// 클라이언트 코드는 contracts/ 만 가져온다(server/ 를 가져오지 않는다). 시험은 server/ 를 참조 구현으로 써도 된다.

/** 지형 층 서명(구현 위치와 함수 이름이 기준). */
export const TERRAIN_LAYER_API = Object.freeze({
  create: 'createTerrainLayer(opts?) -> TerrainLayer   opts: { lightDirEnu?:[x,y,z] 표면→광원 단위 아님 가능(정규화), baseRgb?:[r,g,b], ambient?:number }',
  accept: 'layer.accept(level:0..3, tiles:TerrainTile[]) -> "first"|"replace"|"skip"   skip 이면 상태를 바꾸지 않는다. 같은 묶음 안 타일은 (tx,ty) 유일·cells 동일(한 화면 한 LOD)',
  render: 'layer.render(camera) -> RenderResult(contracts/raster)   color 3바이트 RGB, depth = 카메라 z(m) 또는 EMPTY_DEPTH(0), index = 삼각형이 속한 타일 번호(타일 목록 순서) 또는 EMPTY_INDEX(−1)',
  state: 'layer.state() -> { level:-1|0..3, tileCount:number, triangleCount:number }   level −1 = 아직 아무것도 도착하지 않음(render 는 전부 빈 화소)',
});

/** 모듈 파일(client/tower/terrain/). 각 파일의 export 이름이 기준이다. */
export const TERRAIN_MODULES = Object.freeze({
  mesh: { file: 'mesh.mjs', fn: 'buildLayerMesh(tiles) -> { positions:Float32Array, indices:Uint32Array, tileOfTriangle:Int32Array }  타일 메시를 이어 붙인다. 대각선 규약은 server terrainTileToMesh 와 같다((i,j)–(i+1,j+1), 위에서 볼 때 반시계)' },
  raster: { file: 'raster.mjs', fn: 'rasterizeTriangles(camera, mesh, shadeTriangle, out) -> void  z-버퍼 삼각형 래스터. 근평면(z>0.01 m)에서 잘라낸다. 화소 중심 (x+0.5, y+0.5) 표본, 원근 보정 깊이, 같은 깊이는 앞선 삼각형 유지' },
  shade: { file: 'shade.mjs', fn: 'faceNormalEnu(positions, indices, tri) -> [nx,ny,nz]  /  shadeLambert(normal, lightDir, baseRgb, ambient) -> [r,g,b]  (램버트 I = ambient + (1−ambient)·max(0, n·l))' },
  levels: { file: 'levels.mjs', fn: 'createTerrainState() -> { accept(level, tiles) -> action, level(), tiles() }  decideArrival 로 교체·건너뛰기를 정한다' },
  index: { file: 'index.mjs', fn: 'createTerrainLayer(opts?) 조립' },
});

/** 기본 그리기 값. */
export const TERRAIN_DEFAULTS = Object.freeze({
  lightDirEnu: Object.freeze([-0.4, -0.5, 0.77]), // 표면 → 광원, 서남쪽 위 (정규화는 구현이 한다)
  baseRgb: Object.freeze([150, 160, 140]),
  ambient: 0.3,
  nearM: 0.01,
});

/** 8시점 SSIM 하한(SPEC). 기준 영상은 같은 DEM 의 원본 해상도(LOD 0) 메시를 독립 광선-삼각형 교차로 그린 것이다. */
export const TERRAIN_SSIM_MIN = 0.95;
