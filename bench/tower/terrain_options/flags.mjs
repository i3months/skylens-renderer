// 측정 스크립트 공용 명령줄 플래그 검사(F-491 ⑥).
// 알려진 플래그 밖의 '--' 토큰(`--only=x`·`--onlyy`·`--group`), 값 없는 값 플래그(`--json` 끝·뒤가 또 '--' 토큰), 중복 플래그,
// 플래그가 아닌 남는 토큰은 조용히 넘기지 않고 던진다(비영 종료).

/**
 * args 를 해석한다.
 * @param {string[]} args process.argv.slice(2)
 * @param {{ values?: string[], bools?: string[] }} spec 값을 받는 플래그 이름들, 값 없는 플래그 이름들(둘 다 '--' 포함)
 * @returns {{ get: (name: string) => (string|null), has: (name: string) => boolean }}
 */
export function parseFlags(args, { values = [], bools = [] } = {}) {
  const valueSet = new Set(values), boolSet = new Set(bools);
  const got = new Map();
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (!valueSet.has(tok) && !boolSet.has(tok)) {
      const known = [...valueSet, ...boolSet].join(' ');
      throw new Error(`알 수 없는 인자: ${tok} (알려진 플래그: ${known})`);
    }
    if (got.has(tok)) throw new Error(`플래그가 두 번 나왔다: ${tok}`);
    if (boolSet.has(tok)) { got.set(tok, true); continue; }
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${tok} 에 값이 없다`);
    got.set(tok, v);
    i++;
  }
  return {
    get: (name) => (got.has(name) && got.get(name) !== true ? got.get(name) : null),
    has: (name) => got.has(name),
  };
}
