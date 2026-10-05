# skylens-renderer

## 한국어

SkyLens 서버사이드 렌더러. 준비 중이다.

### 무엇인가
SkyLens 의 3D 표시(현황판·관제탑)를 브라우저 렌더링에서 서버 렌더링으로 옮기는 렌더러다.
- **경로 B — 자산 경량화**: 서버가 점군·지형·건물을 LOD·컬링·뷰 의존 조각으로 미리 가공하고, 브라우저는 경량 래스터라이저로 받은 조각만 그린다. 조작은 로컬이라 입력 지연이 없다.
- **경로 A — 픽셀 스트리밍**: 서버 GPU 가 래스터화·인코딩하고, 브라우저는 영상 재생과 입력 전송만 한다.

관제탑은 B, 현황판은 저사양 기기 A·고사양 기기 B 를 쓴다. B 를 먼저 만들고, A 는 B 의 자산 포맷을 입력으로 쓴다.

### 지켜지는 것
- 딜레이 패턴 4수준(250/1,000/3,500/7,000 스텝): 새 수준이 같은 구간의 낮은 수준을 교체하고, 늦게 온 낮은 수준은 건너뛴다.
- 도착한 것만 그린다. 없는 곳은 없다고 표시하고 메우지 않는다.
- 좌표는 GeoAnchor 기준 로컬 ENU, 1 unit = 1 m.
- 전송은 웹소켓 하나.

### 사용법
테스트: `npm test` (`node --test`). 실제 skylens 입력을 쓰는 테스트는 환경변수 `SKYLENS_DIR`(skylens 체크아웃 경로, 기본 `/tmp/skylens`)를 읽는다.

베이스라인 측정 일괄 실행:
```
node bench/baseline/run_all/cli.mjs --skylens-dir <경로> --out <경로> --commit <해시> [옵션]
```
| 옵션 | 뜻 |
| --- | --- |
| `--skylens-dir` | skylens 체크아웃(읽기 전용). 필수 |
| `--out` | 산출물 폴더. `records.json`, `summary.json` 과 모듈별 하위 폴더. 필수 |
| `--commit` | skylens 커밋 해시. 필수 |
| `--only a,b` | 쉼표로 구분한 모듈만 실행 |
| `--skip c` | 쉼표로 구분한 모듈을 건너뜀 |
| `--points <ply>` | 점군 PLY 입력 |
| `--ws-recording <jsonl>` | 웹소켓 프레임 녹화 입력 |
| `--tower-recording <jsonl>` | 관제탑 녹화 입력 |
| `--dist-dir <dir>` | 빌드된 skylens dist. 없으면 복사본에서 한 번 빌드한다 |
| `--entry-path <경로>` | 첫 프레임·힙 측정이 열 페이지. `/` 로 시작하는 URL 경로(쿼리·해시 불가) |
| `--anchor-lat/--anchor-lon/--anchor-alt` | 앵커 좌표. 셋 다 함께 줘야 한다 |

종료코드: 0 = 모든 모듈 성공(건너뜀 제외), 1 = 하나라도 실패, 2 = 잘못된 인자.

결과 보고서(Markdown):
```
node tools/baseline_report/cli.mjs [--summary summary.json] records.json ...
node tools/baseline_report/cli.mjs --status summary.json
```
`--summary` 는 실패·측정 불가 모듈 절을 보고서 맨 위에 넣는다. `--status` 는 모듈별 상태 표만 출력한다. 오류가 나면 종료코드 1.

측정에 쓰는 선택 환경변수: `SKYLENS_PLAYWRIGHT_DIR`(playwright 패키지 폴더), `SKYLENS_CHROMIUM`(chromium 실행파일), `PLAYWRIGHT_BROWSERS_PATH`. 선택 테스트용: `SKYLENS_DIST_DIR`(빌드된 dist), `SKYLENS_BUILD=1`(실제 빌드 테스트), `TOWER_RECORDING`(관제탑 녹화 경로).

### 기준값 측정 도구
현재 three.js 구현의 기준값을 재는 도구가 `bench/baseline/` 에 있다(번들 크기·자산 바이트·웹소켓 바이트·관제탑 요청·첫 프레임·JS 힙·기준 영상). `bench/baseline/run_all/cli.mjs` 가 한 번에 돌리고, `tools/baseline_report/cli.mjs` 가 결과를 표로 바꾼다. 테스트는 `npm test`(Node 22 이상, 헤드리스 브라우저 테스트는 `PLAYWRIGHT_BROWSERS_PATH` 필요).

실행 예: `node bench/baseline/run_all/cli.mjs --skylens-dir <skylens develop 클론> --out <출력> --commit <해시> --points <원본 PLY> --ws-recording <웹소켓 녹화> --tower-recording <관제탑 녹화> --anchor-lat <위도> --anchor-lon <경도> --anchor-alt <고도>`. 빌드가 필요한 모듈(번들·첫 프레임·힙)은 skylens 복사본에서 `npm ci` 와 vite 빌드를 한 번 하고(`--dist-dir` 로 이미 빌드한 결과를 줄 수 있다), 필수 입력이 없는 모듈은 합성 데이터로 대체하지 않고 실패로 기록한다.

