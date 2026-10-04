// 클라이언트 경량 래스터라이저 계약(T12). WebGL2 로 .skla 조각을 실시간 3D 뷰로 그린다.
//
// ① 입력과 형식(SPEC §8 결정 0012: 27 B 점 경로와 56 B 가우시안 스플랫 경로를 둘 다 가진다)
//   uploadPiece 의 bytes 는 PIECE 메시지 본문의 조각 바이트(contracts/proto PIECE) 그대로, 곧 contracts/asset 의 .skla 조각
//   한 개(헤더 + 본문, codec 0 또는 1)다. 원본 PLY 레코드(27 B·56 B)가 아니다. 복호는 Web Worker 에서
//   client/codec decodeChunkClient 로 하고, 헤더의 format 필드로 경로를 고른다.
//     FORMAT_POINT27(1) → 점 경로      평면: 위치·색·법선(format/ASSET_FORMAT §4.2)
//     FORMAT_GAUSS56(2) → 가우시안 경로 평면: 위치·색·불투명도·크기·회전
//   RECORD_BYTES(27·56)는 원본 레코드 크기로 형식 이름의 근거일 뿐이고 GPU 배치 크기가 아니다. GPU 배치(정점 속성 보폭·패딩)는
//   구현 몫이며 계약으로 고정하지 않는다(memoryBytes 가 실제 사용량을 센다). 그래서 예전 28 B 패딩 상수는 근거
//   (renderer_basis §7-4·contracts/points·ASSET_FORMAT 어디에도 없음)가 없어 지웠다.
//   법선(형식 1 만): 위치와 같은 ENU 축의 세계 좌표 벡터다. 합치기(fusion) 단계의 값이다: 사진마다 카메라 법선 n 을
//     Rᵀn 으로 세계 좌표에 올리고(renderer_basis §7-1), 같은 점으로 판정된 사진들(최소 3장 — renderer_basis §10 의
//     '--number-views-fuse' 기본값 3 이 근거다)의 값을 평균해 한 점의 법선으로
//     저장한다(§7-2, 색도 같은 평균). 팔면체 사상 snorm8 로 저장된다(ASSET_FORMAT §5.3). 평균이라 길이 1 이 보장되지 않으므로
//     셰이더가 정규화한다. 셰이딩(T12.2)은 contracts/raster shade 의 lambert(normalWorld, lightDirWorld, rgb) 와 같은 식이고
//     빛 방향도 세계 좌표다. 형식 2 에는 법선이 없어 셰이딩하지 않는다.
//   색: 점마다 rgb u8 세 개(0..255, 영상 RGB 값).
//     형식 1 은 원본 r g b(codec 1 QUANT2 는 채널당 ±2 손실), 형식 2 는 c = clamp(round((0.5 + C0·f_dc)·255))(ASSET_FORMAT §5.2).
//
// ② 좌표·투영 규약은 contracts/raster 와 같다(그쪽이 정본이고 아래는 그 내용을 옮겨 적은 것이다).
//   X_c = R·X_w + t          세계(GeoAnchor 기준 ENU, 1 unit = 1 m) → 카메라
//   깊이 d = X_c.z            카메라는 +z 를 본다(OpenCV 규약: x 오른쪽, y 아래, z 앞)
//   [u,v,1]ᵀ ∝ K·X_c         u = fx·X_c.x/d + cx, v = fy·X_c.y/d + cy
//   픽셀 (i,j) 는 [i,i+1)×[j,j+1) 칸이고 정수 좌표 (i,j) 는 칸의 왼쪽 위 모서리다(u=i+0.5 가 중심).
//   해상도 변환은 두 가지이고 섞어 쓰지 않는다.
//   (가) 같은 영상을 다시 표본화(가로세로비가 같은 격자, 그리고 dpr 단계): scaleIntrinsics. fx·cx 에 sx, fy·cy 에 sy.
//     주점은 cx' = cx·sx(server/raster_ref/intrinsics 의 'basis' 규약, 위 픽셀 규약과 맞는 식). sx ≠ sy 인 격자에 쓰면
//     장면이 늘어난다(2048×1152 → 375×667@3 이면 fy/fx 가 3.16 배가 된다). 그래서 이 함수는 sx = sy 이거나 버퍼 반올림만큼
//     다른 경우(dpr 단계)에만 쓴다.
//   (나) 가로세로비가 다른 화면에 기준 시야를 놓기: fitIntrinsics. 배율은 하나(s)이고 fx·fy 에 함께 곱해 fx/fy 를 지킨다.
//       bw×bh = drawingBufferSize(W, H, dpr), sx = bw/refW, sy = bh/refH
//       mode 'contain'(기본): s = min(sx, sy)  기준 시야 전체가 보인다(배율이 작은 축에 맞춤, 남는 축은 시야 밖 띠).
//                             가로 기준 사진 → 세로 화면(375×667)이면 s = sx, 곧 가로 맞춤(fit-width)
//       mode 'cover'        : s = max(sx, sy)  화면을 시야로 채운다(배율이 큰 축에 맞춤, 기준 시야의 가장자리가 잘림).
//                             같은 예에서 s = sy, 곧 세로 맞춤(fit-height)
//       fx' = s·fx, fy' = s·fy, cx' = s·cx + (bw − s·refW)/2, cy' = s·cy + (bh − s·refH)/2
//     중앙 맞춤: 기준 영상 중심 (refW/2, refH/2) 은 버퍼 중심 (bw/2, bh/2) 으로 간다(정수 = 칸 모서리 규약이므로 중심은 W/2).
//     가로세로비가 같으면 s = sx = sy, 덧셈 항 0 이라 scaleIntrinsics 와 같다. 띠 부분은 시야 밖이라 점이 없을 뿐이고
//     렌더러가 무엇으로 메우지 않는다.
//   단위: setView 의 width·height 는 CSS 픽셀(캔버스 clientWidth·clientHeight)이고 view.K 도 그 CSS 픽셀 격자
//   (width×height)에 대한 값이다. devicePixelRatio 는 렌더러 안에서 한 곳, scaleIntrinsics 에서만 적용한다:
//   그리기 버퍼 = drawingBufferSize(width, height, dpr) = round(width·dpr) × round(height·dpr) 장치 픽셀,
//   셰이더가 쓰는 K = scaleIntrinsics(view.K, width, height, width, height, dpr)(장치 픽셀, (가)의 경우).
//   다른 해상도(예: 원본 사진 2048×1152)에서 보정된 K_ref 는 호출자가 fitIntrinsics(K_ref, refW, refH, width, height, 1, mode)
//   로 CSS 픽셀 K 로 바꿔 넘긴다((나)의 경우). 버퍼 반올림이 없으면 두 단계 결과는 fitIntrinsics(…, dpr) 한 단계와 같다.
//   dpr 규칙(명시): 호출자는 fitIntrinsics 에 dpr = 1 을 넘긴다. dpr 은 scaleIntrinsics(와 그리기 버퍼 크기)에서만 적용한다.
//   fitIntrinsics 가 dpr 인자를 받는 것은 "한 단계로 장치 픽셀 K 를 바로 얻는" 용도(시험의 기준값 등)이고, 렌더러 경로에서
//   dpr ≠ 1 을 넘긴 뒤 scaleIntrinsics 에 또 dpr 을 주면 dpr 이 두 번 곱해진다.
//   두 단계의 반올림 차이: 둘째 단계(scaleIntrinsics)는 반올림한 버퍼로 sx, sy 를 따로 구하므로 dpr 이 버퍼를 정수로 만들지
//   못하면 첫 단계에서 같던 fx, fy 가 조금 달라진다(333×222@1.25: 버퍼 416×278, sx = 416/333, sy = 278/222 이므로
//   fx = 203.125, fy ≈ 203.61 로 fy/fx ≠ 1). 같은 값을 한 단계 fitIntrinsics(…, 1.25) 로 구하면 s 하나라 fx = fy 다.
//   이 차이는 버퍼 반올림(축마다 ≤ 0.5 장치 픽셀)에서만 오고 dpr 이 정수이거나 버퍼가 정수가 되면 없다.
//   버퍼 크기를 반올림하므로 같은 점의 CSS 위치는 dpr 에 따라 최대 0.5 장치 픽셀까지 다를 수 있다(화면 안 점, |u/W| ≤ 1).
//   GL 규약: 셰이더는 OpenCV 카메라 좌표를 diag(1,−1,−1) 로 GL 카메라 좌표(y 위, −z 를 봄)로 바꾼다(contracts/raster 의
//   tools/render_views 와 같은 변환). R_gl = diag·R, t_gl = diag·t, X_gl = diag·X_c. 깊이 d = X_c.z ≤ 0(카메라 뒤 또는
//   카메라 평면 위)인 점과 정규화 좌표 x/d, y/d 가 유한하지 않은 점은 버린다(cameraPointToGl 이 null. contracts/raster project 는
//   K 를 곱한 뒤의 u, v 유한성을 보므로 조건이 완전히 같지는 않다, cameraPointToGl 설명 참조).
//   장치 픽셀 → NDC: pixelToNdc(u, v, bw, bh) = (2u/bw − 1, 1 − 2v/bh). y 는 뒤집힌다(픽셀 v 아래, NDC y 위).
//   (0,0) 모서리 → (−1, 1), (bw, bh) → (1, −1), 칸 (i,j) 의 중심 u = i+0.5 → 2(i+0.5)/bw − 1.
//
// ③ 조각 키(key): format/ASSET_FORMAT §11 의 정규 문자열 `${segmentId}.${level}.${tileX}.${tileY}.${lod}.${chunkIndex}`
//   (server/asset/ids encodeChunkKey 의 출력, 예: '7.2.1.-2.0.0'). 클라이언트는 PIECE 의 PieceKey 객체를 이 형식으로 바꿔
//   넘긴다. contracts/proto pieceKeyString 의 `a:b:…`(순서도 다름)은 서버 내부 중복 검사용이라 여기서 쓰지 않는다.
//
// ④ 그리기 규칙(수준 도착, contracts/proto LEVEL_ARRIVED): 조각(PIECE)은 받는 것만으로 그리지 않는다.
//   - 조각은 그 (segmentId, level) 의 LEVEL_ARRIVED 를 받은 뒤에만 그린다. 뒤따르는 LEVEL_ARRIVED 가 없는 조각은 절대 그리지 않는다.
//   - arrived 항목은 {segmentId, level, keys} 이고 keys 는 그 수준에서 완료된 조각 key 집합(ASSET_FORMAT §11 정규 문자열,
//     모두 같은 segmentId·level)이다. 가장 높은 수준 M 의 조각 중 그 집합에 든 key 만 그린다. 집합 밖의 M 수준 key 는 그 수준의
//     어느 LEVEL_ARRIVED 창에도 들지 않은 조각(선에서 완료 표시를 받지 못한 시도의 조각)이라 그리지 않고 discard 로 돌려준다.
//     호출자는 discard 를 releasePiece 로 해제한다. keys 가 없거나 빈 배열인 항목은 ClientRasterError('piece')다(LEVEL_ARRIVED 는
//     pieceCount ≥ 1).
//   - 선의 LEVEL_ARRIVED 는 {segmentId, level, pieceCount, firstPieceSeq} 이고 key 는 없어 keys 는 받은 PIECE 열로 만든다(./arrival.mjs completedKeys·
//     collectArrivals). 규칙: 같은 pieceSeq·같은 PieceKey 의 PIECE 는 한 조각(재전송), 같은 pieceSeq 에 다른 PieceKey 는 거부.
//     기본 규칙(F-236): LEVEL_ARRIVED 가 firstPieceSeq 를 싣고 있으면(선을 거친 것은 항상) n = pieceCount 일 때 완료 집합은 pieceSeq
//     firstPieceSeq..firstPieceSeq+n−1 의 조각 n 개의 key 다. 창이 명시되어 받은 PIECE 의 최대 pieceSeq 와 무관하고, 이어받기 뒤
//     혼자 다시 온 LEVEL_ARRIVED 도 같은 창이다(멱등). 대체 규칙: firstPieceSeq 가 없는 항목(선을 거치지 않은 입력)만
//     s = 그 LEVEL_ARRIVED 전까지 받은 가장 큰 pieceSeq 로 추정한 pieceSeq s−n+1..s 를 쓴다.
//     어느 쪽이든 그 n 개를 다 받지 못했거나(모자람) 다른 (segmentId, level) 이 섞였거나 key 가 겹치면 ClientRasterError('piece').
//     server/adapter/core 는 한 수준을 PIECE f..f+n−1 → LEVEL_ARRIVED 로 연달아 내고 그 사이 다른 이벤트를 내지 않으므로(F-204)
//     창은 정확히 그 수준의 조각이다. 실패한 시도가 남긴 조각: LEVEL_ARRIVED 가 쓰였으면 완료로 센다(그 시도가 LEVEL_ARRIVED
//     까지 쓴 뒤 실패하고 재시도가 skip 이 되어도 선에는 완료 표시가 있다, F-235). LEVEL_ARRIVED 가 쓰이지 않은 시도의 조각
//     (재시도 skip 으로 pieceSeq 를 태운 것, 교체된 어댑터의 것)은 뒤 LEVEL_ARRIVED 의 창 밖이라 완료가 아니다(같거나 낮은
//     수준이면 discard, 도착 수준이 없거나 높으면 pending). 입력은 한 세션의 수신 이력이고 새 pieceSeq 는 늘기만 한다(F-234,
//     ./arrival.mjs 규칙 ⓪①).
//   - 해제 근거(F-235): 클라이언트가 releasePiece 를 부르는 근거는 selectDrawable 의 discard 와 아래 pending 정리 규칙 둘뿐이다.
//     서버 어댑터(server/adapter/core)의 해제 알림은 서버 안의 콜백이고 proto 에 해제 메시지가 없으며, LEVEL_ARRIVED 를 쓴 뒤의
//     skip 처럼 클라이언트가 그리는 key 를 담을 수 있다. 그 알림을 releasePiece 로 직결하는 것은 금지한다.
//   - 수준은 쌓이지 않고 바뀐다: 한 구간에서 도착한 가장 높은 수준 M 의 조각만 그린다. 더 높은 수준이 도착하면 낮은 수준의
//     조각은(도착했든 아직 LEVEL_ARRIVED 를 기다리든) 버린다(releasePiece). M 보다 높은 수준의 조각은 자기 LEVEL_ARRIVED 를
//     기다리며 그리지 않는다.
//   - LOD 는 타일마다 하나만 그린다(F-243 ④, ASSET_FORMAT §10.1 '같은 (구간, 수준, 타일) 의 LOD 들은 서로 바꿔 끼우는 표현이다.
//     한 시점에 (구간, 수준, 타일) 마다 LOD 하나만 그린다'). 서버가 한 타일에 LOD 하나만 보낸다는 보장은 계약 어디에도 없으므로
//     (§10.1 은 lod 0..7 을 모두 허용하고 LEVEL_ARRIVED 완료 집합은 타일·LOD 를 가리지 않는다) 그리는 쪽이 고른다.
//     후보는 수준 M 의 완료 집합에 들고 동시에 keys(상주)에도 있는 조각뿐이다. 완료 집합 밖이거나 상주하지 않는 LOD 는 고르지
//     않는다(도착하지 않은 것을 그리지 않는다). 타일의 후보 LOD 가 여럿이면:
//       1) 완료 집합의 그 (타일, LOD) chunk 가 모두 상주한 LOD('완전') 중 가장 세밀한 것(lod 숫자가 가장 작은 것, §10.1 0 = 전부)을
//          고른다. 완전한 LOD 가 없으면 상주 chunk 가 하나라도 있는 LOD 중 가장 세밀한 것을 고른다(chunk 는 서로소라 일부만
//          그려도 도착한 점만 그린다. 다른 LOD 로 빈 chunk 를 메우지 않는다).
//       2) 고른 LOD 의 상주·완료 chunk 는 draw. 고른 LOD 가 완전하면 그보다 성긴 LOD(숫자가 큰 것)는 discard(완전한 LOD 로
//          바꿔 끼워졌다). 고른 LOD 가 완전하지 않으면(완전한 LOD 가 하나도 없으면) 그보다 성긴 LOD 도 pending 이다(F-246 ①).
//          일부 상주한 성긴 LOD 를 discard 로 두면 호출자가 해제해 그 LOD 도 영영 완전해지지 못하고, 고른 세밀한 LOD 마저 끝내
//          완전해지지 않으면 그 타일은 완전한 LOD 를 얻을 길이 없다. 성긴 LOD 가 먼저 완전해지면 다음 호출에서 1) 로 그것이
//          골라지고(draw) 세밀한 일부 LOD 는 아래 3) 으로 pending 이 된다.
//       3) 고른 것보다 세밀하지만 아직 완전하지 않은 LOD 는 pending(나머지 chunk 업로드를 기다린다. 그리지 않는다). discard 로 두면
//          호출자가 해제해 그 LOD 가 영영 완전해지지 못하므로 버리지 않는다. 완전해지면 다음 호출에서 그것이 골라지고 성긴 LOD 는
//          discard 가 된다. 끝내 완전해지지 않으면 아래 pending 정리 규칙으로 해제한다.
//       곧 discard 는 '완전한 LOD 보다 성긴 LOD' 뿐이다. 완전한 LOD 가 없는 동안 타일의 어떤 LOD 도 LOD 고르기 때문에 해제되지 않는다.
//     같은 (타일, LOD) 의 서로 다른 chunk_index 는 점을 나눈 것이라 함께 그린다(§10.1).
//   - 시점 거리 기반 LOD 선택은 미룬다(결정 0034). contracts/lod 는 거리 d 에서 화면 오차 f_view·edgeM/d ≤ τ 로 단계를 고르고
//     edge0M 하한에 깊이 해상도 Δd ≈ d²/(f·b) 를 쓰지만, 여기서는 시점을 보지 않고 늘 위 1)~3) 의 '완전한 것 중 가장 세밀한
//     LOD' 를 그린다. 이유: 한 타일에 여러 LOD 가 온다는 보장도 하나만 온다는 보장도 없고(§10.1, 어느 LOD 를 보낼지는 서버의
//     선택 몫), 시점이 바뀔 때마다 고르면 selectDrawable 이 도착 이벤트가 아니라 setView·프레임마다 돌아야 해(호출 주기 규칙과
//     어긋남) 해제·재업로드가 시점 이동에 따라 오간다. 거리 기반 선택은 서버 송출이 타일당 LOD 를 정하는 방식이 확정된 뒤
//     (결정 0034 '다시 볼 조건') 계약을 바꿔 넣는다. 그 전까지 세밀한 LOD 를 그리는 것은 도착한 점을 더 그리는 쪽이라 원칙을 어기지 않는다.
//   - 자기 LEVEL_ARRIVED 가 끝내 오지 않는 pending 조각: 계속 그리지 않는다. 정리 규칙: 그 구간의 시도(attempt)가 새 시도로
//     대체되거나 끝나면(종료·연결 끊김·재개 재시작 포함) 그 구간에 남은 pending key 전부를 포기(abandoned)로 보고 호출자가
//     releasePiece 로 해제한다. selectDrawable 은 순수 함수라 해제하지 않고 pending 을 그대로 돌려준다. 해제 전까지 pending 조각도
//     maxResidentBytes 에 들어가며, 한도를 넘으면 그리는 조각보다 pending 조각을 먼저 해제한다.
//   - key 의 segmentId 는 SEGMENT_ID_LIMIT(2^30) 미만, tileX·tileY 는 i32, chunkIndex 는 65536 미만이어야 하고 어기면
//     ClientRasterError('piece')다(arrived 항목의 segmentId 도 같다).
//   - 도착하지 않은 것을 그리거나 채우지 않는다(skylens 원칙). 순수 함수 selectDrawable 이 이 규칙의 기준이다.
// 프레임 루프는 조각 도착과 분리되어 있다(async uploadPiece, 다음 draw 에 반영).
// 메모리: maxResidentBytes 이내로 GPU 램을 쓴다(GPU 만, 시스템 메모리 아님).

