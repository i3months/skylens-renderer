// 건물 층 합성(T15.3 .4). 두 RenderResult 를 화소마다 깊이로 겨뤄 새 결과 하나를 만든다.
// 규칙: 깊이 > 0 인 쪽 중 더 가까운(작은) 쪽의 color·depth·index 를 취한다. 한쪽만 0 이면 다른 쪽,
//       둘 다 0 이면 빈 화소(color 0, depth 0, index −1). 같은 깊이는 base 유지.
// 깊이 0 은 "없음"이다. NaN·음수·무한대 깊이는 "없음"이 아니라 입력 오류라 던진다(조용히 무시하지 않는다).
// 입력은 바꾸지 않고, 결과는 새 배열을 쓴다(별칭 없음). 세 번째 인자 into 를 주면 그 버퍼를 재사용한다.
import { EMPTY_DEPTH, EMPTY_INDEX } from '../../../contracts/raster/index.mjs';

/** 결과 한 장의 형태(크기·배열 종류·길이)를 검사한다. */
function checkShape(r, name) {
  if (!r || typeof r !== 'object') throw new TypeError(`compose: ${name} 가 객체가 아님`);
  const { width, height, color, depth, index } = r;
  for (const [n, v] of [['width', width], ['height', height]]) {
    if (!Number.isInteger(v) || v <= 0) throw new TypeError(`compose: ${name}.${n} 는 양의 정수여야 함: ${String(v)}`);
  }
  const n = width * height;
  if (!(color instanceof Uint8Array)) throw new TypeError(`compose: ${name}.color 는 Uint8Array 여야 함`);
  if (!(depth instanceof Float32Array)) throw new TypeError(`compose: ${name}.depth 는 Float32Array 여야 함`);
  if (!(index instanceof Int32Array)) throw new TypeError(`compose: ${name}.index 는 Int32Array 여야 함`);
  if (color.length !== 3 * n) throw new RangeError(`compose: ${name}.color 길이 ${color.length} ≠ ${3 * n}`);
  if (depth.length !== n) throw new RangeError(`compose: ${name}.depth 길이 ${depth.length} ≠ ${n}`);
  if (index.length !== n) throw new RangeError(`compose: ${name}.index 길이 ${index.length} ≠ ${n}`);
}

/** 깊이가 0(없음) 또는 양의 유한 수인지 검사한다. */
function checkDepths(depth, name) {
  for (let i = 0; i < depth.length; i += 1) {
    const d = depth[i];
    if (!(d >= 0) || !Number.isFinite(d)) throw new RangeError(`compose: ${name}.depth[${i}] 는 0 또는 양의 유한 수여야 함: ${String(d)}`);
  }
}

/**
 * 두 렌더 결과를 깊이로 합친다.
 * @param {import('../../../contracts/raster/index.mjs').RenderResult} base 같은 깊이에서 이기는 쪽
 * @param {import('../../../contracts/raster/index.mjs').RenderResult} over
 * @param {import('../../../contracts/raster/index.mjs').RenderResult} [into] 주면 이 버퍼를 지우고 다시 써서 돌려준다(새 배열 0). base·over 와 같은 객체·버퍼(.buffer)를 공유하면 던진다. 한 ArrayBuffer 의 겹치지 않는 구간도 거절하는 보수적 동작이다.
 * @returns {import('../../../contracts/raster/index.mjs').RenderResult} into 또는 새 결과
 */
export function composeLayers(base, over, into) {
  checkShape(base, 'base');
  checkShape(over, 'over');
  if (base.width !== over.width || base.height !== over.height) {
    throw new RangeError(`compose: 크기가 다름 ${base.width}×${base.height} vs ${over.width}×${over.height}`);
  }
  checkDepths(base.depth, 'base');
  checkDepths(over.depth, 'over');
  const { width, height } = base;
  const n = width * height;
  let color; let depth; let index;
  if (into === undefined || into === null) {
    color = new Uint8Array(3 * n);
    depth = new Float32Array(n).fill(EMPTY_DEPTH);
    index = new Int32Array(n).fill(EMPTY_INDEX);
  } else {
    checkShape(into, 'into');
    if (into.width !== width || into.height !== height) throw new RangeError('compose: into 크기가 다름');
    for (const src of [base, over]) {
      if (into === src) throw new RangeError('compose: into 는 base·over 와 같은 객체일 수 없음');
    }
    // 같은 객체뿐 아니라 .buffer 를 공유하는 view(오프셋 포함)도 fill 이 입력을 망가뜨리므로 fill 전에 던진다.
    const intoBufs = [into.color.buffer, into.depth.buffer, into.index.buffer];
    if (new Set(intoBufs).size !== intoBufs.length) throw new RangeError('compose: into 의 color·depth·index 가 버퍼를 공유함');
    for (const src of [base, over]) {
      for (const sb of [src.color.buffer, src.depth.buffer, src.index.buffer]) {
        if (intoBufs.includes(sb)) throw new RangeError('compose: into 는 base·over 와 버퍼를 공유할 수 없음');
      }
    }
    ({ color, depth, index } = into);
    color.fill(0); depth.fill(EMPTY_DEPTH); index.fill(EMPTY_INDEX);
  }
  for (let i = 0; i < n; i += 1) {
    const dBase = base.depth[i];
    const dOver = over.depth[i];
    let src = null;
    if (dBase > 0 && dOver > 0) src = dOver < dBase ? over : base; // 동률은 base
    else if (dBase > 0) src = base;
    else if (dOver > 0) src = over;
    if (src === null) continue;
    color[3 * i] = src.color[3 * i];
    color[3 * i + 1] = src.color[3 * i + 1];
    color[3 * i + 2] = src.color[3 * i + 2];
    depth[i] = src.depth[i];
    index[i] = src.index[i];
  }
  return into === undefined || into === null ? { width, height, color, depth, index } : into;
}
