// 초기 묶음 시험용 카탈로그 헬퍼(F-187 ①): fixtures/scenes 의 점군을 server/asset/pack 의 packChunk 로
// 실제 .skla 조각으로 만들고, 조각 헤더에서 읽은 실제 크기·bbox 로 buildInitialBundle 입력 카탈로그를 만든다.
// 새로 작성한 코드이며 외부 코드를 차용하지 않았다.
import { readFileSync } from 'node:fs';
import { SCENES } from '../../../contracts/scenes/index.mjs';
import { parseHeader, TILE_SIZE_M, FORMAT_POINT27 } from '../../../contracts/asset/index.mjs';
import { packChunk } from '../../asset/pack/index.mjs';
import { levelCloud } from '../../../fixtures/scenes/levels/index.mjs';

const ROOT = new URL('../../../', import.meta.url);
/** 조각 하나가 담을 최대 점 수(타일 안에서 넘으면 chunkIndex 를 올려 나눈다). */
export const CHUNK_POINTS = 65536;
const ANCHOR = Object.freeze({ lat: 37.5, lon: 127.0, alt: 30.0 });

/** 장면 좌표(x=동, y=위, z=-북) → ENU(동, 북, 위). */
export const sceneToEnu = (p) => [p[0], -p[2], p[1]];

/** 27 B 점군 하나를 타일별·CHUNK_POINTS 단위로 나눠 조각 목록 {key, bytes, bbox} 로 만든다(수준 level, lod 0). */
function packCloud(cloud, segmentId, level, out) {
  // 점을 타일별로 모은다. 키는 정수 쌍 문자열, 삽입 순서(=입력 점 순서)로 결정적이다.
  const tiles = new Map();
  for (let i = 0; i < cloud.count; i++) {
    const e = cloud.positions[3 * i], n = -cloud.positions[3 * i + 2];
    const tx = Math.floor(e / TILE_SIZE_M), ty = Math.floor(n / TILE_SIZE_M);
    const k = `${tx}/${ty}`;
    let a = tiles.get(k);
    if (!a) tiles.set(k, (a = []));
    a.push(i);
  }
  for (const idx of tiles.values()) {
    for (let c = 0, ci = 0; c < idx.length; c += CHUNK_POINTS, ci++) {
      const part = idx.slice(c, c + CHUNK_POINTS);
      const m = part.length;
      const positions = new Float32Array(3 * m), normals = new Float32Array(3 * m), colors = new Uint8Array(3 * m);
      part.forEach((s, j) => {
        const [e, n, u] = sceneToEnu(cloud.positions.subarray(3 * s, 3 * s + 3));
        positions.set([e, n, u], 3 * j);
        const nn = sceneToEnu(cloud.normals.subarray(3 * s, 3 * s + 3));
        normals.set(nn, 3 * j);
        colors.set(cloud.colors.subarray(3 * s, 3 * s + 3), 3 * j);
      });
      const file = packChunk({ format: FORMAT_POINT27, segmentId, level, lod: 0, chunkIndex: ci, anchor: ANCHOR, fields: { positions, normals, colors } });
      const h = parseHeader(file);
      out.push({
        key: { segmentId, level, lod: 0, chunkIndex: ci, tileX: h.tileX, tileY: h.tileY },
        bytes: file.length,
        bbox: { min: h.bboxMin, max: h.bboxMax },
      });
    }
  }
}

/**
 * 장면 이름으로 생성기를 불러 .skla 조각 카탈로그를 만든다.
 * levels 장면은 구간(segmentId=구간 번호)·수준 0..3 을 모두 조각으로 만들고, 나머지는 수준 0 한 벌이다.
 * @param {string} name SCENES 의 키
 * @param {{seed?:number,count?:number}} [opts]
 * @returns {Promise<{name:string,pointCount:number,catalog:object[],totalSklaBytes:number,level0Bytes:number}>}
 */
export async function buildSceneCatalog(name, opts = {}) {
  if (!SCENES[name]) throw new RangeError(`unknown scene ${name}`);
  const mod = await import(new URL(SCENES[name], ROOT).href);
  const res = mod.generate({ seed: opts.seed ?? 1, ...(opts.count ? { count: opts.count } : {}) });
  const catalog = [];
  if (name === 'levels') {
    for (const seg of res.truth.segments) for (const lv of seg.levels) packCloud(levelCloud(res, seg.id, lv.level), seg.id, lv.level, catalog);
  } else packCloud(res.cloud, 0, 0, catalog);
  const sum = (f) => catalog.filter(f).reduce((s, it) => s + it.bytes, 0);
  return { name, pointCount: res.count, catalog, totalSklaBytes: sum(() => true), level0Bytes: sum((it) => it.key.level === 0) };
}

/** fixtures/viewpoints/synthetic.json 의 시점들을 읽는다. */
export function loadViewpoints() {
  return JSON.parse(readFileSync(new URL('fixtures/viewpoints/synthetic.json', ROOT), 'utf8')).viewpoints;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };

/**
 * 시점(eye/target/up, 장면 좌표) → buildInitialBundle 의 pose(ENU, quat 는 카메라→월드, 카메라 +z 가 앞).
 * 카메라 축은 x=오른쪽, y=아래, z=앞(OpenCV 식)이고 행렬 열 [x y z] 를 사원수로 바꾼다.
 */
export function poseOfViewpoint(vp) {
  const eye = sceneToEnu(vp.eye);
  const z = unit(sub(sceneToEnu(vp.target), eye));
  const x = unit(cross(z, sceneToEnu(vp.up)));
  const y = cross(z, x);
  // 회전 행렬 R = [x y z](열). 대각합이 양수가 아닐 수 있어 가장 큰 성분 기준으로 계산한다.
  const m = [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]];
  const tr = m[0][0] + m[1][1] + m[2][2];
  let q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s, s / 4];
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    q = [s / 4, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s, (m[2][1] - m[1][2]) / s];
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    q = [(m[0][1] + m[1][0]) / s, s / 4, (m[1][2] + m[2][1]) / s, (m[0][2] - m[2][0]) / s];
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    q = [(m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, s / 4, (m[1][0] - m[0][1]) / s];
  }
  return { pos: eye, quat: q, fovY: (vp.fov_y_deg * Math.PI) / 180, forward: z };
}
