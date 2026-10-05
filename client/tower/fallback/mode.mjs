// 기본: available == true 이면 'live', 아니면 'fallback'.
// 타입 검사 없음 (validate 의 checkAvailable 이 한다).
export const createModeState = () => {
  let available = true;  // 초기값: live 모드
  return {
    set(v) { available = v; },
    mode() { return available ? 'live' : 'fallback'; },
  };
};
