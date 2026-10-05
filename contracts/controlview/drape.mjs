// 관제탑 드레이프 그리기(T15.2) 계약. 구현은 client/tower/drape/. 서명·자료형·기준 수치만 둔다.
// 좌표: GeoAnchor 기준 ENU(x=동, y=북, z=위), 1 unit = 1 m. 카메라: contracts/raster 규약(X_c = R·X_w + t, OpenCV 축).
// 드레이프 = 위성 영상 타일(contracts/tower_assets DrapeTile)을 지형 화소에 입히는 것이다. 지형 층이 그린 RenderResult(깊이·색)를 입력으로 받아
// 화소를 역투영(X_c = d·K⁻¹·[u,v,1]ᵀ → X_w = Rᵀ·(X_c − t))해 ENU (x, y)를 얻고, 그 점이 속한 드레이프 타일의 화소 색으로 바꾼다.
// 원칙: 도착한 타일만 입힌다. 타일이 없거나 coverage.mask 가 0 인 곳은 지형 색을 그대로 둔다(메우지·꾸미지 않는다).
// 수준은 교체(누적 아님)이고 추월당한 수준은 건너뛴다(contracts/levels decideArrival).
// 클라이언트 코드는 contracts/ 만 가져온다(server/ 를 가져오지 않는다). 시험은 server/ 를 참조 구현으로 써도 된다.

/** 드레이프 층 서명(구현 위치와 함수 이름이 기준). */
export const DRAPE_LAYER_API = Object.freeze({
  create: 'createDrapeLayer(opts?) -> DrapeLayer   opts: { shade?: boolean(기본 true: 지형 음영 비율을 곱함) }',
  accept: 'layer.accept(level:0..3, tiles:DrapeTile[]) -> "first"|"replace"|"skip"   skip 이면 상태를 바꾸지 않는다. 같은 묶음 안 타일은 (tx,ty) 유일. 잘못된 타일이면 던지고 상태는 그대로',
  apply: 'layer.apply(camera, terrain:RenderResult, opts?:{ baseRgb?:[r,g,b] }) -> RenderResult   terrain 의 사본에서 지형 화소(depth>0)를 드레이프 색으로 바꾼다. depth·index 는 그대로, terrain 은 바꾸지 않는다',
  state: 'layer.state() -> { level:-1|0..3, tileCount:number }   level −1 = 아직 아무것도 도착하지 않음(apply 는 terrain 사본을 그대로 돌려준다)',
});

/** 모듈 파일(client/tower/drape/). 각 파일의 export 이름이 기준이다. */
export const DRAPE_MODULES = Object.freeze({
  unproject: { file: 'unproject.mjs', fn: 'pixelToEnu(camera, i, j, depth) -> {x, y, z}  화소 (i, j) 칸 중심(i+0.5, j+0.5)과 깊이 d 를 ENU 로 역투영' },
  sample: { file: 'sample.mjs', fn: 'sampleDrape(tile, x, y) -> [r,g,b]|null  ENU (x, y) 에서 타일 화소 중심 기준 이중선형 표본. 타일 밖·coverage.mask 0 이 걸리면 null(경계 화소는 mask>0 인 이웃만 가중)' },
  store: { file: 'store.mjs', fn: 'createDrapeStore() -> { accept(level, tiles) -> action, peek(level) -> action, level(), lookup(x, y) -> DrapeTile|null, count() }  (tx,ty) 색인과 교체·건너뛰기. 타일 검증(크기·길이·mask 길이)' },
  shade: { file: 'shade.mjs', fn: 'shadeRatio(terrainRgb, baseRgb) -> number  지형 화소 색 ÷ 기준색(채널 평균)의 음영 비율, 0..~1.4 로 제한. baseRgb 가 0 이면 1' },
  index: { file: 'index.mjs', fn: 'createDrapeLayer(opts?) 조립' },
});

/** 정합 허용(SPEC S9 합성 근사: 같은 영상을 이상적 투영으로 직접 표본한 기준과 화소 위치 차). */
export const DRAPE_ALIGN_MAX_PX = 1;
