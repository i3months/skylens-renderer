// T15.3 건물 표본점 래스터(points 옵션). 각 묶음의 points(xyz 연속)를 점 하나 = 한 화소로 out 에 그린다.
// 좌표·투영은 contracts/raster 규약 그대로다: X_c = R·X_w + t, d = X_c.z, u = fx·X_c.x/d + cx, v = fy·X_c.y/d + cy.
// 설계 요약
// - 칸: 화소 (i,j) = [i,i+1)×[j,j+1) 이므로 점의 칸은 (floor(u), floor(v)) 이다(round 가 아님). 화면 밖이면 버린다.
// - 투영 분모는 double d0, float32 로 반올림한 d 는 깊이 시험·기록에만 쓴다(lines.mjs 와 같은 규약).
// - 근평면: d > nearM(BUILDINGS_DEFAULTS.nearM = 0.01 m)인 점만 그린다(카메라 뒤·카메라 평면 위 점 제외).
// - 깊이 시험: 빈 화소(깊이 0)이거나 d < out.depth 일 때만 쓴다(엄격). 같은 깊이면 먼저 그린 점이 남는다.
//   쓰면 depth = d, index = 묶음 번호, color = rgb.
// - 비유한 좌표는 TypeError 로 던진다.
import { assertCamera } from '../../../contracts/raster/index.mjs';
import { BUILDINGS_DEFAULTS } from '../../../contracts/controlview/buildings.mjs';
import { assertOutFor, assertRgb } from './lines.mjs';

/**
 * 표본점을 그린다.
 * @param {import('../../../contracts/raster/index.mjs').Camera} camera
 * @param {{points:Float32Array}[]} groups 묶음 목록(번호 = 배열 순서 = out.index 값)
 * @param {number[]} rgb 점 색
 * @param {import('../../../contracts/raster/index.mjs').RenderResult} out 갱신 대상
 */
export function rasterizePoints(camera, groups, rgb, out) {
  assertCamera(camera);
  assertOutFor(camera, out, 'points');
  assertRgb(rgb, 'points');
  if (!Array.isArray(groups)) throw new TypeError('points: groups 는 배열');
  const near = BUILDINGS_DEFAULTS.nearM;
  const { R, t, K, width: W, height: H } = camera;
  const { fx, fy, cx, cy } = K;
  const color = out.color, depth = out.depth, index = out.index;

  for (let g = 0; g < groups.length; g += 1) {
    const P = groups[g] && groups[g].points;
    if (!(P instanceof Float32Array) || P.length % 3 !== 0) throw new TypeError(`points: groups[${g}].points 는 길이가 3 의 배수인 Float32Array`);
    for (let s = 0; s < P.length; s += 3) {
      const x = P[s], y = P[s + 1], z = P[s + 2];
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) throw new TypeError(`points: groups[${g}].points[${s}..${s + 2}] 가 유한하지 않음`);
      const d0 = R[6] * x + R[7] * y + R[8] * z + t[2];
      if (!(d0 > near)) continue;
      const d = Math.fround(d0);
      if (!Number.isFinite(d)) continue; // float32 유한 범위 밖이면 그리지 않는다
      const xc = R[0] * x + R[1] * y + R[2] * z + t[0];
      const yc = R[3] * x + R[4] * y + R[5] * z + t[1];
      const i = Math.floor((fx * xc) / d0 + cx);
      const j = Math.floor((fy * yc) / d0 + cy);
      if (!(i >= 0 && j >= 0 && i < W && j < H)) continue;
      const p = j * W + i;
      const old = depth[p];
      if (old !== 0 && !(d < old)) continue;
      depth[p] = d;
      index[p] = g;
      color[3 * p] = rgb[0]; color[3 * p + 1] = rgb[1]; color[3 * p + 2] = rgb[2];
    }
  }
}