외부 도구: 첫 프레임·힙 측정은 playwright 와 Chromium 이 필요하다. package.json 에는 넣지 않고 `SKYLENS_PLAYWRIGHT_DIR`, `NODE_PATH`, 전역 설치 순으로 찾으며 Chromium 은 `SKYLENS_CHROMIUM` 또는 `PLAYWRIGHT_BROWSERS_PATH` 로 찾는다. 라이선스는 사람이 정하기 전까지 UNLICENSED 로 둔다.

### 경량 자산 포맷 (.skla)
조각 하나가 파일 하나다(헤더 128 B + 필드별 평면 본문, little-endian, 좌표는 GeoAnchor 기준 ENU 64 m 타일). 27 B 점(법선 포함)과 56 B 가우시안(불투명도·크기·회전 포함)을 한 포맷에 담고 헤더의 형식 표시로 구분한다. 명세는 `format/ASSET_FORMAT.md`, 코드 계약은 `contracts/asset/`, 골든 파일은 `fixtures/asset_golden/` 에 있다. 서버 모듈은 `server/asset/`(헤더·타일 색인·경계 상자·식별자·체크섬·역변환·쓰기·결정성·호환·퍼저), 클라이언트 읽기는 `client/asset/`, 검증 도구는 `node tools/asset_validate/cli.mjs <파일.skla>`(위반이 있으면 종료코드 1).

### 압축 codec (T09)
헤더 codec 값 1(SKLC1)은 27 B 점 조각을 압축한다. 양자화 값은 그대로 두고 점을 모턴 순으로 재배치한 뒤 위치 키 차분·법선 차분·색(무손실 차분/팔레트/하위 2 비트 손실)을 필드별 스트림으로 만들어 적응형 범위 부호화로 누른다. 명세는 `format/ASSET_FORMAT.md` §4.3, 계약은 `contracts/codec/`. 서버 부호화·복호화는 `server/codec/chunk/`(`encodeChunk`·`decodeChunk`), 클라이언트 복호기는 `client/codec/`(`decodeChunkClient`), 점당 바이트 측정은 `bench/codec/cli.mjs`, 클라이언트 복호 속도는 `bench/codec_client/cli.mjs`.

### 수준 상태 기계 (T10)
딜레이 패턴 4수준(스텝 250·1,000·3,500·7,000)은 구간마다 교체된다. 새 수준이 도착하면 같은 구간의 낮은 수준 조각을 내보내고(누적 없음), 이미 더 높은 수준이 온 구간에 늦게 온 낮거나 같은 수준은 건너뛴다. 도착하지 않은 구간은 "없음"(렌더 점 0)이며 시간이 흘러도 상태는 도착 이벤트로만 바뀐다. 계약은 `contracts/levels/`(`decideArrival`), 서버 기계는 `server/levels/state/`(`createLevelMachine`), 클라이언트 기계는 `client/levels/`, 없음 표시는 `client/levels/missing/`.

### 점 입력과 좌표 (T04)
27 B 점과 56 B 가우시안 PLY 를 읽고 쓴다. 계약 `contracts/points/`·`contracts/geo/`, 서버 모듈 `server/points/`(PLY 읽기·쓰기·스트리밍·손상 입력 거부·법선 정규화·구간 파일 식별)와 `server/geo/`(GPS↔ENU, ENU↔씬 좌표 x=동, y=위, z=−북), 클라이언트 변환 `client/geo/`, 점 통계 `tools/points_stat/`. GPS↔ENU 는 skylens `geo.ts` 와 같은 등장방형 근사(R = 6378137 m)이며, geo.ts 를 옮긴 기준 함수와 1 mm 이내로 일치함을 테스트한다. 경도 차이(|Δλ|)가 180°를 넘으면 360° − |Δλ|를 쓴다.

ENU 변환에서 skylens geo.ts 와 다른 점은 두 가지다. 첫째, 경도 차 |Δλ| > 180° 를 감싼 뒤 결과 경도를 (−180, 180] 범위로 정규화하며, 실제 측정값으로 |Δλ| ≤ 180 범위는 비트까지 geo.ts 와 같다(결정 0017). 둘째, 극 앵커(위도 ±90°)에서 gpsToEnu 가 동쪽 성분 e 를 0 으로 명시적 설정하여, cos 90° ≈ 6e-17 이 만드는 1e-10 m 잔여를 없앤다. 극 앵커에서는 동쪽 방향이 정의되지 않으므로 이 가지는 geo.ts 와 다른 범위에서 동작한다(결정 0018).

### 합성 장면과 뷰포인트 (T05)
테스트·측정용 8가지 합성 장면. 각 장면 생성기는 `fixtures/scenes/<이름>/index.mjs` 에 위치하고 `generate(opts)` 를 내보내며 `SceneResult` 를 반환한다(계약은 `contracts/scenes/index.mjs`). 좌표는 GeoAnchor 기준 로컬 ENU(1 unit = 1 m). 점 형식: 27 B(위치+법선) 또는 56 B(가우시안·불투명도·크기·회전).

**장면:**
| 이름 | 설명 |
| --- | --- |
| buildings | 건물 외곽 돌출(관제탑용) |
| dem | DEM 타일 합성 장면(관제탑용) |
| depth_noise | 깊이 오차 모형에 따른 잡음 주입 |
| flat_boxes | 평지(200×200 m) 위에 상자 건물 12동 |
| holes | 무늬 있는 평지 + 무늬 없는 빈자리(메우지 않음) |
| large | 대규모 장면 생성(250만 점 성능 시험용) |
| levels | 구간×4수준 점 수 사다리 장면 |
| terrain | 완만한 지형 장면(해석적 높이장) |

