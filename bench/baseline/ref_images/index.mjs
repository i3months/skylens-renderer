// 기준 이미지 생성기 (T01.8). T06 이전의 임시 CPU 점 래스터라이저다.
// 순수 점 투영만 한다: 뒷면 제거, 보간, 구멍 메우기 없음 (RULES 1.2).
//
// 카메라 규약 (OpenGL 식):
//   - 좌표계는 ENU, x=동 y=위 z=-북, 1 unit = 1 m.
//   - 카메라는 자기 -z 방향을 본다. 카메라 좌표 X_c = R·X_w + t.
//   - R 의 행: x_c = normalize(up × z_c), y_c = z_c × x_c, z_c = normalize(eye − target).
//     t = −R·eye.  따라서 눈 앞의 점은 X_c.z < 0 이다. 깊이 d = −X_c.z.
//   - 내부 행렬 K: f = (H/2)/tan(fov_y/2), c = (W/2, H/2).
//   - 화면 좌표: u = cx + f·x_c/d, v = cy − f·y_c/d (v 는 아래로 증가).
//   - 픽셀 (i,j) 는 [i,i+1)×[j,j+1) 구간이다. 점은 floor(u), floor(v) 픽셀에 찍힌다.
//     그래서 주 점(cx,cy)은 픽셀 (W/2, H/2) 에 찍힌다 (W, H 짝수).
//   - 점 크기 1 픽셀, z-버퍼로 가장 가까운(d 최소) 점 하나만 남긴다. 같은 깊이면 먼저 온 점이 이긴다.
//
// 입력 점 형식 (27 B, little-endian): x y z f32×3, nx ny nz f32×3, r g b u8×3.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const POINT_BYTES = 27;
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
  const zc = norm(sub(eye, target));
  const xc = norm(cross(up, zc));
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

/** 27 B 점 버퍼를 읽는다. */
export function decodePoints(buf) {
  if (buf.length % POINT_BYTES !== 0) throw new Error(`점 버퍼 길이 ${buf.length} 가 ${POINT_BYTES} 의 배수가 아니다`);
  const count = buf.length / POINT_BYTES;
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    const o = i * POINT_BYTES;
    positions[i * 3] = buf.readFloatLE(o);
    positions[i * 3 + 1] = buf.readFloatLE(o + 4);
    positions[i * 3 + 2] = buf.readFloatLE(o + 8);
    colors[i * 3] = buf[o + 24];
    colors[i * 3 + 1] = buf[o + 25];
    colors[i * 3 + 2] = buf[o + 26];
  }
  return { positions, colors, count };
}

/** 점 목록을 27 B 형식으로 인코딩한다. 점은 {p:[x,y,z], n:[nx,ny,nz], rgb:[r,g,b]}. */
export function encodePoints(points) {
  const buf = Buffer.alloc(points.length * POINT_BYTES);
  points.forEach((q, i) => {
    const o = i * POINT_BYTES;
    q.p.forEach((v, k) => buf.writeFloatLE(v, o + k * 4));
    (q.n ?? [0, 1, 0]).forEach((v, k) => buf.writeFloatLE(v, o + 12 + k * 4));
    q.rgb.forEach((v, k) => (buf[o + 24 + k] = v));
  });
  return buf;
}

/** 시드 고정 합성 점군 (mulberry32). 지면 격자 + 기둥 + 무작위 구름. 결정적이다. */
export function syntheticPoints(seed = 1) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pts = [];
  for (let x = -200; x <= 200; x += 2) {
    for (let z = -200; z <= 200; z += 2) {
      pts.push({ p: [x, 0, z], n: [0, 1, 0], rgb: [90 + ((x + 200) % 100), 120, 90 + ((z + 200) % 100)] });
    }
  }
  for (let k = 0; k < 40; k++) {
    const bx = (rnd() - 0.5) * 300;
    const bz = (rnd() - 0.5) * 300;
    const h = 5 + rnd() * 40;
    for (let y = 0; y < h; y += 0.5) pts.push({ p: [bx, y, bz], n: [1, 0, 0], rgb: [200, 100 + Math.floor(rnd() * 100), 60] });
  }
  for (let k = 0; k < 20000; k++) {
    pts.push({
      p: [(rnd() - 0.5) * 800, rnd() * 300, (rnd() - 0.5) * 800],
      n: [0, 0, 1],
      rgb: [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)],
    });
  }
  return pts;
}

export function encodePPM(rgb, width, height) {
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii'), rgb]);
}

/**
 * 시점 8곳의 PPM(P6)을 outDir 에 쓴다. 파일 이름 viewpoint_<id>_<name>.ppm.
 * pointsPath 가 없으면 합성 점군(시드 1)을 쓴다. skylensDir 은 읽지 않는다.
 */
export async function run({ skylensDir, outDir, commit, pointsPath }) {
  void skylensDir;
  const vps = JSON.parse(await readFile(VIEWPOINTS_PATH, 'utf8')).viewpoints;
  const pts = pointsPath ? decodePoints(await readFile(pointsPath)) : decodePoints(encodePoints(syntheticPoints(1)));
  await mkdir(outDir, { recursive: true });
  const device = 'cpu-node-point-raster';
  const method = pointsPath ? 'ref_images: 27B 점 파일, 순수 점 투영 z-버퍼' : 'ref_images: 합성 점군(seed=1), 순수 점 투영 z-버퍼';
  const records = [];
  for (const vp of vps) {
    const r = rasterize(pts, vp);
    await writeFile(join(outDir, `viewpoint_${vp.id}_${vp.name}.ppm`), encodePPM(r.rgb, r.width, r.height));
    records.push({ metric: `ref_images.drawn_pixels.v${vp.id}`, value: r.drawn, unit: 'count', device, method, commit });
    records.push({ metric: `ref_images.coverage.v${vp.id}`, value: r.drawn / (r.width * r.height), unit: 'ratio', device, method, commit });
  }
  return records;
}
