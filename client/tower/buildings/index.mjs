// 관제탑 건물 층(T15.3). 도착한 건물 묶음만 CPU 래스터로 그린다(없는 곳은 빈 화소, 메우지 않는다).
// 표시 옵션 3종(points / black / aerial)의 자료는 accept 한 번에 모두 들어오고, 옵션 전환은 로컬 상태만 바꾼다(네트워크 요청 0).
// 수준(딜레이 0..3)은 교체이고 추월당한 수준은 건너뛴다(contracts/levels). 좌표: GeoAnchor 기준 ENU, 1 unit = 1 m.
// 계약: contracts/controlview/buildings.mjs. 이 파일은 조립만 한다.
import { BUILDINGS_DEFAULTS } from '../../../contracts/controlview/buildings.mjs';
import { assertCamera, emptyResult, EMPTY_DEPTH, EMPTY_INDEX } from '../../../contracts/raster/index.mjs';
import { createBuildingsState } from './levels.mjs';
import { createModeState } from './mode.mjs';
import { rasterizeFlat } from './raster_flat.mjs';
import { rasterizeTextured } from './raster_tex.mjs';
import { rasterizeLines } from './lines.mjs';
import { rasterizePoints } from './points.mjs';
import { rasterCount } from './raster_count.mjs';

const EMPTY_GROUP = Object.freeze({
  ids: Object.freeze([]),
  mesh: Object.freeze({ positions: new Float32Array(0), indices: new Uint32Array(0) }),
  edgeLines: new Float32Array(0),
  uv: new Float32Array(0),
  wallMask: new Uint8Array(0),
  points: new Float32Array(0),
});
// 화면 가장자리 여유(화소). 래스터의 가장자리 판정과 어긋나도 보이는 묶음을 빼지 않게 보수적으로 넓힌다.
const CULL_PAD_PX = 2;

/** 묶음 하나의 ENU 경계상자(정점·선 끝점·표본점 전부). 빈 묶음은 null. accept 때 한 번만 계산한다(값은 validate 가 유한함을 보장). */
function groupBounds(g) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const arr of [g.mesh.positions, g.edgeLines, g.points]) {
    // edgeLines 는 끝점 두 개(6 float)여도 3 float 씩 읽으면 같다.
    for (let i = 0; i < arr.length; i += 3) {
      const x = arr[i], y = arr[i + 1], z = arr[i + 2];
      if (x < b[0]) b[0] = x; if (x > b[3]) b[3] = x;
      if (y < b[1]) b[1] = y; if (y > b[4]) b[4] = y;
      if (z < b[2]) b[2] = z; if (z > b[5]) b[5] = z;
    }
  }
  return b[0] === Infinity ? null : b;
}

/** 경계상자가 절두체(근·좌·우·상·하) 밖이면 true. 모서리 8개가 한 평면의 바깥쪽에 전부 있을 때만 뺀다(보수적). */
function outsideFrustum(b, camera, near, corners) {
  const { R, t, K, width, height } = camera;
  const { fx, fy, cx, cy } = K;
  let n = 0;
  for (let i = 0; i < 8; i += 1) {
    const x = (i & 1) ? b[3] : b[0], y = (i & 2) ? b[4] : b[1], z = (i & 4) ? b[5] : b[2];
    corners[n++] = R[0] * x + R[1] * y + R[2] * z + t[0];
    corners[n++] = R[3] * x + R[4] * y + R[5] * z + t[1];
    corners[n++] = R[6] * x + R[7] * y + R[8] * z + t[2];
  }
  let behind = true, left = true, right = true, top = true, bottom = true;
  const wR = width - cx + CULL_PAD_PX, hB = height - cy + CULL_PAD_PX, wL = cx + CULL_PAD_PX, hT = cy + CULL_PAD_PX;
  for (let i = 0; i < 24; i += 3) {
    const x = corners[i], y = corners[i + 1], z = corners[i + 2];
    if (z >= near) behind = false; // lines.mjs 근평면 버림(az < near && bz < near)과 같은 경계: z == near 는 앞쪽
    if (fx * x + wL * z >= 0) left = false;
    if (wR * z - fx * x >= 0) right = false;
    if (fy * y + hT * z >= 0) top = false;
    if (hB * z - fy * y >= 0) bottom = false;
  }
  return behind || left || right || top || bottom;
}

/**
 * @param {{ mode?:string, lineRgb?:number[], pointRgb?:number[] }|null} [opts] null/undefined 는 기본값을 쓴다.
 */
