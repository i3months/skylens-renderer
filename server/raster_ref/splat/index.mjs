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
  return radiusUnchecked(camera.K.fx, depth, sizeM);
}

/**
 * 입력 검사를 호출자가 이미 마친 경우의 반경 계산(점마다 카메라를 다시 검사하지 않으려는 용도).
 * 카메라·depth(>0)·sizeM(>0) 이 유효하다는 보장은 호출자 몫이며, 결과가 비유한이면 같은 'raster:' 오류를 낸다.
 */
export function radiusUnchecked(fx, depth, sizeM) {
  const r = (fx * sizeM) / (2 * depth);
  if (!Number.isFinite(r)) throw new Error(`${ERR} 원판 반경이 유한하지 않음(깊이 ${depth}, sizeM ${sizeM} 이 너무 극단적임)`);
  return r;
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
  // 한 번 세고 한 번 채운다(점마다 배열 push 와 Int32Array.from 복사를 피한다).
  // 행(j) 바깥, 열(i) 안쪽으로 돌면 번호가 저절로 오름차순이 된다.
  const inside = (i, j) => {
    const dx = i + 0.5 - u;
    const dy = j + 0.5 - v;
    return dx * dx + dy * dy <= r2 || (i === ci && j === cj);
  };
  let count = 0;
  for (let j = j0; j <= j1; j += 1) for (let i = i0; i <= i1; i += 1) if (inside(i, j)) count += 1;
  const out = new Int32Array(count);
  let o = 0;
  for (let j = j0; j <= j1; j += 1) for (let i = i0; i <= i1; i += 1) if (inside(i, j)) out[o++] = j * width + i;
  return out;
}
