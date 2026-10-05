// T14.4 건물 LOD: 먼 곳의 건물을 이웃끼리 방향 상자(OBB)로 합쳐 면 수를 줄인다.
// 좌표는 ENU, 1 unit = 1 m. 입력 메시는 계약의 Mesh(positions xyz, indices 삼각형).
//
// 동작 요약
//  1) cameraDistM < BUILDING_LOD_FAR_DIST_M 이면 가까운 곳: 모든 건물을 원본 메시 그대로 한 동 한 그룹으로 돌려준다.
//  2) 먼 곳이면 허용 오차 tol = cameraDistM × BUILDING_LOD_MAX_ANGLE_RAD (m) 를 정하고,
//     - 건물마다 벽(xy 투영이 선분으로 눌린 삼각형)의 지배 방향 θ(90° 주기, 벽 길이 가중 평균)를 구한다.
//       모든 벽이 θ 와 BUILDING_LOD_MAX_WALL_ANGLE_RAD 이내로 평행·직교한 건물만 상자 후보가 된다
//       (다각 원통처럼 벽 방향이 여럿이면 상자로 바꿀 때 벽 법선이 크게 바뀌어 음영이 달라진다).
//     - 상자 후보는 BUILDING_LOD_CELL_M 격자 칸(이웃 단위)으로 나누고, 칸 안에서 θ 를 1차원으로 묶어
//       방향 묶음(묶음 안 모든 θ 가 묶음 기준 방향 φ 와 허용각 이내)을 만든다. 상자는 φ 방향 좌표계의 AABB 다.
//       따라서 상자의 벽 법선은 원래 벽 법선과 허용각 넘게 다르지 않다(음영 오차 상한).
//     - 건물마다 "φ 좌표계의 자기 상자로 바꿨을 때의 기하 오차"가 tol 이하인 것만 실제 상자 후보로 남는다(넘으면 원본 유지).
//     - 같은 방향 묶음 안에서, 두 상자 사이 틈과 높이 차가 모두 BUILDING_LOD_MAX_GAP_PX 이하이고, 합친 상자가 새로 덮는 빈 땅(틈 칸)의
//       메워지는 폭(끼인 틈은 틈 폭, 바깥으로 열린 홈·모서리는 깊이; gapCellError)이 hideTol 이하이며, 합친 상자의 오차가 tol 이하인 이웃 쌍을
//       오차 하한이 작은 순으로 탐욕적으로 합친다(응집 군집). 우선순위 큐에 인접 후보 쌍만 넣고, 꺼낸 쌍만 오차를 재며,
//       합칠 때마다 새 군집과 남은 군집 사이 쌍만 새로 넣는다.
//     - 다 합친 군집은 구성 건물 θ 범위의 가운데 방향으로 같은 병합 순서를 다시 재어 tol 안이면 그 방향 상자를 쓴다
//       (혼자 남은 건물은 자기 θ 방향 상자가 되어 원래 벽과 평행하다).
//     - 한 칸의 상자 후보 전체가 한 출력 그룹이 되고, 그 메시는 군집별 상자(벽 8 + 지붕 2 = 삼각형 10개)를 이어 붙인 것이다.
//  3) 모든 입력 id 는 정확히 한 출력 그룹에 속한다(동 보존). 출력 순서는 그룹의 첫 건물 입력 순서. 결정적.
//
// 오차 정의(수평): 상자 윗면(φ 좌표계 직사각형) 위 점에서 원본 건물들의 xy 투영(삼각형 합집합)까지 거리 최댓값의 상한.
//   직사각형을 표본 격자(간격 ≤ tol/2 균등 격자 + 구성 건물 상자 경계 좌표 + 이웃 좌표 사이 중점)로 덮고,
//   거리 함수가 1-립시츠라는 성질로 "표본 최댓값 + 가장 큰 격자 칸의 반대각선"을 쓴다(과소평가하지 않는다).
//   두 군집 A, B 를 합친 상자의 오차는 max(오차(A), 오차(B), 남는 영역 오차) 로 잰다. 합친 상자 중 A 상자 안의 점은
//   A 까지 거리가 오차(A) 이하이고 B 도 같으므로, 두 상자 밖 영역(틈 칸)만 새로 표본하면 된다(같은 φ 좌표계라 성립).
//   틈 칸은 어느 구성 건물에도 속하지 않는 빈 땅이므로 tol 이 아니라 hideTol 이하여야 한다(아래 "지워지는 세부").
//   tol 까지 허용되는 것은 한 건물을 자기 상자로 바꿀 때(L 자 홈 등)뿐이다.
// 오차 정의(수직): 상자 지붕 높이(군집 최대 높이) − 군집 안 윗면(위를 향한 삼각형) 최저 높이. 건물 사이 높이 차뿐 아니라
//   한 메시 안의 높이 차(기단 위 탑, 경사 지붕)도 포함한다.
// 음영 오차: 상자 벽 법선과 원래 벽 법선의 각 차 ≤ BUILDING_LOD_MAX_WALL_ANGLE_RAD.
// 지워지는 세부: 틈(상자 사이 거리)과 높이 계단(수직 오차)은 화면에서 옮겨지는 테두리가 아니라 통째로 사라지는 선·면이다.
//   그래서 2 px 테두리 허용(tol)이 아니라 BUILDING_LOD_MAX_GAP_PX(hideTol = 거리 × 픽셀 각 × px) 이하일 때만 지운다.
//   틈은 상자 사이 거리(mayMerge)만이 아니라 합친 상자가 새로 덮는 빈 땅 전체로 잰다: 메워지는 폭(모든 틈-칸 점의
//   min(2 × 구성 건물까지 거리, 구성 건물까지 거리 + 합친 상자 경계까지 거리))이
//   ≤ hideTol. 건물 사이 끼인 틈은 폭이 hideTol(1/4 px) 이하로 제한되고, 열린 홈이나 모서리는 깊이가
//   hideTol 이하. (F-334 이전엔 "구성 건물까지 거리 ≤ hideTol" 규칙이라 제3 건물을 거쳐 합쳐진 쌍의
//   끼인 틈이 2 × hideTol 까지 빠져나갔다.) 상자 사이 거리만 보면 앞뒤 면이 들쭉날쭉한 줄이나 대각 배치에서 tol(= 8 × hideTol)까지
//   빈 땅이 메워져, 줄 사이 틈의 벽 띠가 지붕으로 덮였다(이전 시드 180 top-high 건물 영역 SSIM 0.9496, F-326·F-331).
// 계산량: 한 칸 k 동에 대해 쌍 선검사 O(k²)(값싼 상자 비교), 오차 평가는 꺼낸 쌍만, 틈 칸만 표본한다.
import { TowerAssetError } from '../../../contracts/tower_assets/index.mjs';
import { foldContained } from './dedupe_boxes.mjs';

/** 기준 화면의 한 픽셀 각(rad): 세로 시야 60°, 세로 1080 px 화면. 관제탑 표준 화면을 가정한 값. */
export const BUILDING_LOD_REF_PIXEL_RAD = (Math.PI / 3) / 1080;
/** 상자 대체로 생기는 기하 오차의 화면 상한(px, 기준 화면). 2 px 이하면 테두리 앤티에일리어싱 폭 안이라 눈에 띄지 않는다고 본다. */
export const BUILDING_LOD_MAX_ERROR_PX = 2;
/** 허용 오차 각(rad). tol(m) = 거리 × 이 값. */
export const BUILDING_LOD_MAX_ANGLE_RAD = BUILDING_LOD_REF_PIXEL_RAD * BUILDING_LOD_MAX_ERROR_PX;
/**
 * 상자 벽 법선이 원래 벽 법선과 다를 수 있는 각 상한(rad, 3°).
 * 근거: 램버트 음영 n·L 의 변화는 |Δn| = 2 sin(Δ/2) ≤ Δ 이하라 3° 면 확산 음영 범위의 5.2% 이하다.
 * 지적·수치지도 외곽선은 직각·평행이 1~2° 어긋나는 일이 흔하므로 이 정도는 같은 방향으로 본다.
 * 다각 원통(12각 이상)은 벽 방향 간격이 7.5° 이상이라 후보가 되지 않는다.
 */
export const BUILDING_LOD_MAX_WALL_ANGLE_RAD = (3 * Math.PI) / 180;
/**
 * 상자로 바꾸며 통째로 지워도 되는 세부(이웃 사이 틈, 지붕 높이 계단)의 화면 크기 상한(px, 기준 화면).
 * hideTol(m) = 거리 × 기준 픽셀 각 × 이 값. 크기 s 인 세부의 화면 각은 시점 고도와 무관하게 s / 거리 이하다.
 * 근거: 테두리를 옮기는 오차(2 px)는 앞쪽 경계가 앞뒤로 움직일 뿐이지만, 틈을 메우거나 높이 계단을 지우면 그 틈의 지면 선,
 * 계단의 벽 띠(지붕과 음영이 다른 면)가 군집 폭 전체에서 사라진다. 8×8 블록 SSIM 은 균일한 지붕 위의 선·띠 유무에 민감하므로
 * 이런 세부는 한 픽셀을 덮는 비율이 1/4 이하(점 표본에서 네 화소 중 하나 꼴로만 보이는 크기)일 때만 지운다.
 * 이전에는 높이 계단을 2 px(tol)까지 지웠다. 그 결과 S-far-high(3 km, 고도각 11°)에서 한 층(3 m) 차이 연립 줄들이 한 상자로
 * 합쳐져 계단 벽 띠가 사라졌고, 시드 2·3·42·1234·2026 의 건물 영역 SSIM 이 0.914~0.946 으로 떨어졌다(lod.test.mjs DENSE 다중 시드).
 * 1/4 px 는 5 km 에서 약 1.2 m 라 그 거리의 1 m 틈 쌍은 합쳐진다. 맞붙은 같은 높이 건물(맞벽)은 틈·계단 0 이라 언제나 후보다.
 */
export const BUILDING_LOD_MAX_GAP_PX = 0.25;
/**
 * 먼 곳의 거리 기준(m). 이보다 가까우면 합치지 않고 원본을 그대로 둔다.
 * 근거: 500 m 에서 허용 오차는 약 0.97 m 로, 건물 외곽선(지적·수치지도) 자체의 위치 정밀도(대략 1 m)와 같은 수준이다.
 * 그보다 가까우면 줄일 수 있는 면이 거의 없고, 관제탑 바로 앞 전경은 원형 그대로가 낫다.
 */
export const BUILDING_LOD_FAR_DIST_M = 500;
/** 이웃 묶음 격자 칸 한 변(m). 지형 타일(64 m)과 같게 해 타일 단위로 함께 스트리밍되게 한다. */
export const BUILDING_LOD_CELL_M = 64;

/** 한 축 균등 표본 수 하한(작은 직사각형도 이만큼은 본다). */
const ERROR_SAMPLES = 9;
/**
 * 한 축 균등 표본 수 상한(계산량 제한). 넘으면 칸이 커져 상한 추정이 더 보수적이 될 뿐 과소평가는 없다.
 * singleError 에서만 씀(한 건물을 자기 상자와 비교, 한계 tol). (MAX_GRID − 1) × tol/2 보다 긴 변은
 * tol/2 이상의 간격을 가지고 더 큰 립시츠 여유를 가져서 매우 긴 건물은 원본으로 유지될 수 있다(안전한 쪽).
 * 틈 칸은 이 격자를 쓰지 않는다(gapCellError).
 */
