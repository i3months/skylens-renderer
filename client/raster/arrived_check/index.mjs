// 지연 setArrived 용 가벼운 도착 입력 검사기(F-253 ②).
// selectDrawable([], list) 는 key 해석 외에 타일 표·LOD 고르기까지 만들어 10만 key 에 150~210 ms 가 든다. 지연 경로는 결과가
// 필요 없으므로 거부 기준(항목 모양, key 형식·범위, (segmentId, level) 일치)만 같은 규칙으로 검사한다. 타일 표·Map·객체는 만들지 않는다.
// 거부하는 입력은 selectDrawable 과 같고, 던지는 오류도 같은 ClientRasterError('piece') 다.
import { ClientRasterError, SEGMENT_ID_LIMIT, parsePieceKey } from '../../../contracts/client_raster/index.mjs';

// PIECE_KEY_PATTERN 과 같은 문법에 숫자 마디를 잡는 괄호만 더했다(한 번의 exec 로 형식과 마디를 함께 얻는다)
const KEY = /^(0|[1-9][0-9]*)\.([0-3])\.(0|-?[1-9][0-9]*)\.(0|-?[1-9][0-9]*)\.[0-7]\.(0|[1-9][0-9]*)$/;
const I32_MIN = -(2 ** 31);
const I32_MAX = 2 ** 31 - 1;
const CHUNK_INDEX_LIMIT = 65536;

function reject(key, item) {
  parsePieceKey(key); // 형식·범위가 틀리면 계약과 같은 오류를 던진다
  throw new ClientRasterError('piece', `LEVEL_ARRIVED keys 의 key 가 항목의 (segmentId, level) 과 다름: ${key} (${item.segmentId}, ${item.level})`);
}

/**
 * 도착 입력 검사(상태를 바꾸지 않는다). 틀리면 ClientRasterError('piece').
 * @param {{segmentId: number, level: number, keys: string[]}[]} list
 * @param {{onKey?: () => void}} [probe] 시험 전용: key 하나를 검사할 때마다 부른다(결정적 단계 계수)
 */
export function checkArrived(list, probe) {
  if (!Array.isArray(list)) throw new ClientRasterError('piece', 'arrived 는 배열이어야 함');
  const onKey = probe?.onKey;
  for (const a of list) {
    if (!a || !Number.isInteger(a.segmentId) || Object.is(a.segmentId, -0) || a.segmentId < 0 || a.segmentId >= SEGMENT_ID_LIMIT || !Number.isInteger(a.level) || a.level < 0 || a.level > 3) {
      throw new ClientRasterError('piece', `LEVEL_ARRIVED 항목이 틀림: ${JSON.stringify(a)}`);
    }
    if (!Array.isArray(a.keys)) throw new ClientRasterError('piece', `LEVEL_ARRIVED keys 는 배열이어야 함: ${JSON.stringify(a)}`);
    const seg = String(a.segmentId); // 정규 key 는 앞자리 0 이 없어 문자열 일치가 수 일치다
    const lvl = String(a.level);
    for (const k of a.keys) {
      if (onKey) onKey();
      const m = typeof k === 'string' ? KEY.exec(k) : null;
      if (m === null) reject(k, a);
      if (m[1] !== seg || m[2] !== lvl) reject(k, a);
      const x = +m[3];
      const y = +m[4];
      if (!(x >= I32_MIN && x <= I32_MAX && y >= I32_MIN && y <= I32_MAX && +m[5] < CHUNK_INDEX_LIMIT)) reject(k, a);
    }
  }
}
