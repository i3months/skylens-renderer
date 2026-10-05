// 관제탑 드레이프 층(T15.2). 지형 층이 그린 RenderResult 의 화소를 역투영해 ENU (x, y) 를 얻고, 도착한 위성 타일의 색으로 바꾼다.
// 계약: contracts/controlview/drape.mjs. 이 파일은 조립만 한다(unproject·sample·store·shade).
// 원칙: 도착한 타일만 입힌다. 타일이 없거나 coverage.mask 가 0 인 화소는 지형 색 그대로(메우지 않는다). 수준은 교체이고 추월당한 수준은 건너뛴다.
// 검사는 프레임당 한 번(apply 첫머리: 카메라·terrain 길이·baseRgb). 화소 루프는 검사·할당 없는 내부 경로
//   (pixelToEnuInto · sampleDrapePrepared · shadeLut 표)를 쓰고, 결과는 화소마다
//   pixelToEnu → store.lookup → sampleDrape → shadeRatio/applyRatio 를 부른 것과 바이트 단위로 같다.
// 출력: color 만 새 배열이고 depth·index 는 terrain 의 배열을 그대로(복사 없이) 돌려준다. terrain 은 바꾸지 않는다.
import { prepareUnproject, pixelToEnuInto } from './unproject.mjs';
import { prepareDrapeSampler, sampleDrapePrepared } from './sample_into.mjs';
import { createDrapeStore } from './store.mjs';
import { shadeLut } from './shade.mjs';
import { TERRAIN_DEFAULTS } from '../../../contracts/controlview/terrain.mjs';
import { TERRAIN_TILE_SIZE_M } from '../../../contracts/tower_assets/index.mjs';

/** terrain 길이 검사(화소 깊이 값은 보지 않는다: NaN·Infinity 화소는 루프에서 건너뛴다). */
function checkTerrain(terrain, width, height) {
  if (!terrain || typeof terrain !== 'object') throw new RangeError('drape: terrain 이 객체가 아니다');
  if (terrain.width !== width || terrain.height !== height) throw new RangeError('drape: terrain 해상도가 카메라와 다르다');
  const n = width * height;
  const { color, depth, index } = terrain;
  // 음영 표를 채널 합으로 찾으므로 색은 0..255 정수(Uint8Array)여야 한다.
  if (!(color instanceof Uint8Array) || color.length !== 3 * n) throw new RangeError(`drape: terrain.color 는 길이 ${3 * n} 의 Uint8Array 여야 한다`);
  if (!depth || depth.length !== n) throw new RangeError(`drape: terrain.depth 길이는 ${n} 이어야 한다`);
  if (!index || index.length !== n) throw new RangeError(`drape: terrain.index 길이는 ${n} 이어야 한다`);
}

/** baseRgb 검사: 길이 3, 0..255 유한 수(shadeRatio 의 입력 규칙과 같다). */
function checkBaseRgb(baseRgb) {
  if (!baseRgb || typeof baseRgb !== 'object' || baseRgb.length !== 3) throw new RangeError('drape: baseRgb 는 길이 3 배열이어야 한다');
  for (let k = 0; k < 3; k++) {
    const c = baseRgb[k];
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 255) {
      throw new RangeError(`drape: baseRgb[${k}] 는 0..255 범위의 유한 수여야 한다: ${String(c)}`);
    }
  }
}

/** 화소 루프(검사 없음). 입력은 apply 가 이미 검사했다. */
function drapeLoop(coef, width, height, depth, src, color, lut, store, samplerOf) {
  const p3 = new Float64Array(3); // 역투영 결과 (x, y, z)
  const rgb = new Uint8Array(3); // 표본 색
  // 직전 타일 칸 캐시: [cMinX, cMaxX) × [cMinY, cMaxY) 안이면 같은 조회 결과(타일 또는 null)를 쓴다.
  // 경계 값(x = cMaxX 등)은 캐시 밖이라 lookup 으로 넘어가므로 floor 규약(경계는 오른쪽/위 타일)과 같다.
  let cSp = null;
  let cMinX = Infinity, cMaxX = -Infinity, cMinY = Infinity, cMaxY = -Infinity;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const p = j * width + i;
      const d = depth[p];
      if (!(Number.isFinite(d) && d > 0)) continue;
      pixelToEnuInto(coef, i, j, d, p3);
      const x = p3[0];
      const y = p3[1];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(p3[2])) continue;
      if (!(x >= cMinX && x < cMaxX && y >= cMinY && y < cMaxY)) {
        const tile = store.lookup(x, y);
        cSp = tile === null ? null : samplerOf(tile);
        const tx = Math.floor(x / TERRAIN_TILE_SIZE_M);
        const ty = Math.floor(y / TERRAIN_TILE_SIZE_M);
        cMinX = tx * TERRAIN_TILE_SIZE_M; cMaxX = (tx + 1) * TERRAIN_TILE_SIZE_M;
        cMinY = ty * TERRAIN_TILE_SIZE_M; cMaxY = (ty + 1) * TERRAIN_TILE_SIZE_M;
      }
      if (cSp === null) continue;
      if (!sampleDrapePrepared(cSp, x, y, rgb, 0)) continue;
      const q = 3 * p;
      if (lut !== null) {
        const row = (src[q] + src[q + 1] + src[q + 2]) << 8; // 지형 색 채널 합 → 표의 행
        color[q] = lut[row + rgb[0]]; color[q + 1] = lut[row + rgb[1]]; color[q + 2] = lut[row + rgb[2]];
      } else {
        color[q] = rgb[0]; color[q + 1] = rgb[1]; color[q + 2] = rgb[2];
      }
    }
  }
}

/** @param {{ shade?: boolean }|null} [opts] */
export function createDrapeLayer(opts) {
  const useShade = (opts ?? {}).shade ?? true;
  const store = createDrapeStore();
  // 타일 → 표본 계수. 타일 객체는 저장소가 그대로 들고 있으므로(바꾸지 않는다는 규약) 프레임을 넘어 다시 쓴다.
  const samplers = new WeakMap();
  const samplerOf = (tile) => {
    let sp = samplers.get(tile);
    if (sp === undefined) { sp = prepareDrapeSampler(tile); samplers.set(tile, sp); }
    return sp;
  };
  // 음영 표는 baseRgb 가 바뀔 때만 다시 만든다(보통 프레임마다 같다).
  let lut = null;
  let lutBase = null;
  const lutFor = (baseRgb) => {
    if (lut === null || lutBase[0] !== baseRgb[0] || lutBase[1] !== baseRgb[1] || lutBase[2] !== baseRgb[2]) {
      lut = shadeLut(baseRgb);
      lutBase = [baseRgb[0], baseRgb[1], baseRgb[2]];
    }
    return lut;
  };
  return {
    accept(level, tiles) { return store.accept(level, tiles); },
    apply(camera, terrain, o) {
      const coef = prepareUnproject(camera); // assertCamera 는 여기서 한 번
      const { width, height } = camera;
      checkTerrain(terrain, width, height);
      const baseRgb = (o ?? {}).baseRgb ?? TERRAIN_DEFAULTS.baseRgb;
      checkBaseRgb(baseRgb);
      const src = terrain.color;
      const depth = terrain.depth;
      const color = src.slice();
      const out = { width, height, color, depth, index: terrain.index };
      if (store.count() === 0) return out;

      drapeLoop(coef, width, height, depth, src, color, useShade ? lutFor(baseRgb) : null, store, samplerOf);
      return out;
    },
    state() { return { level: store.level(), tileCount: store.count() }; },
  };
}
