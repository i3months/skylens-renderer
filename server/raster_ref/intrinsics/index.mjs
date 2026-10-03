// 내부 파라미터 해상도 변환(T06.3).
// fx·cx 는 가로 배율 sx = toW/fromW, fy·cy 는 세로 배율 sy = toH/fromH 를 곱한다.
//
// 주점 배율 규약이 둘인 이유:
//   'basis'(기본) cx' = cx·sx. 픽셀 좌표 원점을 영상 왼쪽 위 모서리로 두고 연속 좌표를 그대로 늘린다.
//               계약의 픽셀 규약(정수 좌표 = 칸의 왼쪽 위 모서리, 중심은 i+0.5)과 맞고,
//               renderer_basis §1-2 의 표(2048×1152 → 960×540, cx 1024→480)도 이 단순 배율로 계산되어 있다.
//   'half'      cx' = (cx+0.5)·sx − 0.5. 정수 좌표를 칸의 중심으로 보는 규약(일부 보정 도구가 이렇게 둔다)에서
//               쓰는 식이다. 그 규약에서는 원점이 반 픽셀 안쪽에 있으므로 늘리기 전에 모서리 기준으로 옮겼다가 되돌린다.
//   두 식의 차이는 0.5·(sx−1) 픽셀이며 축소가 클수록 커진다. 외부 보정값을 들여올 때만 'half' 를 고른다.

const ERR = 'raster:';

function posFinite(n, x) {
  if (typeof x !== 'number' || !Number.isFinite(x) || !(x > 0)) throw new Error(`${ERR} ${n} 는 양의 유한 수여야 함: ${String(x)}`);
}

/**
 * @param {import('../../../contracts/raster/index.mjs').Intrinsics} K
 * @param {number} fromW
 * @param {number} fromH
 * @param {number} toW
 * @param {number} toH
 * @param {{pixelCenter?: 'basis'|'half'}} [opts]
 * @returns {import('../../../contracts/raster/index.mjs').Intrinsics}
 */
export function scaleIntrinsics(K, fromW, fromH, toW, toH, opts = {}) {
  if (!K || typeof K !== 'object') throw new Error(`${ERR} K 가 객체가 아님`);
  posFinite('K.fx', K.fx);
  posFinite('K.fy', K.fy);
  for (const n of ['cx', 'cy']) {
    if (typeof K[n] !== 'number' || !Number.isFinite(K[n])) throw new Error(`${ERR} K.${n} 는 유한 수여야 함: ${String(K[n])}`);
  }
  posFinite('fromW', fromW);
  posFinite('fromH', fromH);
  posFinite('toW', toW);
  posFinite('toH', toH);
  const mode = (opts && opts.pixelCenter) ?? 'basis';
  if (mode !== 'basis' && mode !== 'half') throw new Error(`${ERR} pixelCenter 는 'basis' 또는 'half': ${String(mode)}`);
  const sx = toW / fromW;
  const sy = toH / fromH;
  const sc = (c, s) => (mode === 'half' ? (c + 0.5) * s - 0.5 : c * s);
  const out = { fx: K.fx * sx, fy: K.fy * sy, cx: sc(K.cx, sx), cy: sc(K.cy, sy) };
  // 극단 배율에서 넘침·언더플로로 f 가 0 이나 무한이 되거나 c 가 비유한이 되면 조용히 돌려주지 않는다.
  for (const n of ['fx', 'fy']) if (!(out[n] > 0) || !Number.isFinite(out[n])) throw new Error(`${ERR} 배율 결과 ${n} 가 양의 유한 수가 아님: ${out[n]}`);
  for (const n of ['cx', 'cy']) if (!Number.isFinite(out[n])) throw new Error(`${ERR} 배율 결과 ${n} 가 유한하지 않음: ${out[n]}`);
  return out;
}
