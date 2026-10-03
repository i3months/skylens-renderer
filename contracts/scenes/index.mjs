// 합성 장면 계약(T05). 모든 장면 생성기가 같은 모양의 결과를 내고, 같은 시드는 같은 바이트를 낸다.
// 좌표는 GeoAnchor 기준 ENU(m): x=동, y=위, z=−북 (씬 규약). 1 unit = 1 m.
// 입력 형식은 두 가지(결정 0012): 27 B 점(법선 포함)과 56 B 가우시안. 두 형식 모두 같은 위치·색을 공유한다.
// 각 장면 모듈은 fixtures/scenes/<이름>/index.mjs 에 `generate(opts)` 를 내보낸다(아래 SCENES).

import { createHash } from 'node:crypto';
import { FORMAT_POINT27, FORMAT_GAUSS56 } from '../points/index.mjs';

export { FORMAT_POINT27, FORMAT_GAUSS56 };

/** 딜레이 패턴 4수준(학습 스텝). 낮은 수준일수록 성긴 점이다(RULES §1.1). */
export const LEVEL_STEPS = Object.freeze([250, 1000, 3500, 7000]);

/** 장면 이름과 모듈 위치(저장소 루트 기준). 모듈은 `generate(opts)` 를 내보낸다. */
export const SCENES = Object.freeze({
  flat_boxes: 'fixtures/scenes/flat_boxes/index.mjs',
  terrain: 'fixtures/scenes/terrain/index.mjs',
  holes: 'fixtures/scenes/holes/index.mjs',
  levels: 'fixtures/scenes/levels/index.mjs',
  large: 'fixtures/scenes/large/index.mjs',
  depth_noise: 'fixtures/scenes/depth_noise/index.mjs',
  buildings: 'fixtures/scenes/buildings/index.mjs',
  dem: 'fixtures/scenes/dem/index.mjs',
});

/**
 * @typedef {Object} GenerateOptions
 * @property {number} seed       uint32. 같은 (seed, 나머지 옵션) → 같은 바이트.
 * @property {number} [count]    점 수. 장면별 기본값이 있고, 정해 주면 정확히 이 수다(모든 점군 장면).
 * @property {1|2} [format]      FORMAT_POINT27(기본) | FORMAT_GAUSS56
 * @property {number} [segments] 구간 수(levels 장면)
 * @property {number} [levels]   수준 수(levels 장면, 기본 4)
 *
 * @typedef {Object} SceneResult
 * @property {string} scene      SCENES 의 키
 * @property {number} seed
 * @property {1|2} format
 * @property {number} count      cloud.count 와 같다
 * @property {import('../points/index.mjs').Point27Cloud | import('../points/index.mjs').Gauss56Cloud} cloud
 * @property {Object} truth      정답 기록(JSON 으로 직렬화 가능). 필수 키: bounds {min:[x,y,z], max:[x,y,z]}(m). 나머지는 장면별.
 */

/** mulberry32. 같은 시드 → 같은 수열(0 이상 1 미만). 모든 장면이 이것만 쓴다(Math.random 금지). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 부분 시드: 장면 안에서 독립된 수열이 필요할 때(예: 구간별). */
export const subSeed = (seed, index) => (Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(index + 1, 0xc2b2ae35)) >>> 0;

const SH_C0 = 0.28209479177387814;

/**
 * 27 B 점군을 56 B 가우시안으로 옮긴다(위치·색 공유, 법선은 버린다).
 * f_dc = (rgb/255 − 0.5)/C0, opacity 로짓 = logit(0.9), scale = ln(sigma) 이고 sigma 는 점마다 같은 값, 회전은 단위 사원수 (1,0,0,0).
 * @param {import('../points/index.mjs').Point27Cloud} c
 * @param {number} [sigma] m 단위 크기(기본 0.05)
 * @returns {import('../points/index.mjs').Gauss56Cloud}
 */
export function point27ToGauss56(c, sigma = 0.05) {
  const n = c.count;
  const fdc = new Float32Array(3 * n);
  for (let i = 0; i < 3 * n; i++) fdc[i] = (c.colors[i] / 255 - 0.5) / SH_C0;
  const opacity = new Float32Array(n).fill(Math.log(0.9 / 0.1));
  const scales = new Float32Array(3 * n).fill(Math.log(sigma));
  const rotations = new Float32Array(4 * n);
  for (let i = 0; i < n; i++) rotations[4 * i] = 1;
  // positions 는 입력 점군과 버퍼를 공유한다(복사 없음: 250만 점에서 30 MB 절약). 안전한 이유: 이 모듈과 모든 장면은
  // 점군을 만든 뒤 변경하지 않고, makeResult 는 27 B 점군을 결과에 남기지 않는다(format 2 결과만 반환). 호출자가 입력의
  // positions 를 이후 직접 고치면 결과도 바뀌므로, 그런 호출자는 먼저 복사해서 넘겨야 한다.
  return { format: FORMAT_GAUSS56, count: n, positions: c.positions, fdc, opacity, scales, rotations };
}

