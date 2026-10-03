// 계층·octree 필드 읽기를 감싸는 공용 래퍼(F-148). 접근자(getter)·Proxy 가 던지는 예외를 'cull:' 오류로 바꾼다.
// 'cull:' 로 시작하는 오류는 그대로 다시 던진다. 모든 컬링 단계(distance·priority·occlusion·predict·combine)가 계층 검사에 이 함수를 쓴다.
const ERR = 'cull:';

/**
 * @template T
 * @param {() => T} read 계층 필드를 읽고 검사하는 함수
 * @returns {T}
 */
export function guardHierarchyRead(read) {
  try {
    return read();
  } catch (e) {
    if (typeof e?.message === 'string' && e.message.startsWith(ERR)) throw e;
    throw new Error(`${ERR} 계층 필드를 읽는 중 예외: ${String(e?.message ?? e)}`, { cause: e });
  }
}