const MAX_GRID = 129;
const QUARTER = Math.PI / 2;

function fail(msg) { throw new TowerAssetError(`buildBuildingLod: ${msg}`); }

// 각을 90° 주기로 [-45°, 45°) 에 접는다.
function fold90(a) {
  let r = (a + Math.PI / 4) % QUARTER;
  if (r < 0) r += QUARTER;
  return r - Math.PI / 4;
}

// 방향 있는 선분 [x1,y1,x2,y2,채널] 묶음(평탄화, 5개씩)이 이루는 고리들의 감김수가 0 이 아닌 영역의 넓이.
// 채널(0 또는 1)마다 감김수를 따로 세고, 어느 한 채널이라도 0 이 아닌 영역의 합집합 넓이를 낸다(F-355: 삼각형 쪽 +1 과 벽 쪽 −1 이 서로 지우지 않게).
// x 구간 [l, r] 마다 걸치는 선분(활성 집합)을 가운데 x 에서 y 로 정렬해 아래에서부터 감김수를 누적하고, 0 이 아닌 사이 간격의 사다리꼴 넓이를 더한다.
// F-367: 선분당 객체와 구간당 배열·정렬 객체를 없애고 Float64Array/Int32Array 만 쓴다. 활성 집합은 선분 번호 배열로 두고 이전 구간의 y 순서를
// 이어받아 삽입 정렬한다(이웃 구간에서 순서가 거의 안 바뀌므로 거의 선형). 한 구간에서 이동이 많으면(선분이 많이 교차) 비교 정렬로 넘어간다.
// 구간 수와 활성 선분 수의 곱(구간별 정렬 작업량)이 WINDING_WORK_CAP 을 넘으면 검사하지 않고 null(알 수 없음)을 돌려준다(F-360):
// 호출자는 그 건물을 원본으로 유지한다.
// 상한 값 40만의 근거: 측정으로 정한 값이 아니라 F-360 때 잡은 임의의 값을 그대로 둔 것이다(임의).
// 측정(F-367, Node 22, 4코어 컨테이너, 최소 5회): 위 개선 전에는 변이 격자 지붕(삼각형 800개, 정점 xy 를 0.3 m 흔든 것) 200동 5000 m 가 4180 ms 였다.
// 개선(타입 배열 + 직전 구간 순서 삽입 정렬 + 메시 안쪽 공유 변 상쇄) 뒤에는 같은 입력이 약 570 ms, 흔들지 않은 격자는 약 330 ms 다.
// 공유 변 상쇄 뒤에는 격자·부채꼴처럼 안쪽 변이 많은 지붕은 활성 선분이 경계 쪽만 남아 상한에 걸리지 않는다(삼각형 12800개 한 동 73 ms).
// 상한에 걸리는 것은 서로 겹쳐 쌓인 층(경계가 많이 겹치는 입력)이다. 같은 모양 직사각 지붕 2장씩 160층 이상(roof_area.test.mjs)이 걸리고,
// 상한 바로 아래 150층 한 동은 약 3 ms 라 상한을 낮출 이유가 측정으로는 없었다.
export const WINDING_WORK_CAP = 400000;
// 작업량 계수(시험이 벽시계 대신 이것으로 판정한다): calls 호출 수, segs 수평이 아닌 입력 선분, kept 공유 변 상쇄 뒤 선분,
// active 구간별 활성 선분 수의 합(감김 누적과 정렬이 도는 양), capped 상한에 걸려 null 을 돌려준 호출,
// probes 공유 변 상쇄 해시 표 탐사 수(선분당 1 + 충돌로 더 본 칸), moves 구간별 삽입 정렬이 옮긴 칸 수의 합(스윕 이동 횟수).
export const windingStats = { calls: 0, segs: 0, kept: 0, active: 0, capped: 0, probes: 0, moves: 0 };
const HK = new Float64Array(4), HU = new Uint32Array(HK.buffer);
function windingArea(segs) {
  const n = segs.length / 5;
  // 수평이 아닌(x1 !== x2) 선분만, x 가 증가하는 방향으로 정규화해 SoA 로 담는다.
  const sx = new Float64Array(n), sx2 = new Float64Array(n), sy2 = new Float64Array(n), sy = new Float64Array(n), sm = new Float64Array(n);
  const sdir = new Int8Array(n), sch = new Uint8Array(n);
  let c = 0;
  for (let i = 0; i < n; i++) {
    let x1 = segs[i * 5], y1 = segs[i * 5 + 1], x2 = segs[i * 5 + 2], y2 = segs[i * 5 + 3];
    if (x1 === x2) continue;
    let dir = 1;
    if (x2 < x1) { dir = -1; const tx = x1, ty = y1; x1 = x2; y1 = y2; x2 = tx; y2 = ty; }
    sx[c] = x1; sx2[c] = x2; sy2[c] = y2; sy[c] = y1; sm[c] = (y2 - y1) / (x2 - x1); sdir[c] = dir; sch[c] = segs[i * 5 + 4];
    c++;
  }
  windingStats.segs += c;
  // 같은 채널에서 같은 선분이 반대 방향으로 한 쌍 있으면 감김수 기여가 서로 정확히 지워지므로(메시 안쪽 공유 변) 미리 뺀다.
  // 결과는 그대로이고 활성 선분이 경계 쪽으로만 남는다(격자 지붕에서 약 3분의 2 감소). 정점은 float32 에서 온 값이라 좌표가 정확히 같다.
  if (c > 1) {
    let cap = 16;
    while (cap < c * 2) cap <<= 1;
    const tab = new Int32Array(cap).fill(-1); // -1 빈칸, -2 지운 칸, 그 외 선분 번호
    const dead = new Uint8Array(c);
    for (let s = 0; s < c; s++) {
      HK[0] = sx[s]; HK[1] = sy[s]; HK[2] = sx2[s]; HK[3] = sy2[s];
      let h = Math.imul(sch[s] + 1, 0x9e3779b1);
      for (let q = 0; q < 8; q++) h = Math.imul(h ^ HU[q], 0x85ebca6b) ^ (h >>> 13);
      let p = h & (cap - 1);
      let placed = false;
      windingStats.probes++;
      for (; tab[p] !== -1; p = (p + 1) & (cap - 1), windingStats.probes++) {
        const o = tab[p];
        if (o < 0) continue;
        if (sdir[o] === -sdir[s] && sch[o] === sch[s] && sx[o] === sx[s] && sx2[o] === sx2[s] && sy[o] === sy[s] && sy2[o] === sy2[s]) {
          dead[o] = 1; dead[s] = 1; tab[p] = -2; placed = true; break;
        }
      }
      if (!placed) tab[p] = s;
    }
    let w = 0;
    for (let s = 0; s < c; s++) {
      if (dead[s]) continue;
      if (w !== s) { sx[w] = sx[s]; sx2[w] = sx2[s]; sy2[w] = sy2[s]; sy[w] = sy[s]; sm[w] = sm[s]; sdir[w] = sdir[s]; sch[w] = sch[s]; }
      w++;
    }
    c = w;
  }
  windingStats.calls++;
  windingStats.kept += c;
  if (c === 0) return 0;
  const ex = new Float64Array(c * 2);
  for (let s = 0; s < c; s++) { ex[2 * s] = sx[s]; ex[2 * s + 1] = sx2[s]; }
  const xs = ex.sort(); // Float64Array 기본 정렬은 수치순
  let k = 0;
  for (let i = 0; i < xs.length; i++) if (i === 0 || xs[i] !== xs[i - 1]) xs[k++] = xs[i];
  const nx = k;
  const slot = (x) => { let lo = 0, hi = nx - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < x) lo = m + 1; else hi = m; } return lo; };
  // 구간 i = [xs[i], xs[i+1]] 마다 걸치는 선분 수를 차분 배열로 센다. 시작 칸별 선분 목록은 계수 정렬(head/next 연결)로 만든다.
  const sa = new Int32Array(c), sb = new Int32Array(c), diff = new Int32Array(nx + 1);
  const head = new Int32Array(nx).fill(-1), next = new Int32Array(c);
  for (let s = c - 1; s >= 0; s--) {
    const a = slot(sx[s]), b = slot(sx2[s]);
    sa[s] = a; sb[s] = b; diff[a]++; diff[b]--;
    next[s] = head[a]; head[a] = s;
  }
  let act = 0, work = 0;
  for (let i = 0; i + 1 < nx; i++) {
    act += diff[i];
    windingStats.active += act;
    work += act * (Math.log2(act + 1) + 1);
    if (work > WINDING_WORK_CAP) { windingStats.capped++; return null; }
  }
  const cur = new Int32Array(c); // 활성 선분 번호, 직전 구간의 y 순서
  const yk = new Float64Array(c); // 선분 번호 → 이번 구간 가운데 x 에서의 y
  let cnt = 0;
  let area = 0;
  for (let i = 0; i + 1 < nx; i++) {
    const l = xs[i], r = xs[i + 1], mid = (l + r) / 2;
    let w = 0;
    for (let j = 0; j < cnt; j++) { const s = cur[j]; if (sb[s] > i) cur[w++] = s; }
    cnt = w;
    for (let s = head[i]; s !== -1; s = next[s]) cur[cnt++] = s;
    for (let j = 0; j < cnt; j++) { const s = cur[j]; yk[s] = sy[s] + sm[s] * (mid - sx[s]); }
    // 삽입 정렬(안정). 이동 횟수가 예산을 넘으면 비교 정렬로 바꾼다.
    let moves = 0;
    const budget = 8 * cnt + 64;
    let slow = false;
    for (let j = 1; j < cnt && !slow; j++) {
      const s = cur[j], y = yk[s];
      let p = j - 1;
      while (p >= 0 && yk[cur[p]] > y) { cur[p + 1] = cur[p]; p--; moves++; }
      cur[p + 1] = s;
      if (moves > budget) slow = true;
    }
    windingStats.moves += moves;
    if (slow) cur.subarray(0, cnt).sort((a, b) => yk[a] - yk[b] || a - b);
    let w0 = 0, w1 = 0;
    for (let j = 0; j + 1 < cnt; j++) {
      const a = cur[j];
      if (sch[a] === 0) w0 += sdir[a]; else w1 += sdir[a];
      if (w0 === 0 && w1 === 0) continue;
      const b = cur[j + 1];
      area += (r - l) * ((sy[b] + sm[b] * (l - sx[b]) - sy[a] - sm[a] * (l - sx[a])) + (sy[b] + sm[b] * (r - sx[b]) - sy[a] - sm[a] * (r - sx[a]))) / 2;
    }
  }
  return area;
}

// 지붕 넓이 검사(summarize 가 모아 둔 선분으로, LOD 가 필요한 거리에서만 부른다). 위를 향한 삼각형 합집합 넓이가 외곽 투영 넓이에 못 미치거나
// 작업량 상한을 넘어 확인할 수 없으면 roofMin = -Infinity(원본 유지).
function resolveRoof(it) {
  const chk = it.roofCheck;
  if (!chk) return;
  it.roofCheck = null;
  const foot = windingArea(chk.footSegs), up = foot === null ? null : windingArea(chk.upSegs);
  if (foot === null || up === null || up < foot - Math.max(1e-3, foot * 1e-4)) it.roofMin = -Infinity;
}