/**
 * @typedef {Object} Intrinsics  contracts/raster 의 Intrinsics 와 같다(fx, fy > 0, 픽셀 단위)
 * @property {number} fx
 * @property {number} fy
 * @property {number} cx
 * @property {number} cy
 *
 * @typedef {Object} FrameStats  프레임 렌더 통계
 * @property {number} drawnPoints 화면에 그려진 점 수
 * @property {number} drawnPieces 렌더링에 사용된 조각 수
 * @property {number} droppedFrames 건너뛴 프레임 수(메모리/성능 제약)
 * @property {number} drawMs 렌더링 소요 시간(밀리초)
 *
 * @typedef {Object} View  카메라 뷰
 * @property {number[]} R  3×3 회전, 행 우선 9개(세계→카메라)
 * @property {number[]} t  3-벡터(m)
 * @property {Intrinsics} K  width×height CSS 픽셀 격자에 대한 내부 파라미터
 * @property {number} width   CSS 픽셀(양의 정수)
 * @property {number} height  CSS 픽셀(양의 정수)
 * @property {number} devicePixelRatio  장치 픽셀 / CSS 픽셀(양의 유한 수). scaleIntrinsics 에서만 적용한다
 *
 * @typedef {Object} Renderer  클라이언트 경량 래스터라이저 인스턴스
 * @property {(key: string, bytes: Uint8Array) => Promise<void>} uploadPiece  .skla 조각을 비동기로 업로드(복호는 Worker 에서). key 는 ASSET_FORMAT §11 정규 문자열
 * @property {(key: string) => void} releasePiece  조각 메모리 해제
 *   근거는 selectDrawable discard 와 pending 정리뿐이다(④ 해제 근거, 서버 어댑터 알림 직결 금지). 같은 key 중복 해제를
 *   견뎌야 한다(discard 와 pending 정리가 같은 key 를 여러 번 낼 수 있다).
 * @property {(view: View) => void} setView  카메라 뷰 설정
 * @property {() => FrameStats} draw  프레임 렌더링 및 통계 반환
 * @property {() => number} memoryBytes  현재 GPU 메모리 사용량(바이트)
 * @property {() => void} dispose  리소스 정리
 * @property {(callback?: () => void) => (() => void)} onContextLost  WebGL 컨텍스트 손실 핸들러. 구독 해제 함수 반환(부르면 그 callback 을 더 부르지 않는다)
 * @property {(callback?: (keys: string[]) => void) => (() => void)} onContextRestored  WebGL 컨텍스트 복구 핸들러. 콜백 인자: 다시 올려야 할 key 배열(소실 당시 상주·업로드 중이던 것). 구독 해제 함수 반환
 * @property {(arrived: {segmentId: number, level: number, keys: string[]}[]) => {draw: string[], pending: string[], discard: string[]}} setArrived  LEVEL_ARRIVED 완료 집합을 넘겨 그리는 조각을 정한다. 두 번째 인자 {deferResult: true} 면 반환 없이(undefined) selectDrawable 을 다음 draw 로 미뤄 프레임당 1회로 합친다(F-248 ④: 이벤트 폭주 때 이벤트 수 × 전체를 피한다). 반환값을 쓰면 인자 없이 부르며 그때는 지금처럼 즉시 계산한다. 지연 경로는 key 해석 오류를 draw 에서 낸다
 * @property {() => string[]} residentKeys  현재 상주 key 배열
 * @property {() => boolean} isContextLost  WebGL 컨텍스트 손실 상태
 *
 * @typedef {Object} CreateRendererOptions
 * @property {HTMLCanvasElement} canvas  렌더 타겟
 * @property {number} maxPieceBytes  한 조각 최대 크기(바이트, GPU 평면 합 = 형식 1 위치·색·법선 또는 형식 2 위치·색)
 * @property {number} maxResidentBytes  GPU 상주 메모리 상한(바이트)
 * @property {(bytes: Uint8Array) => any | Promise<any>} [decode]  복호기 주입. 기본은 client/codec decodeChunkClient(① 의 Worker 복호를
 *   하려면 Worker 클라이언트의 decode 를 넘긴다). 함수가 아니면 ClientRasterError('context')
 * @property {(keys: string[]) => void} [onEvict]  maxResidentBytes 를 지키려고 렌더러가 스스로 해제한 그리지 않는 상주 조각(pending·discard,
 *   오래된 것부터. draw 조각은 해제하지 않는다)의 key 알림. 호출자는 이 key 를 상주로 세지 않는다. 콜백이 던져도 해제는 이미 끝났다
 * @property {{lightDirWorld?: number[], pointSizeM?: number, ambient?: number, near?: number, far?: number}} [shading]  셰이딩·점 크기·
 *   깊이 범위. 빛 방향은 세계 좌표(①). 빠진 필드는 구현 기본값이고 틀린 값은 만들 때 ClientRasterError('view')
 * @property {() => number} [now]  draw 의 drawMs 를 재는 시계(밀리초, 기본 performance.now). 시험에서 가짜 시계를 넣는 용도
 * @property {Object} [contextAttributes]  canvas.getContext('webgl2', …) 속성. 구현 기본값 위에 덮어쓴다
 */

