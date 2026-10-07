// skylens splatScene.ts(딜레이 패턴 4수준 교체) 기존 동작 대조표(T10.10, 원본 대조 T10.10L).
// 원본: NET-Challenge-S13/skylens 0122bd4, src/skylens_client/statusview/splatScene.ts 외.
//   source: 기대값을 처음 정한 문서 서술('파일:줄'). 원본 코드로 정해진 사례는 원본 줄을 그대로 적는다.
//   origin: 이 사례의 기대값을 정하는 원본 코드 줄. 모든 사례에 있다.
//           기대값은 그 줄의 논리에서 손으로 끌어냈다(우리 구현을 돌려 얻지 않았다).
//           같은 줄을 옮긴 기준 모형(origin.mjs)이 기대값과 같은지 시험이 따로 본다.
// 수준 번호: 우리 0..3 = 원본 1..4(ladder.ts:L8-L9, L41-L43). final 은 원본 level >= top(orchestrator.ts:L343).
// top: 원본 top 은 설정한 사다리 길이(ladder.ts:L49-L51)이고 원본 기본은 3칸(config.ts:L97 '1000,7000,30000')이다.
//   이 대조표는 SKYLENS_CORE_LEVEL_STEPS=250,1000,3500,7000 4칸 가정(top 4)이며 기본 설정의 기대가 아니다.
//   기본 3칸에서는 우리 수준 2 가 final 이 되어 L(2) 사례들의 final:false 가 달라진다(MISMATCHES 'final 판정').
// arrivals: [segmentId, level] 를 도착 순서대로 나열한다(조각은 싣지 않는다).
// registered: (선택) 도착 전에 expect 로 "없음" 등록해 두는 구간 번호 목록.
// expect: 마지막 도착 뒤 구간별 { level, final, missing }. 도착하지 않은 구간은 level -1, missing true.
// counters: (선택) 원본 카운터. chunks = splatScene.ts:L153 _chunks(건너뛴 도착 포함),
//           refined = splatScene.ts:L156-L158 _refined(수준이 오른 횟수). 우리 쪽은 history 길이·replace 수와 맞춘다.
// reveal: (선택) 구간별 원본 노출 목표 불투명도(splatReveal.ts:L76-L80 pending). 도착 전이면 0.

export const ESTIMATED = '추정';

const L = (level) => ({ level, final: level === 3, missing: false });
const NONE_STATE = Object.freeze({ level: -1, final: false, missing: true });
const BIG = 2 ** 30 - 1;

const O = (lines) => `${lines} (0122bd4)`;
const REPLACE = O('splatScene.ts:L154-L158');
const SKIP = O('splatScene.ts:L156 (level > prev.level 일 때만 교체)');
const BY_SEGMENT = O('splatScene.ts:L74, L154, L171 (구간 번호 키 Map)');
const ABSENT = O('splatScene.ts:L154, L163-L171, L266-L271 (도착 전 구간은 키가 없다)');
const FINAL = O('splatScene.ts:L160; orchestrator.ts:L343 (final = level >= top, 4칸 가정 top 4)');