**뷰포인트:** `fixtures/viewpoints/synthetic.json` 은 `flat_boxes` 장면용 8개 고정 뷰포인트(id 1-8, 이름: aerial_overview, aerial_oblique_ne, top_down, street_level, low_close_box, tower_high, tower_mid, edge_far)를 정의한다. 실제 자산용 viewpoints.json 과 별개다.

**카메라 경로:** `fixtures/paths/index.mjs` 는 카메라 경로 생성기를 제공한다: 드론 추적(원형 비행·지터 포함)과 자유 조작(Catmull-Rom 웨이포인트). 모두 결정적 시드 지정(contracts/scenes mulberry32, subSeed).

**미리보기 생성:** `node tools/scene_preview/cli.mjs <장면이름> <시드> <출력디렉터리>` 로 지정한 시드의 장면 미리보기 이미지(PNG)를 생성한다. `<장면이름>` 은 8가지 장면 키 중 하나. 출력 디렉터리가 없으면 생성된다.

### LOD (T07)

원본 점군(format 1)을 거리별로 줄이는 계층. 새 점을 만들지 않고 입력 점의 부분집합만 쓴다.
- `server/lod/hierarchy` `buildHierarchy(cloud, {edge0M, levelCount})`: 단계 l 은 한 변 `edge0M·2^l` 격자 칸당 대표점 1개(리프 경계에서 칸을 나눈 조각마다 1개, 단계 0 은 원본 전부).
- `server/lod/distance_table`, `select`, `budget`, `progressive`: 화면 공간 오차 `f·edge/d_eff ≤ τ`(f=max(fx,fy), d_eff 는 상자의 화면 안 부분에서 d·cMin² 이상으로 잡는다, 축 밖 보정은 `select/screen_error.mjs`)로 단계 선택, 점 예산 상한, 거친 단계 먼저 보내기(교체이며 누적 아님).
- `server/lod/view_score`: 이웃 시점 점수(공유 점·광선 각·축척). `server/lod/no_fill`: 빈자리 보존 검사. `bench/lod`: 구간 크기 집계와 materialize 시간(`node bench/lod/cli.mjs`). 단계별 대표점 위치를 리프 순서로 미리 담아(대표점당 12 B) 184만 점 선택 materialize 최댓값이 첫 호출 포함 51~70 ms(4코어 공유 환경, 7회).

### 개발 설정
```
git config core.hooksPath .githooks
```
훅은 커밋 메시지·추가 내용·브랜치 이름에 생성 도구 흔적이 있으면 커밋과 푸시를 막는다.

### 프로토콜 (T11)
웹소켓(TCP) 단일 이진 프레임: 머리 8 B + 본문, 메시지 9종(접속·시점 갱신·조각 요청·확인·환영·조각·수준 도착·없음·오류). 계약은 `contracts/proto/`, 부호화·복호는 서버 `server/proto/codec/`·클라이언트 `client/proto/`(같은 검사 순서·오류 코드), 서버 골격은 `server/ws/`(의존성 없는 RFC 6455 구현, 주소·포트는 환경 변수 `SKYLENS_WS_HOST`·`SKYLENS_WS_PORT`), 역압 `server/ws/backpressure/`, 재접속 `server/ws/resume/`, 송출 스케줄러 `server/scheduler/`(우선순위·바이트 예산·추월 버림)와 초기 묶음 `server/scheduler/initial/`, skylens 이벤트 어댑터 `server/adapter/core/`, 모의 클라이언트 `tools/mock_client/`, 퍼저 `server/proto/fuzz/`, 바이트 집계 `bench/proto/`. 스케줄러 비교 횟수·시간 측정은 `bench/scheduler/index.mjs`(보고 전용, 종료 코드 항상 0, 출력에 Node·코어 수·부하 포함). `server/ws/session` — 배선 모듈(emit 기록·이어받기 재전송·연결 처리)을 제공한다: 어댑터 송출을 이어받기 저장소(server/ws/resume)에 기록하고 HELLO 이어받기 때 재전송한다. LEVEL_ARRIVED 는 보내기 전에 기록하고, 이어받기 때 resendPlan 으로 다시 보낸다. 서버 진입점(createWsServer onConnection)에서의 연결은 미배선이다(시험에서만 쓰인다).

### 컬링 (T08)
- 컬링 단계는 모두 보수적이다(보여야 할 리프를 버리지 않는다). 결과는 길이 leafCount 의 0/1 마스크이고 `contracts/cull` 에 서명이 있다.
- `server/cull/frustum`(절두체), `backface`(법선 원뿔), `occlusion`(CPU 깊이 피라미드), `distance`(거리 컷), `predict`(이동 방향 예측), `priority`(화면 기여 순 정렬), `degenerate`(퇴화 시점은 던지지 않고 빈 결과), `combine`(`cullAndSelect`: 마스크 AND 뒤 LOD 단계 선택). `client/cull`: 서버와 같은 마스크를 내는 절두체 컬링. `bench/cull`: 시점당 CPU 시간.

