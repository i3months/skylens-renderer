// 구간×4수준 점 수 사다리 장면(T05.4). 새로 작성한 코드이며 외부 코드를 차용하지 않았다.
// 구간 s 는 x∈[50s, 50(s+1)], z∈[-50,50] 의 띠이고 지면은 y=0 에 완만한 기복(±2 m)을 더한 것이다.
// 구간별 최고 수준 점군이 cloud 에 연속으로 들어 있고(구간 s 는 [s*count, (s+1)*count)),
// 낮은 수준은 그 점들 중 앞에서부터 균등 간격으로 뽑은 부분집합이다(교체이지 누적이 아니다).

import { mulberry32, subSeed, makeResult, LEVEL_STEPS, FORMAT_POINT27, checkCount, normalizeSeed, checkFormat } from '../../../contracts/scenes/index.mjs';

const STRIP = 50;
// 수준(최고 기준 위에서부터)별 분모. 8:4:2:1 은 낮은 수준일수록 성긴 점(250 스텝이 가장 성김)이라는
// 계약(RULES §1.1)만 만족하면 되는 합성용 임의 선택이며, 실제 학습 스텝(250/1000/3500/7000)의 비율이나
// 측정에서 나온 값이 아니다. 비율이 정수 2배 사다리라 count 가 8 이상이면 수준 점 수가 엄격 증가한다.
const RATIOS = [8, 4, 2, 1];
const AMP = 2;

/** 기복의 파라미터를 시드에서 뽑는다(구간 경계에서 이어지도록 전 장면 공통). */
function reliefParams(seed) {
  const r = mulberry32(subSeed(seed, 1000));
  const T = 2 * Math.PI;
  return { p: [r() * T, r() * T, r() * T, r() * T] };
}

// 진폭 합 1.0+0.6+0.4 = 2.0 → |y| ≤ 2
function height(rp, x, z) {
  const [a, b, c, d] = rp.p;
  return Math.sin(0.11 * x + a) * Math.cos(0.09 * z + b) + 0.6 * Math.sin(0.23 * x + 0.19 * z + c) + 0.4 * Math.cos(0.31 * z + d);
}

function normalAt(rp, x, z) {
  const [a, b, c, d] = rp.p;
  const hx = 0.11 * Math.cos(0.11 * x + a) * Math.cos(0.09 * z + b) + 0.6 * 0.23 * Math.cos(0.23 * x + 0.19 * z + c);
  const hz = -0.09 * Math.sin(0.11 * x + a) * Math.sin(0.09 * z + b) + 0.6 * 0.19 * Math.cos(0.23 * x + 0.19 * z + c) - 0.4 * 0.31 * Math.sin(0.31 * z + d);
  const nx = -hx, ny = 1, nz = -hz;
  const l = Math.hypot(nx, ny, nz);
  return [nx / l, ny / l, nz / l];
}

/** 수준 k(0..L-1)의 점 수. 최고 수준(L-1)이 count. 올림 없이 floor, 최소 1. */
export function levelCounts(count, levels) {
  const out = [];
  for (let k = 0; k < levels; k++) out.push(Math.max(1, Math.floor(count / RATIOS[k + (4 - levels)])));
  return out;
}

/** 최고 수준 N 개 중 앞에서부터 균등 간격으로 n 개의 색인. 엄격 증가. */
function spaced(N, n) {
  const idx = new Array(n);
  for (let j = 0; j < n; j++) idx[j] = Math.floor((j * N) / n);
  return idx;
}