/** 클라이언트 래스터라이저 오류. code: 'context' | 'memory' | 'piece' | 'view' | 'unimplemented'. */
export class ClientRasterError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(`client_raster: ${code}: ${message}`);
    this.name = 'ClientRasterError';
    this.code = code;
  }
}

/** 형식 표시. contracts/asset·contracts/points 의 같은 이름 상수와 같은 값이다(시험으로 대조). */
export const FORMAT_POINT27 = 1;
export const FORMAT_GAUSS56 = 2;
/** 원본 레코드 크기(contracts/asset SOURCE_RECORD_BYTES·contracts/points RECORD_BYTES 와 같다). GPU 배치 크기가 아니다. */
export const RECORD_BYTES = Object.freeze({ [FORMAT_POINT27]: 27, [FORMAT_GAUSS56]: 56 });

/**
 * uploadPiece·releasePiece 의 key 형식(ASSET_FORMAT §11 정규 문자열의 모양). 이 정규식은 모양만 본다.
 * 범위(segmentId < 2^30, tile i32, chunkIndex < 65536)는 parsePieceKey 가 server/asset/ids decodeChunkKey 와 같게 검사한다.
 */
export const PIECE_KEY_PATTERN = /^(0|[1-9][0-9]*)\.[0-3]\.(0|-?[1-9][0-9]*)\.(0|-?[1-9][0-9]*)\.[0-7]\.(0|[1-9][0-9]*)$/;