### 클라이언트 래스터라이저 (T12)
WebGL2 로 .skla 조각을 그린다. 계약 `contracts/client_raster/`, 구현 `client/raster/`(`createRenderer` 는 `index.mjs`; 문맥·소실 복구 `context/`, 점 셰이더·CPU 참조 `shader/`, 조각 버퍼 `buffers/`, 카메라·K 환산 `camera/`, 프레임 루프·복호 Worker 래퍼 `loop/`, 빈자리 검사 `missing/`, 메모리 집계 `memory/`, 캡처 시험 틀 `test_harness/`, 지연 계측 `latency/`). 조각은 LEVEL_ARRIVED 완료 key 집합에 든 것만 그린다. 시험은 `node --test "client/raster/**/*.test.mjs"`(Chromium 이 있으면 실제 WebGL2 시험도 돈다). 성능 수치는 헤드리스 Chromium(SwiftShader, CPU) 기준이며 실제 GPU 환경의 수치가 아니다.

### 현황판 어댑터 (T13)
현황판 화면 역할을 경로 B 위에 얹는다. 계약·대응표 `contracts/statusview/`, 구현 `client/status/`(조각 요청 `arrival/`, 수준 교체 `levels/`, 도착 기준 노출 `reveal/`, 카메라 동기 `camera/`, 마커 덧그리기 `overlay/`, "없음" 안내 `missing_ui/`, 폴백 상태 `fallback/`, 조립 `e2e/`), 측정 `bench/status_bw/`·`bench/status_quality/`. 대응표의 skylens 원본 열은 추정이며 원본 대조는 아직 하지 않았다. SPEC S6 구간당 문턱(≤ 3,000,000 B)은 구간당 250만 점 합성에서 무손실 색 코덱과 구간 점 예산 솎기(`server/scheduler/segment_budget/`)로 구간당 약 2.93 MB 까지 내려가지만, 원본 점의 약 13.4% 만 보내므로 화질(S9)에 영향이 있고 실제 송출 경로에는 아직 배선하지 않았다. 솎지 않으면 구간당 약 10 MB 이상이다. 10만 점 합성 통과는 S6 충족을 뜻하지 않는다. 측정한 솎기 비율 모두 SSIM 0.95 미달, S6·S9 충돌(결정 0043): 채택 방식 13.40% 는 250만 점 8시점 SSIM 최소 0.6877·평균 0.7534 이고 50% 도 최소 0.8714 이다. 품질 측정 `status_quality` 는 320×180 해상도·20만 점·무손실 색·CPU 래스터 조건 ([local] T13.10L)에서 실행되며 S9 가 확정되지 않았다. ws 진입점 배선 `server/ws/wire/`.

### 관제탑 자산 (T14)

`contracts/tower_assets/` 가 계약이다. 지형 격자 LOD(`server/terrain/mesh_lod`), 위성 드레이프 타일(`drape`), 타일 색인(`tile_index`), 오프라인 검사(`offline`), 건물 돌출·LOD·점 표본·검정 건물 선·항공뷰 UV(`server/buildings/*`)가 있다. 입력은 모두 합성이며 실제 VWorld 입력은 아직 검증하지 않았다. `bench/tower_assets` 는 6,191동 합성 도시와 1 km² 지형·드레이프의 처리 시간과 직렬화 크기를 잰다. 잡음 DEM 기준 초기 묶음(지형 LOD3 + 드레이프 밉2)은 약 42.38 MB 로 초기 상한 15 MB 를 넘고(초과로 기록), 매끈한 DEM 은 약 4.46 MB 이다. 두 크기는 각각 진폭 5 m 백색잡음 DEM 의 최악 경우와 완만한 언덕의 낙관 경우인 합성 입력 값이며, 실제 크기는 [local] T14L 에서 실제 입력으로 확정한다. 드레이프 정렬 측정은 평평한 블록을 flatBlocks 와 axisFlatBlocks 로 보고하며, 평평 블록이 피복 블록의 절반 초과면 unmeasurable 로 처리한다. 건물 LOD 는 벽 방향이 3° 이내인 건물을 방향 상자로 합치며, 메워지는 폭(끼인 틈 폭·열린 홈 깊이) 1/4 px 이내로 제한한다(CPU 소프트 래스터 합성 장면 값; 한 건물 자기 상자 안 오목부는 최대 2 px 까지). 지붕이 일부만 있거나 감김이 섞인 메시는 원본을 유지하고, 같은 풋프린트의 중복 상자는 접는다. 밀집 합성 장면 시드 1~300 × 8시점(`node tools/lod_seed_sweep.mjs`)에서 건물 영역 SSIM 은 모두 0.95 이상(최저 0.9789)이고, 면 수 감소율은 시점별로 0~20.8%(가까운 S-near 는 0.0~1.2%)이다. 필지 간격이 큰 장면은 합쳐지지 않는다(결정 0044).

### 관제탑 지형 그리기 (T15)

클라이언트 래스터 기반 관제탑 지형 그리기. 계약 `contracts/controlview/terrain.mjs`, 구현 `client/tower/terrain/`(경계 렌더링·타일 관리·캐시). 도착한 지형 타일만 CPU 래스터로 그린다. 없는 곳은 비운다. 딜레이 패턴 4수준(스텝 250·1,000·3,500·7,000)은 같은 타일의 낮은 수준을 교체하고, 늦게 온 낮거나 같은 수준은 건너뜀. 도착하지 않은 타일은 "없음" 표시이며, 상태는 도착 이벤트로만 바뀐다. 좌표는 GeoAnchor 기준 로컬 ENU, 1 unit = 1 m. 시험: `node --test client/tower/terrain/*.test.mjs`.

