// T06.4 점 원판(splat) 크기와 덮는 픽셀. 점을 깊이 d(m)의 지름 sizeM(m) 원판으로 본다.
// 픽셀 반경 r = fx·sizeM/(2·d). 픽셀 (i,j) 는 [i,i+1)×[j,j+1) 칸이고 중심은 (i+0.5, j+0.5) 다.
import { assertCamera } from '../../../contracts/raster/index.mjs';

const ERR = 'raster:';

const isFiniteNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** 깊이 depth(m)에 놓인 지름 sizeM(m) 원판의 픽셀 반경. 순수 함수. */
export function splatRadiusPx(camera, depth, sizeM) {
  assertCamera(camera);
  if (!isFiniteNum(depth) || !(depth > 0)) throw new Error(`${ERR} 깊이는 양의 유한 수여야 함: ${String(depth)}`);
  if (!isFiniteNum(sizeM) || !(sizeM > 0)) throw new Error(`${ERR} sizeM 은 양의 유한 수여야 함: ${String(sizeM)}`);
  return (camera.K.fx * sizeM) / (2 * depth);
}

/**
 * (u,v) 중심, 반경 rPx 원판이 덮는 픽셀 번호(j·width+i) 를 오름차순으로 돌려준다.
 * 칸 중심이 원 안(거리 ≤ rPx)이면 포함, 화면 밖은 잘라낸다.
 * (u,v) 가 속한 칸 (floor(u), floor(v)) 이 화면 안이면 반경과 무관하게 항상 포함한다(최소 1 픽셀).
 */
export function splatPixels(u, v, rPx, width, height) {
  if (!isFiniteNum(u) || !isFiniteNum(v)) throw new Error(`${ERR} u,v 는 유한 수여야 함: ${String(u)}, ${String(v)}`);
  if (!isFiniteNum(rPx) || rPx < 0) throw new Error(`${ERR} rPx 는 0 이상의 유한 수여야 함: ${String(rPx)}`);
  for (const [n, x] of [['width', width], ['height', height]]) {
    if (!Number.isInteger(x) || x <= 0) throw new Error(`${ERR} ${n} 는 양의 정수여야 함: ${String(x)}`);
  }
  const ci = Math.floor(u);
  const cj = Math.floor(v);
  // 중심 칸 열·행 번호와 원이 걸칠 수 있는 범위를 화면 안으로 자른다.
  const i0 = Math.max(0, Math.min(ci, Math.floor(u - rPx - 0.5)));
  const i1 = Math.min(width - 1, Math.max(ci, Math.ceil(u + rPx - 0.5)));
  const j0 = Math.max(0, Math.min(cj, Math.floor(v - rPx - 0.5)));
  const j1 = Math.min(height - 1, Math.max(cj, Math.ceil(v + rPx - 0.5)));
  const r2 = rPx * rPx;
  const out = [];
  // 행(j) 바깥, 열(i) 안쪽으로 돌면 번호가 저절로 오름차순이 된다.
  for (let j = j0; j <= j1; j += 1) {
    const dy = j + 0.5 - v;
    for (let i = i0; i <= i1; i += 1) {
      const dx = i + 0.5 - u;
      if (dx * dx + dy * dy <= r2 || (i === ci && j === cj)) out.push(j * width + i);
    }
  }
  return Int32Array.from(out);
}
