// 건물 외곽 돌출 장면(관제탑용). 점군이 아니라 footprint 사각형 + 높이 목록이 본체다.
// 계약상 SceneResult 를 따르므로 cloud 는 건물 지붕 중심점 1개씩(법선 (0,1,0), 색은 높이 기반)이고,
// 정답은 truth.buildings=[{id, min:[x,z], max:[x,z], height}] 로 기록한다.
// 배치: 격자 셀 + 셀 안 지터. 각 건물은 자기 셀 안쪽(가장자리 0.5 m 여유)에만 놓이므로 간격 ≥ 1 m, 겹침 0.
import { mulberry32, subSeed, makeResult, checkCount, normalizeSeed, checkFormat } from '../../../contracts/scenes/index.mjs';

const HALF = 1000; // x,z ∈ [-1000, 1000]
const SIDE_MIN = 8;
const SIDE_MAX = 30;
const H_MIN = 5;
const H_MAX = 60;
const GAP = 1;
const r2 = (v) => Math.round(v * 100) / 100;

/** @param {{seed:number,count?:number,format?:1|2}} opts */
export function generate(opts = {}) {
  const seed = normalizeSeed(opts.seed);
  const n = checkCount(opts.count, 1000);
  const format = checkFormat(opts.format);
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const cell = (2 * HALF) / cols;
  const sideMax = Math.min(SIDE_MAX, cell - GAP);
  if (sideMax < SIDE_MIN) throw new Error(`buildings: count ${n} 가 너무 커서 밑면 ${SIDE_MIN} m 를 둘 수 없음`);

  // 셀 순서를 결정적으로 섞어 앞 n 개를 쓴다(Fisher-Yates).
  const order = Array.from({ length: cols * cols }, (_, i) => i);
  const rs = mulberry32(subSeed(seed, 0));
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rs() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const buildings = [];
  const positions = new Float32Array(3 * n);
  const normals = new Float32Array(3 * n);
  const colors = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) {
    const rnd = mulberry32(subSeed(seed, i + 1));
    const c = order[i];
    const x0 = -HALF + (c % cols) * cell;
    const z0 = -HALF + Math.floor(c / cols) * cell;
    const w = r2(SIDE_MIN + rnd() * (sideMax - SIDE_MIN));
    const d = r2(SIDE_MIN + rnd() * (sideMax - SIDE_MIN));
    const height = r2(H_MIN + rnd() * (H_MAX - H_MIN));
    const m = GAP / 2;
    // 셀 안쪽 [x0+m, x0+cell-m] 에 들어가도록 지터. 반올림 오차 방지로 0.01 여유.
    const minX = r2(x0 + m + 0.01 + rnd() * Math.max(0, cell - GAP - w - 0.02));
    const minZ = r2(z0 + m + 0.01 + rnd() * Math.max(0, cell - GAP - d - 0.02));
    const b = { id: i, min: [minX, minZ], max: [r2(minX + w), r2(minZ + d)], height };
    buildings.push(b);
    positions[3 * i] = (b.min[0] + b.max[0]) / 2;
    positions[3 * i + 1] = height;
    positions[3 * i + 2] = (b.min[1] + b.max[1]) / 2;
    normals[3 * i + 1] = 1;
    // 높이 기반 색: 낮음 = 청록, 높음 = 주황. 건물별 미세 변화로 무늬.
    const t = (height - H_MIN) / (H_MAX - H_MIN);
    const jit = Math.floor(rnd() * 16);
    colors[3 * i] = Math.min(255, Math.round(40 + 200 * t) + jit);
    colors[3 * i + 1] = Math.round(160 - 60 * t) + jit;
    colors[3 * i + 2] = Math.round(220 - 180 * t);
  }
  const cloud27 = { format: 1, count: n, positions, normals, colors };
  const truth = {
    bounds: { min: [-HALF, 0, -HALF], max: [HALF, H_MAX, HALF] },
    buildings,
    minGap: GAP,
  };
  return makeResult('buildings', seed, format, cloud27, truth);
}