8시점 SSIM은 SPEC S9의 합성 근사이며, 해상도 160×90, 3곳 눈 높이 17 m로 올림하고, 기준 영상은 같은 DEM의 LOD 0 메시(원본 점군 렌더가 아님)이다. LOD3은 높이 오차 상한을 1 m로 조여(T15.1c, 합성 장면 결과를 보고 고른 값) 합성 시드 1~12의 최소가 0.9645로 0.95를 넘는다(이전에는 시드 5·6·7·9·10이 미달). 기준 0.95는 낮추지 않았다.

### 관제탑 건물 그리기 (T15.3)

클라이언트 래스터 기반 관제탑 건물 그리기. 계약 `contracts/controlview/buildings.mjs`, 구현 `client/tower/buildings/`. 표시 옵션 3종: points·black(기본)·aerial. 옵션 전환 시 네트워크 요청 없음.

### 관제탑 입력 (T15.4)

방향키 조향·Q/E 고도를 서버 왕복 없이 로컬에서 처리한다. 계약 `contracts/controlview/input.mjs`, 구현 `client/tower/input/`(자세 적분·눌림 추적·카메라 변환). ←/→ 방위, ↑/↓ 앞뒤, E/Q 고도 ±. 방위 0 은 북이고 시계 방향이 +이며 좌표는 GeoAnchor 기준 ENU, 1 unit = 1 m. 키 배치와 속도는 원본 대조 전 추정값이다. 이 층은 네트워크·타이머를 쓰지 않으며 keyDown → step → camera 가 한 동기 호출 안에서 갱신된다. 시험: `node --test "client/tower/input/*.test.mjs"`.

### 관제탑 추적 카메라 (T15.5)

드론 목표를 지수 감쇠로 따라가는 카메라. 계약 `contracts/controlview/chase.mjs`, 구현 `client/tower/chase/`(감쇠 수학·카메라 배치·상태·조립). a = 1 − exp(−dt/tau) 라서 프레임 길이와 무관하고, 방위는 ±π 경계에서도 최단 호로 돈다. 목표가 없으면 `camera()` 는 null 이다. 기본값(tau 0.35 s, 뒤 30 m, 위 10 m)과 감쇠 의미는 원본 대조 전 추정이다. 네트워크·타이머를 쓰지 않는다. 시험: `node --test "client/tower/chase/*.test.mjs"`.

## English

Server-side renderer for SkyLens. Work in progress.

### What it is
A renderer that moves SkyLens 3D display (status board and control tower) from browser rendering to server rendering.
- **Path B — asset slimming**: the server preprocesses point clouds, terrain and buildings into LOD, culled, view-dependent chunks, and the browser draws only the chunks it receives with a lightweight rasterizer. Interaction stays local, so there is no input latency.
- **Path A — pixel streaming**: the server GPU rasterizes and encodes, and the browser only plays video and sends input.

The control tower uses B. The status board uses A on low-end devices and B on high-end devices. B is built first, and A takes B's asset format as its input.

### What is preserved
- Four-level delay pattern (250/1,000/3,500/7,000 steps): a new level replaces the lower level of the same segment, and a lower level that arrives late is skipped.
- Only what has arrived is drawn. Missing areas are shown as missing and never filled in.
- Coordinates are local ENU anchored at the GeoAnchor, 1 unit = 1 m.
- A single WebSocket transport.

### Usage
Tests: `npm test` (`node --test`). Tests that use real skylens input read the environment variable `SKYLENS_DIR` (path to a skylens checkout, default `/tmp/skylens`).

Run all baseline measurements:
```
node bench/baseline/run_all/cli.mjs --skylens-dir <path> --out <path> --commit <hash> [options]
```
| Option | Meaning |
| --- | --- |
| `--skylens-dir` | skylens checkout (read-only). Required |
| `--out` | Output folder: `records.json`, `summary.json` and one subfolder per module. Required |
| `--commit` | skylens commit hash. Required |
| `--only a,b` | Run only these comma-separated modules |
| `--skip c` | Skip these comma-separated modules |
| `--points <ply>` | Point cloud PLY input |
| `--ws-recording <jsonl>` | WebSocket frame recording input |
| `--tower-recording <jsonl>` | Control tower recording input |
| `--dist-dir <dir>` | Built skylens dist. If omitted, it is built once from a copy |
| `--entry-path <path>` | Page opened by the first-frame and heap measurements. A URL path starting with `/` (no query or hash) |
| `--anchor-lat/--anchor-lon/--anchor-alt` | Anchor coordinates. All three must be given together |

Exit codes: 0 = every module succeeded (skipped ones excluded), 1 = at least one module failed, 2 = invalid arguments.

Markdown report:
```
node tools/baseline_report/cli.mjs [--summary summary.json] records.json ...
node tools/baseline_report/cli.mjs --status summary.json
```
`--summary` puts a section of failed or unmeasurable modules at the top of the report. `--status` prints only the per-module status table. On error the exit code is 1.

Optional environment variables for measurement: `SKYLENS_PLAYWRIGHT_DIR` (playwright package folder), `SKYLENS_CHROMIUM` (chromium executable), `PLAYWRIGHT_BROWSERS_PATH`. For optional tests: `SKYLENS_DIST_DIR` (built dist), `SKYLENS_BUILD=1` (real build test), `TOWER_RECORDING` (control tower recording path).