/**
 * 장면 결과를 만든다. 생성기는 항상 27 B 점군을 만들고 이것으로 마무리한다(format 2 면 위 변환).
 * @param {string} scene @param {number} seed @param {1|2} format
 * @param {import('../points/index.mjs').Point27Cloud} cloud27 @param {Object} truth
 * @returns {SceneResult}
 */
export function makeResult(scene, seed, format, cloud27, truth) {
  format = checkFormat(format);
  const cloud = format === FORMAT_GAUSS56 ? point27ToGauss56(cloud27) : cloud27;
  return { scene, seed, format, count: cloud.count, cloud, truth };
}

// 호스트가 little-endian 이면 Float32Array 바이트를 그대로 복사해도 레코드 규약과 같다. 아니면 DataView 느린 경로.
const HOST_LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const HASH_CHUNK = 65536; // 청크 해시 단위(점 수). 250만 점에서도 중간 버퍼는 청크 하나(27 B: 약 1.7 MB)뿐이다.

/** [start, end) 점 범위의 레코드 바이트열. 레코드 규약은 packRecords 주석 참조. */
function packRange(cloud, start, end) {
  const m = end - start;
  if (cloud.format === FORMAT_POINT27) {
    // 27 B 는 4 정렬이 아니라 DataView 를 쓴다(측정상 250만 점 포장 약 0.1 s 로, 인터리브 우회보다 느리지 않다).
    const out = new Uint8Array(27 * m);
    const dv = new DataView(out.buffer);
    for (let j = 0; j < m; j++) {
      const i = start + j, o = 27 * j;
      for (let k = 0; k < 3; k++) dv.setFloat32(o + 4 * k, cloud.positions[3 * i + k], true);
      for (let k = 0; k < 3; k++) dv.setFloat32(o + 12 + 4 * k, cloud.normals[3 * i + k], true);
      for (let k = 0; k < 3; k++) out[o + 24 + k] = cloud.colors[3 * i + k];
    }
    return out;
  }
  // 56 B = float32 14 개(정렬됨): 인터리브 Float32Array 하나에 채우고 바이트 뷰를 돌려준다.
  const f = new Float32Array(14 * m);
  for (let j = 0; j < m; j++) {
    const i = start + j, o = 14 * j;
    f[o] = cloud.positions[3 * i]; f[o + 1] = cloud.positions[3 * i + 1]; f[o + 2] = cloud.positions[3 * i + 2];
    f[o + 3] = cloud.fdc[3 * i]; f[o + 4] = cloud.fdc[3 * i + 1]; f[o + 5] = cloud.fdc[3 * i + 2];
    f[o + 6] = cloud.opacity[i];
    f[o + 7] = cloud.scales[3 * i]; f[o + 8] = cloud.scales[3 * i + 1]; f[o + 9] = cloud.scales[3 * i + 2];
    f[o + 10] = cloud.rotations[4 * i]; f[o + 11] = cloud.rotations[4 * i + 1];
    f[o + 12] = cloud.rotations[4 * i + 2]; f[o + 13] = cloud.rotations[4 * i + 3];
  }
  const out = new Uint8Array(f.buffer);
  if (HOST_LE) return out;
  const dv = new DataView(out.buffer);
  for (let k = 0; k < f.length; k++) dv.setFloat32(4 * k, f[k], true);
  return out;
}

/**
 * 레코드 바이트열(점 순서대로 인터리브, little-endian). 27 B: x y z nx ny nz (f32) r g b (u8). 56 B: x y z f_dc_0..2 opacity scale_0..2 rot_0..3 (f32).
 * @param {SceneResult['cloud']} cloud @returns {Uint8Array}
 */
export function packRecords(cloud) {
  return packRange(cloud, 0, cloud.count);
}

/** 결과의 바이트 해시(sha256 hex). 같은 시드 → 같은 해시가 모든 장면의 공통 시험이다. 청크로 나눠 먹여도 전체 바이트 해시와 같다. */
export const resultHash = (r) => {
  const h = createHash('sha256');
  const n = r.cloud.count;
  for (let s = 0; s < n; s += HASH_CHUNK) h.update(packRange(r.cloud, s, Math.min(n, s + HASH_CHUNK)));
  return h.digest('hex');
};

/**
 * 결과 모양 검사. 어긋나면 Error. 모든 장면 시험이 호출한다.
 * @param {SceneResult} r @param {{scene?: string, count?: number}} [expect]
 */