export function createBuildingsLayer(opts) {
  const o = opts ?? {};
  const lineRgb = o.lineRgb ?? BUILDINGS_DEFAULTS.lineRgb;
  const pointRgb = o.pointRgb ?? BUILDINGS_DEFAULTS.pointRgb;
  const modeState = createModeState(o.mode);
  const state = createBuildingsState();
  const face = BUILDINGS_DEFAULTS.faceRgb;
  const cull = o.cull !== false; // 시험용: false 면 묶음 컬링을 끈다
  let bounds = []; // accept 순서 묶음별 경계상자(묶음 번호 = 배열 위치)
  let boundsOf = null; // bounds 를 만든 묶음 목록(교체 감지)
  const scratchGroups = []; // render 마다 재사용하는 래스터 입력(번호 유지: 빠진 자리는 빈 묶음)
  const corners = new Array(24).fill(0);
  let stats = { groupsTotal: 0, groupsDrawn: 0, rasterCalls: 0, rasterPixels: 0 };
  // 생성 시점에 색 인자를 한 번 검사한다(잘못된 값은 render 가 아니라 생성에서 던진다).
  rasterizeLines({ width: 1, height: 1, K: { fx: 1, fy: 1, cx: 0.5, cy: 0.5 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, [], lineRgb, emptyResult(1, 1));
  rasterizePoints({ width: 1, height: 1, K: { fx: 1, fy: 1, cx: 0.5, cy: 0.5 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }, [], pointRgb, emptyResult(1, 1));

  return {
    /** @returns {'first'|'replace'|'skip'} skip 이면 상태를 바꾸지 않는다. 던지면 상태는 그대로다. */
    accept(level, bundle) {
      const action = state.accept(level, bundle);
      if (action !== 'skip') {
        const b = state.bundle();
        bounds = b.groups.map(groupBounds);
        boundsOf = b;
      }
      return action;
    },
    setMode(mode) {
      modeState.set(mode);
    },
    mode() {
      return modeState.get();
    },
    render(camera, outArg) {
      assertCamera(camera);
      let out;
      if (outArg === undefined || outArg === null) out = emptyResult(camera.width, camera.height);
      else {
        const n = camera.width * camera.height;
        if (outArg.width !== camera.width || outArg.height !== camera.height
          || !(outArg.color instanceof Uint8Array) || !(outArg.depth instanceof Float32Array) || !(outArg.index instanceof Int32Array)
          || outArg.color.length !== 3 * n || outArg.depth.length !== n || outArg.index.length !== n) {
          throw new RangeError('buildings: out 은 카메라와 같은 크기의 RenderResult 여야 함');
        }
        // color·depth·index 가 같은 ArrayBuffer 를 공유하면 서로 덮어쓰므로 거절한다.
        if (outArg.color.buffer === outArg.depth.buffer || outArg.color.buffer === outArg.index.buffer || outArg.depth.buffer === outArg.index.buffer) {
          throw new RangeError('buildings: out 의 color·depth·index 는 ArrayBuffer 를 공유할 수 없음');
        }
        out = outArg;
        out.color.fill(0); out.depth.fill(EMPTY_DEPTH); out.index.fill(EMPTY_INDEX);
      }
      const bundle = state.bundle();
      if (!bundle) { stats = { groupsTotal: 0, groupsDrawn: 0, rasterCalls: 0, rasterPixels: 0 }; return out; }
      const groups = bundle.groups;
      let drawn = groups.length;
      let list = groups;
      if (cull && boundsOf === bundle) {
        const near = BUILDINGS_DEFAULTS.nearM;
        scratchGroups.length = groups.length;
        drawn = 0;
        for (let g = 0; g < groups.length; g += 1) {
          const bb = bounds[g];
          if (bb === null || outsideFrustum(bb, camera, near, corners)) scratchGroups[g] = EMPTY_GROUP;
          else { scratchGroups[g] = groups[g]; drawn += 1; }
        }
        list = scratchGroups;
      }
      const calls0 = rasterCount.calls, pixels0 = rasterCount.pixels;
      const mode = modeState.get();
      if (mode === 'points') rasterizePoints(camera, list, pointRgb, out);
      else if (mode === 'aerial') rasterizeTextured(camera, list, bundle.image, out);
      else {
        rasterizeFlat(camera, list, () => face, out);
        rasterizeLines(camera, list, lineRgb, out);
      }
      stats = { groupsTotal: groups.length, groupsDrawn: drawn, rasterCalls: rasterCount.calls - calls0, rasterPixels: rasterCount.pixels - pixels0 };
      return out;
    },
    /** 진단용: 마지막 render 의 래스터에 넘어간 묶음 수, 래스터 호출 수, 처리 화소 수(points 는 점 수). */
    stats() {
      return stats;
    },
    state() {
      const b = state.bundle();
      const buildingCount = b ? b.groups.reduce((n, g) => n + g.ids.length, 0) : 0;
      return { level: state.level(), groupCount: b ? b.groups.length : 0, buildingCount, mode: modeState.get() };
    },
  };
}
