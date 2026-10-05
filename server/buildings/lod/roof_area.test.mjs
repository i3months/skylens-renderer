// F-360: 지붕 넓이 검사의 비용 상한과 근거리 생략. F-355: 삼각형 쪽·벽 쪽 감김을 따로 센다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBuildingLod } from './index.mjs';
import { prism } from './scene.mjs';

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
// 기준값은 F-360 확인 기준 그대로(수치를 측정에 맞춰 바꾸지 않는다). 가장 빠른 3회로 부하 잡음을 거른다.
const best = (f) => { let b = Infinity; for (let i = 0; i < 3; i++) { const t = performance.now(); f(); b = Math.min(b, performance.now() - t); } return b; };

test('n=4096 원통 프리즘 한 동은 100 ms 이하(원거리, 근거리)', () => {
  const n = 4096;
  const ring = [];
  for (let i = 0; i < n; i++) ring.push([20 * Math.cos((2 * Math.PI * i) / n), 20 * Math.sin((2 * Math.PI * i) / n)]);
  const mesh = prism(ring, 3);
  for (const dist of [300, 5000]) {
    const ms = best(() => buildBuildingLod([{ id: 1, mesh }], dist));
    assert.ok(ms <= 100, `${dist} m: ${ms.toFixed(1)} ms`);
  }
});

test('위 향한 부채꼴 삼각형 10000개 한 동은 1 s 미만이고 원본 유지(검사 불가)', () => {
  const T = 10000;
  const pos = [0, 0, 5];
  for (let i = 0; i <= T; i++) { const a = ((Math.PI * 2 * i) / T) * 0.9; pos.push(30 * Math.cos(a), 30 * Math.sin(a), 5); }
  const idx = [];
  for (let i = 1; i <= T; i++) idx.push(0, i, i + 1);
  const mesh = { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
  let out;
  const ms = best(() => { out = buildBuildingLod([{ id: 1, mesh }], 5000); });
  assert.ok(ms < 1000, `${ms.toFixed(1)} ms`);
  assert.ok(same(out[0].mesh.indices, mesh.indices));
});

test('근거리(500 m 미만)는 지붕 넓이 검사를 하지 않는다: 부채꼴 10000개가 30 ms 이하', () => {
  const T = 10000;
  const pos = [0, 0, 5];
  for (let i = 0; i <= T; i++) { const a = ((Math.PI * 2 * i) / T) * 0.9; pos.push(30 * Math.cos(a), 30 * Math.sin(a), 5); }
  const idx = [];
  for (let i = 1; i <= T; i++) idx.push(0, i, i + 1);
  const mesh = { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
  const near = best(() => buildBuildingLod([{ id: 1, mesh }], 100));
  assert.ok(near <= 30, `${near.toFixed(1)} ms`);
});