/**
 * 함수 서명(구현은 client/* 및 Worker 스크립트).
 * 이름과 메서드 순서는 이 표가 기준이다.
 */
export const CLIENT_RASTER_API = Object.freeze({
  createRenderer: { fn: 'createRenderer(options) -> Renderer  options: {canvas, maxPieceBytes, maxResidentBytes, decode?, onEvict?, shading?, now?, contextAttributes?}' },
  uploadPiece: { fn: 'renderer.uploadPiece(key, bytes) -> Promise<void>  key: ASSET_FORMAT §11 "seg.level.tileX.tileY.lod.chunk", bytes: .skla piece (format 1|2)' },
  releasePiece: { fn: 'renderer.releasePiece(key) -> void  basis: selectDrawable discard + pending cleanup only (no direct wiring of server adapter release notices); must tolerate repeated release of the same key' },
  setView: { fn: 'renderer.setView(view) -> void  view: {R, t, K, width, height, devicePixelRatio}  K·width·height in CSS px' },
  draw: { fn: 'renderer.draw() -> FrameStats  {drawnPoints, drawnPieces, droppedFrames, drawMs}' },
  memoryBytes: { fn: 'renderer.memoryBytes() -> number' },
  dispose: { fn: 'renderer.dispose() -> void' },
  onContextLost: { fn: 'renderer.onContextLost(callback?) -> () => void  컨텍스트 손실 알림, 구독 해제 함수 반환' },
  onContextRestored: { fn: 'renderer.onContextRestored(callback?: (keys: string[]) => void) -> () => void  컨텍스트 복구 알림 (인자: 다시 올려야 할 key 배열), 구독 해제 함수 반환' },
  setArrived: { fn: 'renderer.setArrived(arrived: [{segmentId, level, keys}]) -> {draw: string[], pending: string[], discard: string[]}  LEVEL_ARRIVED 완료 집합으로 그리는 조각 결정' },
  residentKeys: { fn: 'renderer.residentKeys() -> string[]  현재 GPU 상주 key 배열' },
  isContextLost: { fn: 'renderer.isContextLost() -> boolean  WebGL 컨텍스트 손실 상태' },
  drawingBufferSize: { fn: 'drawingBufferSize(width, height, dpr) -> {width, height}  = round(width·dpr), round(height·dpr)' },
  scaleIntrinsics: { fn: 'scaleIntrinsics(K, refW, refH, W, H, dpr) -> Intrinsics  sx = round(W·dpr)/refW, sy = round(H·dpr)/refH  (same aspect / dpr step only)' },
  fitIntrinsics: { fn: "fitIntrinsics(K, refW, refH, W, H, dpr, mode?) -> Intrinsics  s = min|max(sx, sy) ('contain' default | 'cover'), fx·fy·s, centred" },
  cvToGlExtrinsics: { fn: 'cvToGlExtrinsics(R, t) -> {R, t}  diag(1,-1,-1)·R, diag(1,-1,-1)·t' },
  cameraPointToGl: { fn: 'cameraPointToGl(xc) -> [x, -y, -z] | null  null when d = xc[2] <= 0 or not finite' },
  pixelToNdc: { fn: 'pixelToNdc(u, v, bw, bh) -> [2u/bw - 1, 1 - 2v/bh]' },
  selectDrawable: { fn: 'selectDrawable(keys, arrived) -> {draw, pending, discard}  arrived: [{segmentId, level, keys}] built by arrival.mjs completedKeys(PIECE list, LEVEL_ARRIVED) (keys = completed key set, non-empty)' },
});

