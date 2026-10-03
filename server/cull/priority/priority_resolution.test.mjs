// F-120 극단 해상도 시험: 합법 극단 해상도는 2 초 안에 정상 출력, 불법 해상도는 던지지 않고 빈 결과.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate as terrain } from '../../../fixtures/scenes/terrain/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { leafPriority, orderChunks } from './index.mjs';

const { cloud } = terrain({ seed: 1, count: 20000 });
const h = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 4, maxLeafPoints: 512 });
const n = h.octree.leafCount;
const LIMIT_MS = 2000;

// 장면 중심을 내려다보는 카메라(R = 아래를 향함). 해상도·초점거리만 바꾼다.
function cam(width, height, f = 500) {
  let c = [0, 0, 0];
  for (let i = 0; i < 3; i++) { let s = 0; for (let k = 0; k < cloud.count; k++) s += cloud.positions[3 * k + i]; c[i] = s / cloud.count; }
  const R = [1, 0, 0, 0, -1, 0, 0, 0, -1]; // 카메라 z = 월드 -z (아래를 봄), det = +1
  const t = [-c[0], c[1], c[2] + 60];
  return { width, height, K: { fx: f, fy: f, cx: width / 2, cy: height / 2 }, R, t };
}
const timed = (fn) => { const t0 = performance.now(); const r = fn(); return [r, performance.now() - t0]; };

// 한 변 상한 1e6 때문에 1x2^26 같은 가는 해상도는 불법. 합법 극단: 정사각 상한, 2^26 경계, 한 변 1e6.
const LEGAL = [[8192, 8192], [1000, 67108], [67108, 1000], [1e6, 67], [67, 1e6], [1e6, 1], [1, 1e6], [1, 1]];
for (const [w, hh] of LEGAL) {
  test(`합법 ${w}x${hh}`, () => {
    const c = cam(w, hh);
    const [p, ms1] = timed(() => leafPriority(h, c));
    assert.equal(p.length, n);
    assert.ok(p.every((v) => Number.isFinite(v) && v >= 0));
    const mask = new Uint8Array(n).fill(1);
    mask[0] = 0;
    const [o, ms2] = timed(() => orderChunks(h, c, mask));
    assert.deepEqual([...o].sort((a, b) => a - b), Array.from({ length: n - 1 }, (_, i) => i + 1));
    console.log(`  ${w}x${hh}: leafPriority ${ms1.toFixed(0)} ms, orderChunks ${ms2.toFixed(0)} ms`);
    assert.ok(ms1 < LIMIT_MS && ms2 < LIMIT_MS, `느림: ${ms1} / ${ms2}`);
  });
}

for (const [w, hh] of [[2e9, 1080], [1080, 2e9], [1, 67108864], [67108864, 1], [1000, 67109], [8193, 8193], [1e6 + 1, 1], [1, 1e6 + 1], [60000, 60000], [1.5, 100]]) {
  test(`불법 ${w}x${hh}`, () => {
    const c = cam(w, hh);
    const [p, ms] = timed(() => leafPriority(h, c));
    assert.equal(p.length, n);
    assert.ok(p.every((v) => v === 0));
    assert.equal(orderChunks(h, c, new Uint8Array(n).fill(1)).length, 0);
    assert.ok(ms < LIMIT_MS);
  });
}