// 작업량 계수: calls 요약한 건물 수, tris 훑은 삼각형 수, wallLookups 벽 중복 제거 표 조회 수, wallProbes 그 탐사 수(조회마다 1 + 충돌).
export const summarizeStats = { calls: 0, tris: 0, wallLookups: 0, wallProbes: 0 };
// 건물 하나의 요약: 월드 AABB, 꼭대기 높이, xy 투영 삼각형(평탄화 배열 [ax,ay,bx,by,cx,cy,...]), 벽 지배 방향.
function summarize(b, index) {
  if (!b || typeof b !== 'object') fail(`buildings[${index}] 가 객체가 아니다`);
  const { id, mesh } = b;
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) fail(`buildings[${index}].id 가 u32 가 아니다`);
  if (!mesh || !(mesh.positions instanceof Float32Array) || !(mesh.indices instanceof Uint32Array)) {
    fail(`buildings[${index}].mesh 는 { positions: Float32Array, indices: Uint32Array } 여야 한다`);
  }
  const p = mesh.positions;
  const idx = mesh.indices;
  if (p.length % 3 !== 0 || idx.length % 3 !== 0) fail(`buildings[${index}].mesh 길이가 3의 배수가 아니다`);
  const nv = p.length / 3;
  summarizeStats.calls++;
  summarizeStats.tris += idx.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i];
    if (v >= nv) fail(`buildings[${index}].mesh 인덱스가 범위를 벗어났다`);
    const x = p[v * 3], y = p[v * 3 + 1], z = p[v * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) fail(`buildings[${index}].mesh 좌표가 유한하지 않다`);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const tris = new Float64Array((idx.length / 3) * 6);
  for (let t = 0; t < idx.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k];
      tris[t * 6 + k * 2] = p[v * 3];
      tris[t * 6 + k * 2 + 1] = p[v * 3 + 1];
    }
  }
  // 벽 방향: xy 투영이 선분으로 눌린 삼각형(벽)의 가장 긴 변 방향. 90° 주기 방향이라 4배 각의 길이 가중 평균으로
  // 지배 방향 θ 를 구하고, 모든 벽이 θ 와 허용각 이내인지(wallDev) 본다.
  const wallAngles = [];
  let sc = 0, ss = 0;
  for (let o = 0; o < tris.length; o += 6) {
    const ax = tris[o], ay = tris[o + 1], bx = tris[o + 2], by = tris[o + 3], cx = tris[o + 4], cy = tris[o + 5];
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) > 1e-6) continue; // 지붕·바닥 삼각형
    let dx = 0, dy = 0, len = 0;
    for (const [ux, uy, vx, vy] of [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]]) {
      const l = Math.hypot(vx - ux, vy - uy);
      if (l > len) { len = l; dx = vx - ux; dy = vy - uy; }
    }
    if (len < 1e-6) continue;
    const a = Math.atan2(dy, dx);
    wallAngles.push(a);
    sc += len * Math.cos(4 * a); ss += len * Math.sin(4 * a);
  }
  const theta = wallAngles.length ? fold90(Math.atan2(ss, sc) / 4) : 0;
  // 윗면 최저 높이: 위를 향한(xy 투영이 반시계, 넓이 있는) 삼각형 꼭짓점 z 의 최솟값. 상자 지붕은 maxZ 이므로
  // 한 메시 안의 높이 차(낮은 기단 위 탑, 경사 지붕)도 수직 오차 maxZ − roofMin 으로 잡힌다.
  // 지붕 높이를 알 수 없거나 믿을 수 없으면 roofMin 을 -Infinity 로 두어 수직 오차를 무한대로 만들고 그 건물은 원본을 유지한다
  // (계약의 오류 관례: 해석할 수 없는 입력은 바꾸지 않고 그대로 돌려준다). 상자는 지붕을 maxZ 에 새로 만들기 때문에(F-327, F-355):
  //  - 위를 향한 삼각형이 하나도 없다(벽만 있는 퇴화 입력, 또는 계약과 반대인 시계 방향 감김).
  //  - 바닥면(minZ)이 아닌 높이에 넓이 있는 시계 방향 삼각형이 있다(뒤집힌 윗면).
  //  - 위를 향한 삼각형의 xy 합집합 넓이가 외곽 투영(벽 고리와 모든 넓이 있는 삼각형의 합집합; 삼각형 쪽과 벽 쪽 감김은 따로 세어 |w| 합집합으로 본다, F-355) 넓이에 못 미친다
  //    작업량 상한을 넘어 확인할 수 없는 큰 메시도 원본을 유지한다(F-360). 이 비교는 LOD 가 필요한 거리에서만 한다(resolveRoof).
  //    (일부만 지붕이 있거나 감김이 섞인 메시: 지붕 없는 구역 위에 상자 지붕이 생긴다).
  let roofMin = Infinity, cwAbove = false;
  const upSegs = [], footSegs = [];
  // 벽 중복 제거 표(열린 주소, 좌표 비트 해시): 사각 벽의 두 삼각형이 같은 선분이라 한 번만 넣는다. 문자열 Set 과 같은 결과이고 탐사 수를 센다.
  let wcap = 16;
  while (wcap < idx.length / 3 * 2) wcap <<= 1;
  const wtab = new Int32Array(wcap).fill(-1); // footSegs 안 선분 위치
  const WK = new Float64Array(4), WU = new Uint32Array(WK.buffer);
  for (let t = 0; t < idx.length / 3; t++) {
    const o = t * 6;
    const ax = tris[o], ay = tris[o + 1], bx = tris[o + 2], by = tris[o + 3], cx = tris[o + 4], cy = tris[o + 5];
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    const v0 = idx[t * 3], v1 = idx[t * 3 + 1], v2 = idx[t * 3 + 2];
    if (area > 1e-6) {
      for (let k = 0; k < 3; k++) roofMin = Math.min(roofMin, p[idx[t * 3 + k] * 3 + 2]);
      upSegs.push(ax, ay, bx, by, 0, bx, by, cx, cy, 0, cx, cy, ax, ay, 0);
      footSegs.push(ax, ay, bx, by, 0, bx, by, cx, cy, 0, cx, cy, ax, ay, 0);
    } else if (area < -1e-6) {
      if (Math.min(p[v0 * 3 + 2], p[v1 * 3 + 2], p[v2 * 3 + 2]) > minZ + 1e-6) cwAbove = true;
      footSegs.push(ax, ay, cx, cy, 0, cx, cy, bx, by, 0, bx, by, ax, ay, 0);
    } else {
      // 벽 삼각형: 가장 먼 두 점이 이루는 선분을 바깥 법선이 오른쪽에 오는 방향(반시계 고리)으로 넣는다. 사각 벽의 두 삼각형은 같은 선분이라 한 번만.
      const e1x = p[v1 * 3] - p[v0 * 3], e1y = p[v1 * 3 + 1] - p[v0 * 3 + 1], e1z = p[v1 * 3 + 2] - p[v0 * 3 + 2];
      const e2x = p[v2 * 3] - p[v0 * 3], e2y = p[v2 * 3 + 1] - p[v0 * 3 + 1], e2z = p[v2 * 3 + 2] - p[v0 * 3 + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z;
      let sx = ax, sy = ay, ex = bx, ey = by, best = Math.hypot(bx - ax, by - ay);
      for (const [px, py, qx, qy] of [[bx, by, cx, cy], [cx, cy, ax, ay]]) {
        const l = Math.hypot(qx - px, qy - py);
        if (l > best) { best = l; sx = px; sy = py; ex = qx; ey = qy; }
      }
      if (best < 1e-6 || Math.hypot(nx, ny) < 1e-12) continue;
      if ((ex - sx) * -ny + (ey - sy) * nx < 0) { [sx, sy, ex, ey] = [ex, ey, sx, sy]; }
      WK[0] = sx + 0; WK[1] = sy + 0; WK[2] = ex + 0; WK[3] = ey + 0; // +0: -0 을 0 으로
      let hh = 0x811c9dc5;
      for (let q = 0; q < 8; q++) hh = Math.imul(hh ^ WU[q], 0x85ebca6b) ^ (hh >>> 13);
      summarizeStats.wallLookups++;
      let seen = false, wp = hh & (wcap - 1);
      for (; ; wp = (wp + 1) & (wcap - 1)) {
        summarizeStats.wallProbes++;
        const o = wtab[wp];
        if (o === -1) break;
        if (footSegs[o] === WK[0] && footSegs[o + 1] === WK[1] && footSegs[o + 2] === WK[2] && footSegs[o + 3] === WK[3]) { seen = true; break; }
      }
      if (seen) continue;
      wtab[wp] = footSegs.length;
      footSegs.push(sx, sy, ex, ey, 1); // 채널 1: 벽 고리(삼각형 채널 0 과 따로 센다)
    }
  }
  let roofCheck = null;
  if (roofMin === Infinity || cwAbove) roofMin = -Infinity;
  else roofCheck = { upSegs, footSegs }; // 넓이 비교는 resolveRoof 에서(근거리에서는 필요 없다)
  let wallDev = 0;
  for (const a of wallAngles) wallDev = Math.max(wallDev, Math.abs(fold90(a - theta)));
  return {
    order: index, id, mesh, empty: idx.length === 0, minX, minY, minZ, maxX, maxY, maxZ, roofMin, roofCheck, tris, theta,
    dirOk: wallDev <= BUILDING_LOD_MAX_WALL_ANGLE_RAD,
  };
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const qx = ax + t * dx - px, qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

// 점이 넓이 있는 xy 투영 삼각형 안(경계 포함)인지.
function inTri(px, py, t, o) {
  const ax = t[o], ay = t[o + 1], bx = t[o + 2], by = t[o + 3], cx = t[o + 4], cy = t[o + 5];
  const s = Math.sign((bx - ax) * (cy - ay) - (cx - ax) * (by - ay));
  return ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) * s >= 0
    && ((cx - bx) * (py - by) - (px - bx) * (cy - by)) * s >= 0
    && ((ax - cx) * (py - cy) - (px - cx) * (ay - cy)) * s >= 0;
}

