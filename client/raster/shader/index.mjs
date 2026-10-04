// T12.2 점 셰이더(크기·색·법선 셰이딩). WebGL2(GLSL ES 3.00) 정점·조각 셰이더 소스와 컴파일·링크 도우미, 유니폼 값 계산.
// 좌표·투영 규약은 contracts/client_raster/index.mjs 머리 주석 ②가 정본이다(여기는 그 식을 셰이더로 옮긴 것).
//   X_gl = R_gl·X_w + t_gl, R_gl = diag(1,−1,−1)·R, t_gl = diag(1,−1,−1)·t (cvToGlExtrinsics)
//   d = −X_gl.z = X_c.z, u = fx·X_gl.x/d + cx, v = fy·(−X_gl.y)/d + cy   (장치 픽셀, 정수 = 칸 모서리)
//   NDC = pixelToNdc(u, v, bw, bh) = (2u/bw − 1, 1 − 2v/bh)
// 점 크기(contracts/raster splat 과 같은 식): 지름 pointSizeM(m) 원판, 픽셀 반경 r = fx·pointSizeM/(2·d).
//   조각 셰이더가 칸 중심이 원 안(거리 ≤ r)인 칸과, 반경과 무관하게 중심 칸 (floor(u), floor(v)) 을 남긴다
//   (server/raster_ref/splat splatPixels 와 같은 규칙). gl_PointSize = min(2r + 2, maxPointSize) 는 그 칸들을 덮는 사각형이다.
// 셰이딩(형식 1, contracts/raster shade 의 lambert 와 같은 식):
//   n̂ = 팔면체 snorm8 복호(ASSET_FORMAT §5.3·§6, server/asset/unpack decodeOctNormal 과 같은 식) 후 정규화,
//   l̂ = 세계 좌표 빛 방향(표면 → 광원) 정규화, I = ambient + (1 − ambient)·max(0, n̂·l̂), c = clamp(round(rgb·I), 0, 255).
//   round 는 JS Math.round 와 맞추려고 floor(x + 0.5) 로 쓴다(GLSL round 의 .5 방향은 구현 몫이라 쓰지 않는다).
//   형식 2(법선 없음)는 u_shade = false 로 색을 그대로 낸다.
// 깊이: z_ndc = 2·(d − near)/(far − near) − 1 (선형). 같은 깊이면 먼저 그린 점이 이기도록 깊이 함수는 LESS 를 쓴다(호출자 몫).
// 참조(server/raster_ref zbuffer)와 다른 점(GL 규약 때문이며 숨기지 않는다):
//   - 중심이 클립 공간 밖인 점: GLES 3.0 명세는 통째로 버리게 하나 구현이 가드 밴드로 그리기도 한다. 헤드리스 Chromium
//     (ANGLE/SwiftShader)은 원판의 화면 안 부분을 그려 참조와 같다(실측). 버리는 구현에서는 화면 가장자리에 걸친 원판이 빠진다.
//   - d < near 또는 d > far 인 점은 버린다(참조는 d > 0 이면 그린다).
//   - gl_PointSize 상한(ALIASED_POINT_SIZE_RANGE)보다 큰 원판은 잘린다.
//   - 깊이 버퍼 정밀도(보통 24 비트)가 참조의 f32 깊이보다 거칠어 거의 같은 깊이의 승부가 달라질 수 있다.
// 빈 칸은 메우지 않는다: 지우기 색 (0,0,0) 그대로 둔다(도착하지 않은 것을 그리거나 메우지 않는다).
// 조각 원점 기준 상대 좌표(RTE, F-243 ③): a_position 은 조각 원점 o(f64) 를 뺀 상대 ENU(m)이고 u_tgl 은 조각마다
//   t'_gl = R_gl·o + t_gl 을 f64 로 계산해 올린다(applyPieceOrigin). 셰이더 식 X_gl = R_gl·X_rel + t'_gl 은 위와 같은 값이다.
//   앵커에서 수 km 떨어진 장면을 절대 ENU f32 로 올리면 위치·R·X 합의 f32 반올림(5 km 에서 ulp ≈ 0.5 mm)이 깊이 1 m 점에서
//   약 1 CSS px(기준 0.5 px 초과, client/raster/rte.test.mjs)가 된다. 상대 좌표는 조각 크기(타일 64 m) 안이고 t' 는 카메라에서 조각 원점까지 거리라 f32 오차가 작다.
//   원점 o = 0 이면 예전 절대 좌표 방식과 같다(pointUniformValues 의 u_tgl 은 o = 0 의 값).
import { cvToGlExtrinsics } from '../../../contracts/client_raster/index.mjs';
import { pieceTranslation } from '../camera/index.mjs';

