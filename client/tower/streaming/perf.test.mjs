// 조각 요청 층 update 성능 시험. 합성 시점 120개 경로를 재생해 update 한 번 평균 시간을 잰다.
// 단언: 한 번 평균의 중앙값 ≤ 4 ms(이 상한은 측정에 맞춰 낮추지 않는다), maxDistM 1500·광각 시점의 needed ≤ 4096.
// CI 에서 흔들리지 않게 경로 재생을 여러 번 반복해 중앙값을 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createTowerStreaming } from './index.mjs';
import { poseToCameraPose } from '../input/camera.mjs';

const N_POSES = 120;
const ROUNDS = 9; // 경로 재생 반복 수(중앙값용)
const MAX_MS = 4;
const MAX_NEEDED = 4096;
const SIZE = { width: 1280, height: 720 };
const FOV_NORMAL = 1.0;
const FOV_WIDE = 2.4; // 광각(약 137°)

/** 결정적 합성 경로: 고도 60~140 m 를 오가며 선회·이동하는 120개 시점. */
function makePath(fovY) {
  const poses = [];
  for (let i = 0; i < N_POSES; i += 1) {
    poses.push(poseToCameraPose({
      pos: [i * 25 - 1500, Math.sin(i * 0.1) * 400, 100 + 40 * Math.sin(i * 0.2)],
      yaw: i * 0.15,
      pitch: -0.3 + 0.2 * Math.sin(i * 0.07),
    }, fovY));
  }
  return poses;
}

/** 경로를 한 번 재생(요청은 즉시 도착)하며 update 만 재어 한 번 평균(ms)과 최대 needed 를 돌려준다. */
function replay(poses, opts) {
  const s = createTowerStreaming(opts);
  let total = 0;
  let maxNeeded = 0;
  for (const pose of poses) {
    const t0 = performance.now();
    const plan = s.update(pose, SIZE);
    total += performance.now() - t0;
    if (plan.needed.length > maxNeeded) maxNeeded = plan.needed.length;
    for (const t of plan.request) s.arrived(t.tx, t.ty);
  }
  return { meanMs: total / poses.length, maxNeeded };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test('perf: 120개 시점 경로 재생 update 한 번 평균(중앙값) ≤ 4 ms', () => {
  const poses = makePath(FOV_NORMAL);
  replay(poses); // 데우기
  const means = [];
  for (let r = 0; r < ROUNDS; r += 1) means.push(replay(poses).meanMs);
  const ms = median(means);
  console.log(`streaming perf: update 한 번 평균 중앙값 ${ms.toFixed(3)} ms (상한 ${MAX_MS} ms, ${ROUNDS}회 중 최소 ${Math.min(...means).toFixed(3)}·최대 ${Math.max(...means).toFixed(3)})`);
  assert.ok(ms <= MAX_MS, `중앙값 ${ms.toFixed(3)} ms > ${MAX_MS} ms`);
});

test('perf: 광각 시점에서도 update 한 번 평균(중앙값) ≤ 4 ms', () => {
  const poses = makePath(FOV_WIDE);
  replay(poses);
  const means = [];
  for (let r = 0; r < ROUNDS; r += 1) means.push(replay(poses).meanMs);
  const ms = median(means);
  console.log(`streaming perf(광각): update 한 번 평균 중앙값 ${ms.toFixed(3)} ms (상한 ${MAX_MS} ms)`);
  assert.ok(ms <= MAX_MS, `중앙값 ${ms.toFixed(3)} ms > ${MAX_MS} ms`);
});

test('perf: maxDistM 1500·광각 시점의 needed ≤ 4096', () => {
  const { maxNeeded } = replay(makePath(FOV_WIDE), { maxDistM: 1500 });
  console.log(`streaming perf: 광각 최대 needed ${maxNeeded} (상한 ${MAX_NEEDED})`);
  assert.ok(maxNeeded > 0, 'needed 가 비어 있으면 시험이 무의미함');
  assert.ok(maxNeeded <= MAX_NEEDED, `needed ${maxNeeded} > ${MAX_NEEDED}`);
});