export function generate(options) {
  const opts = options ?? {};
  const seed = normalizeSeed(opts.seed);
  const format = checkFormat(opts.format);
  const segments = opts.segments ?? 8;
  const levels = opts.levels ?? 4;
  const count = checkCount(opts.count, 20000);
  if (!Number.isInteger(segments) || segments < 1) throw new RangeError('segments 는 1 이상 정수');
  if (!Number.isInteger(levels) || levels < 1 || levels > 4) throw new RangeError('levels 는 1..4');
  // 수준 점 수가 엄격 증가하려면 가장 성긴 수준이 floor(count/분모) >= 1 이고 이웃 수준이 서로 달라야 한다:
  // 분모가 2배씩이므로 count >= RATIOS[4-levels] (levels=4 → 8, 3 → 4, 2 → 2, 1 → 1) 이면 충분하다.
  const minCount = RATIOS[4 - levels];
  if (count < minCount) throw new RangeError(`levels=${levels} 이면 count 는 ${minCount} 이상이어야 수준 점 수가 엄격 증가함: ${count}`);

  const rp = reliefParams(seed);
  const total = segments * count;
  const positions = new Float32Array(3 * total);
  const normals = new Float32Array(3 * total);
  const colors = new Uint8Array(3 * total);
  const counts = levelCounts(count, levels);
  const segTruth = [];

  for (let s = 0; s < segments; s++) {
    const rnd = mulberry32(subSeed(seed, s));
    for (let j = 0; j < count; j++) {
      const i = s * count + j;
      const x = STRIP * s + rnd() * STRIP;
      const z = (rnd() * 2 - 1) * STRIP;
      positions[3 * i] = x;
      positions[3 * i + 1] = height(rp, x, z);
      positions[3 * i + 2] = z;
      const n = normalAt(rp, x, z);
      normals[3 * i] = n[0]; normals[3 * i + 1] = n[1]; normals[3 * i + 2] = n[2];
      // 무늬: 2 m 체크 + 구간별 색조 + 가는 줄무늬 + 약한 잡음
      const check = (Math.floor(x / 2) + Math.floor(z / 2)) & 1;
      const stripe = Math.sin(x * 1.7 + z * 0.9) > 0.6 ? 40 : 0;
      const tint = [(s * 53) % 80, (s * 97) % 80, (s * 31) % 80];
      const noise = Math.floor(rnd() * 16);
      const base = check ? 190 : 80;
      for (let k = 0; k < 3; k++) colors[3 * i + k] = Math.min(255, base + tint[k] * (k === s % 3 ? 1 : 0.4) + stripe + noise) | 0;
    }
    const lv = counts.map((n, k) => {
      const e = { level: k, step: LEVEL_STEPS[k + (4 - levels)], count: n };
      if (k < levels - 1) e.indices = spaced(count, n).map((q) => s * count + q);
      else { e.start = s * count; }
      return e;
    });
    segTruth.push({ id: s, levels: lv });
  }

  const truth = {
    bounds: { min: [0, -AMP, -STRIP], max: [STRIP * segments, AMP, STRIP] },
    segmentWidth: STRIP,
    relief: { amplitude: AMP, phases: rp.p },
    segments: segTruth,
  };
  const cloud27 = { format: FORMAT_POINT27, count: total, positions, normals, colors };
  return makeResult('levels', seed, format, cloud27, truth);
}

/**
 * 구간 segment 의 수준 level 점군을 27 B 형식으로 꺼낸다. 낮은 수준은 높은 수준의 부분집합이다.
 * 형식 2 결과면 색은 f_dc 에서, 법선은 기복 정답에서 복원한다.
 */
export function levelCloud(result, segment, level) {
  const seg = result.truth.segments.find((q) => q.id === segment);
  if (!seg) throw new RangeError(`없는 구간 ${segment}`);
  const lv = seg.levels[level];
  if (!lv) throw new RangeError(`없는 수준 ${level}`);
  const n = lv.count;
  const src = result.cloud;
  const positions = new Float32Array(3 * n);
  const normals = new Float32Array(3 * n);
  const colors = new Uint8Array(3 * n);
  const rp = { p: result.truth.relief.phases };
  const C0 = 0.28209479177387814;
  for (let j = 0; j < n; j++) {
    const i = lv.indices ? lv.indices[j] : lv.start + j;
    for (let k = 0; k < 3; k++) positions[3 * j + k] = src.positions[3 * i + k];
    if (src.normals) {
      for (let k = 0; k < 3; k++) { normals[3 * j + k] = src.normals[3 * i + k]; colors[3 * j + k] = src.colors[3 * i + k]; }
    } else {
      const nn = normalAt(rp, src.positions[3 * i], src.positions[3 * i + 2]);
      for (let k = 0; k < 3; k++) {
        normals[3 * j + k] = nn[k];
        colors[3 * j + k] = Math.min(255, Math.max(0, Math.round((src.fdc[3 * i + k] * C0 + 0.5) * 255)));
      }
    }
  }
  return { format: FORMAT_POINT27, count: n, positions, normals, colors };
}