/** 정점 속성 위치(layout(location)). 보폭·패딩 같은 GPU 배치는 T12.3 몫이다. */
export const ATTRIB = Object.freeze({
  position: 0, // vec3 f32 조각 원점 기준 상대 ENU(m). 원점은 u_tgl 로 넘긴다(RTE)
  color: 1, // u8×3, normalized = false 로 올린다(0..255 값 그대로)
  normalOct: 2, // i8×2 팔면체 snorm8, normalized = false 로 올린다(−127..127 값 그대로)
});

/** 팔면체 snorm8 의 정수 범위(contracts/asset OCT_SNORM_MAX 와 같다). */
export const OCT_SNORM_MAX = 127;
/** 기본 ambient(contracts/raster shade 기본값과 같다). */
export const DEFAULT_AMBIENT = 0.3;

export const VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_color;
layout(location = 2) in vec2 a_normalOct;
uniform mat3 u_Rgl;
uniform vec3 u_tgl;
uniform float u_fx;
uniform float u_fy;
uniform float u_cx;
uniform float u_cy;
uniform float u_bw;
uniform float u_bh;
uniform vec3 u_lightDir;
uniform float u_ambient;
uniform bool u_shade;
uniform float u_pointSizeM;
uniform float u_near;
uniform float u_far;
uniform float u_maxPointSize;
flat out vec3 v_color;
flat out vec2 v_center;
flat out float v_radius;

// 팔면체 snorm8 복호(ASSET_FORMAT §5.3 의 역). 결과는 정규화한다.
vec3 octDecode(vec2 q) {
  vec2 e = q / 127.0;
  float z = 1.0 - abs(e.x) - abs(e.y);
  if (z < 0.0) {
    vec2 s = vec2(e.x >= 0.0 ? 1.0 : -1.0, e.y >= 0.0 ? 1.0 : -1.0);
    e = vec2((1.0 - abs(e.y)) * s.x, (1.0 - abs(e.x)) * s.y);
  }
  return normalize(vec3(e, z));
}

void main() {
  vec3 xg = u_Rgl * a_position + u_tgl;
  float d = -xg.z;
  float x = xg.x / d;
  float y = -xg.y / d;
  // 카메라 뒤·카메라 평면 위·비유한 좌표는 클립 공간 밖으로 보내 버린다
  if (!(d > 0.0) || isnan(x) || isnan(y) || isinf(x) || isinf(y)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 1.0;
    v_color = vec3(0.0);
    v_center = vec2(0.0);
    v_radius = 0.0;
    return;
  }
  float u = u_fx * x + u_cx;
  float v = u_fy * y + u_cy;
  float zl = (d - u_near) / (u_far - u_near);
  gl_Position = vec4(2.0 * u / u_bw - 1.0, 1.0 - 2.0 * v / u_bh, 2.0 * zl - 1.0, 1.0);
  float r = u_fx * u_pointSizeM / (2.0 * d);
  gl_PointSize = min(2.0 * r + 2.0, u_maxPointSize);
  v_center = vec2(u, v);
  v_radius = r;
  if (u_shade) {
    vec3 n = octDecode(a_normalOct);
    vec3 l = normalize(u_lightDir);
    float I = u_ambient + (1.0 - u_ambient) * max(0.0, dot(n, l));
    v_color = clamp(floor(a_color * I + 0.5), 0.0, 255.0) / 255.0;
  } else {
    v_color = a_color / 255.0;
  }
}
`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform float u_bh;
flat in vec3 v_color;
flat in vec2 v_center;
flat in float v_radius;
out vec4 o_color;

void main() {
  // 칸 중심의 픽셀 좌표(OpenCV 규약, v 아래). gl_FragCoord 는 왼쪽 아래 원점이고 칸 중심(i + 0.5)이다.
  vec2 p = vec2(gl_FragCoord.x, u_bh - gl_FragCoord.y);
  vec2 dd = p - v_center;
  bool centerCell = all(equal(floor(p), floor(v_center)));
  if (dot(dd, dd) > v_radius * v_radius && !centerCell) discard;
  o_color = vec4(v_color, 1.0);
}
`;

