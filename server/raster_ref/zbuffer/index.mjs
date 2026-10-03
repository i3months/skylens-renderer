// T06.5 깊이 버퍼 래스터: 점마다 원판(splat)을 그리고 픽셀마다 가장 가까운 점을 남긴다.
// 같은 깊이면 먼저 온(번호 작은) 점이 이긴다(엄격 < 로만 갱신). 빈 픽셀은 메우지 않는다.
// 56 B 점의 opacity·scale·rot 는 쓰지 않고 pointSizeM 고정 원판으로 그린다(contracts/raster 문구 참조).
// 이 단계의 색은 점 색 그대로다(셰이딩은 별도 하위 작업).
import { assertCamera, assertRenderResult, emptyResult, pointCount } from '../../../contracts/raster/index.mjs';
import { projectMany } from '../project/index.mjs';
import { radiusUnchecked, splatPixels } from '../splat/index.mjs';

const ERR = 'raster:';
const SH_C0 = 0.28209479177387814;

// 기본 승부 규칙: 새 깊이가 기존보다 엄격히 가까울 때만 이긴다.
const strictlyCloser = (dNew, dOld) => dNew < dOld;

// 점군에서 점 번호 i 의 색 3개를 out 에 쓴다. 형식 1 은 그대로, 형식 2 는 fdc 로 계산한다.
function pointColors(cloud) {
  const n = cloud.positions.length / 3;
  if (cloud.format === 1) {
    if (!(cloud.colors instanceof Uint8Array) || cloud.colors.length !== 3 * n) throw new Error(`${ERR} colors 길이가 3·점수가 아님`);
    return cloud.colors;
  }
  if (cloud.format === 2) {
    if (!(cloud.fdc instanceof Float32Array) || cloud.fdc.length !== 3 * n) throw new Error(`${ERR} fdc 길이가 3·점수가 아님`);
    const out = new Uint8Array(3 * n);
    for (let k = 0; k < 3 * n; k += 1) {
      const c = Math.min(1, Math.max(0, 0.5 + SH_C0 * cloud.fdc[k]));
      out[k] = Math.round(c * 255);
    }
    return out;
  }
  throw new Error(`${ERR} 알 수 없는 점군 형식: ${String(cloud.format)}`);
}

/**
 * 승부 규칙을 바꿀 수 있는 핵심 구현(시험이 변이를 주입하는 용도). 일반 사용은 renderPoints 를 쓴다.
 * wins(dNew, dOld) 가 참이면 새 점이 기존 점을 대체한다.
 */
export function renderPointsWith(camera, cloud, opts, wins) {
  assertCamera(camera);
  const n = pointCount(cloud); // 점 수 정의는 no_fill 과 공유(count 불일치는 'raster:' 오류)
  const pointSizeM = opts?.pointSizeM ?? 0.05;
  if (typeof pointSizeM !== 'number' || !Number.isFinite(pointSizeM) || !(pointSizeM > 0)) throw new Error(`${ERR} pointSizeM 은 양의 유한 수여야 함: ${String(pointSizeM)}`);
  const validate = opts?.validate ?? true;
  const { width, height } = camera;
  const fx = camera.K.fx;
  const res = emptyResult(width, height);
  if (n === 0) {
    if (validate) assertRenderResult(res);
    return res;
  }
  const colors = pointColors(cloud);
  const proj = projectMany(camera, cloud.positions, new Float64Array(3 * n));
  for (let p = 0; p < n; p += 1) {
    const u = proj[3 * p];
    const v = proj[3 * p + 1];
    const d = proj[3 * p + 2];
    if (!(d > 0) || !Number.isFinite(u) || !Number.isFinite(v)) continue; // 카메라 뒤
    const dStored = Math.fround(d); // 저장되는 값과 같은 정밀도로 비교한다
    if (!(dStored > 0) || !Number.isFinite(dStored)) continue;
    const r = radiusUnchecked(fx, d, pointSizeM); // 카메라·pointSizeM 은 위에서 한 번 검사했다
    // 원판이 화면과 겹치지 않으면 건너뛴다(중심 칸이 화면 밖이고 원도 밖).
    if (u + r < 0 || v + r < 0 || u - r > width || v - r > height) continue;
    const pix = splatPixels(u, v, r, width, height);
    for (let q = 0; q < pix.length; q += 1) {
      const px = pix[q];
      if (res.index[px] === -1 || wins(dStored, res.depth[px])) {
        res.depth[px] = dStored;
        res.index[px] = p;
        res.color[3 * px] = colors[3 * p];
        res.color[3 * px + 1] = colors[3 * p + 1];
        res.color[3 * px + 2] = colors[3 * p + 2];
      }
    }
  }
  if (validate) assertRenderResult(res);
  return res;
}

/**
 * 점군을 깊이 버퍼로 그린다. opts.pointSizeM 기본 0.05(m), opts.validate 기본 true(결과를 계약대로 검사).
 * @returns {import('../../../contracts/raster/index.mjs').RenderResult}
 */
export function renderPoints(camera, cloud, opts) {
  return renderPointsWith(camera, cloud, opts, strictlyCloser);
}
