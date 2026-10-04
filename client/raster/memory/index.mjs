// 메모리 집계. GPU 메모리 사용량을 key 별로 추적한다.
// 협약: contracts/client_raster/index.mjs 헤더 참조 (좌표·투영, 메모리 관리).

/**
 * 메모리 미터를 생성한다. GPU 버퍼 할당을 추적하고 총량을 계산한다.
 * @returns {Object} 메모리 미터 인터페이스
 *   - add(key, bytes): key의 메모리 bytes 추가/교체
 *   - remove(key): key의 메모리 제거 (없으면 무시)
 *   - total(): 전체 메모리 합계 반환
 *   - byKey(): {key: bytes, ...} 객체 반환
 *   - reset(): 모든 항목 초기화
 */
export function createMemoryMeter() {
  // 메모리 저장소: Map<key, bytes>
  const store = new Map();

  return {
    /**
     * key의 메모리 크기를 등록하거나 갱신한다.
     * 같은 key의 중복 호출 시 덮어쓴다.
     * @param {string} key - 조각 키 (e.g., '7.2.1.-2.0.0')
     * @param {number} bytes - 메모리 크기 (바이트)
     */
    add(key, bytes) {
      store.set(key, bytes);
    },

    /**
     * key의 메모리를 제거한다.
     * 없는 key는 무시한다.
     * @param {string} key - 조각 키
     */
    remove(key) {
      store.delete(key);
    },

    /**
     * 전체 메모리 합계를 반환한다.
     * @returns {number} 모든 버퍼의 메모리 합계 (바이트)
     */
    total() {
      let sum = 0;
      for (const bytes of store.values()) {
        sum += bytes;
      }
      return sum;
    },

    /**
     * key별 메모리 분포를 반환한다.
     * @returns {Object} {key: bytes, ...}
     */
    byKey() {
      const result = {};
      for (const [key, bytes] of store) {
        result[key] = bytes;
      }
      return result;
    },

    /**
     * 모든 항목을 초기화한다.
     */
    reset() {
      store.clear();
    }
  };
}
