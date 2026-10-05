// T15.3 건물 모서리 선 래스터. 각 묶음의 edgeLines(선분당 xyz 두 개 = 6 float)를 out(contracts/raster RenderResult)에 그린다.
// 좌표·투영은 contracts/raster 규약 그대로다: X_c = R·X_w + t (OpenCV 축: x 오른쪽, y 아래, z 앞),
//   깊이 d = X_c.z, u = fx·X_c.x/d + cx, v = fy·X_c.y/d + cy. 화소 (i,j) = [i,i+1)×[j,j+1) 칸.
// 설계 요약
// - 근평면: 카메라 공간에서 선분을 z ≥ nearM(BUILDINGS_DEFAULTS.nearM = 0.01 m)으로 자른다. 두 끝이 모두 근평면 뒤면 건너뛴다.
// - 화면 자르기: 투영한 선분을 Liang–Barsky 로 [0,W]×[0,H] 에 자른다(화면 밖 긴 선분도 순회 길이가 화면 크기로 묶인다).
//   경계 u=W, v=H 에 닿은 점의 칸은 화면 밖이므로 칠할 때 범위 검사로 버린다.
// - 그리기(DDA): |Δu| ≥ |Δv| 이면 열마다, 아니면 행마다 한 화소. 열 i 의 표본은 u = clamp(i+0.5, u0, u1) 에서의 v 이고
//   칸 = (i, floor(v)). 두 끝점의 칸 (floor(u), floor(v)) 은 따로 반드시 칠한다(round 가 아니라 floor).
//   그래서 수평선 한 줄의 화소 수 = floor(u1) − floor(u0) + 1 이다.
// - 깊이: 화면에서 1/z 가 선분을 따라 선형이므로 화면 매개변수로 1/z 를 보간하고 z = 1/보간값(원근 보정).
// - 깊이 시험: 빈 화소(깊이 0)이거나, 선이 이미 쓴 화소면 선분 깊이 < out.depth, 아니면(면) (선분 깊이 − depthBias) < out.depth 일 때만 쓴다.
//   깊이는 Math.fround 후 기록하고 float32 유한 범위 밖이면 그리지 않는다. 쓰면 깊이는 선분 깊이(편향 없음)로,
//   index 는 묶음 번호로, 색은 rgb 로 갱신한다. depthBias > 0 이면 같은 깊이의 면 위 선이 보인다.
// - 비유한 좌표는 건너뛰지 않고 TypeError 로 던진다(계약 위반을 숨기지 않는다. terrain/raster 와 같은 방침).
import { assertCamera } from '../../../contracts/raster/index.mjs';
import { BUILDINGS_DEFAULTS } from '../../../contracts/controlview/buildings.mjs';

/** out 이 카메라와 같은 크기의 RenderResult 모양인지 확인한다(전체 화소 검사는 하지 않는다). */
export function assertOutFor(camera, out, who) {
  const n = camera.width * camera.height;
  if (!out || out.width !== camera.width || out.height !== camera.height) throw new RangeError(`${who}: out 크기가 카메라 ${camera.width}×${camera.height} 와 다름`);
  if (!(out.color instanceof Uint8Array) || out.color.length !== 3 * n) throw new TypeError(`${who}: out.color 는 길이 ${3 * n} Uint8Array`);
  if (!(out.depth instanceof Float32Array) || out.depth.length !== n) throw new TypeError(`${who}: out.depth 는 길이 ${n} Float32Array`);
  if (!(out.index instanceof Int32Array) || out.index.length !== n) throw new TypeError(`${who}: out.index 는 길이 ${n} Int32Array`);
}

/** rgb 가 0..255 정수 3개인지 확인한다. */
export function assertRgb(rgb, who) {
  if (!rgb || rgb.length !== 3) throw new TypeError(`${who}: rgb 는 길이 3`);
  for (let k = 0; k < 3; k += 1) {
    if (!(Number.isInteger(rgb[k]) && rgb[k] >= 0 && rgb[k] <= 255)) throw new RangeError(`${who}: rgb[${k}] 는 0..255 정수: ${String(rgb[k])}`);
  }
}

/**
 * edgeLines 를 그린다.
 * @param {import('../../../contracts/raster/index.mjs').Camera} camera
 * @param {{edgeLines:Float32Array}[]} groups 묶음 목록(번호 = 배열 순서 = out.index 값)
 * @param {number[]} rgb 선 색
 * @param {import('../../../contracts/raster/index.mjs').RenderResult} out 갱신 대상
 * @param {{depthBias?:number}} [opts] depthBias(m, 기본 BUILDINGS_DEFAULTS.lineDepthBiasM)
 */