/** 유니폼 이름과 형(applyPointUniforms 가 이 표로 올린다). */
export const UNIFORMS = Object.freeze({
  u_Rgl: 'mat3', u_tgl: 'vec3',
  u_fx: 'float', u_fy: 'float', u_cx: 'float', u_cy: 'float',
  u_bw: 'float', u_bh: 'float',
  u_lightDir: 'vec3', u_ambient: 'float', u_shade: 'bool',
  u_pointSizeM: 'float', u_near: 'float', u_far: 'float', u_maxPointSize: 'float',
});

/** 셰이더 오류. stage: 'vertex' | 'fragment' | 'link' | 'uniform'. */
export class PointShaderError extends Error {
  /** @param {string} stage @param {string} message */
  constructor(stage, message) {
    super(`point_shader: ${stage}: ${message}`);
    this.name = 'PointShaderError';
    this.stage = stage;
  }
}

function compile(gl, type, src, stage) {
  const sh = gl.createShader(type);
  if (!sh) throw new PointShaderError(stage, 'createShader 실패(컨텍스트 소실?)');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || '';
    gl.deleteShader(sh);
    throw new PointShaderError(stage, log);
  }
  return sh;
}

/**
 * 점 프로그램을 컴파일·링크한다. 실패하면 PointShaderError(만든 셰이더·프로그램은 지운다).
 * @param {WebGL2RenderingContext} gl
 * @returns {{program: WebGLProgram, uniforms: Record<string, WebGLUniformLocation|null>}}
 */
export function createPointProgram(gl) {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER, 'vertex');
  let fs;
  try {
    fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER, 'fragment');
  } catch (e) {
    gl.deleteShader(vs);
    throw e;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new PointShaderError('link', 'createProgram 실패(컨텍스트 소실?)');
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // 링크 뒤 셰이더 객체는 필요 없다
  gl.detachShader(program, vs);
  gl.detachShader(program, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || '';
    gl.deleteProgram(program);
    throw new PointShaderError('link', log);
  }
  const uniforms = {};
  for (const name of Object.keys(UNIFORMS)) uniforms[name] = gl.getUniformLocation(program, name);
  return { program, uniforms };
}

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

function need(cond, msg) {
  if (!cond) throw new PointShaderError('uniform', msg);
}

/**
 * 유니폼 값을 계산한다(순수 함수). K 는 장치 픽셀 K(scaleIntrinsics 결과), bw×bh 는 그리기 버퍼.
 * @param {Object} p
 * @param {number[]} p.R 3×3 행 우선(세계→OpenCV 카메라)
 * @param {number[]} p.t 3-벡터
 * @param {{fx:number, fy:number, cx:number, cy:number}} p.K
 * @param {number} p.bw @param {number} p.bh
 * @param {number[]} p.lightDirWorld 세계 좌표 빛 방향(표면 → 광원, 길이 0 아님)
 * @param {number} p.pointSizeM 점 지름(m, > 0)
 * @param {number} [p.ambient] 기본 0.3
 * @param {boolean} [p.shade] 기본 true(형식 1). 형식 2 는 false
 * @param {number} p.near @param {number} p.far 0 < near < far
 * @param {number} p.maxPointSize ALIASED_POINT_SIZE_RANGE[1]
 * @returns {Record<string, number|boolean|number[]>} u_Rgl 은 행 우선 9개(올릴 때 transpose = true)
 */
