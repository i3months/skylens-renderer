// 기준 이미지 생성기. 렌더러 구현 이전의 임시 CPU 점 래스터라이저다.
// 순수 점 투영만 한다: 뒷면 제거, 보간, 구멍 메우기 없음 (RULES 1.2).
// 입력은 원본 점군 PLY(inputs.pointsPath)가 필수다. 없으면 throw 하며 합성 점군으로 대체하지 않는다.
//
// 좌표 규약:
//   - 씬 좌표: x, y=위, z 의 오른손 좌표. 앱(skylens develop sceneSource.ts deriveFromSplat)이 스플랫을 그리는
//     정규화 틀이다: world = s·(R·raw) + P. 원점은 틀 PLY 의 5~95 % 분위 상자의 XZ 중심과 그 상자의 바닥(y=0)이며,
//     GeoAnchor 의 ENU 원점이 아니다. 축 방향도 동/북에 맞췄다는 보장이 없다(PLY 원좌표 축을 회전 R 만 해서 쓴다).
//   - 단위: PLY 원좌표 1 unit 이 축척 s 적용 전의 단위다. 씬 좌표 1 unit 은 원좌표 1/s unit 이며 1 m 가 아니다
//     (segments.json metersPerUnit 는 원좌표 기준 값이라 씬 좌표에 그대로 쓰면 안 된다).
//   - anchor 는 운영자 선언값이다. 두 선언(viewpoints.json, inputs.anchor)끼리만 대조하며 점군 파일은 대조하지 않는다.
//     PLY 헤더·스플랫 레코드에는 앵커가 없고 이 모듈은 앵커로 좌표를 옮기지 않는다.
//   - 점군 틀(sceneFrame): 앱과 같이 틀 PLY(framePly, 기본 res/static/demo/step00250_light.ply = CONFIG.splat.demoPreview)
//     한 파일에서 s·P·clip 을 한 번 구하고, 그려야 할 점군(구간 PLY 등)에는 같은 변환을 적용만 한다.
//     틀 계산: 표본 stride = max(1, floor(total/sampleTarget)), 회전 R(none | x180), 표본의 lo~hi 분위 상자,
//     s = targetExtent / 최대 변, P = (−s·cx, −s·lo_y, −s·cz), 상자 ± clipMargin·최대 변(회전 후, 축척 전) 밖 점은 버린다.
//     자체 촬영(demoPreview 와 그 구간 PLY)은 rotate=none, 인터넷 샘플만 x180 이다(sceneSource.ts:342-356).
//   - 이 파일의 카메라는 OpenGL 식(GL)이다: 카메라는 자기 -z 를 보고 +y 가 위이며, 눈 앞 점은 X_c.z < 0, 깊이 d = −X_c.z.
//     renderer_basis §2 의 OpenCV 식은 +z 가 시선, +y 가 아래, d = X_c.z 이다.
//     두 규약은 X_cv = diag(1,−1,−1)·X_gl 로 변환된다 (y, z 부호 반전). 식 이름이 같아도 부호가 다르니 섞지 말 것.
//   - 카메라 좌표 X_c = R·X_w + t.
//     R 의 행: x_c = normalize(up × z_c), y_c = z_c × x_c, z_c = normalize(eye − target). t = −R·eye.
//   - 내부 행렬 K: f = (H/2)/tan(fov_y/2), c = (W/2, H/2).
//   - 화면 좌표(GL): u = cx + f·x_c/d, v = cy − f·y_c/d (v 는 아래로 증가).
//     OpenCV 로 쓰면 X_cv = diag(1,−1,−1)·X_c 이므로 u = cx + f·X_cv.x/X_cv.z, v = cy + f·X_cv.y/X_cv.z 로 같은 결과다.
//   - 픽셀 (i,j) 는 [i,i+1)×[j,j+1) 구간이다. 점은 floor(u), floor(v) 픽셀에 찍힌다.
//     그래서 주 점(cx,cy)은 픽셀 (W/2, H/2) 에 찍힌다 (W, H 짝수).
//   - 점 크기 1 픽셀, z-버퍼로 가장 가까운(d 최소) 점 하나만 남긴다. 같은 깊이면 먼저 온 점이 이긴다(엄격한 <).
//
// 입력 점 형식: binary_little_endian PLY. 헤더는 contracts/ply 의 parsePlyHeader 로 읽는다.
//   - 3DGS 스플랫(x y z f_dc_0..2 ... float32): 중심 x y z 와
//     f_dc 색(rgb = clamp(0.5 + 0.28209479·f_dc, 0, 1)·255)만 쓴다. opacity·scale·rot 는 쓰지 않는다.
//   - x y z float32 + red green blue uchar 인 일반 점군도 읽는다.
//   - 비유한(NaN·±Inf) 좌표나 f_dc 를 가진 레코드는 그리는 점군에서 제외하고 그 수를 method 와
//     ref_images.nonfinite_excluded 지표로 보고한다. 틀 PLY 에 비유한 값이 있으면 앱과 같은 표본을 만들 수 없으므로 throw.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlyHeader } from '../../../contracts/ply/index.mjs';
import { requireInput } from '../../../contracts/inputs/index.mjs';

