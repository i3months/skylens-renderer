// 컬링 비용 측정(T08.9): 시점당 CPU 시간 기록. 계층과 카메라들을 받아 컬링 단계별 수행시간을 측정한다.
// 결과는 모든 시점의 합계(perViewMs) 와 단계별 평균(perStageMs) 으로 반환한다.
import { writeFileSync } from 'node:fs';

/**
 * 컬링 비용 측정: 계층·카메라 목록과 선택적 컬링 단계들로 시간을 측정한다.
 * @param {Object} hierarchy     server/lod/hierarchy buildHierarchy 결과
 * @param {Object[]} cameras     Camera 객체 배열
 * @param {Object} opts
 * @param {Object} [opts.stages] {이름: (hierarchy,camera)=>LeafMask} 컬링 단계 함수들. 기본값 없음(테스트용).
 * @param {number} [opts.repeats=5] 반복 횟수
 * @returns {{perViewMs: {median: number, p95: number, max: number}, perStageMs: Object}}
 *   perStageMs: {단계명: {median, p95, max}} ms 단위
 *   perViewMs: 카메라당 모든 단계의 총 시간
 *   perStageMs: 단계별, 카메라당 평균 시간
 */
export function measureCullCost(hierarchy, cameras, opts = {}) {
  const { stages = {}, repeats = 5 } = opts;

  // 입력 검사
  if (!hierarchy || typeof hierarchy !== 'object') throw new Error('cull: hierarchy 는 객체여야 함');
  if (!Array.isArray(cameras)) throw new Error('cull: cameras 는 배열이어야 함');
  if (cameras.length === 0) throw new Error('cull: cameras 는 최소 1개 필요');
  if (typeof repeats !== 'number' || !Number.isInteger(repeats) || repeats < 1) {
    throw new Error(`cull: repeats 는 1 이상의 정수여야 함: ${repeats}`);
  }

  const leafCount = hierarchy.octree.leafCount;
  const stageNames = Object.keys(stages);
  const perViewTimes = []; // 각 카메라마다 모든 단계 합계 시간들 (repeats × cameras 개)
  const perStageTimes = {}; // {단계명: [모든 반복의 모든 카메라별 시간들]}

  // 각 단계별 시간 배열 초기화
  for (const name of stageNames) {
    perStageTimes[name] = [];
  }

  // repeats 번 반복
  for (let r = 0; r < repeats; r++) {
    // 각 카메라에 대해
    for (const camera of cameras) {
      let viewTotalMs = 0;
      const stageTimesThisView = {};
      for (const name of stageNames) {
        stageTimesThisView[name] = 0;
      }

      // 이 카메라의 모든 단계 실행
      for (const name of stageNames) {
        const stageFn = stages[name];
        const t0 = performance.now();
        stageFn(hierarchy, camera);
        const ms = performance.now() - t0;
        stageTimesThisView[name] = ms;
        viewTotalMs += ms;
      }

      perViewTimes.push(viewTotalMs);

      // 단계 시간 기록
      for (const name of stageNames) {
        perStageTimes[name].push(stageTimesThisView[name]);
      }
    }
  }

  // 통계 계산 함수
  const getStats = (times) => {
    if (times.length === 0) return { median: 0, p95: 0, max: 0 };
    const sorted = [...times].sort((a, b) => a - b);
    const n = sorted.length;
    const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
    return {
      median,
      p95: sorted[Math.ceil((n * 95) / 100) - 1],
      max: sorted[n - 1],
    };
  };

  const result = {
    perViewMs: getStats(perViewTimes),
    perStageMs: {},
  };

  for (const name of stageNames) {
    result.perStageMs[name] = getStats(perStageTimes[name]);
  }

  return result;
}

/**
 * 측정 결과를 표 형식으로 콘솔에 출력.
 * @param {Object} result measureCullCost 결과
 * @param {Object} opts 표 출력 옵션
 */
export function printCullTable(result, opts = {}) {
  const { title = '컬링 비용 측정' } = opts;
  console.log(`\n${title}:`);
  console.log(['지표', 'median(ms)', 'p95(ms)', 'max(ms)'].join('\t'));

  const { perViewMs, perStageMs } = result;
  console.log(['시점당(평균)', perViewMs.median.toFixed(3), perViewMs.p95.toFixed(3), perViewMs.max.toFixed(3)].join('\t'));

  for (const [name, stats] of Object.entries(perStageMs)) {
    console.log([name, stats.median.toFixed(3), stats.p95.toFixed(3), stats.max.toFixed(3)].join('\t'));
  }
}

/**
 * 결과를 JSON 파일로 저장.
 * @param {Object} result
 * @param {string} filePath
 * @param {Object} extra 추가 메타데이터
 */
export function writeCullJSON(result, filePath, extra = {}) {
  const data = {
    timestamp: new Date().toISOString(),
    perViewMs: result.perViewMs,
    perStageMs: result.perStageMs,
    ...extra,
  };
  writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`\nJSON 저장: ${filePath}`);
}