// 건물을 방향 φ 좌표계(u = x cosφ + y sinφ, v = −x sinφ + y cosφ)로 옮긴 요소: 그 좌표계 AABB,
// 넓이 있는 삼각형(fill, 안 판정용)과 모든 삼각형 변의 중복 없는 선분(segs, 거리용; 퇴화한 벽 삼각형은 선분으로 남는다).
// 작업량 계수(시험이 벽시계 대신 이것으로 판정한다): segs 점-선분 거리 계산 수, frameSegs toFrame 이 만든 중복 없는 선분 수,
// addCalls toFrame 의 선분 추가 시도 수(삼각형 변마다 1), probes 그 해시 표 탐사 수(시도마다 1 + 충돌로 더 본 칸; 선형 탐색이면 시도 수의 제곱으로 는다).
// gapCellError(F-377): gapCalls 호출 수, gapNear 호출마다 near 건물 수의 합, gapCells 분기-한계로 잰 칸 수, gapVisits 색인 조회가 넘긴 건물 수(색인 없는 전수 경로는 세지 않는다), gapBig 색인 big 목록에 둔 건물 수의 합(F-382)
// (칸마다 near 전부를 훑으면 gapCells × near 로 는다).
export const distStats = { segs: 0, frameSegs: 0, addCalls: 0, probes: 0, gapCalls: 0, gapNear: 0, gapCells: 0, gapVisits: 0, gapBig: 0 };
const SK = new Float64Array(4), SU = new Uint32Array(SK.buffer);
function toFrame(it, phi) {
  const c = Math.cos(phi), s = Math.sin(phi);
  const src = it.tris, tris = new Float64Array(src.length);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let o = 0; o < src.length; o += 2) {
    const u = src[o] * c + src[o + 1] * s, v = -src[o] * s + src[o + 1] * c;
    tris[o] = u; tris[o + 1] = v;
    if (u < minX) minX = u; if (u > maxX) maxX = u;
    if (v < minY) minY = v; if (v > maxY) maxY = v;
  }
  const fill = [], segs = [];
  // 중복 변 제거: 방향을 정규화한 끝점 4개가 같은 선분은 한 번만 남긴다(처음 나온 것). 문자열 키 대신 좌표 비트 해시 표(열린 주소)를 쓴다(F-367: 800삼각형 200동에서 toFrame 이 가장 컸다).
  let cap = 16;
  while (cap < (tris.length / 2) * 2) cap <<= 1;
  const tab = new Int32Array(cap).fill(-1); // 선분 번호(segs 안 위치 / 4)
  // norm 은 비교용 정규화 끝점, segs 는 처음 나온 방향 그대로(거리 계산이 방향에 따라 ulp 단위로 달라져 옛 문자열 키 판과 결과가 어긋나지 않게).
  const norm = [];
  const addSeg = (px, py, qx, qy, rev) => {
    SK[0] = px + 0; SK[1] = py + 0; SK[2] = qx + 0; SK[3] = qy + 0; // +0: -0 을 0 으로(=== 와 같게)
    let h = 0x811c9dc5;
    for (let q = 0; q < 8; q++) h = Math.imul(h ^ SU[q], 0x85ebca6b) ^ (h >>> 13);
    distStats.addCalls++;
    for (let i = h & (cap - 1); ; i = (i + 1) & (cap - 1)) {
      distStats.probes++;
      const o = tab[i];
      if (o === -1) {
        tab[i] = norm.length / 4; norm.push(px, py, qx, qy);
        if (rev) segs.push(qx, qy, px, py); else segs.push(px, py, qx, qy);
        return;
      }
      const b = o * 4;
      if (norm[b] === px && norm[b + 1] === py && norm[b + 2] === qx && norm[b + 3] === qy) return;
    }
  };
  for (let o = 0; o < tris.length; o += 6) {
    const ax = tris[o], ay = tris[o + 1], bx = tris[o + 2], by = tris[o + 3], cx = tris[o + 4], cy = tris[o + 5];
    if (Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) > 1e-9) fill.push(ax, ay, bx, by, cx, cy);
    for (let e = 0; e < 3; e++) {
      const px = e === 0 ? ax : e === 1 ? bx : cx, py = e === 0 ? ay : e === 1 ? by : cy;
      const qx = e === 0 ? bx : e === 1 ? cx : ax, qy = e === 0 ? by : e === 1 ? cy : ay;
      if (px < qx || (px === qx && py <= qy)) addSeg(px, py, qx, qy, false); else addSeg(qx, qy, px, py, true);
    }
  }
  distStats.frameSegs += segs.length / 4;
  return {
    it, order: it.order, minX, minY, maxX, maxY, minZ: it.minZ, maxZ: it.maxZ, roofMin: it.roofMin, err: 0,
    fill: Float64Array.from(fill), segs: Float64Array.from(segs),
  };
}

// 한 축의 표본 좌표: 균등 격자 + (lo, hi) 안의 구성 건물 상자 경계 + 이웃 경계 좌표 사이 중점.
// 틈의 최대 오차는 틈 한가운데(경계 사이 중점)에서 나므로 균등 격자만으로는 놓칠 수 있다.
// gap 은 이웃 표본 좌표 사이 최대 간격(립시츠 여유 계산용).
function sampleCoords(lo, hi, members, kLo, kHi, step, minSamples) {
  const n = Math.min(MAX_GRID, Math.max(minSamples, Math.ceil((hi - lo) / step) + 1));
  const edges = [lo, hi];
  for (const m of members) {
    if (m[kLo] > lo && m[kLo] < hi) edges.push(m[kLo]);
    if (m[kHi] > lo && m[kHi] < hi) edges.push(m[kHi]);
  }
  edges.sort((p, q) => p - q);
  const v = [...edges];
  for (let i = 1; i < edges.length; i++) v.push((edges[i - 1] + edges[i]) / 2);
  for (let i = 1; i + 1 < n; i++) v.push(lo + ((hi - lo) * i) / (n - 1));
  v.sort((p, q) => p - q);
  const coords = [v[0]];
  let gap = 0;
  for (let i = 1; i < v.length; i++) {
    const last = coords[coords.length - 1];
    if (v[i] === last) continue;
    if (v[i] - last > gap) gap = v[i] - last;
    coords.push(v[i]);
  }
  return { coords, gap };
}

// 점 (x, y) 에서 건물 m 의 xy 투영(삼각형 합집합)까지 거리², best 이상이면 그 값은 의미가 없다.
// 합집합까지 거리 = (어느 넓이 있는 삼각형 안이면 0) 아니면 모든 삼각형 변까지 거리의 최솟값이다.
// 변은 toFrame 에서 중복을 지워 두었다(벽 두 장이 같은 선분으로 눌리고, 지붕 삼각형끼리 변을 공유한다).
function memberDist2(x, y, m, best) {
  if (x >= m.minX && x <= m.maxX && y >= m.minY && y <= m.maxY) {
    const t = m.fill;
    for (let o = 0; o < t.length; o += 6) if (inTri(x, y, t, o)) return 0;
  }
  const s = m.segs;
  distStats.segs += s.length / 4;
  for (let o = 0; o < s.length; o += 4) {
    const d = segDist2(x, y, s[o], s[o + 1], s[o + 2], s[o + 3]);
    if (d < best) best = d;
  }
  return best;
}

// 직사각형 [x0,x1]×[y0,y1] 위 점에서 members 의 xy 투영 합집합까지 거리 최댓값의 상한(m).
// limit 를 넘는 순간 일찍 끝낸다(그때 결과는 "limit 초과"라는 뜻만 있다). floor 는 호출자가 이미 아는 오차로,
// 결과는 max(floor, 이 직사각형 오차) 다(floor 이하로 끝나는 표본은 정확한 거리를 끝까지 구하지 않는다).
// minSamples: 한 축 균등 표본 수 하한.
function rectError(x0, y0, x1, y1, members, limit, tol, floor = 0, minSamples = ERROR_SAMPLES) {
  // 직사각형에서 limit 보다 먼 건물은 limit 이하 거리를 줄 수 없으므로 볼 필요가 없다.
  const near = [];
  const inside = []; // 직사각형 안쪽과 겹치는 건물(경계 좌표를 표본에 더한다)
  for (const m of members) {
    const ox = Math.max(m.minX - x1, 0, x0 - m.maxX), oy = Math.max(m.minY - y1, 0, y0 - m.maxY);
    if (ox * ox + oy * oy > limit * limit) continue;
    near.push(m);
    if (m.minX < x1 && m.maxX > x0 && m.minY < y1 && m.maxY > y0) inside.push(m);
  }
  if (near.length === 0) return Infinity;
  const xs = sampleCoords(x0, x1, inside, 'minX', 'maxX', tol / 2, minSamples);
  const ys = sampleCoords(y0, y1, inside, 'minY', 'maxY', tol / 2, minSamples);
  // 1-립시츠: 표본 칸 안의 임의 점은 그 칸 모서리 표본 하나에서 반대각선 h 이내.
  const h = 0.5 * Math.hypot(xs.gap, ys.gap);
  let err = floor;
  if (h > limit) return h;
  const box2 = new Float64Array(near.length);
  for (const y of ys.coords) {
    for (const x of xs.coords) {
      // 이 표본이 err 를 올리려면 거리 > err − h 여야 한다. 그 이하인 건물을 하나라도 찾으면 더 볼 필요가 없다.
      const enough = err - h > 0 ? (err - h) * (err - h) : -1;
      // 먼저 AABB 가 가장 가까운 건물로 best 를 잡고, 나머지는 AABB 거리가 best 보다 작은 것만 본다.
      let first = 0;
      for (let i = 0; i < near.length; i++) {
        const m = near[i];
        const ox = Math.max(m.minX - x, 0, x - m.maxX), oy = Math.max(m.minY - y, 0, y - m.maxY);
        box2[i] = ox * ox + oy * oy;
        if (box2[i] < box2[first]) first = i;
      }
      let best = memberDist2(x, y, near[first], Infinity);
      for (let i = 0; i < near.length && best > enough && best > 0; i++) {
        if (i === first || box2[i] >= best) continue;
        best = memberDist2(x, y, near[i], best);
      }
      if (best <= enough) continue;
      const d = Math.sqrt(best) + h;
      if (d > err) { err = d; if (err > limit) return err; }
    }
  }
  return err;
}

// 군집을 다른 방향 φ2 좌표계로 다시 잰다. 같은 병합 순서(이진 트리)를 φ2 에서 다시 밟아 mergeError 로 오차를 구하므로
// 비용은 병합 한 번과 같은 수준이다. 어느 단계든 tol 을 넘으면 null.
function reframe(c, phi2, tol, hideTol) {
  if (!c.left) {
    const m = toFrame(c.members[0].it, phi2);
    m.err = singleError(m, tol, hideTol);
    return m.err <= tol ? makeCluster([m], m.err) : null;
  }
  const L = reframe(c.left, phi2, tol, hideTol);
  if (!L) return null;
  const R = reframe(c.right, phi2, tol, hideTol);
  if (!R) return null;
  const gaps = [];
  const err = mergeError(L, R, tol, hideTol, gaps);
  return err <= tol ? makeCluster(L.members.concat(R.members), err, L, R, gaps) : null;
}

// 건물 하나를 자기 φ 좌표계 상자로 바꿀 때의 오차. 메시 안 높이 차(maxZ − roofMin)가 hideTol 을 넘으면 Infinity(원본 유지):
// 지붕을 maxZ 로 평평하게 하면 그 높이 차의 벽(계단)이 통째로 사라진다. 수평 오차는 그 수직 오차에서 시작한다.
function singleError(m, tol, hideTol) {
  const step = m.maxZ - m.roofMin;
  if (step > hideTol) return Infinity;
  return rectError(m.minX, m.minY, m.maxX, m.maxY, [m], tol, tol, step);
}

