// T12.2 점 셰이더 CPU 모사. index.mjs 의 GLSL 정점·조각 셰이더와 GL 점 래스터(클립·점 사각형·깊이 LESS·24 비트 깊이)를
// 같은 순서·같은 식으로 JS 에 옮겼다. 실제 GL 을 쓸 수 없는 환경에서 셰이더 수식을 수치로 검증하는 용도다.
// highp float 는 Math.fround 로 단계마다 f32 로 맞춘다(구현마다 연산 순서·FMA 가 달라 비트까지 같지는 않다).
// 조각 원점(RTE): pts.origin 이 있으면 렌더러처럼 u_tgl 대신 t'_gl = R_gl·o + t_gl(f64 계산 뒤 f32)을 쓴다(F-243 ③).
import { pieceTglValue } from './index.mjs';

const f = Math.fround;

/**
 * 셰이더 `u_Rgl * a_position + u_tgl` 의 한 행을 f32 로 계산한다.
 * order 'seq': 곱마다·합마다 f32 반올림, ((r0·x + r1·y) + r2·z) + t (GLSL 의 행렬·벡터 곱 뒤 덧셈 순서).
 * order 'fma': 각 곱셈·덧셈을 반올림 한 번으로 계산한다(f(r·x + acc), f32 두 수의 곱은 f64 에서 정확해 융합 곱셈·덧셈의 근사다).
 */
function rowF32(r0, r1, r2, tk, X, Y, Z, order) {
  if (order === 'fma') return f(f(f(f(r0 * X) + r1 * Y) + r2 * Z) + tk);
  return f(f(f(f(r0 * X) + f(r1 * Y)) + f(r2 * Z)) + tk);
}

/**
 * 정점 셰이더의 투영 단계만 f32 로 모사한다(시험용). X 는 버퍼에 올린 f32 위치(원점이 있으면 상대 좌표).
 * @param {Record<string, any>} U pointUniformValues 결과
 * @param {ArrayLike<number>} X 3-벡터(f32 로 반올림해 쓴다)
 * @param {{origin?: number[], order?: 'seq'|'fma'}} [opts]
 * @returns {{u:number, v:number, d:number, xn:number, yn:number} | null} u·v 장치 픽셀, xn·yn NDC. 카메라 뒤면 null
 */
