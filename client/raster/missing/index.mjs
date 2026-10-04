// T12.6 빈자리 표시. 도착하지 않은 영역의 픽셀은 빈 값(index −1, depth 0, color 0,0,0) 그대로여야 한다.
// 여기는 '빈 픽셀 = 참조' 를 검사하는 도우미뿐이다. 그리거나 보간·채우기를 하는 코드는 없다(skylens 원칙).
// 참조는 contracts/raster 의 RenderResult 규약과 server/raster_ref 의 래스터라이저(읽기 전용 재사용)다.
import { assertRenderResult, EMPTY_INDEX, EMPTY_DEPTH } from '../../../contracts/raster/index.mjs';

const ERR = 'missing:';

/** 칠해진 픽셀 마스크(Uint8Array, 1 = 칠해짐)를 RenderResult 에서 뽑는다. 빈 번호와 빈 깊이가 어긋나면 오류. */
export function drawnMask(result) {
  if (!result || typeof result !== 'object') throw new Error(`${ERR} 결과가 객체가 아님: ${String(result)}`);
  assertRenderResult(result);
  const n = result.width * result.height;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) mask[i] = result.index[i] === EMPTY_INDEX ? 0 : 1;
  return mask;
}

// 입력은 {width, height, drawn: Uint8Array} 마스크이거나 RenderResult 다.
function toMask(x) {
  // null·원시값 입력은 TypeError 가 아니라 'missing:' 오류로 알린다
  if (!x || typeof x !== 'object') throw new Error(`${ERR} 입력이 객체가 아님: ${String(x)}`);
  if (x.drawn instanceof Uint8Array) {
    if (!Number.isInteger(x.width) || !Number.isInteger(x.height) || x.drawn.length !== x.width * x.height) {
      throw new Error(`${ERR} 마스크 모양이 틀림`);
    }
    // 0×0 거부 및 음수 크기 거부
    if (x.width <= 0 || x.height <= 0) {
      throw new Error(`${ERR} 크기가 양수여야 함: ${x.width}×${x.height}`);
    }
    return { width: x.width, height: x.height, drawn: x.drawn };
  }
  // RenderResult: drawnMask 가 assertRenderResult 로 모든 검사를 한다
  // raster: 오류를 missing: 으로 변환
  try {
    return { width: x.width, height: x.height, drawn: drawnMask(x) };
  } catch (e) {
    if (e.message.startsWith('raster:')) {
      throw new Error(e.message.replace(/^raster:/, ERR));
    }
    throw e;
  }
}

/**
 * 덮임 통계. 칠해진 픽셀 수·빈 픽셀 수·빈 비율을 센다. 이 함수는 읽기만 한다.
 * @returns {{width:number,height:number,total:number,drawn:number,empty:number,emptyFraction:number}}
 */
export function computeCoverage(input) {
  const { width, height, drawn } = toMask(input);
  let d = 0;
  for (let i = 0; i < drawn.length; i += 1) if (drawn[i]) d += 1;
  const total = width * height;
  return { width, height, total, drawn: d, empty: total - d, emptyFraction: (total - d) / total };
}

/**
 * 후보와 참조의 빈 픽셀을 비교한다. 참조에서 빈 픽셀이 후보에서 칠해져 있으면 메운 것(filled)이다.
 * 참조에서 칠해졌는데 후보가 빈 것(lost)은 도착하지 않은 조각 때문일 수 있어 따로 센다.
 * @returns {{filled:number[],lost:number[],ok:boolean}} filled 가 비어 있어야 ok
 */
export function compareWithReference(candidate, reference) {
  const c = toMask(candidate);
  const r = toMask(reference);
  if (c.width !== r.width || c.height !== r.height) throw new Error(`${ERR} 해상도가 다름`);
  const filled = [];
  const lost = [];
  for (let i = 0; i < c.drawn.length; i += 1) {
    if (c.drawn[i] && !r.drawn[i]) filled.push(i);
    else if (!c.drawn[i] && r.drawn[i]) lost.push(i);
  }
  return { filled, lost, ok: filled.length === 0 };
}

/** 빈 픽셀이 빈 값 그대로인지(색 0,0,0·깊이 0·번호 −1) 검사한다. 어긋난 픽셀 번호 목록을 돌려준다. */
export function nonEmptyValuesInEmpty(result, emptyPixels) {
  if (!result || typeof result !== 'object') throw new Error(`${ERR} 결과가 객체가 아님: ${String(result)}`);
  // 해상도 및 배열 구조만 검사 (값 검증은 하지 않음)
  if (!Number.isInteger(result.width) || !Number.isInteger(result.height) || result.width <= 0 || result.height <= 0) {
    throw new Error(`${ERR} 크기가 양의 정수여야 함: ${result.width}×${result.height}`);
  }
  const n = result.width * result.height;
  if (!(result.index instanceof Int32Array) || result.index.length !== n) {
    throw new Error(`${ERR} index 길이 ${n} 이어야 함`);
  }
  if (!(result.depth instanceof Float32Array) || result.depth.length !== n) {
    throw new Error(`${ERR} depth 길이 ${n} 이어야 함`);
  }
  if (!(result.color instanceof Uint8Array) || result.color.length !== 3 * n) {
    throw new Error(`${ERR} color 길이 ${n * 3} 이어야 함`);
  }
  if (!Array.isArray(emptyPixels)) throw new Error(`${ERR} emptyPixels 는 배열이어야 함`);
  const bad = [];
  for (const p of emptyPixels) {
    if (!Number.isInteger(p) || p < 0 || p >= n) {
      throw new Error(`${ERR} 픽셀 인덱스 범위 벗어남: ${p} (범위 [0, ${n}))`);
    }
    // 이제 이 검사가 실제로 작동한다: assertRenderResult가 없으므로 빈 픽셀이 아닌 값을 가지면 감지
    if (result.index[p] !== EMPTY_INDEX || result.depth[p] !== EMPTY_DEPTH
      || (result.color[3 * p] | result.color[3 * p + 1] | result.color[3 * p + 2]) !== 0) bad.push(p);
  }
  return bad;
}

/** 후보가 참조에 없는 픽셀을 칠했으면 'missing:' 오류. 통과하면 비교 결과를 돌려준다. */
export function assertNoFilled(candidate, reference) {
  const cmp = compareWithReference(candidate, reference);
  if (!cmp.ok) throw new Error(`${ERR} 참조가 빈 픽셀 ${cmp.filled.length} 개가 칠해짐(메움), 첫 픽셀 ${cmp.filled[0]}`);
  return cmp;
}