// gaps: 이 군집 상자 안의 빈 땅 칸 목록 { x0, y0, x1, y1, e, ref } (앞선 병합들의 틈 칸, e 는 잰 거리 상한, ref 는 칸의 w 가
// hideTol 이하임을 확인한 기준 상자). F-338: 나중 병합이 상자를 키우면 열린 홈이던 칸이 끼인 틈이 될 수 있어 mergeError 가
// 새 상자 기준으로 다시 잰다(F-345: x 를 정한 변이 그대로인 칸과 2·e ≤ hideTol 인 칸은 빼고).
function makeCluster(members, err, left = null, right = null, gaps = []) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity, minTop = Infinity, first = Infinity;
  for (const m of members) {
    if (m.minX < minX) minX = m.minX; if (m.maxX > maxX) maxX = m.maxX;
    if (m.minY < minY) minY = m.minY; if (m.maxY > maxY) maxY = m.maxY;
    if (m.minZ < minZ) minZ = m.minZ; if (m.maxZ > maxZ) maxZ = m.maxZ;
    if (m.roofMin < minTop) minTop = m.roofMin;
    if (m.order < first) first = m.order;
  }
  return { members, minX, minY, minZ, maxX, maxY, maxZ, minTop, first, err, alive: true, left, right, gaps };
}

// 두 군집을 합칠 후보인지(값싼 조건): 두 상자 사이 틈 ≤ hideTol 이고 높이 차(계단) ≤ hideTol.
// 높이 계단 한계는 여기에만 있다. mergeError 는 이를 반복하지 않는다: agglomerate 는 mayMerge 를 통과한 쌍에 대해서만 mergeError 를 호출하고, reframe 은 이미 받아들여진 병합 트리를 다른 프레임에서 다시 밟으므로 maxZ 와 minTop 은
// 프레임에 무관하고, 계단은 여기를 통과한 것과 같은 값이다.
function mayMerge(A, B, hideTol) {
  const gx = Math.max(0, A.minX - B.maxX, B.minX - A.maxX), gy = Math.max(0, A.minY - B.maxY, B.minY - A.maxY);
  if (gx * gx + gy * gy > hideTol * hideTol) return false;
  return Math.max(A.maxZ, B.maxZ) - Math.min(A.minTop, B.minTop) <= hideTol;
}

/** 병합 한 번의 틈-칸 분기-한계 칸 예산. 새 틈 칸과 이어받은 칸 재측정이 따로 하나씩 쓴다(F-345). 부족하면 병합을 거부한다(안전한 쪽: 두 상자 유지). */
const GAP_MAX_CELLS = 1 << 14;

// 합친 상자 `box`(minX..maxY)가 새로 덮는 빈 직사각형 [x0,x1]×[y0,y1]에 대한 틈-칸 측도.
// 빈 점 p에서 e(p) = 구성 건물의 xy 합집합까지 거리, x(p) = 합친 상자 경계까지 거리라 하면,
// p 에서의 메워지는 폭은 w(p) = min(2·e(p), e(p) + x(p)):
//  - 건물 사이 끼인 틈(x ≥ e)에선 점이 가까운 쪽에서 e만큼 떨어져 있어 그곳 틈의 폭이 최소 2·e 이상;
//    폭이 w 인 틈은 중심선에서 w(p) = w (F-334: 예전 한계 e ≤ hideTol 은 끼인 틈이 2·hideTol 까지 통과하게 함);
//  - 열린 홈이나 모서리(빈 땅이 상자 경계에 닿음)에선 지붕이 될 땅이 e + x 깊이이고,
//    이는 경계에서의 예전 "구성 건물까지 거리"와 같아서 엇갈리고 대각선 배치인 쌍은 예전 한계를 지킨다.
// 병합은 max w(p) ≤ 한계(= hideTol) 일 때만 받아들여진다. 최댓값은 부분 직사각형에서 분기-한계로 구한다:
//  - 칸 위의 e 상한: 구성 건물 변 S 에 대해 네 칸 꼭짓점에서 dist(꼭짓점, S)의 최댓값의 최솟값
//    (한 선분까지 거리는 볼록이라 직사각형 위의 최댓값은 꼭짓점에서 나타나고, e ≤ 어느 변까지 거리),
//    그리고 e(중심) + 반대각선(1-립시츠);
//  - 칸 위의 x 상한: 네 상자 변에 대해 그 변까지 칸의 최대 거리의 최솟값;
//  - 하한: w(중심) 정확히. 한계 초과는 거부를 뜻한다.
// 변 한계는 벽을 따라 칸 길이가 늘어나도 커지지 않아서, 길쭉한 틈은 길이를 따라 몇 칸만 필요;
// 정밀도는 틈을 가로지르는 칸 폭이 정하고(F-335: 예전 균등 격자는 축당 MAX_GRID 표본으로 한계를 두어 16·hideTol 보다 긴 틈 칸의 정밀도를 잃고 작은 실제 틈을 거부했음),
// 고정 표본 상한이 아니다.
// 한계를 넘거나 예산을 소진했을 때 null, 아니면 { e, w } 상한(e 는 기하 오차에 쓰임, 반환 e 는 칸 단위의 느슨한 상한)을 돌려준다.
export function gapCellError(x0, y0, x1, y1, members, limit, box, budget) {
  // 칸 수 계수는 칸마다 올리지 않고 호출 끝에 예산 감소분으로 한 번 올린다(작은 입력의 핫 루프에서 계수 오버헤드를 뺀다, F-383).
  // 예산을 넘긴 마지막 칸(거부)은 세지 않는다.
  // 진입 예산이 음수면 한 칸도 못 쓰니 0, NaN·undefined 도 0 으로 바꿔(비교가 모두 거짓이라 그대로 두면 무제한으로 돈다) 바로 거부한다.
  // 무제한은 Infinity 만 뜻한다. 예산 없음(undefined)은 무제한이 아니라 거부다.
  // 의도: 음수·NaN·undefined 예산은 호출 뒤에도 0 또는 음수로 남는다(거부 후 음수 유지 또는 소진 상태). Infinity 만 finally 에서 복원된다.
  // Infinity 면 뺄셈이 NaN 이 되므로 큰 유한값으로 바꿔 돌린 뒤 finally 에서 되돌린다.
  const orig = budget.cells;
  const inf = orig === Infinity;
  const c0 = inf ? Number.MAX_SAFE_INTEGER : (orig > 0 ? orig : 0);
  if (inf || !(orig > 0)) budget.cells = c0;
  let res;
  try {
    res = gapCellErrorImpl(x0, y0, x1, y1, members, limit, box, budget);
  } finally {
    distStats.gapCells += c0 - (budget.cells > 0 ? budget.cells : 0);
    if (inf) budget.cells = Infinity;
  }
  return res;
}
function gapCellErrorImpl(x0, y0, x1, y1, members, limit, box, budget) {
  const near = [];
  for (const m of members) {
    const ox = Math.max(m.minX - x1, 0, x0 - m.maxX), oy = Math.max(m.minY - y1, 0, y0 - m.maxY);
    if (ox * ox + oy * oy <= limit * limit) near.push(m);
  }
  if (near.length === 0) return null;
  distStats.gapCalls++;
  distStats.gapNear += near.length;
  // F-377: 칸마다 near 전부를 훑으면 한 칸에 촘촘한 건물 수천 채일 때 병합 한 번이 (칸 수 × near) 라 초선형이었다.
  // near 를 xy 격자(gapIndex)에 넣고, 칸마다 그 칸 근처(아래 반지름) AABB 의 건물만 본다. 빠지는 건물은 AABB 거리가
  // 반지름보다 커서 예전 식에서도 결과(최솟값)를 바꿀 수 없다: e·w 상한과 거부는 반올림 수준(~2e-14 m, 보수 쪽)의 차이를 빼면 같다.
  // near 가 적거나 정의역이 유한하지 않으면 idx 는 null: 색인 없이 near 전부를 훑는 예전 경로(작은 입력에서 색인 오버헤드가 없다, F-383).
  const idx = gapIndex(near, x0 - limit, y0 - limit, x1 + limit, y1 + limit);
  let eMax = 0, wMax = 0;
  const stack = [x0, y0, x1, y1];
  const minDiag = limit * 1e-6;
  while (stack.length) {
    const cy1 = stack.pop(), cx1 = stack.pop(), cy0 = stack.pop(), cx0 = stack.pop();
    if (--budget.cells < 0) return null;
    const mx = (cx0 + cx1) / 2, my = (cy0 + cy1) / 2;
    const half = 0.5 * Math.hypot(cx1 - cx0, cy1 - cy0);
    // 중심 거리: 반지름 r 안(AABB 기준)의 건물로 c2 를 구한다. c2 ≤ r² 이면 r 밖 건물은 거리 > r 라 c2 를 못 낮춘다.
    // 아니면 r 을 두 배로(limit 까지). limit 안에 아무도 없으면 eC > limit 이고 xC ≥ 0 이라 예전처럼 거부.
    let c2 = Infinity;
    if (idx) {
      for (let r = idx.g / 4; ; r = Math.min(2 * r, limit)) {
        idx.query(mx, my, mx, my, r, (m) => {
          const ox = Math.max(m.minX - mx, 0, mx - m.maxX), oy = Math.max(m.minY - my, 0, my - m.maxY);
          if (ox * ox + oy * oy < c2) c2 = memberDist2(mx, my, m, c2);
        });
        if (c2 <= r * r || r >= limit) break;
      }
    } else {
      // 색인 경로와 같은 AABB 사전 거름: AABB 거리² 가 c2 이상이면 c2 를 낮출 수 없으니 건너뛴다(값 동일, distStats.segs 는 그만큼 덜 센다).
      for (const m of near) {
        const ox = Math.max(m.minX - mx, 0, mx - m.maxX), oy = Math.max(m.minY - my, 0, my - m.maxY);
        if (ox * ox + oy * oy < c2) c2 = memberDist2(mx, my, m, c2);
      }
    }
    const eC = Math.sqrt(c2);
    const xC = Math.min(mx - box.minX, box.maxX - mx, my - box.minY, box.maxY - my);
    if (Math.min(2 * eC, eC + xC) > limit) return null;
    // 변 한계: 변에 대한 가장 먼 꼭짓점 거리의 최솟값. AABB 가 칸보다 현재 한계 이상 먼 구성 건물은
    // 한계를 낮출 수 없다(그래서 처음 한계 eC + half 반지름 안의 건물만 색인에서 꺼낸다).
    let eUb2 = (eC + half) * (eC + half);
    if (idx) {
      idx.query(cx0, cy0, cx1, cy1, eC + half, (m) => { eUb2 = edgeFar2(m, cx0, cy0, cx1, cy1, eUb2); });
    } else {
      // 색인 없는 경로도 같은 edgeFar2 를 쓴다(AABB 사전 거름·꼭짓점 최대 거리 한 벌, 복제 방지).
      for (const m of near) eUb2 = edgeFar2(m, cx0, cy0, cx1, cy1, eUb2);
    }
    const eUb = Math.sqrt(eUb2);
    const xUb = Math.min(cx1 - box.minX, box.maxX - cx0, cy1 - box.minY, box.maxY - cy0);
    const wUb = Math.min(2 * eUb, eUb + xUb);
    if (wUb <= limit) {
      if (eUb > eMax) eMax = eUb;
      if (wUb > wMax) wMax = wUb;
      continue;
    }
    if (half < minDiag) return null;
    stack.push(cx0, cy0, mx, my, mx, cy0, cx1, my, cx0, my, mx, cy1, mx, my, cx1, cy1);
  }
  return { e: eMax, w: wMax };
}