export const CASES = Object.freeze([
  {
    name: '순서 도착 0→1→2→3 은 마지막 수준 3 만 남고 최종이다',
    source: 'RULES.md:9-10 (§1.1 4수준, 낮은 수준 교체)',
    origin: `${REPLACE}; ${FINAL}`,
    arrivals: [[0, 0], [0, 1], [0, 2], [0, 3]],
    expect: { 0: L(3) },
    counters: { chunks: 4, refined: 3 },
    reveal: { 0: 1.0 },
  },
  {
    name: '건너뛰기 0→3 은 바로 3 으로 교체된다',
    source: 'RULES.md:10 (§1.1 새 수준은 같은 구간의 낮은 수준을 교체)',
    origin: REPLACE,
    arrivals: [[0, 0], [0, 3]],
    expect: { 0: L(3) },
    counters: { chunks: 2, refined: 1 },
  },
  {
    name: '추월 3→1 에서 늦게 온 1 은 건너뛴다',
    source: 'RULES.md:11 (§1.1 추월당한 수준은 건너뛴다)',
    origin: SKIP,
    arrivals: [[0, 3], [0, 1]],
    expect: { 0: L(3) },
    counters: { chunks: 2, refined: 0 },
  },
  {
    name: '0→3 뒤 늦게 온 1·2 는 모두 건너뛴다',
    source: 'RULES.md:11; SPEC.md:77 (§3 추월당한 수준은 건너뛴다)',
    origin: SKIP,
    arrivals: [[0, 0], [0, 3], [0, 1], [0, 2]],
    expect: { 0: L(3) },
    counters: { chunks: 4, refined: 1 },
  },
  {
    name: '역순 도착 3→2→1→0 은 처음 온 3 만 남는다',
    source: 'RULES.md:11 (§1.1)',
    origin: SKIP,
    arrivals: [[0, 3], [0, 2], [0, 1], [0, 0]],
    expect: { 0: L(3) },
    counters: { chunks: 4, refined: 0 },
  },
  {
    name: '최종 아닌 수준에서의 추월 1→0 은 1 에 머물고 최종이 아니다',
    source: 'RULES.md:11 (§1.1)',
    origin: `${SKIP}; ${O('splatReveal.ts:L79 (노출 목표는 큰 쪽만 남는다)')}`,
    arrivals: [[0, 1], [0, 0]],
    expect: { 0: L(1) },
    counters: { chunks: 2, refined: 0 },
    reveal: { 0: 0.8 },
  },
  {
    name: '추월된 낮은 수준이 끼는 [L2, L1, L2] 는 수준 2 다',
    source: 'decisions/0010-ws-bytes-copy-rule.md:17 (§대가 [L2 5, L1 3, L2 5 final])',
    origin: SKIP,
    arrivals: [[5, 2], [5, 1], [5, 2]],
    expect: { 5: L(2) },
    counters: { chunks: 3, refined: 0 },
  },
  {
    name: '구간 독립: 한 구간의 수준 3 이 다른 구간의 수준 0 에 영향 없다',
    source: 'RULES.md:10 (§1.1 "같은 구간의" 낮은 수준만 교체)',
    origin: BY_SEGMENT,
    arrivals: [[0, 3], [1, 0]],
    expect: { 0: L(3), 1: L(0) },
  },
  {
    name: '구간 독립: 다른 구간에 3 이 왔어도 이 구간의 늦은 1 은 추월이 아니다',
    source: 'RULES.md:10-11 (§1.1 교체·추월 판정은 같은 구간 안에서); SPEC.md:124 (구간·수준 식별자)',
    origin: `${BY_SEGMENT}; ${SKIP}`,
    arrivals: [[0, 3], [1, 1], [1, 0]],
    expect: { 0: L(3), 1: L(1) },
  },
  {
    name: '두 구간이 엇갈려 도착해도 구간마다 따로 교체·건너뛰기',
    source: 'RULES.md:10-11 (§1.1)',
    origin: `${BY_SEGMENT}; ${REPLACE}`,
    arrivals: [[0, 0], [1, 0], [0, 2], [1, 1], [0, 1], [1, 3]],
    expect: { 0: L(2), 1: L(3) },
    counters: { chunks: 6, refined: 3 },
  },
  {
    name: '도착 전 구간은 없음이다',
    source: 'RULES.md:15-16 (§1.2 도착한 것만 그린다, 없으면 없다고 표시)',
    origin: ABSENT,
    arrivals: [],
    expect: { 7: NONE_STATE },
    reveal: { 7: 0 },
  },
  {
    name: 'expect 로 등록만 한 구간은 도착 전까지 없음이고, 도착하면 그 수준이 된다',
    source: 'RULES.md:16-17 (§1.2 없으면 없다고 표시, 도착한 것만 그린다)',
    origin: `${ABSENT} — 원본에는 미리 등록하는 길이 없다. 등록 여부와 상관없이 도착 전은 키 없음`,
    registered: [3, 4],
    arrivals: [[3, 1]],
    expect: { 3: L(1), 4: NONE_STATE },
  },
  {
    name: '한 구간만 도착하면 다른 구간은 없음으로 남는다',
    source: 'RULES.md:16-17 (§1.2 메우지 않는다)',
    origin: `${ABSENT}; ${O('splatReveal.ts:L40, L178-L181 (도착 전 슬랩은 노출 0 이라 그리지 않는다)')}`,
    arrivals: [[0, 2]],
    expect: { 0: L(2), 1: NONE_STATE },
    reveal: { 0: 0.95, 1: 0 },
  },
  {
    name: '최저 수준 0 하나만 도착해도 없음이 아니고 최종도 아니다',
    source: 'RULES.md:15 (§1.2 도착한 자산만 그린다); RULES.md:9 (4수준)',
    origin: `${O('splatScene.ts:L163-L171')}; ${FINAL}`,
    arrivals: [[3, 0]],
    expect: { 3: L(0) },
    reveal: { 3: 0.62 },
  },
  {
    name: '재접속처럼 최신 수준 3 만 받으면 바로 최종이다',
    source: 'logs/supervisor/2026-10-01.md:38 (boards.ts:144-150 재접속 최신 수준만)',
    origin: `${O('boards.ts:L127-L137, L143-L150 (재전송은 구간마다 최신 수준 하나)')}; ${O('splatScene.ts:L163-L171')}; ${FINAL}`,
    arrivals: [[0, 3]],
    expect: { 0: L(3) },
    counters: { chunks: 1, refined: 0 },
  },
  {
    name: '낮은 수준 0 이 반복돼도 수준은 그대로이고 1 이 오면 1 로 교체된다(0→0→1 은 1)',
    source: 'RULES.md:10 (§1.1 새 수준이 도착해야 낮은 수준을 교체; 같은 수준 0 의 반복은 상태를 바꾸지 않는다)',
    origin: `${SKIP}; ${REPLACE}`,
    arrivals: [[0, 0], [0, 0], [0, 1]],
    expect: { 0: L(1) },
    counters: { chunks: 3, refined: 1 },
  },
  // ---- 아래는 T10.10L 에서 원본 코드로 출처를 바꾸거나 새로 넣은 사례(UNVERIFIED 1~10) ----
  {
    name: '같은 수준 중복 2→2 는 수준 2 그대로다',
    source: O('splatScene.ts:L156 (엄격한 > 비교라 같은 수준은 수준을 바꾸지 않는다)'),
    origin: SKIP,
    arrivals: [[0, 2], [0, 2]],
    expect: { 0: L(2) },
    counters: { chunks: 2, refined: 0 },
  },
  {
    name: '최종 수준 3 중복 도착 뒤에도 최종 3 이다',
    source: O('splatScene.ts:L156, L160 (같은 수준은 무시, final 은 한 번 참이면 참)'),
    origin: `${SKIP}; ${FINAL}`,
    arrivals: [[0, 3], [0, 3]],
    expect: { 0: L(3) },
    counters: { chunks: 2, refined: 0 },
    reveal: { 0: 1.0 },
  },
  {
    name: '0 없이 1 부터 시작한 구간도 1→2 로 교체된다',
    source: O('splatScene.ts:L163-L171 (처음 온 수준이 무엇이든 그 수준으로 기록); boards.ts:L135-L136, L149 (중간 합류 보드는 최신 수준부터 받는다)'),
    origin: `${O('splatScene.ts:L163-L171')}; ${REPLACE}`,
    arrivals: [[0, 1], [0, 2]],
    expect: { 0: L(2) },
    counters: { chunks: 2, refined: 1 },
  },
  {
    name: '아주 큰 구간 번호와 0 번 구간은 서로 독립이다',
    source: O('segmenter.ts:L134-L137 (구간 번호는 0 이상 정수); splatScene.ts:L74 (구간 번호 키 Map)'),
    origin: `${BY_SEGMENT}; ${SKIP}`,
    arrivals: [[BIG, 2], [0, 0], [BIG, 1]],
    expect: { 0: L(0), [BIG]: L(2), 1: NONE_STATE },
    counters: { chunks: 3, refined: 0 },
  },
  {
    name: '건너뛴 도착도 원본 chunks 에는 세고 refined 에는 세지 않는다(0→3→1→2→3)',
    source: O('splatScene.ts:L153, L156-L158 (건너뛰기는 이벤트·로그 없이 카운터만 다르다)'),
    origin: `${O('splatScene.ts:L153')}; ${SKIP}`,
    arrivals: [[0, 0], [0, 3], [0, 1], [0, 2], [0, 3]],
    expect: { 0: L(3) },
    counters: { chunks: 5, refined: 1 },
    reveal: { 0: 1.0 },
  },
  {
    name: '클라이언트도 늦은 낮은 수준을 스스로 버린다(2→1 은 2)',
    source: O('splatScene.ts:L156 (송신 쪽 orchestrator.ts:L217-L229·boards.ts:L149 와 별개로 받는 쪽도 막는다)'),
    origin: SKIP,
    arrivals: [[0, 2], [0, 1]],
    expect: { 0: L(2) },
    counters: { chunks: 2, refined: 0 },
    reveal: { 0: 0.95 },
  },
  {
    name: '재연결 재전송: 이미 가진 수준은 무시하고 더 높은 최신 수준만 교체한다',
    source: O('statusViewer.ts:L524-L525 (SplatScene 은 처음 한 번만 만든다); serverSource.ts:L136-L143 (down()·재연결 예약뿐, 상태를 비우지 않는 근거는 위 statusViewer 줄); boards.ts:L135-L137, L149 (재전송은 구간마다 최신, 내려가지 않는다)'),
    origin: `${SKIP}; ${REPLACE}`,
    arrivals: [[0, 1], [1, 0], [0, 1], [1, 2]],
    expect: { 0: L(1), 1: L(2) },
    counters: { chunks: 4, refined: 1 },
  },
  {
    name: '노출 중 교체: 노출 목표는 오르기만 하고 늦은 낮은 수준은 내리지 못한다(0→2→1)',
    source: O('splatReveal.ts:L76-L80, L101-L105 (pending 은 큰 값만, fade 는 오르기만)'),
    origin: `${O('splatReveal.ts:L26-L31, L79')}; ${SKIP}`,
    arrivals: [[0, 0], [0, 2], [0, 1]],
    expect: { 0: L(2) },
    counters: { chunks: 3, refined: 1 },
    reveal: { 0: 0.95 },
  },
]);