export const SH_C0 = 0.28209479177387814;
export const BACKGROUND = [0, 0, 0]; // 배경 고정색 (검정)
export const MIN_COVERAGE = 0.05; // 시점별 최소 점유율(찍힌 픽셀/전체). 고정값이며 입력으로 바꿀 수 없다.
export const ROTATIONS = { none: [1, 0, 0, 0, 1, 0, 0, 0, 1], x180: [1, 0, 0, 0, -1, 0, 0, 0, -1] }; // 행 우선 3x3

const here = dirname(fileURLToPath(import.meta.url));
const VIEWPOINTS_PATH = join(here, '../../../fixtures/viewpoints/viewpoints.json');

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** 시점에서 R(행 우선 3x3, 길이 9)과 t(길이 3)를 만든다. */
export function cameraExtrinsics({ eye, target, up }) {
  for (const v of [eye, target, up]) {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) throw new Error('카메라: eye/target/up 은 유한한 3-벡터여야 한다');
  }
  const ze = sub(eye, target);
  if (Math.hypot(...ze) < 1e-9) throw new Error('퇴화 카메라: eye 와 target 이 같다');
  const zc = norm(ze);
  const xr = cross(up, zc);
  if (Math.hypot(...up) < 1e-9 || Math.hypot(...xr) < 1e-6 * Math.hypot(...up)) throw new Error('퇴화 카메라: up 이 시선과 평행하다');
  const xc = norm(xr);
  const yc = cross(zc, xc);
  const R = [...xc, ...yc, ...zc];
  const t = [
    -(xc[0] * eye[0] + xc[1] * eye[1] + xc[2] * eye[2]),
    -(yc[0] * eye[0] + yc[1] * eye[1] + yc[2] * eye[2]),
    -(zc[0] * eye[0] + zc[1] * eye[1] + zc[2] * eye[2]),
  ];
  return { R, t };
}

/** width/height 는 양의 정수, fov_y_deg 는 0 < fov < 180 인 유한 수여야 한다. */
export function assertView({ width, height, fov_y_deg }) {
  if (!Number.isInteger(width) || width <= 0) throw new Error(`해상도: width 는 양의 정수여야 한다 (현재 ${width})`);
  if (!Number.isInteger(height) || height <= 0) throw new Error(`해상도: height 는 양의 정수여야 한다 (현재 ${height})`);
  if (typeof fov_y_deg !== 'number' || !Number.isFinite(fov_y_deg) || !(fov_y_deg > 0 && fov_y_deg < 180)) {
    throw new Error(`fov_y_deg 는 0 초과 180 미만의 유한 수여야 한다 (현재 ${fov_y_deg})`);
  }
}

/** 해상도와 fov_y(도) 에서 K 의 성분을 만든다. */
export function intrinsics({ width, height, fov_y_deg }) {
  assertView({ width, height, fov_y_deg });
  const f = height / 2 / Math.tan((fov_y_deg * Math.PI) / 360);
  return { f, cx: width / 2, cy: height / 2 };
}

/** X_c = R·X_w + t. */
export function worldToCamera(R, t, p) {
  return [
    R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0],
    R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1],
    R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2],
  ];
}

/** 역투영 X_w = Rᵀ(X_c − t). */
export function cameraToWorld(R, t, c) {
  const d = [c[0] - t[0], c[1] - t[1], c[2] - t[2]];
  return [
    R[0] * d[0] + R[3] * d[1] + R[6] * d[2],
    R[1] * d[0] + R[4] * d[1] + R[7] * d[2],
    R[2] * d[0] + R[5] * d[1] + R[8] * d[2],
  ];
}