export function emulateProjectVertex(U, X, opts) {
  const R = U.u_Rgl.map(f);
  const t = (opts?.origin ? pieceTglValue(U, opts.origin) : U.u_tgl).map(f);
  const order = opts?.order ?? 'seq';
  const [x0, y0, z0] = [f(X[0]), f(X[1]), f(X[2])];
  const xg = rowF32(R[0], R[1], R[2], t[0], x0, y0, z0, order);
  const yg = rowF32(R[3], R[4], R[5], t[1], x0, y0, z0, order);
  const zg = rowF32(R[6], R[7], R[8], t[2], x0, y0, z0, order);
  const d = -zg;
  const x = f(xg / d);
  const y = f(-yg / d);
  if (!(d > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const u = f(f(f(U.u_fx) * x) + f(U.u_cx));
  const v = f(f(f(U.u_fy) * y) + f(U.u_cy));
  const xn = f(f(f(2 * u) / U.u_bw) - 1);
  const yn = f(1 - f(f(2 * v) / U.u_bh));
  return { u, v, d, xn, yn };
}

/** 깊이 버퍼 비트 수(WebGL 기본 그리기 버퍼의 흔한 값). */
export const DEPTH_BITS = 24;
const DEPTH_MAX = 2 ** DEPTH_BITS - 1;

/** 셰이더 octDecode 와 같은 식(정규화 포함). q 는 −127..127 정수. */
export function shaderOctDecode(qx, qy) {
  let ex = qx / 127;
  let ey = qy / 127;
  const z = 1 - Math.abs(ex) - Math.abs(ey);
  if (z < 0) {
    const sx = ex >= 0 ? 1 : -1;
    const sy = ey >= 0 ? 1 : -1;
    [ex, ey] = [(1 - Math.abs(ey)) * sx, (1 - Math.abs(ex)) * sy];
  }
  const len = Math.hypot(ex, ey, z);
  return [ex / len, ey / len, z / len];
}

/**
 * 셰이더의 셰이딩 식. rgb 는 0..255 정수, light 는 정규화 전이어도 된다. 0..255 정수 [r,g,b] 를 돌려준다.
 * c = clamp(floor(rgb·I + 0.5), 0, 255), I = ambient + (1 − ambient)·max(0, n̂·l̂).
 */
export function shaderShade(qx, qy, lightDir, ambient, rgb) {
  const n = shaderOctDecode(qx, qy);
  const ll = Math.hypot(lightDir[0], lightDir[1], lightDir[2]);
  const l = [lightDir[0] / ll, lightDir[1] / ll, lightDir[2] / ll];
  const I = ambient + (1 - ambient) * Math.max(0, n[0] * l[0] + n[1] * l[1] + n[2] * l[2]);
  return [0, 1, 2].map((c) => Math.min(255, Math.max(0, Math.floor(rgb[c] * I + 0.5))));
}

/**
 * 셰이더 경로를 CPU 로 그린다.
 * @param {Record<string, any>} U pointUniformValues 결과
 * @param {{positions: Float32Array, colors: Uint8Array, normalOct?: Int8Array, origin?: number[]}} pts normalOct 는 [qx, qy] 쌍(2n).
 *   origin 이 있으면 positions 는 그 원점 기준 상대 좌표이고 u_tgl 대신 조각별 t'_gl 을 쓴다(렌더러와 같음)
 * @param {{clipPointCenter?: boolean}} [opts] clipPointCenter: 중심이 화면 밖인 점을 통째로 버린다(명세 문자 그대로의 구현)
 * @returns {{width:number, height:number, color: Uint8Array, depth: Uint32Array, drawn: Uint8Array}}
 *   color 는 3·w·h rgb(위에서 아래 행). depth 는 양자화 깊이(빈 칸 DEPTH_MAX + 1). drawn 은 칸마다 0/1.
 */
export function emulatePointRender(U, pts, opts) {
  const clipCenter = !!opts?.clipPointCenter;
  const bw = U.u_bw;
  const bh = U.u_bh;
  const n = pts.positions.length / 3;
  const color = new Uint8Array(3 * bw * bh);
  const depth = new Uint32Array(bw * bh).fill(DEPTH_MAX + 1);
  const drawn = new Uint8Array(bw * bh);
  const R = U.u_Rgl.map(f);
  const t = (pts.origin ? pieceTglValue(U, pts.origin) : U.u_tgl).map(f);
  const [fx, fy, cx, cy] = [f(U.u_fx), f(U.u_fy), f(U.u_cx), f(U.u_cy)];
  const near = f(U.u_near);
  const far = f(U.u_far);
  const sizeM = f(U.u_pointSizeM);
  const ambient = f(U.u_ambient);
  const P = pts.positions;
  for (let k = 0; k < n; k += 1) {
    // 정점 셰이더
    const X = P[3 * k], Y = P[3 * k + 1], Z = P[3 * k + 2];
    const xg = rowF32(R[0], R[1], R[2], t[0], X, Y, Z, 'seq');
    const yg = rowF32(R[3], R[4], R[5], t[1], X, Y, Z, 'seq');
    const zg = rowF32(R[6], R[7], R[8], t[2], X, Y, Z, 'seq');
    const d = -zg;
    const x = f(xg / d);
    const y = f(-yg / d);
    if (!(d > 0) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const u = f(f(fx * x) + cx);
    const v = f(f(fy * y) + cy);
    const xn = f(f(f(2 * u) / bw) - 1);
    const yn = f(1 - f(f(2 * v) / bh));
    const zl = f(f(d - near) / f(far - near));
    const zn = f(f(2 * zl) - 1);
    // 점 클립: z 는 항상 near·far 로 자른다. x·y 는 구현 몫이다(GLES 3.0 명세는 중심이 클립 공간 밖인 점을 버리게 하지만
    // ANGLE/SwiftShader 는 가드 밴드로 원판의 화면 안 부분을 그린다, 실측). opts.clipPointCenter 로 고른다(기본 false = 실측 동작).
    if (!(zn >= -1 && zn <= 1)) continue;
    if (clipCenter && !(xn >= -1 && xn <= 1 && yn >= -1 && yn <= 1)) continue;
    const r = f(f(fx * sizeM) / f(2 * d));
    const S = Math.min(f(f(2 * r) + 2), U.u_maxPointSize);
    let rgb = [pts.colors[3 * k], pts.colors[3 * k + 1], pts.colors[3 * k + 2]];
    if (U.u_shade) rgb = shaderShade(pts.normalOct[2 * k], pts.normalOct[2 * k + 1], U.u_lightDir, ambient, rgb);
    // 창 좌표와 깊이(24 비트 고정소수)
    const xw = f(f(f(xn + 1) * bw) / 2);
    const yw = f(f(f(yn + 1) * bh) / 2);
    const zq = Math.round(f(f(zn + 1) / 2) * DEPTH_MAX);
    const h = S / 2;
    const i0 = Math.max(0, Math.ceil(xw - h - 0.5));
    const i1 = Math.min(bw - 1, Math.floor(xw + h - 0.5));
    const g0 = Math.max(0, Math.ceil(yw - h - 0.5));
    const g1 = Math.min(bh - 1, Math.floor(yw + h - 0.5));
    const cu = Math.floor(u);
    const cv = Math.floor(v);
    const r2 = f(r * r);
    for (let g = g0; g <= g1; g += 1) {
      // 조각 셰이더: p = (gl_FragCoord.x, bh − gl_FragCoord.y)
      const py = bh - (g + 0.5);
      const j = bh - 1 - g;
      for (let i = i0; i <= i1; i += 1) {
        const px = i + 0.5;
        const dx = f(px - u);
        const dy = f(py - v);
        const centerCell = Math.floor(px) === cu && Math.floor(py) === cv;
        if (f(f(dx * dx) + f(dy * dy)) > r2 && !centerCell) continue;
        const q = j * bw + i;
        if (!(zq < depth[q])) continue; // 깊이 LESS
        depth[q] = zq;
        drawn[q] = 1;
        color[3 * q] = rgb[0];
        color[3 * q + 1] = rgb[1];
        color[3 * q + 2] = rgb[2];
      }
    }
  }
  return { width: bw, height: bh, color, depth, drawn };
}