function posFinite(n, x) {
  if (typeof x !== 'number' || !Number.isFinite(x) || !(x > 0)) throw new ClientRasterError('view', `${n} 는 양의 유한 수여야 함: ${String(x)}`);
}

function posInt(n, x) {
  if (!Number.isInteger(x) || x <= 0) throw new ClientRasterError('view', `${n} 는 양의 정수여야 함: ${String(x)}`);
}

/** 그리기 버퍼 한 변의 기본 상한(장치 픽셀). 일반 WebGL2 MAX_TEXTURE_SIZE/렌더버퍼 한도 안쪽의 보수적 값이다. */
export const MAX_BUFFER_DIMENSION = 16384;

/** segmentId 상한(배타). server/asset/ids 의 segmentId < 2^30 과 같다. */
export const SEGMENT_ID_LIMIT = 2 ** 30;

/**
 * maxDimension 으로 주입할 수 있는 값의 상한(장치 픽셀). 이보다 큰 한도는 거부한다.
 * 입력 상식 검사용 상한이며 장치 한도가 아니다. 실제 장치 한도는 호출자가 gl.getParameter 로 확인해 maxDimension 에 넘긴다.
 */
export const MAX_BUFFER_DIMENSION_LIMIT = 32768;

/**
 * 배율 sx·sy 허용 범위 [1/SCALE_LIMIT, SCALE_LIMIT]. 밖이면 K 가 터무니없는 값이 되므로 거부한다.
 * 입력 상식 검사용 상한이며 장치 한도가 아니다(장치 한도는 gl.getParameter 로 호출자가 확인한다).
 */
export const SCALE_LIMIT = 4096;

const I32_MIN = -(2 ** 31);
const I32_MAX = 2 ** 31 - 1;
const CHUNK_INDEX_LIMIT = 65536;

/**
 * CSS 픽셀 크기와 dpr 로 그리기 버퍼(장치 픽셀) 크기를 정한다. 반올림 결과가 0 이거나 유한 안전 정수가 아니거나
 * maxDimension(기본 16384, options 로 주입, 주입값은 MAX_BUFFER_DIMENSION_LIMIT = 32768 이하)을 넘으면
 * ClientRasterError('view') 로 거부한다(곱셈 뒤에 검사한다). options 가 null·undefined 이면 기본값을 쓴다.
 * @param {number} width CSS 픽셀(양의 정수)
 * @param {number} height CSS 픽셀(양의 정수)
 * @param {number} dpr devicePixelRatio(양의 유한 수)
 * @param {{maxDimension?: number}} [options]
 * @returns {{width: number, height: number}}
 */
export function drawingBufferSize(width, height, dpr, options) {
  posInt('width', width);
  posInt('height', height);
  posFinite('devicePixelRatio', dpr);
  if (options != null && typeof options !== 'object') throw new ClientRasterError('view', `options 는 객체여야 함: ${String(options)}`);
  const maxDimension = options?.maxDimension ?? MAX_BUFFER_DIMENSION;
  posInt('maxDimension', maxDimension);
  if (maxDimension > MAX_BUFFER_DIMENSION_LIMIT) throw new ClientRasterError('view', `maxDimension 이 상한 ${MAX_BUFFER_DIMENSION_LIMIT} 을 넘음: ${maxDimension}`);
  const out = { width: Math.round(width * dpr), height: Math.round(height * dpr) };
  for (const n of ['width', 'height']) {
    if (!Number.isFinite(out[n]) || !Number.isSafeInteger(out[n]) || out[n] > maxDimension) {
      throw new ClientRasterError('view', `그리기 버퍼 ${n} 가 범위 밖(유한 안전 정수 ≤ ${maxDimension} 이어야 함): ${out[n]}`);
    }
  }
  if (out.width <= 0 || out.height <= 0) throw new ClientRasterError('view', `그리기 버퍼 크기가 0: ${out.width}×${out.height}`);
  return out;
}