/** 카메라 좌표 점을 연속 화면 좌표 {u,v,depth} 로 투영한다. 눈 뒤(−z 가 아님)면 null. */
export function projectCamera(K, c) {
  const d = -c[2];
  if (!(d > 0)) return null;
  return { u: K.cx + (K.f * c[0]) / d, v: K.cy - (K.f * c[1]) / d, depth: d };
}

/** 디코드된 점({positions, colors, count})을 래스터화해 RGB 버퍼를 돌려준다. */
export function rasterize({ positions, colors, count }, view) {
  assertView(view);
  const { width: W, height: H } = view;
  const { R, t } = cameraExtrinsics(view);
  const K = intrinsics(view);
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) rgb.set(BACKGROUND, i * 3);
  const zbuf = new Float64Array(W * H).fill(Infinity);
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    const c = worldToCamera(R, t, [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
    const s = projectCamera(K, c);
    if (!s) continue;
    const px = Math.floor(s.u);
    const py = Math.floor(s.v);
    if (!(px >= 0 && px < W && py >= 0 && py < H)) continue;
    const idx = py * W + px;
    if (s.depth < zbuf[idx]) {
      if (zbuf[idx] === Infinity) drawn++;
      zbuf[idx] = s.depth;
      rgb[idx * 3] = colors[i * 3];
      rgb[idx * 3 + 1] = colors[i * 3 + 1];
      rgb[idx * 3 + 2] = colors[i * 3 + 2];
    }
  }
  return { rgb, drawn, width: W, height: H };
}

/** 오름차순 배열의 분위. sceneSource.ts pct 와 같은 반올림 색인. */
const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];

/** sceneFrame 형식 검사. */
export function assertSceneFrame(f, name = 'viewpoints.json') {
  const bad = (m) => { throw new Error(`${name}: sceneFrame ${m}`); };
  if (!f || typeof f !== 'object') bad('가 없다 (점군 틀을 명시해야 한다)');
  if (!Object.hasOwn(ROTATIONS, f.rotate)) bad(`.rotate 는 "none" 또는 "x180" 이어야 한다 (현재 ${JSON.stringify(f.rotate)})`);
  if (!(Number.isFinite(f.targetExtent) && f.targetExtent > 0)) bad('.targetExtent 는 양수여야 한다');
  if (!(Number.isFinite(f.percentileLo) && Number.isFinite(f.percentileHi) && f.percentileLo >= 0 && f.percentileLo < f.percentileHi && f.percentileHi <= 1)) bad('.percentileLo/.percentileHi 는 0 ≤ lo < hi ≤ 1 이어야 한다');
  if (!(Number.isFinite(f.clipMargin) && f.clipMargin >= 0)) bad('.clipMargin 은 0 이상이어야 한다');
  if (!(Number.isInteger(f.sampleTarget) && f.sampleTarget > 0)) bad('.sampleTarget 은 양의 정수여야 한다');
  if (typeof f.framePly !== 'string' || !f.framePly.endsWith('.ply') || f.framePly.startsWith('/')) bad('.framePly 는 skylens 트리 기준 상대 .ply 경로여야 한다');
}

const rot = (R, x, y, z) => [R[0] * x + R[1] * y + R[2] * z, R[3] * x + R[4] * y + R[5] * z, R[6] * x + R[7] * y + R[8] * z];

/**
 * 틀 PLY 에서 앱과 같은 방법으로 틀 변환을 구한다(sceneSource.ts:335-391).
 * 돌려주는 값: {rotate, R, s, P:[3], rMin, rMax, clipMin, clipMax, sampleStride, sampleCount, total}.
 * 비유한 좌표가 있으면 throw (앱 표본과 같아질 수 없다).
 */
