// 입력→화면 지연 계측 지점. Performance API 와 유사하지만 시계 주입으로 테스트 가능.
//
// 예:
//   const probe = createLatencyProbe({ now: () => performance.now() });
//   probe.mark('input');
//   ...
//   probe.mark('draw');
//   probe.measure('input-to-draw', 'input', 'draw');
//   const events = probe.events();

/** marks·measurements 개수 상한(메모리 누적 방지) */
const MAX_MARKS = 10000;
const MAX_MEASUREMENTS = 10000;

/**
 * 입력→setView→draw→present 파이프라인의 지연을 계측한다.
 *
 * @param {Object} config - 설정
 * @param {Function} config.now - 현재 시각 반환 함수 (밀리초, 기본값: performance.now)
 * @returns {Object} 계측 객체
 */
export function createLatencyProbe({ now = () => performance.now() } = {}) {
  const marks = new Map(); // name → { time, id }
  const measurements = []; // { name, fromName, toName, id, duration }

  return {
    /**
     * 지명된 시간 지점을 기록한다.
     *
     * @param {string} name - 마크 이름 ('input', 'setView', 'draw', 'present' 등)
     * @param {string|number} [id] - 선택적 식별자 (기본값: name)
     */
    mark(name, id) {
      const time = now();
      const key = id !== undefined ? `${name}:${id}` : name;
      // 이미 존재하지 않으면 개수 확인
      if (!marks.has(key) && marks.size >= MAX_MARKS) {
        // 상한 도달: 가장 오래된 것(삽입 순서의 첫 항목)을 버린다
        const first = marks.keys().next().value;
        marks.delete(first);
      }
      marks.set(key, { time, id });
    },

    /**
     * 두 마크 사이의 시간 차이를 측정한다.
     *
     * @param {string} fromName - 시작 마크 이름
     * @param {string} toName - 끝 마크 이름
     * @param {string|number} [id] - 선택적 식별자
     * @returns {number} 측정된 시간(밀리초), 마크가 없으면 NaN
     */
    measure(fromName, toName, id) {
      // fromName, toName이 id를 포함한 키인지, 아니면 단순 이름인지 확인
      const fromKey = id !== undefined ? `${fromName}:${id}` : fromName;
      const toKey = id !== undefined ? `${toName}:${id}` : toName;

      const from = marks.get(fromKey);
      const to = marks.get(toKey);

      if (!from || !to) {
        return NaN;
      }

      const duration = to.time - from.time;

      // 측정 개수 상한 확인
      if (measurements.length >= MAX_MEASUREMENTS) {
        // 상한 도달: 가장 오래된 것(배열의 첫 항목)을 버린다
        measurements.shift();
      }

      // 측정 기록
      measurements.push({
        name: `${fromName}-to-${toName}`,
        fromName,
        toName,
        id,
        duration,
      });

      return duration;
    },

    /**
     * 기록된 모든 마크와 측정을 반환한다.
     *
     * @returns {Object} { marks, measurements }
     */
    events() {
      return {
        marks: Array.from(marks.entries()).map(([key, { time, id }]) => ({
          key,
          time,
          id,
        })),
        measurements: [...measurements],
      };
    },

    /**
     * 모든 마크와 측정을 초기화한다.
     */
    reset() {
      marks.clear();
      measurements.length = 0;
    },
  };
}
