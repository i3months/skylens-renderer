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

### Development setup
```
git config core.hooksPath .githooks
```
The hooks block commits and pushes whose message, added content or branch name contains generation-tool traces.
