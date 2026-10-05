// 건물 층 통합 시험용 번들 조립 헬퍼. 실제 서버 자산 파이프라인(extrude → lod → black → aerial_uv → points)의 출력으로
// BuildingBundle(contracts/controlview/buildings.mjs)을 만든다. 시험 전용이라 server/ 를 가져와도 된다(클라이언트 본 코드는 안 된다).
import { extrudeAll } from '../../../../server/buildings/extrude/index.mjs';
import { buildBuildingLod } from '../../../../server/buildings/lod/index.mjs';
import { buildBlackBuilding } from '../../../../server/buildings/black/index.mjs';
import { buildAerialUv } from '../../../../server/buildings/aerial_uv/index.mjs';
import { sampleBuildingPoints } from '../../../../server/buildings/points/index.mjs';

export const BUILDING_COUNT = 40;
export const GRID_COLS = 8;
export const GRID_ROWS = 5;
export const GRID_PITCH_M = 24;
/** 항공영상이 덮는 범위(ENU m). 격자 전체를 여백과 함께 덮는다. */
export const IMAGE_BOUNDS = Object.freeze({ minX: -10, minY: -10, maxX: GRID_COLS * GRID_PITCH_M + 10, maxY: GRID_ROWS * GRID_PITCH_M + 10 });

// 결정적 난수(mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 합성 외곽선 40동. 8×5 격자(간격 24 m)의 칸마다 한 동, 한 변 9~14 m 라 서로 겹치지 않는다(칸 안에 들어간다).
 * 7번째마다 L 자형(오목) 외곽. 층 수: 3·없음·1·5·2 순환(없음은 키 자체가 없거나 null), 0번 = 3층, 1번 = 층 수 없음.
 * @returns {Array<{id:number, ring:Array<[number,number]>, floors?:number|null, probe:[number,number]}>} probe = 지붕 위의 한 점(ENU xy).
 */
export function makeFootprints(seed) {
  const rnd = rng(seed);
  const floorCycle = [3, undefined, 1, 5, 2];
  const out = [];
  for (let i = 0; i < BUILDING_COUNT; i++) {
    const col = i % GRID_COLS, row = Math.floor(i / GRID_COLS);
    const w = 9 + Math.floor(rnd() * 6), h = 9 + Math.floor(rnd() * 6);
    const x0 = col * GRID_PITCH_M + 2 + Math.floor(rnd() * 3), y0 = row * GRID_PITCH_M + 2 + Math.floor(rnd() * 3);
    let ring, probe;
    if (i % 7 === 6) {
      // L 자: 오른쪽 위 모서리를 잘라낸다.
      const cw = Math.floor(w / 2), ch = Math.floor(h / 2);
      ring = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + ch], [x0 + cw, y0 + ch], [x0 + cw, y0 + h], [x0, y0 + h]];
      probe = [x0 + cw / 2, y0 + ch / 2];
    } else {
      ring = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]];
      probe = [x0 + w / 2, y0 + h / 2];
    }
    const fp = { id: 1000 + i * 3 + (seed % 3), ring, probe };
    const f = floorCycle[i % 5];
    if (i === 0) fp.floors = 3;
    else if (i === 1) { /* 층 수 키 없음 */ } else if (f === undefined) { if (i % 10 === 6) fp.floors = null; } else fp.floors = f;
    out.push(fp);
  }
  return out;
}

/** 결정적 합성 항공영상(64×64, 행 0 = 북). 화소마다 값이 달라 옵션 사이 차이가 드러난다. bounds 는 aerial_uv 입력용이다. */
export function makeAerialImage(seed) {
  const rnd = rng(seed ^ 0x9e3779b9);
  const width = 64, height = 64;
  const rgb = new Uint8Array(width * height * 3);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const o = (j * width + i) * 3;
      rgb[o] = 60 + Math.floor((i / width) * 150);
      rgb[o + 1] = 60 + Math.floor((j / height) * 150);
      rgb[o + 2] = 80 + Math.floor(rnd() * 120);
    }
  }
  return { width, height, rgb, bounds: { ...IMAGE_BOUNDS } };
}

/**
 * 실제 서버 파이프라인으로 BuildingBundle 을 만든다.
 * @param {number} seed
 * @param {{cameraDistM?:number, withImage?:boolean}} [opts] cameraDistM 기본 0(원본 그대로, 병합 없음). 500 이상이면 buildBuildingLod 가 상자로 병합한다.
 * @returns {{groups:Array, image:object|null}} BuildingBundle (ids 는 입력 id 전부를 병합 상자 포함해 보존한다)
 */
export function buildRealBundle(seed, opts = {}) {
  const { cameraDistM = 0, withImage = true } = opts;
  const fps = makeFootprints(seed);
  const meshes = extrudeAll(fps.map(({ id, ring, floors }) => ({ id, ring, floors })));
  const lod = buildBuildingLod(meshes, cameraDistM);
  const src = withImage ? makeAerialImage(seed) : null;
  const groups = lod.map(({ ids, mesh }) => {
    const { mesh: blackMesh, edgeLines } = buildBlackBuilding(mesh);
    // 영상이 없으면 uv 0, wallMask 1(전부 검정 면). 계약: image null 이면 aerial 은 전부 검정.
    let uv, wallMask;
    if (src) ({ uv, wallMask } = buildAerialUv(blackMesh, src));
    else { uv = new Float32Array((blackMesh.positions.length / 3) * 2); wallMask = new Uint8Array(blackMesh.positions.length / 3).fill(1); }
    const points = sampleBuildingPoints(blackMesh, ids[0]);
    return { ids: [...ids], mesh: blackMesh, edgeLines, uv, wallMask, points };
  });
  const image = src ? { width: src.width, height: src.height, rgb: src.rgb } : null;
  return { groups, image };
}
