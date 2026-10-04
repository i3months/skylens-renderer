// skylens splatScene.ts(딜레이 패턴 4수준 교체) 기존 동작 대조표(T10.10).
// 원본 소스는 이 환경에서 열람하지 못했다. 표의 출처는 연구 저장소(skylens-renderer-lab)의 문서 서술이다.
//   source: '파일:줄' 은 그 줄의 서술로 기대값이 정해지는 사례.
//   source: '추정' 은 문서 서술이 없어 계약의 결정 규칙으로 기대값을 채운 사례(시험에서 따로 묶는다).
// arrivals: [segmentId, level] 를 도착 순서대로 나열한다(조각은 싣지 않는다).
// expect: 마지막 도착 뒤 구간별 { level, final, missing }. 도착하지 않은 구간은 level -1, missing true.

export const ESTIMATED = '추정';

const L = (level) => ({ level, final: level === 3, missing: false });
const NONE_STATE = Object.freeze({ level: -1, final: false, missing: true });

export const CASES = Object.freeze([
  {
    name: '순서 도착 0→1→2→3 은 마지막 수준 3 만 남고 최종이다',
    source: 'RULES.md:9-10 (§1.1 4수준, 낮은 수준 교체)',
    arrivals: [[0, 0], [0, 1], [0, 2], [0, 3]],
    expect: { 0: L(3) },
  },
  {
    name: '건너뛰기 0→3 은 바로 3 으로 교체된다',
    source: 'RULES.md:10 (§1.1 새 수준은 같은 구간의 낮은 수준을 교체)',
    arrivals: [[0, 0], [0, 3]],
    expect: { 0: L(3) },
  },
  {
    name: '추월 3→1 에서 늦게 온 1 은 건너뛴다',
    source: 'RULES.md:11 (§1.1 추월당한 수준은 건너뛴다)',
    arrivals: [[0, 3], [0, 1]],
    expect: { 0: L(3) },
  },
  {
    name: '0→3 뒤 늦게 온 1·2 는 모두 건너뛴다',
    source: 'RULES.md:11; SPEC.md:77 (§3 추월당한 수준은 건너뛴다)',
    arrivals: [[0, 0], [0, 3], [0, 1], [0, 2]],
    expect: { 0: L(3) },
  },
  {
    name: '역순 도착 3→2→1→0 은 처음 온 3 만 남는다',
    source: 'RULES.md:11 (§1.1)',
    arrivals: [[0, 3], [0, 2], [0, 1], [0, 0]],
    expect: { 0: L(3) },
  },
  {
    name: '최종 아닌 수준에서의 추월 1→0 은 1 에 머물고 최종이 아니다',
    source: 'RULES.md:11 (§1.1)',
    arrivals: [[0, 1], [0, 0]],
    expect: { 0: L(1) },
  },
  {
    name: '같은 수준 중복 2→2 는 수준 2 그대로다',
    source: 'decisions/0010-ws-bytes-copy-rule.md:13 ((구간, 수준)마다 원본은 한 번)',
    arrivals: [[0, 2], [0, 2]],
    expect: { 0: L(2) },
  },
  {
    name: '추월된 낮은 수준이 끼는 [L2, L1, L2] 는 수준 2 다',
    source: 'decisions/0010-ws-bytes-copy-rule.md:17 (§대가 [L2 5, L1 3, L2 5 final])',
    arrivals: [[5, 2], [5, 1], [5, 2]],
    expect: { 5: L(2) },
  },
  {
    name: '구간 독립: 한 구간의 수준 3 이 다른 구간의 수준 0 에 영향 없다',
    source: 'RULES.md:10 (§1.1 "같은 구간의" 낮은 수준만 교체)',
    arrivals: [[0, 3], [1, 0]],
    expect: { 0: L(3), 1: L(0) },
  },
  {
    name: '구간 독립: 다른 구간에 3 이 왔어도 이 구간의 늦은 1 은 추월이 아니다',
    source: 'RULES.md:10-11 (§1.1 교체·추월 판정은 같은 구간 안에서); SPEC.md:124 (구간·수준 식별자)',
    arrivals: [[0, 3], [1, 1], [1, 0]],
    expect: { 0: L(3), 1: L(1) },
  },
  {
    name: '두 구간이 엇갈려 도착해도 구간마다 따로 교체·건너뛰기',
    source: 'RULES.md:10-11 (§1.1)',
    arrivals: [[0, 0], [1, 0], [0, 2], [1, 1], [0, 1], [1, 3]],
    expect: { 0: L(2), 1: L(3) },
  },
  {
    name: '도착 전 구간은 없음이다',
    source: 'RULES.md:15-16 (§1.2 도착한 것만 그린다, 없으면 없다고 표시)',
    arrivals: [],
    expect: { 7: NONE_STATE },
  },
  {
    name: '한 구간만 도착하면 다른 구간은 없음으로 남는다',
    source: 'RULES.md:16-17 (§1.2 메우지 않는다)',
    arrivals: [[0, 2]],
    expect: { 0: L(2), 1: NONE_STATE },
  },
  {
    name: '최저 수준 0 하나만 도착해도 없음이 아니고 최종도 아니다',
    source: 'RULES.md:15 (§1.2 도착한 자산만 그린다); RULES.md:9 (4수준)',
    arrivals: [[3, 0]],
    expect: { 3: L(0) },
  },
  {
    name: '재접속처럼 최신 수준 3 만 받으면 바로 최종이다',
    source: 'logs/supervisor/2026-10-01.md:38 (boards.ts:144-150 재접속 최신 수준만)',
    arrivals: [[0, 3]],
    expect: { 0: L(3) },
  },
  {
    name: '낮은 수준만 여러 번 와도 시간으로 진행하지 않는다(0→0→1 은 1)',
    source: 'RULES.md:12 (§1.1 렌더러는 타이머로 수준을 스스로 진행시키지 않는다)',
    arrivals: [[0, 0], [0, 0], [0, 1]],
    expect: { 0: L(1) },
  },
  {
    name: '최종 수준 3 중복 도착 뒤에도 최종 3 이다',
    source: ESTIMATED,
    arrivals: [[0, 3], [0, 3]],
    expect: { 0: L(3) },
  },
  {
    name: '0 없이 1 부터 시작한 구간도 1→2 로 교체된다',
    source: ESTIMATED,
    arrivals: [[0, 1], [0, 2]],
    expect: { 0: L(2) },
  },
  {
    name: '아주 큰 구간 번호와 0 번 구간은 서로 독립이다',
    source: ESTIMATED,
    arrivals: [[0xffffffff, 2], [0, 0], [0xffffffff, 1]],
    expect: { 0: L(0), [0xffffffff]: L(2), 1: NONE_STATE },
  },
]);