export function pointUniformValues(p) {
  need(p && typeof p === 'object', '인자가 객체가 아님');
  const { R: Rgl, t: tgl } = cvToGlExtrinsics(p.R, p.t);
  const K = p.K;
  need(K && finite(K.fx) && K.fx > 0 && finite(K.fy) && K.fy > 0 && finite(K.cx) && finite(K.cy), 'K 가 올바르지 않음');
  need(Number.isInteger(p.bw) && p.bw > 0 && Number.isInteger(p.bh) && p.bh > 0, 'bw, bh 는 양의 정수');
  const l = p.lightDirWorld;
  need(Array.isArray(l) && l.length === 3 && l.every(finite) && (l[0] !== 0 || l[1] !== 0 || l[2] !== 0), 'lightDirWorld 는 길이 0 이 아닌 유한 3-벡터');
  need(finite(p.pointSizeM) && p.pointSizeM > 0, 'pointSizeM 은 양의 유한 수');
  const ambient = p.ambient === undefined ? DEFAULT_AMBIENT : p.ambient;
  need(finite(ambient) && ambient >= 0 && ambient <= 1, 'ambient 는 0..1');
  need(finite(p.near) && finite(p.far) && p.near > 0 && p.far > p.near, '0 < near < far');
  need(finite(p.maxPointSize) && p.maxPointSize >= 1, 'maxPointSize ≥ 1');
  return {
    u_Rgl: Rgl, u_tgl: tgl,
    u_fx: K.fx, u_fy: K.fy, u_cx: K.cx, u_cy: K.cy,
    u_bw: p.bw, u_bh: p.bh,
    u_lightDir: [l[0], l[1], l[2]], u_ambient: ambient, u_shade: p.shade === undefined ? true : !!p.shade,
    u_pointSizeM: p.pointSizeM, u_near: p.near, u_far: p.far, u_maxPointSize: p.maxPointSize,
  };
}

/**
 * 조각 원점 o 에 맞춘 u_tgl 값 t'_gl = R_gl·o + t_gl 을 f64 로 계산한다(순수 함수).
 * @param {Record<string, any>} values pointUniformValues 결과
 * @param {number[]} origin 조각 원점 [e, n, u] m
 * @returns {number[]}
 */
export function pieceTglValue(values, origin) {
  return pieceTranslation(values.u_Rgl, values.u_tgl, origin);
}

/**
 * 조각을 그리기 직전에 그 조각 원점의 u_tgl 을 올린다(applyPointUniforms 뒤, 조각마다). 올린 값(f64)을 돌려준다.
 * @param {WebGL2RenderingContext} gl
 * @param {Record<string, WebGLUniformLocation|null>} uniforms
 * @param {Record<string, any>} values pointUniformValues 결과
 * @param {number[]} origin 조각 원점 [e, n, u] m
 */
export function applyPieceOrigin(gl, uniforms, values, origin) {
  const t = pieceTglValue(values, origin);
  const loc = uniforms.u_tgl;
  if (loc !== null && loc !== undefined) gl.uniform3f(loc, t[0], t[1], t[2]);
  return t;
}

/**
 * pointUniformValues 결과를 프로그램에 올린다(gl.useProgram(program) 뒤에 부른다). 없는 위치(null)는 건너뛴다.
 * @param {WebGL2RenderingContext} gl
 * @param {Record<string, WebGLUniformLocation|null>} uniforms createPointProgram 의 uniforms
 * @param {Record<string, number|boolean|number[]>} values
 */
export function applyPointUniforms(gl, uniforms, values) {
  for (const [name, type] of Object.entries(UNIFORMS)) {
    const loc = uniforms[name];
    if (loc === null || loc === undefined) continue;
    const v = values[name];
    if (type === 'mat3') gl.uniformMatrix3fv(loc, true, v); // 행 우선 → transpose
    else if (type === 'vec3') gl.uniform3f(loc, v[0], v[1], v[2]);
    else if (type === 'bool') gl.uniform1i(loc, v ? 1 : 0);
    else gl.uniform1f(loc, v);
  }
}