/**
 * 내부 파라미터를 refW×refH 격자에서 그리기 버퍼(round(W·dpr)×round(H·dpr) 장치 픽셀) 격자로 옮긴다. 순수 함수.
 * fx·cx 에 sx = round(W·dpr)/refW, fy·cy 에 sy = round(H·dpr)/refH 를 따로 곱한다(cx' = cx·sx, 정수 좌표 = 칸 모서리 규약).
 * dpr = 1 이면 결과는 W×H CSS 픽셀 격자의 K 다.
 * 같은 영상을 다시 표본화할 때(가로세로비가 같은 격자, dpr 단계)만 쓴다. 가로세로비가 다르면 장면이 늘어나므로 fitIntrinsics 를 쓴다.
 * @param {Intrinsics} K refW×refH 격자의 K
 * @param {number} refW
 * @param {number} refH
 * @param {number} W CSS 픽셀
 * @param {number} H CSS 픽셀
 * @param {number} dpr
 * @returns {Intrinsics} 장치 픽셀 K
 */
export function scaleIntrinsics(K, refW, refH, W, H, dpr) {
  const buf = checkScaleInputs(K, refW, refH, W, H, dpr);
  const sx = buf.width / refW;
  const sy = buf.height / refH;
  checkScale('sx', sx);
  checkScale('sy', sy);
  return checkScaled({ fx: K.fx * sx, fy: K.fy * sy, cx: K.cx * sx, cy: K.cy * sy });
}

function checkScaleInputs(K, refW, refH, W, H, dpr) {
  if (!K || typeof K !== 'object') throw new ClientRasterError('view', 'K 가 객체가 아님');
  posFinite('K.fx', K.fx);
  posFinite('K.fy', K.fy);
  for (const n of ['cx', 'cy']) {
    if (typeof K[n] !== 'number' || !Number.isFinite(K[n])) throw new ClientRasterError('view', `K.${n} 는 유한 수여야 함: ${String(K[n])}`);
  }
  posFinite('refW', refW);
  posFinite('refH', refH);
  return drawingBufferSize(W, H, dpr);
}

function checkScale(n, x) {
  if (!(x >= 1 / SCALE_LIMIT && x <= SCALE_LIMIT)) throw new ClientRasterError('view', `배율 ${n} 가 범위 [1/${SCALE_LIMIT}, ${SCALE_LIMIT}] 밖: ${x}`);
}

function checkScaled(out) {
  for (const n of ['fx', 'fy']) if (!(out[n] > 0) || !Number.isFinite(out[n])) throw new ClientRasterError('view', `배율 결과 ${n} 가 양의 유한 수가 아님: ${out[n]}`);
  for (const n of ['cx', 'cy']) if (!Number.isFinite(out[n])) throw new ClientRasterError('view', `배율 결과 ${n} 가 유한하지 않음: ${out[n]}`);
  return out;
}

/** fitIntrinsics 의 mode 값. */
export const FIT_MODES = Object.freeze(['contain', 'cover']);

/**
 * 기준 격자 refW×refH 의 K 를 가로세로비가 다를 수 있는 그리기 버퍼(round(W·dpr)×round(H·dpr))로 옮긴다. 순수 함수.
 * 배율 하나 s 를 fx·fy 에 함께 곱해 fx/fy 를 지키고, 기준 영상 중심이 버퍼 중심에 오도록 cx·cy 에 중앙 맞춤 항을 더한다.
 *   'contain'(기본): s = min(sx, sy), 'cover': s = max(sx, sy)
 *   fx' = s·fx, fy' = s·fy, cx' = s·cx + (bw − s·refW)/2, cy' = s·cy + (bh − s·refH)/2
 * @param {Intrinsics} K refW×refH 격자의 K
 * @param {number} refW
 * @param {number} refH
 * @param {number} W CSS 픽셀
 * @param {number} H CSS 픽셀
 * @param {number} dpr
 * @param {'contain'|'cover'} [mode='contain']
 * @returns {Intrinsics} 장치 픽셀 K
 */
export function fitIntrinsics(K, refW, refH, W, H, dpr, mode = 'contain') {
  if (!FIT_MODES.includes(mode)) throw new ClientRasterError('view', `mode 는 'contain' 또는 'cover': ${String(mode)}`);
  const buf = checkScaleInputs(K, refW, refH, W, H, dpr);
  const sx = buf.width / refW;
  const sy = buf.height / refH;
  checkScale('sx', sx);
  checkScale('sy', sy);
  const s = mode === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
  return checkScaled({
    fx: K.fx * s,
    fy: K.fy * s,
    cx: K.cx * s + (buf.width - s * refW) / 2,
    cy: K.cy * s + (buf.height - s * refH) / 2,
  });
}

function finiteArray(n, a, len) {
  if (!(Array.isArray(a) || ArrayBuffer.isView(a)) || a.length !== len) throw new ClientRasterError('view', `${n} 는 길이 ${len} 이어야 함`);
  for (let i = 0; i < len; i += 1) {
    if (typeof a[i] !== 'number' || !Number.isFinite(a[i])) throw new ClientRasterError('view', `${n}[${i}] 는 유한 수여야 함: ${String(a[i])}`);
  }
}

/**
 * OpenCV 카메라 외부 파라미터(세계→카메라)를 GL 카메라 규약(y 위, −z 를 봄)으로 바꾼다. 순수 함수.
 * R_gl = diag(1,−1,−1)·R, t_gl = diag(1,−1,−1)·t (tools/render_views 의 역방향과 같은 대각 행렬, 자기 역행렬).
 * @param {number[]} R 3×3 행 우선 9개
 * @param {number[]} t 3-벡터
 * @returns {{R: number[], t: number[]}}
 */
export function cvToGlExtrinsics(R, t) {
  finiteArray('R', R, 9);
  finiteArray('t', t, 3);
  return {
    R: [R[0], R[1], R[2], -R[3], -R[4], -R[5], -R[6], -R[7], -R[8]],
    t: [t[0], -t[1], -t[2]],
  };
}

/**
 * OpenCV 카메라 좌표 점을 GL 카메라 좌표로 바꾼다. 깊이 d = xc[2] 가 0 이하(카메라 뒤 또는 카메라 평면 위)이거나
 * 정규화 좌표 x/d, y/d 가 유한하지 않으면 null(그리지 않음).
 * contracts/raster project 와의 차이: project 는 d ≤ 0 을 먼저 거르고, K 를 곱한 뒤(u = fx·x/d + cx) 결과가 유한한지로
 * NaN 을 판정한다. 여기는 K 를 모르므로 K 곱하기 전의 x/d, y/d 가 유한한지만 본다. 그래서 K 곱셈에서 넘치는 경우
 * (x/d 가 유한하지만 fx·x/d 가 Infinity)는 여기서 null 이 아니고 project 는 NaN 이다. 그런 점은 셰이더/클립이 걸러낸다.
 * @param {number[]} xc [x, y, d]
 * @returns {number[] | null} [x, −y, −d]
 */