### Baseline measurement tools
`bench/baseline/` holds tools that measure the current three.js implementation (bundle size, asset bytes, WebSocket bytes, control-tower requests, first frame, JS heap, reference images). `bench/baseline/run_all/cli.mjs` runs them all and `tools/baseline_report/cli.mjs` turns the results into a table. Tests run with `npm test` (Node 22+; headless-browser tests need `PLAYWRIGHT_BROWSERS_PATH`).

Example: `node bench/baseline/run_all/cli.mjs --skylens-dir <skylens develop clone> --out <dir> --commit <hash> --points <original PLY> --ws-recording <websocket recording> --tower-recording <tower recording> --anchor-lat <lat> --anchor-lon <lon> --anchor-alt <alt>`. Modules that need a build (bundle, first frame, heap) build a copy of skylens once with `npm ci` and a vite build (`--dist-dir` accepts an already built result), and a module whose required input is missing is recorded as failed instead of being fed synthetic data.

External tools: first-frame and heap measurement need playwright and Chromium. They are not listed in package.json; playwright is located via `SKYLENS_PLAYWRIGHT_DIR`, `NODE_PATH`, then the global install, and Chromium via `SKYLENS_CHROMIUM` or `PLAYWRIGHT_BROWSERS_PATH`. The license stays UNLICENSED until a human decides.

### Lightweight asset format (.skla)
One chunk is one file (128 B header + per-field planar body, little-endian, coordinates in GeoAnchor-relative ENU on 64 m tiles). The 27 B point (with normal) and the 56 B Gaussian (with opacity, scale and rotation) share one format, told apart by the format field in the header. The spec is `format/ASSET_FORMAT.md`, the code contract is `contracts/asset/`, and golden files are in `fixtures/asset_golden/`. Server modules live in `server/asset/` (header, tile index, bounds, ids, checksum, unpack, pack, determinism, compat, fuzzer), the client reader in `client/asset/`, and the validator is `node tools/asset_validate/cli.mjs <file.skla>` (exit code 1 on violations).

### Compression codec (T09)
Header codec value 1 (SKLC1) compresses 27 B point chunks. Quantized values stay as they are; points are reordered along a Morton curve, then position-key deltas, normal deltas and colour (lossless delta / palette / lossy low 2 bits) become per-field streams squeezed by an adaptive range coder. The spec is `format/ASSET_FORMAT.md` §4.3 and the contract is `contracts/codec/`. Server encode/decode is `server/codec/chunk/` (`encodeChunk`, `decodeChunk`), the client decoder is `client/codec/` (`decodeChunkClient`), bytes per point are measured by `bench/codec/cli.mjs`, and client decode speed by `bench/codec_client/cli.mjs`.

### Level state machine (T10)
The four delay-pattern levels (steps 250, 1,000, 3,500, 7,000) are replaced per segment. A new level releases the lower-level pieces of the same segment (no accumulation), and a lower or equal level arriving after a higher one is skipped. A segment that has not arrived is "missing" (zero render points), and state changes only on arrival events, never with time. The contract is `contracts/levels/` (`decideArrival`), the server machine is `server/levels/state/` (`createLevelMachine`), the client machine is `client/levels/`, and the missing-segment display is `client/levels/missing/`.

### Point input and coordinates (T04)
Reads and writes 27 B point and 56 B Gaussian PLY files. Contracts live in `contracts/points/` and `contracts/geo/`; server modules in `server/points/` (PLY read/write/streaming, rejection of corrupt input, normal normalization, segment file identification) and `server/geo/` (GPS↔ENU, ENU↔scene axes x=east, y=up, z=−north); the client conversion in `client/geo/`; point statistics in `tools/points_stat/`. GPS↔ENU uses the same equirectangular approximation as skylens `geo.ts` (R = 6378137 m) and is tested against a transcribed reference function to within 1 mm. When longitude difference |Δλ| exceeds 180°, use 360° − |Δλ|.

The ENU conversion differs from skylens geo.ts in two ways. First, after wrapping longitude difference |Δλ| > 180°, the result longitude is normalized to the range (−180, 180], and in the measured range |Δλ| ≤ 180° the output matches geo.ts bit-for-bit (decision 0017). Second, at a pole anchor (latitude ±90°), gpsToEnu explicitly sets the east component e to 0, eliminating the 1e-10 m residual created by cos 90° ≈ 6e-17. At a pole anchor the east direction is undefined, so this branch operates in a different range than geo.ts (decision 0018).

### Synthetic scenes and viewpoints (T05)
8 synthetic scenes for testing and measurement. Each scene generator lives in `fixtures/scenes/<name>/index.mjs` and exports `generate(opts)` returning a `SceneResult` (contract in `contracts/scenes/index.mjs`). Coordinates are local ENU anchored at the GeoAnchor, 1 unit = 1 m. Point formats: 27 B (position + normal) and 56 B (Gaussian with opacity, scale, rotation).

**Scenes:**
| Name | Description |
| --- | --- |
| buildings | Building footprints with heights (control tower use) |
| dem | Digital Elevation Model synthetic scene (control tower use) |
| depth_noise | Depth error model with noise injection |
| flat_boxes | Flat terrain (200×200 m) with 12 box buildings |
| holes | Flat terrain with patterned ground and rectangular gaps (no infill) |
| large | Large-scale scene generation (2.5M points for performance testing) |
| levels | Segment × 4-level point count ladder scene |
| terrain | Gentle terrain scene with analytical height field |