/**
 * 원본과 어긋나는 점(T10.10L). 제품 코드(server/levels 의 parity 밖)는 고치지 않고 test.todo 로 남긴다.
 */
export const MISMATCHES = Object.freeze([
  {
    name: 'final 판정: 원본 chunk.final 은 level >= 설정 top(기본 3칸이면 top 3), 우리는 level === 3 고정',
    origin: O('orchestrator.ts:L343 (final = level >= top); ladder.ts:L49-L51 (top = 사다리 길이); config.ts:L97 (기본 1000,7000,30000, 3칸)'),
    ours: 'server/levels/state/index.mjs final = (level === 3), 사다리 칸 수와 무관',
    // 원본 기본 3칸이면 우리 수준 2(원본 3)가 final 이고 노출 목표가 1.0 이 된다. 우리는 final:false.
    ourLevel: 2,
  },
  {
    name: '구간 번호 2^30 이상: 원본은 받고(상한 없음) 우리 기계는 RangeError 로 거절한다',
    origin: O('segmenter.ts:L134-L137 (Math.floor(arcM / segmentMeters), 상한 없음); protocol.ts:L176 (segment: number)'),
    ours: 'contracts/levels/index.mjs assertSegmentId: 0 이상 SEGMENT_ID_LIMIT(2^30) 미만',
    segmentId: 2 ** 30,
  },
]);

/**
 * 원본 모형(origin.mjs)이 옮기지 않은 것(T10.10L 후속). 대조표의 reveal 기대는 이 둘이 없는 경우만 뜻한다.
 */
export const NOT_MODELED = Object.freeze([
  {
    name: '슬랩 접힘 생략: 원본 노출 목표는 coreSegment % regionCount 슬랩 단위, 모형은 구간 단위',
    origin: O('splatReveal.ts:L41, L77 (setFrame 전 regionCount = 1 이면 모든 구간이 한 슬랩으로 접힌다)'),
  },
  {
    name: 'float32 저장 생략: 원본 pending 은 Float32Array 라 0.95 가 0.949999988 로 저장, 모형은 float64',
    origin: O('splatReveal.ts:L40, L79 (new Float32Array(MAX_REGIONS))'),
  },
]);