export function assertSceneResult(r, expect = {}) {
  const bad = (m) => { throw new Error(`scene result: ${m}`); };
  if (!r || typeof r !== 'object') bad('객체가 아님');
  if (!(r.scene in SCENES)) bad(`알 수 없는 장면 ${r.scene}`);
  if (expect.scene !== undefined && r.scene !== expect.scene) bad(`scene ${r.scene} != ${expect.scene}`);
  if (!Number.isInteger(r.seed) || r.seed < 0 || r.seed > 0xffffffff) bad('seed 는 uint32');
  if (r.format !== FORMAT_POINT27 && r.format !== FORMAT_GAUSS56) bad('format');
  const c = r.cloud;
  if (!c || c.format !== r.format) bad('cloud.format 이 format 과 다름');
  if (!Number.isInteger(c.count) || c.count < 0 || r.count !== c.count) bad('count 불일치');
  if (expect.count !== undefined && c.count !== expect.count) bad(`count ${c.count} != ${expect.count}`);
  const n = c.count;
  const need = r.format === FORMAT_POINT27
    ? { positions: [Float32Array, 3], normals: [Float32Array, 3], colors: [Uint8Array, 3] }
    : { positions: [Float32Array, 3], fdc: [Float32Array, 3], opacity: [Float32Array, 1], scales: [Float32Array, 3], rotations: [Float32Array, 4] };
  for (const [k, [T, m]] of Object.entries(need)) {
    if (!(c[k] instanceof T) || c[k].length !== m * n) bad(`${k} 열 길이/형`);
  }
  // 모든 float 열은 유한해야 한다(NaN·Infinity 는 해시·정답 비교를 조용히 망가뜨린다). 색(Uint8)은 형과 길이 검사로 충분하다.
  for (const k of Object.keys(need)) {
    if (k === 'colors') continue;
    const a = c[k];
    for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) bad(`${k}[${i}] 비유한`);
  }
  if (r.format === FORMAT_POINT27) {
    // 주의: 법선 단위 길이 강제는 합성 장면 전용이다. 자산 형식(ASSET_FORMAT.md §5.3)은 법선 단위 길이를 보장하지 않고
    // (길이 0·NaN 만 쓰는 쪽이 거부), 합성 생성기는 항상 단위 법선을 내므로 여기서만 더 엄격하게 검사한다.
    for (let i = 0; i < n; i++) {
      const len = Math.hypot(c.normals[3 * i], c.normals[3 * i + 1], c.normals[3 * i + 2]);
      if (Math.abs(len - 1) > 1e-3) bad(`normals[${i}] 단위 길이 아님(${len})`);
    }
  } else {
    // 회전은 단위 사원수(길이 1±1e-3). 전부 0 인 사원수는 정규화 불가라 거부된다.
    for (let i = 0; i < n; i++) {
      const len = Math.hypot(c.rotations[4 * i], c.rotations[4 * i + 1], c.rotations[4 * i + 2], c.rotations[4 * i + 3]);
      if (Math.abs(len - 1) > 1e-3) bad(`rotations[${i}] 단위 사원수 아님(${len})`);
    }
  }
  const t = r.truth;
  if (!t || !Array.isArray(t.bounds?.min) || !Array.isArray(t.bounds?.max)) bad('truth.bounds {min,max} 없음');
  // truth 안의 비유한 수(NaN/Infinity)는 JSON 에서 null 이 되어 조용히 사라지므로 직접 찾는다.
  const seen = new Set();
  const scan = (v, path) => {
    if (typeof v === 'number') { if (!Number.isFinite(v)) bad(`truth${path} 비유한 수`); return; }
    if (v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    for (const k of Object.keys(v)) scan(v[k], `${path}.${k}`);
  };
  scan(t, '');
  for (let a = 0; a < 3; a++) if (!(t.bounds.min[a] <= t.bounds.max[a])) bad('truth.bounds min>max');
}

/** 점 수 검증: 0 이상의 정수만 받는다(NaN·음수·소수·문자열 거부). 생략(undefined)이면 기본값. */
export function checkCount(count, defaultValue) {
  const v = count === undefined ? defaultValue : count;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`scene: count 는 0 이상의 정수여야 함: ${String(v)}`);
  return v;
}

/** 시드 검증: uint32 정수만 받는다. 생략(undefined)이면 1(모든 장면 공통 기본값). */
export function normalizeSeed(seed) {
  const v = seed === undefined ? 1 : seed;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error(`scene: seed 는 uint32 정수여야 함: ${String(v)}`);
  return v;
}

/** 형식 검증: 1(27 B 점) 또는 2(56 B 가우시안)만. 생략이면 1. */
export function checkFormat(format) {
  const v = format === undefined ? FORMAT_POINT27 : format;
  if (v !== FORMAT_POINT27 && v !== FORMAT_GAUSS56) throw new Error(`scene: format 은 1 또는 2 여야 함: ${String(v)}`);
  return v;
}
