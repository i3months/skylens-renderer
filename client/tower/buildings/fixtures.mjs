// 관제탑 건물 층 시험용 합성 번들·카메라(T15.3.6). 시험 전용이며 제품 코드가 가져오지 않는다.
// 좌표: GeoAnchor 기준 ENU(x 동, y 북, z 위), 1 unit = 1 m. 카메라는 contracts/raster 규약(X_c = R·X_w + t, OpenCV 축).
// 번들은 서버 가공 함수(server/buildings/extrude·lod·black·aerial_uv·points)를 그대로 거쳐 만든다(시험·픽스처라 server/ 허용).
//
// 서명:
//   makeBundle(seed, { count=6, image=true, uv='server', lodDistM=100 }={}) -> BuildingBundle
//     3×3 필지(간격 26 m, 중심 0) 중 count 개(1..9)를 시드로 골라 직사각형(임의 회전) 또는 L 자 건물을 세운다.
//     층 수 1..6 또는 null(높이 6 m). id = 1000 + 필지 번호. 묶음은 buildBuildingLod(…, lodDistM) 결과(가까우면 한 동 한 묶음).
//     image 가 false 면 bundle.image = null(aerial 은 전부 검정 면).
//   bundleFromFootprints(footprints, { image=makeAerialImage(), uv='server', lodDistM=100 }={}) -> BuildingBundle
//     손 계산 시험용(상자 하나 등). image 에 null 을 주면 영상 없음.
//   makeAerialImage({ width=96, height=96, bounds=AERIAL_BOUNDS }={}) -> { width, height, rgb, bounds }
//     행 0 = 북. 화소 (col,row) 의 지상 좌표 x = minX + (col+0.5)·Δx/W, y = maxY − (row+0.5)·Δy/H.
//     r = 동쪽으로 선형 증가, g = 북쪽으로 선형 증가, b = 두 방향 사인 무늬(대칭이 없어 uv 뒤집기가 드러난다).
//   makeCameras({ width=80, height=45 }={}) -> Camera[3]  각 항목에 name: 'top' | 'oblique' | 'eye17'.
//     top: 눈 (0,0,120) 에서 수직으로 내려다봄(화면 위 = 북). oblique: 눈 (−60,−80,60) → (0,0,0).
//     eye17: 눈 (0,−70,17) → (0,0,8)(눈높이 17 m). 수평 화각 60°, 주점 = 화면 중심.
//
// uv 규약: 계약은 서버 aerial_uv 와 같다(v = 0 이 북). uv='server'(기본)면 서버 출력 그대로,
//   uv='flipped' 면 v 를 1 − v 로 뒤집어(flipV) 넣는다(뒤집기 변이 시험용).

import { extrudeBuilding } from '../../../server/buildings/extrude/index.mjs';
import { buildBuildingLod } from '../../../server/buildings/lod/index.mjs';
import { buildBlackBuilding } from '../../../server/buildings/black/index.mjs';
import { buildAerialUv } from '../../../server/buildings/aerial_uv/index.mjs';
import { sampleBuildingPoints } from '../../../server/buildings/points/index.mjs';
import { assertCamera } from '../../../contracts/raster/index.mjs';

/** 합성 항공영상 범위(ENU m). 필지 배치 전체(±39 m)를 덮는다. */
export const AERIAL_BOUNDS = Object.freeze({ minX: -48, minY: -48, maxX: 48, maxY: 48 });
/** 필지 간격(m)과 필지 한 변 절반 안쪽 여유. 건물은 필지 중심에서 반경 13 m 안에 들어간다. */
export const PARCEL_PITCH_M = 26;
export const MAX_COUNT = 9;

/** 직접 작성한 32비트 결정적 난수(0 이상 1 미만). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** v 를 1 − v 로 뒤집는다(뒤집기 변이 시험용; 계약 규약은 서버와 같은 v = 0 이 북). 새 배열을 돌려준다. */
export function flipV(uv) {
  const out = new Float32Array(uv.length);
  for (let i = 0; i < uv.length; i += 2) { out[i] = uv[i]; out[i + 1] = 1 - uv[i + 1]; }
  return out;
}

export function makeAerialImage({ width = 96, height = 96, bounds = AERIAL_BOUNDS } = {}) {
  const rgb = new Uint8Array(width * height * 3);
  const dx = bounds.maxX - bounds.minX, dy = bounds.maxY - bounds.minY;
  for (let row = 0; row < height; row++) {
    const fy = (row + 0.5) / height; // 0 = 북쪽 끝
    for (let col = 0; col < width; col++) {
      const fx = (col + 0.5) / width; // 0 = 서쪽 끝
      const o = 3 * (row * width + col);
      rgb[o] = Math.round(20 + 210 * fx);
      rgb[o + 1] = Math.round(20 + 210 * (1 - fy));
      rgb[o + 2] = Math.round(128 + 100 * Math.sin((fx * dx) / 7 + 0.3) * Math.cos((fy * dy) / 11 + 1.1));
    }
  }
  return { width, height, rgb, bounds: { ...bounds } };
}

function rotRing(ring, cx, cy, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return ring.map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}