// 건물 m 의 변에 대한 칸 [cx0,cx1]×[cy0,cy1] 꼭짓점 최대 거리² 의 최솟값을 eUb2 에 합쳐 돌려준다(변 한계 한 건물분).
function edgeFar2(m, cx0, cy0, cx1, cy1, eUb2) {
  const ox = Math.max(m.minX - cx1, 0, cx0 - m.maxX), oy = Math.max(m.minY - cy1, 0, cy0 - m.maxY);
  if (ox * ox + oy * oy >= eUb2) return eUb2;
  const s = m.segs;
  for (let o = 0; o < s.length; o += 4) {
    const ax = s[o], ay = s[o + 1], bx = s[o + 2], by = s[o + 3];
    let far = segDist2(cx0, cy0, ax, ay, bx, by);
    if (far >= eUb2) continue;
    far = Math.max(far, segDist2(cx1, cy0, ax, ay, bx, by));
    if (far >= eUb2) continue;
    far = Math.max(far, segDist2(cx0, cy1, ax, ay, bx, by));
    if (far >= eUb2) continue;
    far = Math.max(far, segDist2(cx1, cy1, ax, ay, bx, by));
    if (far < eUb2) eUb2 = far;
  }
  return eUb2;
}

// gapCellError 의 near 건물 xy 격자(F-377). 정의역 [X0,X1]×[Y0,Y1] 은 틈 직사각형을 limit 만큼 넓힌 것(near 건물의 AABB 는 모두 이와 겹친다).
// 칸 크기 G 는 칸 수가 near 수 정도(축당 GAP_IDX_AXIS 이하)가 되게 고른다. 건물은 AABB 가 걸치는 칸(정의역으로 자른) 전부에 놓이고,
// GAP_IDX_REG 칸보다 많이 걸치면 big 목록에 두어 모든 조회가 훑는다. near 가 GAP_IDX_MIN 개 이하이거나 정의역이 유한하지 않으면 null(격자 없이 전부 훑는다).
// query(qx0, qy0, qx1, qy1, r, f): AABB 가 [qx0 − r, qx1 + r]×[qy0 − r, qy1 + r] 와 겹치는 건물을 모두(더 있을 수 있음) 한 번씩 f 에 넘긴다.
//  구간을 정의역으로 자르는 것은 단조라, 겹치는 두 구간은 잘라도 겹친다(놓치는 건물이 없다). 칸 번호 계산이 NaN 이면 0 칸.
//  쿼리 반지름 r 은 반올림 여유로 1e-9 + |좌표|·2^-44 를 더 넓힌다(호출 쪽이 정확한 AABB 거리로 다시 거른다).
// 작업량 계수 distStats.gapVisits: f 에 넘긴 건물 수(near 전부 훑는 예전 방식이면 칸 수 × near).
const GAP_IDX_AXIS = 256;
const GAP_IDX_REG = 64;
const GAP_IDX_MIN = 16;
function gapIndex(near, X0, Y0, X1, Y1) {
  if (near.length <= GAP_IDX_MIN) return null;
  const W = X1 - X0, H = Y1 - Y0;
  const G = Math.max(Math.sqrt((W * H) / near.length), Math.max(W, H) / GAP_IDX_AXIS, 1e-9);
  // F-383: 정의역 폭이 유한하지 않거나(limit = Infinity, 1e308 처럼 합이 넘침) 칸 크기가 유한 양수가 아니면 nx·ny 가 NaN 이라 RangeError.
  // 이때는 색인 없이 전부 훑는다(기준 구현과 같은 값).
  if (!(Number.isFinite(W) && Number.isFinite(H) && Number.isFinite(G) && W >= 0 && H >= 0)) return null;
  const nx = Math.min(GAP_IDX_AXIS, Math.floor(W / G) + 1), ny = Math.min(GAP_IDX_AXIS, Math.floor(H / G) + 1);
  const ix = (v) => { const i = Math.floor((v - X0) / G); return i >= 0 ? Math.min(i, nx - 1) : 0; };
  const iy = (v) => { const i = Math.floor((v - Y0) / G); return i >= 0 ? Math.min(i, ny - 1) : 0; };
  const cells = new Array(nx * ny);
  const big = [];
  for (let k = 0; k < near.length; k++) {
    const m = near[k];
    const a0 = ix(m.minX), a1 = ix(m.maxX), b0 = iy(m.minY), b1 = iy(m.maxY);
    if ((a1 - a0 + 1) * (b1 - b0 + 1) > GAP_IDX_REG) { big.push(k); continue; }
    for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) (cells[b * nx + a] ||= []).push(k);
  }
  distStats.gapBig += big.length;
  const stamp = new Int32Array(near.length);
  let q = 0;
  return {
    g: G,
    query(qx0, qy0, qx1, qy1, r, f) {
      q++;
      const s = r + 1e-9 + Math.max(Math.abs(qx0), Math.abs(qx1), Math.abs(qy0), Math.abs(qy1)) * 2 ** -44;
      for (const k of big) { distStats.gapVisits++; f(near[k]); }
      const a0 = ix(qx0 - s), a1 = ix(qx1 + s), b0 = iy(qy0 - s), b1 = iy(qy1 + s);
      for (let b = b0; b <= b1; b++) {
        for (let a = a0; a <= a1; a++) {
          const c = cells[b * nx + a];
          if (!c) continue;
          for (const k of c) {
            if (stamp[k] === q) continue;
            stamp[k] = q;
            distStats.gapVisits++;
            f(near[k]);
          }
        }
      }
    },
  };
}

// 같은 φ 좌표계의 두 군집 A, B 를 상자 하나로 합칠 때의 오차 상한(m). tol 초과면 tol 초과라는 뜻만 있다.
// 전제조건: 높이 계단 max(maxZ) − min(minTop) ≤ hideTol 은 이미 mayMerge 에서 검사했다(그곳 참고); 수직 부분으로 오차에 여전히
// 들어간다.
// 틈 칸(A·B 어느 상자에도 들지 않는 칸)은 어느 구성 건물에도 속하지 않는 빈 땅이라, 메우면 테두리가 옮겨지는 것이 아니라
// 그 땅(과 그 너머로 보이던 벽)이 통째로 지붕이 된다. 그래서 틈 칸은 tol 이 아니라 hideTol 로 잰다: 메워지는 폭
// w(p) = min(2·e, e + x) (gapCellError) 가 hideTol 이하여야 한다(넘으면 Infinity, 합치지 않는다).
// 불변식 범위: 새 틈 칸과 A·B 가 가진 틈 칸(앞선 군집 상자 안의 빈 땅, A.gaps / B.gaps)을 합친 상자 기준으로 잰다(F-338: 앞선 상자의 열린 홈이 뒤의 병합 뒤 끼인 틈이 될 수 있음). 구성 건물 자신의 상자 안의 빈 땅(L자 건물의 홈)은 hideTol 이 아니라 tol 에서 singleError 로 한계를 잡는다.
// 이어받은 칸 재측정 범위(F-345):
//  - e 상한이 2·e ≤ hideTol 인 칸은 어느 상자에 대해서도 w ≤ 2·e ≤ hideTol 이라 목록에 넣지 않는다(목록이 군집 크기에 비례해 쌓이지 않게).
//  - 목록의 칸은 w ≤ hideTol 을 확인한 기준 상자 ref 를 함께 둔다. 칸의 점 p 에서 2·e(p) > hideTol 이면 w_ref(p) = e + x_ref ≤ hideTol 이라
//    x_ref(p) < hideTol/2, 즉 x_ref 를 정한 ref 의 변이 p 에서 hideTol/2 안에 있다. 그 변이 새 상자에서 그대로면 x_new(p) ≤ x_ref(p) 이고
//    구성 건물은 늘기만 해 e_new(p) ≤ e(p) 이므로 w_new(p) ≤ e + x_ref ≤ hideTol. 2·e(p) ≤ hideTol 인 점은 늘 성립한다.
//    그래서 새 상자에서 바뀐 ref 의 변마다 칸 가운데 그 변에서 hideTol/2 이내인 띠만 다시 잰다. 바뀐 변이 칸에서 hideTol/2 보다 멀면
//    (또는 하나도 안 바뀌었으면) 그 칸은 재지 않는다. 다 통과하면 칸의 ref 를 새 상자로 바꾼다(띠 안은 쟀고 띠 밖은 위 근거).
// 예산: 새 틈 칸과 이어받은 칸 재측정이 GAP_MAX_CELLS 를 따로 하나씩 쓴다. 이어받은 홈 칸(깊이가 hideTol 에 가까우면 칸 수천 개)이
// 새 칸의 예산을 먹어 기하로는 합격인 병합이 거부되던 것을 막는다(F-345).
// gapsOut (선택): 합친 상자의 틈 칸 목록(이어받은 칸 + 새 칸)을 여기에 채운다(makeCluster 의 gaps).
function mergeError(A, B, tol, hideTol, gapsOut = null) {
  const step = Math.max(A.maxZ, B.maxZ) - Math.min(A.minTop, B.minTop);
  const err = Math.max(A.err, B.err, step);
  if (err > tol) return err;
  const uniq = (a) => a.sort((p, q) => p - q).filter((x, i) => i === 0 || x !== a[i - 1]);
  const xs = uniq([A.minX, A.maxX, B.minX, B.maxX]);
  const ys = uniq([A.minY, A.maxY, B.minY, B.maxY]);
  const inBox = (C, x, y) => x > C.minX && x < C.maxX && y > C.minY && y < C.maxY;
  const box = { minX: xs[0], maxX: xs[xs.length - 1], minY: ys[0], maxY: ys[ys.length - 1] };
  const budget = { cells: GAP_MAX_CELLS }; // 새 틈 칸
  const reBudget = { cells: GAP_MAX_CELLS }; // 이어받은 칸 재측정(F-345)
  let members = null;
  let gapErr = 0;
  const gaps = [];
  const measure = (x0, y0, x1, y1, bud) => {
    if (!members) members = A.members.concat(B.members);
    const g = gapCellError(x0, y0, x1, y1, members, hideTol, box, bud);
    if (g && g.e > gapErr) gapErr = g.e;
    return g;
  };
  // 이어받은 칸 c 에서 다시 잴 띠: ref 에서 바뀐 변 중 칸까지 hideTol/2 이내인 변마다, 칸 가운데 그 변에서 hideTol/2 이내인 부분.
  // 띠 밖의 점 p 는 2·e(p) > hideTol 이면 x_ref(p) 를 정한 변(p 에서 hideTol/2 안)이 그대로라 w_new(p) ≤ hideTol 이다(위 근거).
  const near = hideTol / 2;
  const strips = (c) => {
    const r = c.ref, out = [];
    if (r.minX !== box.minX && c.x0 - r.minX <= near) out.push([c.x0, c.y0, Math.min(c.x1, r.minX + near), c.y1]);
    if (r.maxX !== box.maxX && r.maxX - c.x1 <= near) out.push([Math.max(c.x0, r.maxX - near), c.y0, c.x1, c.y1]);
    if (r.minY !== box.minY && c.y0 - r.minY <= near) out.push([c.x0, c.y0, c.x1, Math.min(c.y1, r.minY + near)]);
    if (r.maxY !== box.maxY && r.maxY - c.y1 <= near) out.push([c.x0, Math.max(c.y0, r.maxY - near), c.x1, c.y1]);
    return out;
  };
  for (let j = 0; j + 1 < ys.length; j++) {
    for (let i = 0; i + 1 < xs.length; i++) {
      const mx = (xs[i] + xs[i + 1]) / 2, my = (ys[j] + ys[j + 1]) / 2;
      if (inBox(A, mx, my) || inBox(B, mx, my)) continue;
      const g = measure(xs[i], ys[j], xs[i + 1], ys[j + 1], budget);
      if (!g) return Infinity;
      if (2 * g.e > hideTol) gaps.push({ x0: xs[i], y0: ys[j], x1: xs[i + 1], y1: ys[j + 1], e: g.e, ref: box });
    }
  }
  // 앞선 군집 상자 안의 틈 칸: 새 상자 기준으로 x 가 커져 w = min(2e, e + x) 가 늘 수 있다(F-338). 새 칸보다 뒤에 잰다:
  // 거부되는 병합은 대개 새 칸에서 걸리므로 그때 재측정을 아낀다.
  for (const C of [A, B]) {
    for (const c of C.gaps) {
      const ss = strips(c);
      if (!ss.length) { gaps.push(c); continue; }
      for (const [x0, y0, x1, y1] of ss) if (!measure(x0, y0, x1, y1, reBudget)) return Infinity;
      gaps.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, e: c.e, ref: box });
    }
  }
  if (gapsOut) gapsOut.push(...gaps);
  return Math.max(err, gapErr);
}