export function computeSceneFrame({ positions, count, nonFinite = 0 }, frame, name = 'sceneFrame') {
  assertSceneFrame(frame, name);
  if (nonFinite > 0) throw new Error(`${name}: 틀 PLY 에 비유한 레코드 ${nonFinite}개가 있다 (앱과 같은 표본을 만들 수 없다)`);
  if (!(count > 0)) throw new Error(`${name}: 점이 없다`);
  for (let i = 0; i < count * 3; i++) if (!Number.isFinite(positions[i])) throw new Error(`${name}: 틀 PLY 에 비유한 좌표가 있다 (점 ${Math.floor(i / 3)})`);
  const R = ROTATIONS[frame.rotate];
  const sampleStride = Math.max(1, Math.floor(count / frame.sampleTarget));
  const xs = [];
  const ys = [];
  const zs = [];
  for (let i = 0; i < count; i += sampleStride) {
    const v = rot(R, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    xs.push(v[0]);
    ys.push(v[1]);
    zs.push(v[2]);
  }
  for (const a of [xs, ys, zs]) a.sort((p, q) => p - q);
  const rMin = [pct(xs, frame.percentileLo), pct(ys, frame.percentileLo), pct(zs, frame.percentileLo)];
  const rMax = [pct(xs, frame.percentileHi), pct(ys, frame.percentileHi), pct(zs, frame.percentileHi)];
  const maxDim = Math.max(rMax[0] - rMin[0], rMax[1] - rMin[1], rMax[2] - rMin[2]);
  if (!(maxDim > 0)) throw new Error(`${name}: 분위 상자의 크기가 0 이다`);
  const s = frame.targetExtent / maxDim;
  const P = [-s * ((rMin[0] + rMax[0]) * 0.5), -s * rMin[1], -s * ((rMin[2] + rMax[2]) * 0.5)];
  const margin = maxDim * frame.clipMargin;
  return {
    rotate: frame.rotate, R, s, P, rMin, rMax,
    clipMin: rMin.map((v) => v - margin), clipMax: rMax.map((v) => v + margin),
    sampleStride, sampleCount: xs.length, total: count,
  };
}

/**
 * 구한 틀 변환을 점군에 적용만 한다: 회전 → clip 상자 밖(또는 비유한) 제거 → world = s·v + P.
 * 새 {positions, colors, count, clipped} 를 돌려주고 입력은 바꾸지 않는다.
 */
export function applyFrameTransform({ positions, colors, count }, fr) {
  const outP = new Float32Array(count * 3);
  const outC = new Uint8Array(count * 3);
  let j = 0;
  for (let i = 0; i < count; i++) {
    const v = rot(fr.R, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    let inside = true;
    for (let k = 0; k < 3; k++) if (!(v[k] >= fr.clipMin[k] && v[k] <= fr.clipMax[k])) inside = false;
    if (!inside) continue;
    for (let k = 0; k < 3; k++) {
      outP[j * 3 + k] = fr.s * v[k] + fr.P[k];
      outC[j * 3 + k] = colors[i * 3 + k];
    }
    j++;
  }
  return { positions: outP.slice(0, j * 3), colors: outC.slice(0, j * 3), count: j, clipped: count - j };
}

/** 같은 점군에서 틀을 구하고 바로 적용한다(틀 PLY 와 그릴 점군이 같은 경우). */
export function applySceneFrame(points, frame, name = 'sceneFrame') {
  return applyFrameTransform(points, computeSceneFrame(points, frame, name));
}

/** 점유율 = drawn/(W·H) 이 MIN_COVERAGE 보다 낮으면 throw. 경계값(정확히 5 %)은 통과한다. */
export function assertCoverage(vp, drawn) {
  const cov = drawn / (vp.width * vp.height);
  if (cov < MIN_COVERAGE) throw new Error(`시점 ${vp.id} ${vp.name}: 점유율 ${(cov * 100).toFixed(3)} % 가 최소 ${MIN_COVERAGE * 100} % 보다 낮다`);
  return cov;
}

const TYPE_READ = { float: 'readFloatLE', float32: 'readFloatLE', double: 'readDoubleLE', float64: 'readDoubleLE' };

/**
 * binary_little_endian PLY 를 읽어 {positions, colors, count, layout, stride, nonFinite, rawCount} 로 돌려준다.
 * 좌표·f_dc 중 하나라도 비유한인 레코드는 제외하고 nonFinite 에 센다(색을 조용히 바꾸지 않는다).
 * name 은 오류 메시지용 파일 이름. 헤더가 모자라거나 크기가 어긋나면 파일 이름을 넣어 throw 한다.
 */
export function decodePly(buf, name = '<buffer>') {
  let h;
  try {
    h = parsePlyHeader(buf);
  } catch (e) {
    throw new Error(`${name}: ${e.message}`);
  }
  const expect = h.headerBytes + h.stride * h.vertexCount;
  if (buf.length !== expect) throw new Error(`${name}: 크기 ${buf.length} B 가 헤더 ${h.headerBytes} + ${h.stride}×${h.vertexCount} = ${expect} B 와 다르다`);
  const off = {};
  let o = 0;
  const SIZE = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
  for (const p of h.properties) {
    off[p.name] = { at: o, type: p.type };
    o += SIZE[p.type];
  }
  for (const k of ['x', 'y', 'z']) {
    if (!off[k] || !TYPE_READ[off[k].type]) throw new Error(`${name}: 헤더에 float 속성 ${k} 가 없다`);
  }
  const f = (rec, k) => buf[TYPE_READ[off[k].type]](rec + off[k].at);
  let layout;
  if (off.f_dc_0 && off.f_dc_1 && off.f_dc_2) {
    for (const k of ['f_dc_0', 'f_dc_1', 'f_dc_2']) if (!TYPE_READ[off[k].type]) throw new Error(`${name}: ${k} 가 float 이 아니다`);
    layout = 'splat-f_dc';
  } else if (off.red && off.green && off.blue && [off.red, off.green, off.blue].every((q) => q.type === 'uchar' || q.type === 'uint8')) {
    layout = 'rgb-u8';
  } else {
    throw new Error(`${name}: 색 속성(f_dc_0..2 또는 uchar red green blue)이 없다`);
  }
  const rawCount = h.vertexCount;
  const positions = new Float32Array(rawCount * 3);
  const colors = new Uint8Array(rawCount * 3);
  const clamp8 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  let j = 0;
  let nonFinite = 0;
  for (let i = 0; i < rawCount; i++) {
    const rec = h.headerBytes + i * h.stride;
    const p = [f(rec, 'x'), f(rec, 'y'), f(rec, 'z')];
    const dc = layout === 'splat-f_dc' ? [f(rec, 'f_dc_0'), f(rec, 'f_dc_1'), f(rec, 'f_dc_2')] : null;
    if (!p.every(Number.isFinite) || (dc && !dc.every(Number.isFinite))) {
      nonFinite++;
      continue;
    }
    positions.set(p, j * 3);
    if (dc) {
      for (let c = 0; c < 3; c++) colors[j * 3 + c] = clamp8(0.5 + SH_C0 * dc[c]);
    } else {
      colors[j * 3] = buf[rec + off.red.at];
      colors[j * 3 + 1] = buf[rec + off.green.at];
      colors[j * 3 + 2] = buf[rec + off.blue.at];
    }
    j++;
  }
  return {
    positions: nonFinite ? positions.slice(0, j * 3) : positions,
    colors: nonFinite ? colors.slice(0, j * 3) : colors,
    count: j, rawCount, nonFinite, layout, stride: h.stride,
  };
}

export function encodePPM(rgb, width, height) {
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii'), rgb]);
}

const sameNum = (a, b) => typeof a === 'number' && typeof b === 'number' && a === b;

/**
 * viewpoints.json 을 읽고 coord·anchor·sceneFrame 과 시점마다 해상도·fov 를 검증한다.
 * anchor 가 inputs.anchor 와 다르면 throw. (두 값은 모두 사람이 선언한 값이며 점군과는 대조하지 않는다.)
 * 검증을 통과하면 {viewpoints, sceneFrame} 을 돌려준다.
 */
export function loadViewpoints(json, anchor, name = 'viewpoints.json') {
  if (typeof json.coord !== 'string' || !/^scene\b/.test(json.coord)) throw new Error(`${name}: coord 는 "scene ..." 로 시작해야 한다 (현재 ${JSON.stringify(json.coord)})`);
  const a = json.anchor;
  if (!a || !['lat', 'lon', 'alt'].every((k) => Number.isFinite(a[k]))) throw new Error(`${name}: anchor {lat,lon,alt} 가 없거나 숫자가 아니다`);
  for (const k of ['lat', 'lon', 'alt']) {
    if (!sameNum(a[k], anchor[k])) throw new Error(`${name}: anchor.${k}=${a[k]} 가 inputs.anchor.${k}=${anchor[k]} 와 다르다 (두 선언값끼리의 대조이며 점군은 보지 않는다)`);
  }
  assertSceneFrame(json.sceneFrame, name);
  if (!Array.isArray(json.viewpoints) || json.viewpoints.length === 0) throw new Error(`${name}: viewpoints 가 비어 있다`);
  for (const vp of json.viewpoints) {
    try {
      assertView(vp);
    } catch (e) {
      throw new Error(`${name}: 시점 ${vp.id} ${vp.name}: ${e.message}`);
    }
  }
  return { viewpoints: json.viewpoints, sceneFrame: json.sceneFrame };
}

const fmt = (v) => Number(v.toPrecision(10));

/**
 * 시점마다 PPM(P6)을 outDir 에 쓴다. 파일 이름 viewpoint_<id>_<name>.ppm.
 * inputs.pointsPath(PLY)와 inputs.anchor 가 필수다. 없으면 throw (합성 대체 없음).
 * 틀은 <skylensDir>/<sceneFrame.framePly> 에서 구한다. 없으면 throw.
 * 어느 시점이든 drawn == 0, 점유율 < MIN_COVERAGE, 카메라 퇴화, fov·해상도 부적합이면 throw 한다(파일은 쓰기 전에 모두 검사).
 * viewpointsPath 는 테스트용 덮어쓰기이고 기본은 fixtures/viewpoints/viewpoints.json.
 */
export async function run({ skylensDir, outDir, commit, inputs, viewpointsPath = VIEWPOINTS_PATH }) {
  const pointsPath = requireInput(inputs, 'pointsPath');
  const anchor = requireInput(inputs, 'anchor');
  const { viewpoints: vps, sceneFrame } = loadViewpoints(JSON.parse(await readFile(viewpointsPath, 'utf8')), anchor, viewpointsPath);
  if (typeof skylensDir !== 'string' || skylensDir === '') throw new Error('ref_images: skylensDir 가 없다 (틀 PLY 를 찾을 수 없다)');
  const framePath = join(skylensDir, sceneFrame.framePly);
  const fr = computeSceneFrame(decodePly(await readFile(framePath), framePath), sceneFrame, framePath);
  const raw = decodePly(await readFile(pointsPath), pointsPath);
  const pts = applyFrameTransform(raw, fr);
  const device = 'cpu-node-point-raster';
  const frameNote = `앱 틀 적용(틀 PLY ${sceneFrame.framePly} ${fr.total}점·표본 stride ${fr.sampleStride}, rotate ${fr.rotate}, `
    + `${sceneFrame.percentileLo}~${sceneFrame.percentileHi} 분위 상자 최대 변=${sceneFrame.targetExtent}, `
    + `s=${fmt(fr.s)} P=[${fr.P.map(fmt).join(',')}], 여유 ${sceneFrame.clipMargin} 밖 ${pts.clipped}점 제거, `
    + `비유한 ${raw.nonFinite}점 제외; ${pts.count}/${raw.rawCount}점 사용)`;
  const method = raw.layout === 'splat-f_dc'
    ? `ref_images: PLY ${raw.stride}B 스플랫 ${raw.rawCount}점, 중심 x y z·f_dc 색(0.5+0.28209479·f_dc) 사용(opacity·scale·rot 무시), 순수 점 투영 z-버퍼, ${frameNote}`
    : `ref_images: PLY ${raw.stride}B 점 ${raw.rawCount}개, x y z·uchar rgb, 순수 점 투영 z-버퍼, ${frameNote}`;
  const records = [];
  const rasters = [];
  for (const vp of vps) {
    const r = rasterize(pts, vp);
    if (!(r.drawn > 0)) throw new Error(`시점 ${vp.id} ${vp.name}: 찍힌 픽셀이 0 이다 (점군과 시점이 맞지 않음)`);
    assertCoverage(vp, r.drawn);
    rasters.push([vp, r]);
  }
  await mkdir(outDir, { recursive: true });
  records.push({ metric: 'ref_images.nonfinite_excluded', value: raw.nonFinite, unit: 'count', device, method, commit });
  for (const [vp, r] of rasters) {
    await writeFile(join(outDir, `viewpoint_${vp.id}_${vp.name}.ppm`), encodePPM(r.rgb, r.width, r.height));
    records.push({ metric: `ref_images.drawn_pixels.v${vp.id}`, value: r.drawn, unit: 'count', device, method, commit });
    records.push({ metric: `ref_images.coverage.v${vp.id}`, value: r.drawn / (r.width * r.height), unit: 'ratio', device, method, commit });
  }
  return records;
}
