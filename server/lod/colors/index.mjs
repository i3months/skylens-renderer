// 축소 시 색 대표값(T07.7). 칸 안 점 색의 채널별 평균을 반올림해 칸마다 한 색을 만든다.
// 합은 정수로 누적하고 반올림도 정수 연산만 쓴다: 부동소수 오차가 끼지 않는다.
import { assertCloud } from '../../../contracts/lod/index.mjs';

const ERR = 'lod:';

// 점 수·칸 수가 계약대로인지 확인하고 칸별 점 수와 채널별 합을 구한다.
function accumulate(cloud, voxel) {
  const n = assertCloud(cloud);
  const { count, cellOfPoint } = voxel ?? {};
  if (!Number.isInteger(count) || count < 0) throw new Error(`${ERR} voxel.count 가 음이 아닌 정수가 아님`);
  if (!(cellOfPoint instanceof Uint32Array) || cellOfPoint.length !== n) throw new Error(`${ERR} cellOfPoint 길이(${cellOfPoint?.length})가 점 수(${n})와 다름`);
  const sums = new Float64Array(3 * count); // 정수만 담는다(최대 255·n, 2^53 아래)
  const sizes = new Uint32Array(count);
  const col = cloud.colors;
  for (let i = 0; i < n; i++) {
    const c = cellOfPoint[i];
    if (c >= count) throw new Error(`${ERR} cellOfPoint[${i}]=${c} 가 칸 수 ${count} 이상`);
    sizes[c]++;
    sums[3 * c] += col[3 * i];
    sums[3 * c + 1] += col[3 * i + 1];
    sums[3 * c + 2] += col[3 * i + 2];
  }
  for (let c = 0; c < count; c++) if (sizes[c] === 0) throw new Error(`${ERR} 칸 ${c} 에 점이 없음`);
  return { sums, sizes };
}

/** 칸 안 점 색의 채널별 평균(0.5 는 올림). Uint8Array(3·count). */
export function representativeColors(cloud, voxel) {
  const { sums, sizes } = accumulate(cloud, voxel);
  const out = new Uint8Array(sums.length);
  for (let c = 0; c < voxel.count; c++) {
    const k = sizes[c];
    // round-half-up(sum/k) = floor((2·sum + k) / (2k)), 정수 연산
    for (let ch = 0; ch < 3; ch++) out[3 * c + ch] = Math.floor((2 * sums[3 * c + ch] + k) / (2 * k));
  }
  return out;
}

/** 칸 안 실제 평균과 colors 의 채널 최대 차(1/255 단위, 즉 0..1). 칸이 없으면 0. */
export function meanColorError(cloud, voxel, colors) {
  const { sums, sizes } = accumulate(cloud, voxel);
  if (!(colors instanceof Uint8Array) || colors.length !== sums.length) throw new Error(`${ERR} colors 길이가 3·count 가 아님`);
  let max = 0;
  for (let c = 0; c < voxel.count; c++) {
    const k = sizes[c];
    for (let ch = 0; ch < 3; ch++) {
      // |colors − sum/k| = |colors·k − sum| / k (분자는 정수)
      const e = Math.abs(colors[3 * c + ch] * k - sums[3 * c + ch]) / k;
      if (e > max) max = e;
    }
  }
  return max / 255;
}