// 결정적 최소 힙: (오차, 앞 군집 첫 순서, 뒤 군집 첫 순서) 사전순.
function less(p, q) {
  if (p.err !== q.err) return p.err < q.err;
  if (p.k0 !== q.k0) return p.k0 < q.k0;
  return p.k1 < q.k1;
}
function heapPush(h, e) {
  h.push(e);
  let i = h.length - 1;
  while (i > 0) {
    const up = (i - 1) >> 1;
    if (!less(h[i], h[up])) break;
    [h[i], h[up]] = [h[up], h[i]]; i = up;
  }
}
function heapPop(h) {
  const top = h[0], last = h.pop();
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < h.length && less(h[l], h[m])) m = l;
      if (r < h.length && less(h[r], h[m])) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m], h[i]]; i = m;
    }
  }
  return top;
}

function pairEntry(A, B, err) {
  return A.first < B.first ? { err, k0: A.first, k1: B.first, a: A, b: B } : { err, k0: B.first, k1: A.first, a: B, b: A };
}

// 쌍의 우선순위: 합친 상자 오차의 값싼 하한. mergeError 는 오차(A)·오차(B)·수직 오차 이상이고,
// 두 상자 사이 거리가 g 면 가장 가까운 두 점의 중점이 합친 상자 안에 있어 오차 ≥ g/2 다.
function pairKey(A, B) {
  const gx = Math.max(0, A.minX - B.maxX, B.minX - A.maxX), gy = Math.max(0, A.minY - B.maxY, B.minY - A.maxY);
  return Math.max(A.err, B.err, Math.max(A.maxZ, B.maxZ) - Math.min(A.minTop, B.minTop), 0.5 * Math.hypot(gx, gy));
}

// 응집 군집: 오차 하한(pairKey)이 가장 작은 쌍부터(동률이면 앞선 쌍) 꺼내, 합친 상자 오차(mergeError)가 tol 이하면 합친다.
// 인접 후보 쌍(mayMerge)만 큐에 넣고, 합칠 때마다 새 군집과 남은 군집 사이 쌍만 넣는다(죽은 군집의 쌍은 꺼낼 때 버린다).
// 오차는 꺼낸 쌍만 잰다. 넘는 쌍은 버리고, 그 군집이 다른 군집과 합쳐지면 새 쌍으로 다시 들어온다.
function agglomerate(singles, tol, hideTol) {
  const all = singles.map((m) => makeCluster([m], m.err));
  const heap = [];
  const index = makeClusterIndex(singles, hideTol);
  const push = (A, B) => { if (mayMerge(A, B, hideTol)) heapPush(heap, pairEntry(A, B, pairKey(A, B))); };
  // 후보 쌍은 색인이 돌려준 군집만 mayMerge 로 확인한다(전쌍 비교 없음). 쌍마다 한 번: 앞서 넣은 군집과만 짝짓는다.
  for (const C of all) { index.forEachNear(C, (D) => push(C, D)); index.add(C); }
  while (heap.length) {
    const top = heapPop(heap);
    if (!top.a.alive || !top.b.alive) continue;
    const gaps = [];
    const err = mergeError(top.a, top.b, tol, hideTol, gaps);
    if (err > tol) continue;
    top.a.alive = false; top.b.alive = false;
    index.remove(top.a); index.remove(top.b);
    const C = makeCluster(top.a.members.concat(top.b.members), err, top.a, top.b, gaps);
    index.forEachNear(C, (D) => push(C, D));
    index.add(C);
    all.push(C);
  }
  return all.filter((c) => c.alive);
}

// mayMerge 후보만 돌려주는 군집 색인(xy 격자 × 높이 띠). 돌려주는 집합은 mayMerge 를 통과하는 군집을 모두 포함한다(더 있을 수 있어 호출 쪽이 mayMerge 로 거른다).
//  - xy: 군집은 상자가 걸치는 칸 전부에 놓이고, 조회는 [minX − hideTol, maxX + hideTol] × [minY − hideTol, maxY + hideTol] 이 걸치는 칸만 본다.
//    D 가 C 와 틈 ≤ hideTol 이면 D 상자가 이 범위와 겹치므로 D 가 놓인 칸 하나 이상을 본다. 한 조회 안에서 같은 군집은 한 번만 넘긴다(표식).
//    예전처럼 최소 모서리 칸 하나에만 놓고 지금까지의 최대 폭 W 만큼 넓혀 보면, 긴 건물 하나가 들어온 뒤의 모든 조회가 한 축 전체를 훑었다(F-373).
//  - 칸 크기 G = max(hideTol, 입력 상자 긴 변의 중앙값, 입력 범위 / XY_MAX_CELLS, 1e-9): 전형 상자가 축마다 칸 1~2 개에 걸치고, 축당 칸 수는 XY_MAX_CELLS 이하.
//    예전 G = max(hideTol, 범위/8) 은 칸이 9×9 이하라 같은 높이 띠의 촘촘한 건물이 칸마다 n/64 개씩 쌓였다(F-373).
//  - 높이: mayMerge 의 계단 조건 max(A.maxZ, B.maxZ) − min(A.minTop, B.minTop) ≤ hideTol 에서 B.minTop ∈ [A.maxZ − hideTol, A.minTop + hideTol]
//    (B.minTop ≤ B.maxZ 이므로). 군집은 minTop 띠(너비 B = hideTol) 하나에 놓이고 조회는 이 구간의 띠만 본다.
//  - 반올림 여유: 조회 구간 양끝을 slack = 1e-9 + max(|좌표|, hideTol)·2^-44 만큼 넓힌다(mayMerge 의 뺄셈·곱셈 반올림보다 크다).
//  - 걸치는 칸이 REG_MAX_CELLS 를 넘는 군집과, |좌표|/G 나 |높이|/B 가 IDX_MAX(2^40) 를 넘는 군집은 격자에 넣지 않고 따로 목록(big)에 둔다.
//    모든 조회가 big 을 훑고, 칸 번호가 IDX_MAX 를 넘거나 범위 칸 수가 격자 군집 수보다 많은 조회는 격자 군집 전부를 훑는다(전쌍 비교).
//    큰 좌표에서 칸 번호 floor(좌표/B) 가 2^53 을 넘으면 칸 번호 ++ 가 값을 바꾸지 못해 조회 반복이 끝나지 않았다(F-372). 지금 칸 반복은 횟수 기반이고
//    칸 번호는 IDX_MAX 이하라 정확한 정수다.
//  - minTop·maxZ 가 유한하지 않거나 maxZ − minTop > hideTol 인 군집은 어느 쌍도 통과할 수 없어 색인하지 않는다.
// 비용: 군집 하나의 등록·삭제는 걸치는 칸 수(REG_MAX_CELLS 이하), 조회는 범위 칸 수(빈 칸 포함, 격자 군집 수 이하) + 그 칸의 군집 수 + big 수.
//  같은 높이 띠의 촘촘한 건물, 그 사이에 긴 건물 몇 채가 섞인 경우는 n 에 선형이다(cluster_index.test.mjs). 최악은 여전히 이차다(상수배 감소):
//  병합으로 REG_MAX_CELLS 칸을 넘는 군집이 많아져 big 이 커지거나, 한 칸·한 높이 띠에 서로 합칠 수 없는 군집이 많이 겹쳐 쌓이면
//  (dedupe 가 접지 못한 같은 자리 상자) 조회가 그들을 모두 훑는다.
// 작업량 계수 agglomerateStats: visited 조회가 넘긴 군집 수(중복 없음, 전쌍 비교면 n²/2), cells 조회가 본 칸 수(빈 칸 포함),
//  hits 칸·목록에서 꺼낸 군집 수(여러 칸에 놓인 군집은 칸마다 센다), regs 등록한 칸 수, big big 목록에 넣은 군집 수.
export const agglomerateStats = { calls: 0, clusters: 0, visited: 0, cells: 0, hits: 0, regs: 0, big: 0 };
const XY_MAX_CELLS = 1024;
const REG_MAX_CELLS = 256;
const IDX_MAX = 2 ** 40;
function makeClusterIndex(singles, hideTol) {
  agglomerateStats.calls++;
  agglomerateStats.clusters += singles.length;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const sizes = [];
  for (const m of singles) {
    if (m.minX < x0) x0 = m.minX; if (m.maxX > x1) x1 = m.maxX;
    if (m.minY < y0) y0 = m.minY; if (m.maxY > y1) y1 = m.maxY;
    const s = Math.max(m.maxX - m.minX, m.maxY - m.minY);
    if (Number.isFinite(s)) sizes.push(s);
  }
  sizes.sort((p, q) => p - q);
  const typical = sizes.length ? sizes[sizes.length >> 1] : 0;
  const span = Math.max(x1 - x0, y1 - y0);
  // 범위가 유한하지 않으면(float 범위 끝의 좌표) 칸 크기를 최대로 둔다: 큰 좌표 군집은 IDX_MAX 검사에서 big 으로 간다.
  const G = Math.min(Number.MAX_VALUE, Math.max(hideTol, typical, Number.isFinite(span) ? span / XY_MAX_CELLS : Number.MAX_VALUE, 1e-9));
  const B = Math.max(hideTol, 1e-9);
  const cells = new Map(); // 칸 키 → 군집 Set
  const grid = new Set(); // 격자에 넣은 산 군집
  const big = new Set(); // 격자에 넣지 않은 산 군집(전쌍 비교)
  const recs = new Map(); // 군집 → { big, a0, na, b0, nb, zb, mark }
  let stamp = 0;
  const keyOf = (cx, cy, zb) => `${cx},${cy},${zb}`;
  const indexable = (C) => Number.isFinite(C.minTop) && Number.isFinite(C.maxZ) && C.maxZ - C.minTop <= hideTol;
  const slackOf = (p, q) => 1e-9 + Math.max(hideTol, Math.abs(p), Math.abs(q)) * 2 ** -44;
  // 실수 구간 [lo, hi] 가 걸치는 칸 번호 범위 { c0, n }(n = 칸 수). 번호가 IDX_MAX 를 넘거나 유한하지 않으면 null.
  const cellRange = (lo, hi, g) => {
    const c0 = Math.floor(lo / g), c1 = Math.floor(hi / g);
    if (!(Math.abs(c0) <= IDX_MAX && Math.abs(c1) <= IDX_MAX)) return null;
    return { c0, n: c1 - c0 + 1 };
  };
  const visit = (D, fn) => {
    agglomerateStats.hits++;
    const r = recs.get(D);
    if (r.mark === stamp) return;
    r.mark = stamp;
    agglomerateStats.visited++;
    fn(D);
  };
  return {
    add(C) {
      if (!indexable(C)) return;
      const rx = cellRange(C.minX, C.maxX, G), ry = cellRange(C.minY, C.maxY, G), rz = cellRange(C.minTop, C.minTop, B);
      if (!rx || !ry || !rz || rx.n * ry.n > REG_MAX_CELLS) {
        recs.set(C, { big: true, mark: 0 });
        big.add(C);
        agglomerateStats.big++;
        return;
      }
      recs.set(C, { big: false, a0: rx.c0, na: rx.n, b0: ry.c0, nb: ry.n, zb: rz.c0, mark: 0 });
      grid.add(C);
      for (let i = 0; i < rx.n; i++) for (let j = 0; j < ry.n; j++) {
        const k = keyOf(rx.c0 + i, ry.c0 + j, rz.c0);
        let set = cells.get(k);
        if (!set) { set = new Set(); cells.set(k, set); }
        set.add(C);
        agglomerateStats.regs++;
      }
    },
    remove(C) {
      const r = recs.get(C);
      if (!r) return;
      recs.delete(C);
      if (r.big) { big.delete(C); return; }
      grid.delete(C);
      for (let i = 0; i < r.na; i++) for (let j = 0; j < r.nb; j++) {
        const k = keyOf(r.a0 + i, r.b0 + j, r.zb), set = cells.get(k);
        if (set) { set.delete(C); if (!set.size) cells.delete(k); }
      }
    },
    forEachNear(C, fn) {
      if (!indexable(C)) return;
      stamp++;
      for (const D of big) visit(D, fn);
      const sx = slackOf(C.minX, C.maxX), sy = slackOf(C.minY, C.maxY), sz = slackOf(C.minTop, C.maxZ);
      const rx = cellRange(C.minX - hideTol - sx, C.maxX + hideTol + sx, G);
      const ry = cellRange(C.minY - hideTol - sy, C.maxY + hideTol + sy, G);
      const rz = cellRange(C.maxZ - hideTol - sz, C.minTop + hideTol + sz, B);
      // 칸 번호가 범위 밖이거나 범위 칸 수가 격자 군집 수보다 많으면 격자 군집 전부를 훑는다(그편이 싸다).
      if (!rx || !ry || !rz || rx.n * ry.n * rz.n > grid.size) {
        for (const D of grid) visit(D, fn);
        return;
      }
      for (let k = 0; k < rz.n; k++) for (let i = 0; i < rx.n; i++) for (let j = 0; j < ry.n; j++) {
        agglomerateStats.cells++;
        const set = cells.get(keyOf(rx.c0 + i, ry.c0 + j, rz.c0 + k));
        if (set) for (const D of set) visit(D, fn);
      }
    },
  };
}

