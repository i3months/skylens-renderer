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
- `server/lod/distance_table`, `select`, `budget`, `progressive`: 화면 공간 오차 `f·edge/d_eff ≤ τ`(f=max(fx,fy), d_eff=d·cMin², 축 밖 보정은 `select/screen_error.mjs`)로 단계 선택, 점 예산 상한, 거친 단계 먼저 보내기(교체이며 누적 아님).
- `select` 의 `materialize` 는 단계별 대표점 위치(`levels[l].positions`, 대표점당 12 B)를 리프 구간 복사로 옮긴다(184만 점 선택 약 67~75 ms, 부하에 따라 변동). 같은 리프에 더 고운 조각이 이미 있으면 `applyChunks` 는 늦게 온 거친 조각을 건너뛴다.
- `server/lod/view_score`: 이웃 시점 점수(공유 점·광선 각·축척). `server/lod/no_fill`: 빈자리 보존 검사. `bench/lod`: 구간 크기 집계(`node bench/lod/cli.mjs`).

### 개발 설정
```
git config core.hooksPath .githooks
```
훅은 커밋 메시지·추가 내용·브랜치 이름에 생성 도구 흔적이 있으면 커밋과 푸시를 막는다.

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
- `server/lod/distance_table`, `select`, `budget`, `progressive`: level choice by screen-space error `f·edge/d_eff ≤ τ` (f=max(fx,fy), d_eff=d·cMin², off-axis correction in `select/screen_error.mjs`), a point-budget cap, and coarse-first delivery (replacement, not accumulation).
- `select` `materialize` copies per-level representative positions (`levels[l].positions`, 12 B per representative) by leaf range (about 67-75 ms for 1.84M selected points, varies with load). `applyChunks` skips a late coarse chunk when a finer one already holds the leaf.
- `server/lod/view_score`: neighbour-view scoring (shared points, ray angle, scale). `server/lod/no_fill`: hole-preservation check. `bench/lod`: per-segment size tally (`node bench/lod/cli.mjs`).

### Development setup
```
git config core.hooksPath .githooks
```
The hooks block commits and pushes whose message, added content or branch name contains generation-tool traces.