export function rasterizeLines(camera, groups, rgb, out, opts = {}) {
  assertCamera(camera);
  assertOutFor(camera, out, 'lines');
  assertRgb(rgb, 'lines');
  if (!Array.isArray(groups)) throw new TypeError('lines: groups 는 배열');
  const bias = opts.depthBias === undefined ? BUILDINGS_DEFAULTS.lineDepthBiasM : opts.depthBias;
  if (typeof bias !== 'number' || !Number.isFinite(bias)) throw new RangeError(`lines: depthBias 는 유한 수: ${String(bias)}`);

  const near = BUILDINGS_DEFAULTS.nearM;
  const { R, t, K, width: W, height: H } = camera;
  const { fx, fy, cx, cy } = K;
  const color = out.color, depth = out.depth, index = out.index;
  const r0 = rgb[0], g0 = rgb[1], b0 = rgb[2];

  // 화소 하나를 깊이 시험 후 쓴다.
  // 이 호출에서 선이 쓴 화소 표시: 선끼리는 편향 없이 비교하고 면(선이 쓰지 않은 화소)과만 편향을 둔다.
  const lineMark = new Uint8Array(W * H);
  const plot = (i, j, dRaw, g) => {
    if (i < 0 || j < 0 || i >= W || j >= H) return;
    const d = Math.fround(dRaw);
    if (!Number.isFinite(d)) return; // float32 유한 범위 밖이면 그리지 않는다
    const p = j * W + i;
    const old = depth[p];
    if (old !== 0 && !(lineMark[p] === 1 ? d < old : d - bias < old)) return;
    lineMark[p] = 1;
    depth[p] = d;
    index[p] = g;
    color[3 * p] = r0; color[3 * p + 1] = g0; color[3 * p + 2] = b0;
  };

  for (let g = 0; g < groups.length; g += 1) {
    const e = groups[g] && groups[g].edgeLines;
    if (!(e instanceof Float32Array) || e.length % 6 !== 0) throw new TypeError(`lines: groups[${g}].edgeLines 는 길이가 6 의 배수인 Float32Array`);
    for (let s = 0; s < e.length; s += 6) {
      for (let k = 0; k < 6; k += 1) {
        if (!Number.isFinite(e[s + k])) throw new TypeError(`lines: groups[${g}].edgeLines[${s + k}] 가 유한하지 않음`);
      }
      // 카메라 공간 끝점
      let ax = R[0] * e[s] + R[1] * e[s + 1] + R[2] * e[s + 2] + t[0];
      let ay = R[3] * e[s] + R[4] * e[s + 1] + R[5] * e[s + 2] + t[1];
      let az = R[6] * e[s] + R[7] * e[s + 1] + R[8] * e[s + 2] + t[2];
      let bx = R[0] * e[s + 3] + R[1] * e[s + 4] + R[2] * e[s + 5] + t[0];
      let by = R[3] * e[s + 3] + R[4] * e[s + 4] + R[5] * e[s + 5] + t[1];
      let bz = R[6] * e[s + 3] + R[7] * e[s + 4] + R[8] * e[s + 5] + t[2];
      // 근평면 자르기
      if (az < near && bz < near) continue;
      if (az < near) {
        const f = (near - az) / (bz - az);
        ax += f * (bx - ax); ay += f * (by - ay); az = near;
      } else if (bz < near) {
        const f = (near - bz) / (az - bz);
        bx += f * (ax - bx); by += f * (ay - by); bz = near;
      }
      // 투영
      let u0 = (fx * ax) / az + cx, v0 = (fy * ay) / az + cy, w0 = 1 / az;
      let u1 = (fx * bx) / bz + cx, v1 = (fy * by) / bz + cy, w1 = 1 / bz;
      // 화면 자르기(Liang–Barsky, 매개변수 s ∈ [0,1], 1/z 도 같은 매개변수로 선형)
      const du = u1 - u0, dv = v1 - v0;
      let s0 = 0, s1 = 1;
      const pq = [[-du, u0], [du, W - u0], [-dv, v0], [dv, H - v0]];
      let reject = false;
      for (const [p, q] of pq) {
        if (p === 0) { if (q < 0) { reject = true; break; } continue; }
        const r = q / p;
        if (p < 0) { if (r > s1) { reject = true; break; } if (r > s0) s0 = r; }
        else { if (r < s0) { reject = true; break; } if (r < s1) s1 = r; }
      }
      if (reject) continue;
      const dw = w1 - w0;
      const nu0 = u0 + s0 * du, nv0 = v0 + s0 * dv, nw0 = w0 + s0 * dw;
      const nu1 = u0 + s1 * du, nv1 = v0 + s1 * dv, nw1 = w0 + s1 * dw;
      u0 = nu0; v0 = nv0; w0 = nw0; u1 = nu1; v1 = nv1; w1 = nw1;
      const cu = u1 - u0, cv = v1 - v0, cw = w1 - w0;

      // 두 끝점 칸은 반드시 칠한다.
      plot(Math.floor(u0), Math.floor(v0), 1 / w0, g);
      plot(Math.floor(u1), Math.floor(v1), 1 / w1, g);
      if (Math.abs(cu) >= Math.abs(cv)) {
        if (cu === 0) continue; // 한 점으로 줄어든 선분
        const lo = Math.min(u0, u1), hi = Math.max(u0, u1);
        const iEnd = Math.min(Math.floor(hi), W - 1);
        for (let i = Math.max(Math.floor(lo), 0); i <= iEnd; i += 1) {
          const u = Math.min(Math.max(i + 0.5, lo), hi);
          const a = (u - u0) / cu;
          plot(i, Math.floor(v0 + a * cv), 1 / (w0 + a * cw), g);
        }
      } else {
        const lo = Math.min(v0, v1), hi = Math.max(v0, v1);
        const jEnd = Math.min(Math.floor(hi), H - 1);
        for (let j = Math.max(Math.floor(lo), 0); j <= jEnd; j += 1) {
          const v = Math.min(Math.max(j + 0.5, lo), hi);
          const a = (v - v0) / cv;
          plot(Math.floor(u0 + a * cu), j, 1 / (w0 + a * cw), g);
        }
      }
    }
  }
}