// 한 칸의 상자 후보를 벽 방향으로 묶는다. 90° 주기 원 위에서 가장 큰 빈 구간을 끊고 펼친 뒤,
// 앞에서부터 폭 2 × 허용각 이하로 묶고 묶음 기준 방향 φ 는 양 끝 가운데로 한다(묶음 안 θ 는 모두 φ 와 허용각 이내).
function directionBins(list) {
  const s = [...list].sort((a, b) => a.theta - b.theta || a.order - b.order);
  let cut = 0, bestGap = -1;
  for (let i = 0; i < s.length; i++) {
    const next = i + 1 < s.length ? s[i + 1].theta : s[0].theta + QUARTER;
    if (next - s[i].theta > bestGap) { bestGap = next - s[i].theta; cut = (i + 1) % s.length; }
  }
  const bins = [];
  let cur = null;
  for (let k = 0; k < s.length; k++) {
    const i = (cut + k) % s.length;
    const t = s[i].theta + (i < cut ? QUARTER : 0);
    if (!cur || t - cur.t0 > 2 * BUILDING_LOD_MAX_WALL_ANGLE_RAD) { cur = { t0: t, t1: t, items: [] }; bins.push(cur); }
    cur.t1 = t; cur.items.push(s[i]);
  }
  return bins.map((b) => ({ phi: (b.t0 + b.t1) / 2, items: b.items.sort((p, q) => p.order - q.order) }));
}

// 방향 상자 여러 개를 메시 하나로. 상자마다 정점 12개(벽 8 + 지붕 전용 4), 벽 8 + 지붕 2 = 삼각형 10개(바닥은 지면에 붙어 보이지 않으므로 생략).
// 지붕 꼭짓점은 벽 꼭대기와 위치가 같아도 정점을 따로 둔다(F-312): 공유하면 buildAerialUv 가 벽 꼭대기를 지붕으로 쳐
// 벽에 영상 UV 가 남아 지붕 외곽 픽셀이 벽으로 늘어난다.
// 상자는 φ 좌표계 AABB(minX..maxY 는 u·v 범위)이고 꼭짓점을 월드로 되돌린다(회전이라 감김 방향은 그대로).
// 감김은 바깥에서 볼 때 반시계(지붕은 위에서 볼 때 반시계, 계약과 같음).
function boxesToMesh(boxes) {
  const positions = new Float32Array(boxes.length * 12 * 3);
  const indices = new Uint32Array(boxes.length * 10 * 3);
  const QUADS = [
    [0, 1, 5, 4], // 남(-v)
    [1, 2, 6, 5], // 동(+u)
    [2, 3, 7, 6], // 북(+v)
    [3, 0, 4, 7], // 서(-u)
    [8, 9, 10, 11], // 지붕(+Z), 벽과 정점을 공유하지 않는다
  ];
  let pi = 0, ii = 0;
  boxes.forEach((b, k) => {
    const base = k * 12;
    const c = Math.cos(b.phi), s = Math.sin(b.phi);
    const corners = [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]];
    for (const z of [b.minZ, b.maxZ, b.maxZ]) {
      for (const [u, v] of corners) { positions[pi++] = u * c - v * s; positions[pi++] = u * s + v * c; positions[pi++] = z; }
    }
    for (const [a, q, d, e] of QUADS) {
      indices[ii++] = base + a; indices[ii++] = base + q; indices[ii++] = base + d;
      indices[ii++] = base + a; indices[ii++] = base + d; indices[ii++] = base + e;
    }
  });
  return { positions, indices };
}

/**
 * 건물 LOD.
 * @param {Array<{id:number, mesh:{positions:Float32Array, indices:Uint32Array}}>} buildings
 * @param {number} cameraDistM 카메라에서 이 건물 묶음까지 거리(m). 호출자가 타일·묶음 단위로 잰다.
 * @returns {Array<{ids:number[], mesh:{positions:Float32Array, indices:Uint32Array}}>}
 */
export function buildBuildingLod(buildings, cameraDistM) {
  if (!Array.isArray(buildings)) fail('buildings 는 배열이어야 한다');
  if (typeof cameraDistM !== 'number' || !Number.isFinite(cameraDistM) || cameraDistM < 0) fail('cameraDistM 은 0 이상 유한수여야 한다');
  const items = buildings.map(summarize);
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.id)) fail(`id ${it.id} 가 중복된다`);
    seen.add(it.id);
  }

  // 가까운 곳: 원본 그대로.
  if (cameraDistM < BUILDING_LOD_FAR_DIST_M) return items.map((it) => ({ ids: [it.id], mesh: it.mesh }));

  const tol = cameraDistM * BUILDING_LOD_MAX_ANGLE_RAD;
  // 지워지는 세부(틈, 높이 계단)의 크기 상한(m). 화면 크기는 크기/거리 이하(시선과 수직일 때 최대)라 거리 × 픽셀 각 × px.
  const hideTol = cameraDistM * BUILDING_LOD_REF_PIXEL_RAD * BUILDING_LOD_MAX_GAP_PX;
  const groups = []; // { order, ids, mesh }
  const keepOriginal = (it) => groups.push({ order: it.order, ids: [it.id], mesh: it.mesh });
  const cells = new Map(); // 칸 키 → 벽 방향 후보 목록(입력 순서)
  for (const it of items) {
    if (it.empty || !it.dirOk) { keepOriginal(it); continue; }
    resolveRoof(it);
    const cx = Math.floor((it.minX + it.maxX) / 2 / BUILDING_LOD_CELL_M);
    const cy = Math.floor((it.minY + it.maxY) / 2 / BUILDING_LOD_CELL_M);
    const key = `${cx},${cy}`;
    let list = cells.get(key);
    if (!list) { list = []; cells.set(key, list); }
    list.push(it);
  }

  for (const list of cells.values()) {
    const boxes = [];
    const members = [];
    for (const { phi, items: binItems } of directionBins(list)) {
      const singles = [];
      for (const it of binItems) {
        const m = toFrame(it, phi);
        m.err = singleError(m, tol, hideTol);
        if (m.err > tol) keepOriginal(it); else singles.push(m);
      }
      for (const c of agglomerate(foldContained(singles), tol, hideTol)) {
        // 혼자 남은 건물의 원본이 상자(삼각형 10개)보다 작으면(벽만 있는 퇴화 입력 등) 바꿔도 줄지 않으므로 원본 유지.
        if (c.members.length === 1 && c.members[0].it.mesh.indices.length / 3 < 10) {
          keepOriginal(c.members[0].it);
          c.members[0].kept = true;
          continue;
        }
        // 군집은 구성 건물 θ 범위의 가운데 방향 상자가 허용 오차 안이면 그것을 쓴다(묶음 기준 방향보다 원래 벽에 가깝다).
        // 혼자 남은 건물이면 자기 지배 방향이 된다. 넘으면 합칠 때 검사한 묶음 기준 방향 상자를 쓴다.
        let lo = Infinity, hi = -Infinity;
        for (const m of c.members) {
          const t = phi + fold90(m.it.theta - phi);
          if (t < lo) lo = t; if (t > hi) hi = t;
        }
        const own = (lo + hi) / 2;
        const oc = own !== phi ? reframe(c, own, tol, hideTol) : null;
        if (oc) boxes.push({ ...oc, phi: own });
        else boxes.push({ ...c, phi });
      }
      members.push(...singles.filter((m) => !m.kept));
    }
    if (!boxes.length) continue;
    boxes.sort((a, b) => a.first - b.first);
    members.sort((a, b) => a.order - b.order);
    groups.push({ order: members[0].order, ids: members.map((m) => m.it.id), mesh: boxesToMesh(boxes) });
  }

  groups.sort((a, b) => a.order - b.order);
  return groups.map(({ ids, mesh }) => ({ ids, mesh }));
}