export function cameraPointToGl(xc) {
  finiteArray('xc', xc, 3);
  const d = xc[2];
  if (!(d > 0) || !Number.isFinite(xc[0] / d) || !Number.isFinite(xc[1] / d)) return null;
  return [xc[0], -xc[1], -d];
}

/**
 * 장치 픽셀 좌표 (u, v) 를 NDC 로 바꾼다. 픽셀 규약은 contracts/raster 와 같다(정수 = 칸 모서리, 중심 i+0.5). y 는 뒤집힌다.
 * @param {number} u 장치 픽셀(오른쪽 +)
 * @param {number} v 장치 픽셀(아래 +)
 * @param {number} bw 그리기 버퍼 너비(양의 정수)
 * @param {number} bh 그리기 버퍼 높이(양의 정수)
 * @returns {number[]} [x_ndc, y_ndc] = [2u/bw − 1, 1 − 2v/bh]
 */
export function pixelToNdc(u, v, bw, bh) {
  posInt('bw', bw);
  posInt('bh', bh);
  finiteArray('[u, v]', [u, v], 2);
  return [(2 * u) / bw - 1, 1 - (2 * v) / bh];
}

/**
 * key 문자열을 ASSET_FORMAT §11 규칙으로 해석한다. 모양이 틀리거나 범위(segmentId < SEGMENT_ID_LIMIT, tileX·tileY i32,
 * chunkIndex < 65536)를 벗어나면 ClientRasterError('piece').
 * @param {string} key
 * @returns {{segmentId: number, level: number, tileX: number, tileY: number, lod: number, chunkIndex: number}}
 */
export function parsePieceKey(key) {
  if (typeof key !== 'string' || !PIECE_KEY_PATTERN.test(key)) throw new ClientRasterError('piece', `key 형식이 틀림: ${String(key)}`);
  const [segmentId, level, tileX, tileY, lod, chunkIndex] = key.split('.').map(Number);
  if (!(segmentId < SEGMENT_ID_LIMIT)) throw new ClientRasterError('piece', `key 의 segmentId 가 상한 ${SEGMENT_ID_LIMIT} 이상: ${key}`);
  for (const [n, v] of [['tileX', tileX], ['tileY', tileY]]) {
    if (!(v >= I32_MIN && v <= I32_MAX)) throw new ClientRasterError('piece', `key 의 ${n} 가 i32 밖: ${key}`);
  }
  if (!(chunkIndex < CHUNK_INDEX_LIMIT)) throw new ClientRasterError('piece', `key 의 chunkIndex 가 상한 ${CHUNK_INDEX_LIMIT} 이상: ${key}`);
  return { segmentId, level, tileX, tileY, lod, chunkIndex };
}

/**
 * 그리기 규칙(헤더 ④)의 기준 함수. 순수 함수.
 * 구간마다 LEVEL_ARRIVED 로 도착한 가장 높은 수준 M 을 구하고 조각 key 를 셋으로 나눈다.
 *   draw:    level = M 이고 M 의 완료 key 집합(LEVEL_ARRIVED.keys)에 든 조각
 *   discard: level < M 인 조각(더 높은 수준이 도착해 바뀌었다. 도착했든 기다리든 버린다),
 *            또는 level = M 이지만 완료 집합 밖인 조각(시도가 중간에 버린 abandoned 조각. 그리기 전에 해제된다)
 *   pending: 도착한 수준이 없는 구간의 조각 또는 level > M 인 조각(자기 LEVEL_ARRIVED 를 기다린다. 그리지 않는다)
 * LOD(헤더 ④, ASSET_FORMAT §10.1): 위 draw 후보를 (타일) 마다 묶어 LOD 하나만 draw 로 남긴다. 완전히 상주한 LOD 중 가장 세밀한 것,
 *   없으면 상주 chunk 가 있는 LOD 중 가장 세밀한 것을 고른다. 더 세밀하지만 덜 상주한 LOD 는 pending. 더 성긴 LOD 는 고른 LOD 가
 *   완전하면 discard, 완전하지 않으면 pending(F-246 ①: 완전한 LOD 가 없는 동안 어느 LOD 도 해제하지 않는다).
 * 같은 구간·같은 수준의 항목이 여럿이면 완료 집합은 합집합이다. 결과 배열 순서는 입력 순서를 따른다.
 * keys 에 같은 key 가 여러 번 있으면 첫 등장만 남기고 나머지는 버린다(draw·pending·discard 어디에도 한 번만 나온다).
 * 호출 주기: LEVEL_ARRIVED 도착 이벤트마다 부르며 프레임마다 부르지 않는다(결과는 다음 도착까지 재사용한다).
 * 비용: key 는 한 번만 해석한다(arrived.keys 에서 해석한 결과를 keys 처리에서 재사용한다).
 * 비용: key 당 Map get 1회·set 1회가 더 든다. 중복 key 제거(EMITTED 표시)와 해석 결과 재사용을 한 Map 이 겸하므로 key 마다 get(조회)과
 *   set(처리 표시)이 필요하고, 중복 없는 10만 key 에서 해석 한 번만 하는 단순 구현(약 45~47 ms) 대비 약 1.6배(약 71~80 ms)다.
 *   중복 제거를 포기하지 않는 한 key 당 get·set 을 더 줄일 수 없어 그대로 두었다(F-237 ⑤). 도착 이벤트마다 한 번 부르는 주기에서는 감수한다.
 * 비용(F-243 ④ LOD 고르기): 완료 key 마다 타일 문자열(key 앞 네 마디 slice) 하나와 타일 Map get 1회가 더 든다. 같은 기계에서
 *   10만 key·한 수준을 번갈아 잰 중앙값(각 10회)으로 고치기 전 약 160~200 ms 대비 약 245~315 ms(약 1.3~1.8배)였다(이 측정
 *   기계는 위 45~80 ms 측정 때보다 약 3배 느리다). 타일마다 묶지 않으면 LOD 하나를 고를 수 없어 감수한다. key 당 객체는 만들지 않는다.
 * completedKeys(./arrival.mjs) 주의: completedKeys 는 호출마다 pieces 전체로 색인을 다시 만든다(n=100k 한 번에 약 105 ms).
 *   도착 이벤트마다 부르면 O(n·k) 이므로 이벤트마다 호출하지 않는다. 이벤트를 따라가는 증분 경로는 collectArrivals 다(F-237 ④).
 * @param {string[]} keys ASSET_FORMAT §11 정규 문자열
 * @param {{segmentId: number, level: number, keys: string[]}[]} arrived 받은 LEVEL_ARRIVED 마다 completedKeys 로 만든 항목
 *   (segmentId < SEGMENT_ID_LIMIT = 2^30, -0 은 거부). keys 는 그 수준의 완료 key 집합이고 모두 (segmentId, level) 의 key 여야 한다.
 *   없거나 빈 배열이면 ClientRasterError('piece')(LEVEL_ARRIVED pieceCount ≥ 1).
 * @returns {{draw: string[], pending: string[], discard: string[]}}
 */