/** 시드로 외곽 목록을 만든다(Footprint[], contracts/tower_assets). */
export function makeFootprints(seed, count = 6) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) throw new RangeError(`fixtures: count 는 1..${MAX_COUNT}: ${String(count)}`);
  const rnd = mulberry32(seed);
  const order = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  for (let i = order.length - 1; i > 0; i--) { // 피셔–예이츠
    const j = Math.floor(rnd() * (i + 1));
    const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
  }
  const picked = order.slice(0, count).sort((a, b) => a - b);
  return picked.map((parcel) => {
    const cx = ((parcel % 3) - 1) * PARCEL_PITCH_M, cy = (Math.floor(parcel / 3) - 1) * PARCEL_PITCH_M;
    const ang = rnd() * (Math.PI / 2);
    const hx = 3 + rnd() * 6, hy = 3 + rnd() * 6; // 반폭 3..9 m → 회전해도 반경 12.8 m 이하
    let ring;
    if (rnd() < 0.35) {
      // L 자: 오른쪽 위 사분면을 잘라낸다(cut 비율 0.3..0.7).
      const kx = -hx + 2 * hx * (0.3 + 0.4 * rnd()), ky = -hy + 2 * hy * (0.3 + 0.4 * rnd());
      ring = [[-hx, -hy], [hx, -hy], [hx, ky], [kx, ky], [kx, hy], [-hx, hy]];
    } else {
      ring = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
    }
    const f = rnd();
    const floors = f < 0.15 ? null : 1 + Math.floor(rnd() * 6);
    return { id: 1000 + parcel, ring: rotRing(ring, cx, cy, ang), floors };
  });
}

export function bundleFromFootprints(footprints, { image, uv = 'server', lodDistM = 100 } = {}) {
  if (uv !== 'flipped' && uv !== 'server') throw new RangeError(`fixtures: uv 는 'server' | 'flipped': ${String(uv)}`);
  const img = image === undefined ? makeAerialImage() : image;
  // uv 는 영상 범위로 만든다. 영상이 없을 때도 형태(정점당 2)를 맞추려고 기본 범위의 빈 영상으로 계산한다.
  const uvImage = img ?? { width: 1, height: 1, rgb: new Uint8Array(3), bounds: { ...AERIAL_BOUNDS } };
  const buildings = footprints.map((fp) => ({ id: fp.id, mesh: extrudeBuilding(fp) }));
  const lod = buildBuildingLod(buildings, lodDistM);
  const groups = lod.map(({ ids, mesh }) => {
    const { edgeLines } = buildBlackBuilding(mesh);
    const a = buildAerialUv(mesh, uvImage);
    const points = sampleBuildingPoints(mesh, ids[0]);
    return {
      ids: [...ids],
      mesh: { positions: mesh.positions, indices: mesh.indices },
      edgeLines,
      uv: uv === 'flipped' ? flipV(a.uv) : a.uv,
      wallMask: a.wallMask,
      points,
    };
  });
  return { groups, image: img };
}

export function makeBundle(seed, { count = 6, image = true, uv = 'server', lodDistM = 100 } = {}) {
  return bundleFromFootprints(makeFootprints(seed, count), { image: image ? makeAerialImage() : null, uv, lodDistM });
}

/** 번들 전체를 바이트 한 줄로(결정성 비교용). */
export function bundleBytes(bundle) {
  const parts = [];
  const push = (ta) => parts.push(Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength));
  for (const g of bundle.groups) {
    push(Uint32Array.from(g.ids));
    push(g.mesh.positions); push(g.mesh.indices); push(g.edgeLines); push(g.uv); push(g.wallMask); push(g.points);
  }
  if (bundle.image) { push(Uint32Array.of(bundle.image.width, bundle.image.height)); push(bundle.image.rgb); }
  return Buffer.concat(parts);
}

// ENU 눈·목표 → OpenCV 카메라(x 오른쪽, y 아래, z 앞). R 의 행 = 카메라 축의 월드 성분.
function lookAt(name, eye, target, upHint, width, height, hfovRad) {
  const f = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const nf = Math.hypot(...f); f[0] /= nf; f[1] /= nf; f[2] /= nf;
  const x = [f[1] * upHint[2] - f[2] * upHint[1], f[2] * upHint[0] - f[0] * upHint[2], f[0] * upHint[1] - f[1] * upHint[0]];
  const nx = Math.hypot(...x); x[0] /= nx; x[1] /= nx; x[2] /= nx;
  const y = [f[1] * x[2] - f[2] * x[1], f[2] * x[0] - f[0] * x[2], f[0] * x[1] - f[1] * x[0]];
  const R = [...x, ...y, ...f];
  const t = [0, 1, 2].map((r) => -(R[3 * r] * eye[0] + R[3 * r + 1] * eye[1] + R[3 * r + 2] * eye[2]));
  const fx = width / 2 / Math.tan(hfovRad / 2);
  const cam = { width, height, K: { fx, fy: fx, cx: width / 2, cy: height / 2 }, R, t };
  assertCamera(cam);
  cam.name = name;
  return cam;
}

export function makeCameras({ width = 80, height = 45 } = {}) {
  const hfov = Math.PI / 3;
  return [
    // 수직 내려다봄: 위쪽 힌트를 북(0,1,0)으로 주어 화면 위 = 북, 오른쪽 = 동.
    lookAt('top', [0, 0, 120], [0, 0, 0], [0, 1, 0], width, height, hfov),
    lookAt('oblique', [-60, -80, 60], [0, 0, 0], [0, 0, 1], width, height, hfov),
    lookAt('eye17', [0, -70, 17], [0, 0, 8], [0, 0, 1], width, height, hfov),
  ];
}
