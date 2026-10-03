// 'holes' 장면: 무늬 없는 영역(흰 지붕·물)에는 실제 복원에서 점이 생기지 않는다(renderer_basis §7-3).
// x,z ∈ [-100,100] 평지(y=0, 법선 (0,1,0))에 무늬 있는 땅 점을 뿌리되, 시드로 정한 직사각형 빈자리 6곳
// (지붕 4·물 2, 한 변 10~30 m, 서로 겹치지 않음)에는 점을 만들지 않는다. 빈자리는 메우지 않는다(RULES §1.2).
import { mulberry32, subSeed, makeResult, FORMAT_POINT27, checkCount, normalizeSeed, checkFormat } from '../../../contracts/scenes/index.mjs';

const HALF = 100;
const AREA_M2 = (2 * HALF) * (2 * HALF);
const KINDS = ['roof', 'roof', 'roof', 'roof', 'water', 'water'];
const DEFAULT_COUNT = 100000;

// 위치·크기는 0.5 m 단위로 맞춰 면적 합이 부동소수점에서 정확하게 계산되게 한다.
const q = (v) => Math.round(v * 2) / 2;

function placeHoles(seed) {
  const rnd = mulberry32(subSeed(seed, 1));
  const holes = [];
  for (const kind of KINDS) {
    for (let tries = 0; ; tries++) {
      if (tries > 10000) throw new Error('holes: 빈자리를 겹치지 않게 놓지 못함');
      const w = q(10 + rnd() * 20), d = q(10 + rnd() * 20);
      const x0 = q(-HALF + rnd() * (2 * HALF - w)), z0 = q(-HALF + rnd() * (2 * HALF - d));
      const h = { kind, min: [x0, z0], max: [x0 + w, z0 + d] };
      if (h.max[0] > HALF || h.max[1] > HALF) continue;
      // 겹침 금지(맞닿음도 피하도록 1 m 여유)
      const clash = holes.some((o) => h.min[0] < o.max[0] + 1 && o.min[0] < h.max[0] + 1 && h.min[1] < o.max[1] + 1 && o.min[1] < h.max[1] + 1);
      if (!clash) { holes.push(h); break; }
    }
  }
  return holes;
}

const inHole = (holes, x, z) => holes.some((h) => x >= h.min[0] && x <= h.max[0] && z >= h.min[1] && z <= h.max[1]);

/** 무늬: 2 m 체크 + 점별 잡음. 위치로부터 결정적. */
function color(x, z, rnd) {
  const check = ((Math.floor(x / 2) + Math.floor(z / 2)) & 1) === 0;
  const base = check ? [150, 120, 80] : [70, 100, 60];
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) out[k] = Math.max(0, Math.min(255, Math.round(base[k] + (rnd() - 0.5) * 50)));
  return out;
}

/** @param {import('../../../contracts/scenes/index.mjs').GenerateOptions} opts */
export function generate(opts = {}) {
  const seed = normalizeSeed(opts.seed);
  const n = checkCount(opts.count, DEFAULT_COUNT);
  const format = checkFormat(opts.format);
  const holes = placeHoles(seed);
  const rnd = mulberry32(subSeed(seed, 2));
  const positions = new Float32Array(3 * n);
  const normals = new Float32Array(3 * n);
  const colors = new Uint8Array(3 * n);
  for (let i = 0; i < n; ) {
    // 저장될 f32 값으로 판정해 반올림 때문에 빈자리에 걸치는 일이 없게 한다.
    const x = Math.fround(-HALF + rnd() * 2 * HALF), z = Math.fround(-HALF + rnd() * 2 * HALF);
    if (inHole(holes, x, z)) continue;
    positions[3 * i] = x; positions[3 * i + 1] = 0; positions[3 * i + 2] = z;
    normals[3 * i + 1] = 1;
    colors.set(color(x, z, rnd), 3 * i);
    i++;
  }
  let holeAreaM2 = 0;
  for (const h of holes) holeAreaM2 += (h.max[0] - h.min[0]) * (h.max[1] - h.min[1]);
  const truth = {
    bounds: { min: [-HALF, 0, -HALF], max: [HALF, 0, HALF] },
    holes, holeAreaM2, areaM2: AREA_M2, holeFraction: holeAreaM2 / AREA_M2,
  };
  return makeResult('holes', seed, format, { format: FORMAT_POINT27, count: n, positions, normals, colors }, truth);
}