export function selectDrawable(keys, arrived) {
  if (!Array.isArray(keys)) throw new ClientRasterError('piece', 'keys 는 배열이어야 함');
  if (!Array.isArray(arrived)) throw new ClientRasterError('piece', 'arrived 는 배열이어야 함');
  const top = new Map(); // segmentId -> 도착한 가장 높은 수준 M
  const EMITTED = -1;
  // key -> 해석 결과. 해석 결과 재사용과 중복 제거(처리한 key 는 EMITTED)를 겸한다.
  // 완료 집합 key 는 타일 번호 * 8 + lod(0 이상, PIECE_KEY_PATTERN 이 lod 0..7 만 받는다)로 담는다. 타일은 (segmentId, level,
  // tileX, tileY) 이고 정규 key 의 앞 네 마디 문자열로 0 부터 차례로 번호를 매긴다(tileSegLevel 에 segmentId * 4 + level).
  // key 마다 객체를 만들지 않고 수 하나로 담아 타일·LOD 별 수를 배열로 센다(F-243 ④, 비용은 아래 selectDrawable 주석).
  const parsed = new Map();
  const tileIndex = new Map(); // 'segmentId.level.tileX.tileY' -> 타일 번호
  const tileSegLevel = []; // 타일 번호 -> segmentId * 4 + level
  const need = []; // [타일 * 8 + lod] -> 완료 집합의 chunk 수(중복 key 는 한 번)
  for (const a of arrived) {
    if (!a || !Number.isInteger(a.segmentId) || Object.is(a.segmentId, -0) || a.segmentId < 0 || a.segmentId >= SEGMENT_ID_LIMIT || !Number.isInteger(a.level) || a.level < 0 || a.level > 3) {
      throw new ClientRasterError('piece', `LEVEL_ARRIVED 항목이 틀림: ${JSON.stringify(a)}`);
    }
    if (!Array.isArray(a.keys) || a.keys.length === 0) throw new ClientRasterError('piece', `LEVEL_ARRIVED keys 는 비지 않은 배열이어야 함: ${JSON.stringify(a)}`);
    for (const k of a.keys) {
      const p = parsePieceKey(k);
      if (p.segmentId !== a.segmentId || p.level !== a.level) throw new ClientRasterError('piece', `LEVEL_ARRIVED keys 의 key 가 항목의 (segmentId, level) 과 다름: ${k}`);
      if (parsed.has(k)) continue; // 같은 완료 key 가 여러 항목에 있다(완료 집합은 합집합)
      const dot = k.lastIndexOf('.', k.lastIndexOf('.') - 1); // 정규 문자열이라 lod 앞의 '.'
      const tileId = k.slice(0, dot);
      let t = tileIndex.get(tileId);
      if (t === undefined) {
        t = tileIndex.size;
        tileIndex.set(tileId, t);
        tileSegLevel.push(a.segmentId * 4 + a.level);
        for (let i = 0; i < 8; i++) need.push(0);
      }
      const code = t * 8 + p.lod;
      need[code]++;
      parsed.set(k, code);
    }
    const cur = top.get(a.segmentId);
    if (cur === undefined || a.level > cur) top.set(a.segmentId, a.level);
  }
  // 입력 순서의 [key, 분류]. 분류: PENDING·DISCARD, 또는 0 이상이면 draw 후보(LOD 고르기 전)의 타일 * 8 + lod
  const PENDING = -2;
  const DISCARD = -3;
  const order = [];
  const have = new Uint32Array(need.length); // [타일 * 8 + lod] -> 상주 완료 chunk 수. 상주 수 = need 이면 그 LOD 는 '완전'하다
  for (const key of keys) {
    const code = parsed.get(key);
    if (code === EMITTED) continue; // 중복 key: 첫 등장만 남긴다
    parsed.set(key, EMITTED);
    if (code === undefined) {
      // 어느 완료 집합에도 없는 key: 도착 수준이 없거나 더 높으면 pending, 아니면(같거나 낮은 수준) discard
      const p = parsePieceKey(key);
      const m = top.get(p.segmentId);
      order.push(key, m === undefined || p.level > m ? PENDING : DISCARD);
      continue;
    }
    // 완료 집합 key: 자기 수준이 그 구간의 가장 높은 수준 M 이면 draw 후보, 낮으면(바뀌었다) discard
    const sl = tileSegLevel[(code - (code % 8)) / 8];
    if (sl % 4 === top.get((sl - (sl % 4)) / 4)) {
      have[code]++;
      order.push(key, code);
    } else order.push(key, DISCARD);
  }
  // 타일마다 그릴 LOD 하나: 완전한 LOD 중 가장 세밀한 것, 없으면 상주 chunk 가 있는 LOD 중 가장 세밀한 것(헤더 ④).
  // 고른 것이 완전하지 않으면 성긴 LOD 도 discard 하지 않고 pending 으로 둔다(F-246 ①)
  const tiles = tileSegLevel.length;
  const chosen = new Int8Array(tiles).fill(-1); // 타일 -> 고른 lod(-1 = 상주 후보 없음)
  const chosenComplete = new Uint8Array(tiles); // 타일 -> 고른 lod 가 완전하면 1(그때만 성긴 LOD 를 discard)
  for (let t = 0; t < tiles; t++) {
    let best = -1;
    let bestComplete = -1;
    for (let lod = 7; lod >= 0; lod--) { // 성긴 쪽부터 훑어 마지막에 남는 것이 가장 세밀하다
      const n = have[t * 8 + lod];
      if (n === 0) continue;
      best = lod;
      if (n === need[t * 8 + lod]) bestComplete = lod;
    }
    chosen[t] = bestComplete !== -1 ? bestComplete : best;
    chosenComplete[t] = bestComplete !== -1 ? 1 : 0;
  }
  const out = { draw: [], pending: [], discard: [] };
  for (let i = 0; i < order.length; i += 2) {
    const key = order[i];
    const c = order[i + 1];
    if (c === PENDING) out.pending.push(key);
    else if (c === DISCARD) out.discard.push(key);
    else {
      const lod = c % 8;
      const t = (c - lod) / 8;
      const pick = chosen[t];
      if (lod === pick) out.draw.push(key);
      else if (lod > pick && chosenComplete[t] === 1) out.discard.push(key); // 완전한 LOD 보다 성긴 LOD: 바꿔 끼워졌다
      else out.pending.push(key); // 더 세밀하지만 덜 상주한 LOD, 또는 완전한 LOD 가 없을 때의 성긴 LOD: 나머지 chunk 를 기다린다
    }
  }
  return out;
}

/**
 * 렌더러를 만든다. 반환 객체는 Renderer 인터페이스를 따른다.
 * @param {CreateRendererOptions} options
 * @returns {Renderer}
 */
export function createRenderer(options) {
  throw new ClientRasterError('unimplemented', 'createRenderer 는 계약서 서명만 제공; 구현은 client/* 에 있음');
}
