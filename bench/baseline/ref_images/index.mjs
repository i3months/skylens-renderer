// 기준 이미지 생성기 (T01.8). T06 이전의 임시 CPU 점 래스터라이저다.
// 순수 점 투영만 한다: 뒷면 제거, 보간, 구멍 메우기 없음 (RULES 1.2).
// 입력은 원본 점군 PLY(inputs.pointsPath)가 필수다. 없으면 throw 하며 합성 점군으로 대체하지 않는다.
//
// 좌표 규약:
//   - 씬 좌표: x=동, y=위, z=-북, 1 unit = 1 m (로컬 ENU 에서 변환한 값. ENU 자체가 아니다).
//     원점의 GeoAnchor {lat,lon,alt} 는 viewpoints.json 의 anchor 이고 inputs.anchor 와 같아야 한다.
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
//   - 점 크기 1 픽셀, z-버퍼로 가장 가까운(d 최소) 점 하나만 남긴다. 같은 깊이면 먼저 온 점이 이긴다.
//
// 입력 점 형식: binary_little_endian PLY. 헤더는 contracts/ply 의 parsePlyHeader 로 읽는다.
//   - 56 B 3DGS 스플랫(x y z f_dc_0..2 opacity scale_0..2 rot_0..3, float32×14): 중심 x y z 와
//     f_dc 색(rgb = clamp(0.5 + 0.28209479·f_dc, 0, 1)·255)만 쓴다. opacity·scale·rot 는 쓰지 않는다.
//   - x y z float32 + red green blue uchar 인 일반 점군도 읽는다.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlyHeader } from '../../../contracts/ply/index.mjs';
import { requireInput } from '../../../contracts/inputs/index.mjs';

export const SH_C0 = 0.28209479177387814;
export const BACKGROUND = [0, 0, 0]; // 배경 고정색 (검정)

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

/** 해상도와 fov_y(도) 에서 K 의 성분을 만든다. */
export function intrinsics({ width, height, fov_y_deg }) {
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
    if (px < 0 || px >= W || py < 0 || py >= H) continue;
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

const TYPE_READ = { float: 'readFloatLE', float32: 'readFloatLE', double: 'readDoubleLE', float64: 'readDoubleLE' };

/**
 * binary_little_endian PLY 를 읽어 {positions, colors, count, layout} 로 돌려준다.
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
  const count = h.vertexCount;
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  const clamp8 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  for (let i = 0; i < count; i++) {
    const rec = h.headerBytes + i * h.stride;
    positions[i * 3] = f(rec, 'x');
    positions[i * 3 + 1] = f(rec, 'y');
    positions[i * 3 + 2] = f(rec, 'z');
    if (layout === 'splat-f_dc') {
      for (let c = 0; c < 3; c++) colors[i * 3 + c] = clamp8(0.5 + SH_C0 * f(rec, `f_dc_${c}`));
    } else {
      colors[i * 3] = buf[rec + off.red.at];
      colors[i * 3 + 1] = buf[rec + off.green.at];
      colors[i * 3 + 2] = buf[rec + off.blue.at];
    }
  }
  return { positions, colors, count, layout, stride: h.stride };
}

export function encodePPM(rgb, width, height) {
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii'), rgb]);
}

const sameNum = (a, b) => typeof a === 'number' && typeof b === 'number' && a === b;

/** viewpoints.json 을 읽고 coord·anchor 를 검증한다. anchor 가 inputs.anchor 와 다르면 throw. */
export function loadViewpoints(json, anchor, name = 'viewpoints.json') {
  if (typeof json.coord !== 'string' || !/^scene\b/.test(json.coord)) throw new Error(`${name}: coord 는 "scene (x=east, y=up, z=-north) ..." 로 시작해야 한다 (현재 ${JSON.stringify(json.coord)})`);
  const a = json.anchor;
  if (!a || !['lat', 'lon', 'alt'].every((k) => Number.isFinite(a[k]))) throw new Error(`${name}: anchor {lat,lon,alt} 가 없거나 숫자가 아니다`);
  for (const k of ['lat', 'lon', 'alt']) {
    if (!sameNum(a[k], anchor[k])) throw new Error(`${name}: anchor.${k}=${a[k]} 가 inputs.anchor.${k}=${anchor[k]} 와 다르다`);
  }
  if (!Array.isArray(json.viewpoints) || json.viewpoints.length === 0) throw new Error(`${name}: viewpoints 가 비어 있다`);
  return json.viewpoints;
}

/**
 * 시점마다 PPM(P6)을 outDir 에 쓴다. 파일 이름 viewpoint_<id>_<name>.ppm.
 * inputs.pointsPath(PLY)와 inputs.anchor 가 필수다. 없으면 throw (합성 대체 없음).
 * 어느 시점이든 drawn == 0 이거나 카메라가 퇴화면 throw 한다.
 * viewpointsPath 는 테스트용 덮어쓰기이고 기본은 fixtures/viewpoints/viewpoints.json.
 */
export async function run({ skylensDir, outDir, commit, inputs, viewpointsPath = VIEWPOINTS_PATH }) {
  void skylensDir;
  const pointsPath = requireInput(inputs, 'pointsPath');
  const anchor = requireInput(inputs, 'anchor');
  const vps = loadViewpoints(JSON.parse(await readFile(viewpointsPath, 'utf8')), anchor, viewpointsPath);
  const bytes = await readFile(pointsPath);
  const pts = decodePly(bytes, pointsPath);
  await mkdir(outDir, { recursive: true });
  const device = 'cpu-node-point-raster';
  const method = pts.layout === 'splat-f_dc'
    ? `ref_images: PLY ${pts.stride}B 스플랫 ${pts.count}점, 중심 x y z·f_dc 색(0.5+0.28209479·f_dc) 사용(opacity·scale·rot 무시), 순수 점 투영 z-버퍼`
    : `ref_images: PLY ${pts.stride}B 점 ${pts.count}개, x y z·uchar rgb, 순수 점 투영 z-버퍼`;
  const records = [];
  for (const vp of vps) {
    const r = rasterize(pts, vp);
    if (!(r.drawn > 0)) throw new Error(`시점 ${vp.id} ${vp.name}: 찍힌 픽셀이 0 이다 (점군과 시점이 맞지 않음)`);
    await writeFile(join(outDir, `viewpoint_${vp.id}_${vp.name}.ppm`), encodePPM(r.rgb, r.width, r.height));
    records.push({ metric: `ref_images.drawn_pixels.v${vp.id}`, value: r.drawn, unit: 'count', device, method, commit });
    records.push({ metric: `ref_images.coverage.v${vp.id}`, value: r.drawn / (r.width * r.height), unit: 'ratio', device, method, commit });
  }
  return records;
}