**Viewpoints:** `fixtures/viewpoints/synthetic.json` defines 8 fixed viewpoints for the `flat_boxes` scene (ids 1-8, names: aerial_overview, aerial_oblique_ne, top_down, street_level, low_close_box, tower_high, tower_mid, edge_far). This is separate from the production viewpoints file.

**Camera paths:** `fixtures/paths/index.mjs` provides camera path generators: drone tracking (circular flight with jitter) and free navigation (Catmull-Rom waypoints). Both use deterministic seeding (contracts/scenes mulberry32, subSeed).

**Preview generation:** Use `node tools/scene_preview/cli.mjs <scene-name> <seed> <output-directory>` to generate a preview image (PNG) of a scene with the specified seed. `<scene-name>` is one of the 8 scene keys. Output directory is created if needed.

### LOD (T07)

A hierarchy that thins the source cloud (format 1) by distance. It never creates points; it only uses a subset of the input points.
- `server/lod/hierarchy` `buildHierarchy(cloud, {edge0M, levelCount})`: level l keeps one representative per grid cell of edge `edge0M·2^l`, split at leaf boundaries (one per leaf×cell piece; level 0 is the full cloud).
- `server/lod/distance_table`, `select`, `budget`, `progressive`: level choice by screen-space error `f·edge/d_eff ≤ τ` (f=max(fx,fy), d_eff bounded below by d·cMin² over the on-screen part of the box, off-axis correction in `select/screen_error.mjs`), a point-budget cap, and coarse-first delivery (replacement, not accumulation).
- `server/lod/view_score`: neighbour-view scoring (shared points, ray angle, scale). `server/lod/no_fill`: hole-preservation check. `bench/lod`: per-segment size tally and materialize timing (`node bench/lod/cli.mjs`). Per-level representative positions are precomputed in leaf order (12 B per representative); materializing 1.84 M selected points peaks at 51–70 ms including the first call (shared 4-core machine, 7 runs).

### Development setup
```
git config core.hooksPath .githooks
```
The hooks block commits and pushes whose message, added content or branch name contains generation-tool traces.

### Protocol (T11)
A single binary WebSocket (TCP) framing: 8-byte header plus payload, nine message types (hello, view update, piece request, ack, welcome, piece, level arrived, missing, error). The contract is `contracts/proto/`; encode/decode lives in `server/proto/codec/` and `client/proto/` (same check order and error codes). The server skeleton is `server/ws/` (dependency-free RFC 6455; host and port come from the environment variables `SKYLENS_WS_HOST` and `SKYLENS_WS_PORT`), with backpressure in `server/ws/backpressure/`, reconnect in `server/ws/resume/`, the send scheduler in `server/scheduler/` (priority, byte budget, overtaken-level drop) and the initial bundle in `server/scheduler/initial/`, the skylens event adapter in `server/adapter/core/`, a mock client in `tools/mock_client/`, a fuzzer in `server/proto/fuzz/` and byte accounting in `bench/proto/`. Scheduler operation counts and timing are measured by `bench/scheduler/index.mjs` (report-only, exit code always 0, output includes Node version, core count and load). `server/ws/session` — provides wiring modules (emit recording, resumption resend, connection handling): they record adapter emissions to the continuation storage (server/ws/resume) and resend them on HELLO reception. LEVEL_ARRIVED is recorded before sending and resent via resendPlan on resumption. Connecting them at the server entry point (createWsServer onConnection) is not wired yet (used only in tests).

### Culling (T08)
- Every culling stage is conservative (never drops a leaf that should be visible). Each returns a 0/1 mask of length leafCount; signatures live in `contracts/cull`.
- `server/cull/frustum`, `backface` (normal cones), `occlusion` (CPU depth pyramid), `distance`, `predict` (motion-based look-ahead), `priority` (screen-contribution order), `degenerate` (degenerate views return an empty result instead of throwing), `combine` (`cullAndSelect`: AND the masks, then pick LOD levels). `client/cull`: frustum culling that yields the same mask as the server. `bench/cull`: CPU time per view.

### Client rasteriser (T12)
Draws .skla chunks with WebGL2. Contract: `contracts/client_raster/`; implementation: `client/raster/` (`createRenderer` in `index.mjs`; context and loss recovery `context/`, point shader and CPU reference `shader/`, chunk buffers `buffers/`, camera and K conversion `camera/`, frame loop and decode-worker wrapper `loop/`, hole check `missing/`, memory meter `memory/`, capture harness `test_harness/`, latency probes `latency/`). Only chunks in the LEVEL_ARRIVED completed-key set are drawn. Tests: `node --test "client/raster/**/*.test.mjs"` (real WebGL2 tests also run when Chromium is available). Performance figures are based on headless Chromium (SwiftShader, CPU) and do not represent actual GPU environments.

