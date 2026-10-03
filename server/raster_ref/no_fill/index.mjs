// T06.7 "메우지 않는다" 검사. 빈 픽셀 수를 세고, 칠해진 픽셀 집합을 정답(점이 닿는 픽셀의 합집합)과 대조한다.
import { assertCamera, assertRenderResult, pointCount, EMPTY_INDEX, EMPTY_DEPTH } from '../../../contracts/raster/index.mjs';
import { project } from '../project/index.mjs';
import { splatRadiusPx, splatPixels } from '../splat/index.mjs';

const ERR = 'no_fill:';

/** 빈 픽셀(index === −1) 수. depth 0 과 어긋나면 'no_fill:' Error. */
export function countEmpty(result) {
  if (!result || !(result.index instanceof Int32Array) || !(result.depth instanceof Float32Array) || result.index.length !== result.depth.length) {
    throw new Error(`${ERR} 결과 모양이 틀림`);
  }
  let n = 0;
  for (let i = 0; i < result.index.length; i += 1) {
    const empty = result.index[i] === EMPTY_INDEX;
    if (empty !== (result.depth[i] === EMPTY_DEPTH)) throw new Error(`${ERR} 픽셀 ${i}: 빈 번호와 빈 깊이가 어긋남`);
    if (empty) n += 1;
  }
  return n;
}

/** 모든 점이 덮는 픽셀 번호(j·width+i)의 합집합. 렌더러와 독립으로 project·splat 만 쓴다. */
export function reachablePixelSet(camera, cloud, pointSizeM) {
  assertCamera(camera);
  const pos = cloud.positions;
  const n = pointCount(cloud); // zbuffer 와 같은 점 수 정의
  const set = new Set();
  for (let k = 0; k < n; k += 1) {
    const { u, v, d } = project(camera, [pos[3 * k], pos[3 * k + 1], pos[3 * k + 2]]);
    if (!(d > 0) || !Number.isFinite(u) || !Number.isFinite(v)) continue; // 카메라 뒤·비유한 투영(렌더러와 같은 규칙)
    // 렌더러는 저장 정밀도(Float32)로 반올림한 깊이가 0 이면 그 점을 그리지 않는다. 정답 집합도 같은 규칙으로 건너뛴다.
    if (!(Math.fround(d) > 0)) continue;
    const r = splatRadiusPx(camera, d, pointSizeM);
    // 화면 밖 점은 걸치는 픽셀이 없으면 건너뛴다(중심 칸이 화면 밖이면 splatPixels 가 범위를 자른다).
    for (const p of splatPixels(u, v, r, camera.width, camera.height)) set.add(p);
  }
  return set;
}

/** 칠해진 픽셀 집합이 reachablePixelSet 과 정확히 같아야 한다. 메운 것도 사라진 것도 오류. */
export function assertNoFill(result, camera, cloud, pointSizeM) {
  assertRenderResult(result);
  if (result.width !== camera.width || result.height !== camera.height) throw new Error(`${ERR} 해상도가 카메라와 다름`);
  const want = reachablePixelSet(camera, cloud, pointSizeM);
  const total = result.width * result.height;
  const empty = countEmpty(result);
  const filled = new Set();
  for (let i = 0; i < total; i += 1) {
    if (result.index[i] === EMPTY_INDEX) continue;
    filled.add(i);
    if (!want.has(i)) throw new Error(`${ERR} 점이 닿지 않는 픽셀 ${i} 가 칠해짐(메움)`);
  }
  for (const p of want) if (!filled.has(p)) throw new Error(`${ERR} 점이 닿는 픽셀 ${p} 가 비어 있음(사라짐)`);
  if (empty !== total - want.size) throw new Error(`${ERR} 빈 픽셀 수 ${empty} != 전체 ${total} - 집합 ${want.size}`);
}