### Status view adapter (T13)
Puts the status-view roles on top of path B. Contract and role map: `contracts/statusview/`; implementation: `client/status/` (piece requests `arrival/`, level replacement `levels/`, arrival-based reveal `reveal/`, camera sync `camera/`, marker overlay `overlay/`, "missing" notice `missing_ui/`, fallback state `fallback/`, assembly `e2e/`); measurements: `bench/status_bw/`, `bench/status_quality/`. The skylens-original column of the role map is an estimate and has not been checked against the source. The SPEC S6 per-segment threshold (≤ 3,000,000 B) is reached in 2.5M-point synthesis at about 2.93 MB per segment using the lossless-color codec plus a per-segment point-budget thinning (`server/scheduler/segment_budget/`), but only about 13.4% of the source points are sent, so quality (S9) is affected and it is not yet wired into the real send path. Without thinning a segment is about 10 MB or more. Passing 100k-point synthesis does not mean S6 compliance. Every measured thinning ratio falls short of SSIM 0.95, so S6 and S9 conflict (decision 0043): the adopted 13.40% ratio gives an 8-viewpoint SSIM minimum of 0.6877 and mean of 0.7534 at 2.5M points, and even 50% has a minimum of 0.8714. Quality measurement `status_quality` runs at 320×180 resolution, 200k points, lossless color, CPU raster ([local] T13.10L) and S9 is not yet confirmed. ws entry wiring: `server/ws/wire/`.

### Tower assets (T14)

The contract lives in `contracts/tower_assets/`. It covers terrain mesh LOD (`server/terrain/mesh_lod`), satellite drape tiles (`drape`), a tile index (`tile_index`), an offline-use check (`offline`), and building extrusion, LOD, point samples, black-building edge lines and aerial UVs (`server/buildings/*`). All inputs are synthetic; real VWorld inputs have not been verified yet. `bench/tower_assets` measures processing time and serialized size for a 6,191-building synthetic city plus 1 km² of terrain and drape. With a noisy DEM the initial bundle (terrain LOD3 + drape mip2) is about 42.38 MB, over the 15 MB initial limit (recorded as exceeded); a smooth DEM gives about 4.46 MB. These two sizes are the worst case (5 m amplitude white-noise DEM) and an optimistic case (gentle hill) on synthetic inputs; real sizes will be fixed with real inputs in [local] T14L. Drape alignment measurement reports flat blocks as flatBlocks and axisFlatBlocks; if flat blocks exceed half of covered blocks, it is treated as unmeasurable. Building LOD merges buildings whose walls are within 3° into oriented boxes, and the width that is filled in (width of a sandwiched gap, depth of an open groove) is limited to 1/4 px (CPU soft raster composite scene value; a building's own box concave part is up to 2 px maximum). Meshes with partial roofs or mixed wrapping are kept in their original form, and duplicate boxes with the same footprint are folded. Over dense synthetic scenes with seeds 1–300 × 8 views (`node tools/lod_seed_sweep.mjs`), building-area SSIM is ≥ 0.95 everywhere (minimum 0.9789) and face count drops 0–20.8% depending on the view (0.0–1.2% for the close S-near view). Scenes with wide parcel gaps are not merged (decision 0044).

### Control tower terrain drawing (T15)

Client rasterization-based control tower terrain drawing. Contract: `contracts/controlview/terrain.mjs`; implementation: `client/tower/terrain/` (boundary rendering, tile management, caching). Only arrived terrain tiles are CPU-rasterized. Missing areas are left empty. The four-level delay pattern (steps 250, 1,000, 3,500, 7,000) replaces the lower level of the same tile, and a lower or equal level arriving late is skipped. An unreached tile is shown as missing; state changes only on arrival events. Coordinates are local ENU anchored at the GeoAnchor, 1 unit = 1 m. Tests: `node --test client/tower/terrain/*.test.mjs`.

The 8-viewpoint SSIM is a composite approximation of SPEC S9, with resolution 160×90 and eye height 17 m on 3 locations, and the reference image is LOD 0 mesh from the same DEM (not original point-cloud render). LOD3 now clears 0.95 (minimum 0.9645 over synthetic seeds 1-12) by tightening the height-error cap to 1 m (T15.1c, a value chosen after seeing the synthetic results); seeds 5, 6, 7, 9 and 10 previously fell short. The baseline 0.95 was not lowered.

### Control tower building drawing (T15.3)

Client rasterization-based control tower building drawing. Contract: `contracts/controlview/buildings.mjs`; implementation: `client/tower/buildings/`. Three display options: points, black (default), aerial. No network requests when switching options.

### Control tower input (T15.4)

Arrow-key steering and Q/E altitude are handled locally with no server round trip. Contract: `contracts/controlview/input.mjs`; implementation: `client/tower/input/` (pose integration, key tracking, camera conversion). Left/Right yaw, Up/Down forward/back, E/Q altitude. Yaw 0 is north, clockwise positive; coordinates are GeoAnchor-based ENU, 1 unit = 1 m. Key layout and speeds are estimates until compared with the original. The layer uses no network or timers, and keyDown → step → camera updates within one synchronous call. Tests: `node --test "client/tower/input/*.test.mjs"`.

### Tower chase camera (T15.5)

A camera that follows the drone target with exponential damping. Contract: `contracts/controlview/chase.mjs`; implementation: `client/tower/chase/` (damping math, camera rig, state, assembly). The factor a = 1 − exp(−dt/tau) is frame-rate independent, and yaw takes the shortest arc across the ±π boundary. `camera()` returns null until a target exists. Defaults (tau 0.35 s, 30 m behind, 10 m above) and the damping semantics are estimates until compared with the original. No network or timers. Tests: `node --test "client/tower/chase/*.test.mjs"`.
