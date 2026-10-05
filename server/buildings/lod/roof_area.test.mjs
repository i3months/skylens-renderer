// F-360: 지붕 넓이 검사의 비용 상한과 근거리 생략. F-355: 삼각형 쪽·벽 쪽 감김을 따로 센다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBuildingLod } from './index.mjs';
import { prism } from './scene.mjs';

// 같은 높이(z=5) 직사각 지붕을 L 장 겹쳐 쌓은 메시(한 장은 삼각형 2개, 층마다 가장자리를 0.01 m 씩 안쪽으로).
// 합집합은 가장 바깥 직사각 하나라 상자와 일치(오차 0)하고, 선분이 서로 상쇄되지 않아 작업량이 L² 으로 는다.
// 작업량 상한(400000)은 L=150 에서는 아래, L=160 부터는 위다(측정: roof_area 시험 작성 때 L=150 으로 상자, 160 으로 원본 유지 확인).
function layers(L, ox = 0, oy = 0) {
  const pos = [], idx = [];
  for (let i = 0; i < L; i++) {
    const e = i * 0.01, o = pos.length / 3;
    pos.push(ox + e, oy + e * 1.3, 5, ox + 30 - e, oy + e * 1.3, 5, ox + 30 - e, oy + 30 - e * 0.7, 5, ox + e, oy + 30 - e * 0.7, 5);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

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

test('위 향한 부채꼴 삼각형 10000개 한 동은 1 s 미만이고 원본 유지(자기 상자와의 오차가 큼)', () => {
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

// F-368 ①: 상한을 넘으면 '통과' 가 아니라 원본 유지다. 같은 모양의 상한 아래 메시는 20000 m 에서 상자 10삼각형이 되므로 상한만 다르다.
test('작업량 상한을 넘는 메시는 20000 m 에서도 원본 유지, 상한 아래 같은 모양은 상자', () => {
  const under = layers(150), over = layers(200);
  const u = buildBuildingLod([{ id: 1, mesh: under }], 20000);
  assert.equal(u[0].mesh.indices.length / 3, 10, '상한 아래는 상자(오차 0)');
  const o = buildBuildingLod([{ id: 1, mesh: over }], 20000);
  assert.ok(same(o[0].mesh.indices, over.indices), '상한 초과는 원본 유지');
  assert.ok(same(o[0].mesh.positions, over.positions));
});

// F-368 ②: 근거리 생략. 상한 아래에서 가장 비싼 층 메시 200동은 원거리 검사 시 약 0.5 s(측정: Node 22, 4코어)이고
// 근거리에서 검사를 하면 그만큼 늘어난다. 정상은 약 16 ms 다.
test('근거리(300 m)는 상한 아래 비싼 메시 200동도 100 ms 이하(검사를 안 한다)', () => {
  const bs = [];
  for (let k = 0; k < 200; k++) bs.push({ id: k + 1, mesh: layers(150, (k % 15) * 40, Math.floor(k / 15) * 40) });
  const near = best(() => buildBuildingLod(bs, 300));
  assert.ok(near <= 100, `${near.toFixed(1)} ms`);
  // 대조: 같은 입력이 원거리에서는 검사가 실제로 돈다(느려진다). 근거리 단언이 빈 시험이 아님을 보인다.
  const far = best(() => buildBuildingLod(bs, 5000));
  assert.ok(far > near * 3, `near ${near.toFixed(1)} ms, far ${far.toFixed(1)} ms`);
});

// F-368 ③: 양성 대조. 상한 아래의 정상 프리즘은 원거리에서 상자가 된다(상한 0 이면 전부 원본 유지가 되어 이 시험이 깨진다).
test('상한 아래 정상 프리즘(한 변에 꼭짓점이 하나 더 있는 30x30x3 m)은 원거리에서 상자 10삼각형', () => {
  // 원본은 10삼각형이 아니어야 상자와 구분된다(지붕 3삼각형 + 벽 10삼각형).
  const mesh = prism([[0, 0], [15, 0], [30, 0], [30, 30], [0, 30]], 3);
  assert.ok(mesh.indices.length / 3 > 10);
  for (const dist of [3000, 5000, 20000]) {
    const out = buildBuildingLod([{ id: 1, mesh }], dist);
    assert.equal(out.length, 1);
    assert.equal(out[0].mesh.indices.length / 3, 10, `${dist} m`);
    assert.ok(!same(out[0].mesh.indices, mesh.indices), `${dist} m`);
  }
});

// F-367: 삼각형 800개 격자 지붕(정점 xy 를 0.3 m 흔든 것) 200동 원거리 5000 m 빌드는 1 s 이하(개선 전 약 4.2~6.3 s).
test('삼각형 800개 격자 지붕 200동 5000 m 빌드는 1 s 이하', () => {
  const N = 20, bs = [];
  for (let k = 0; k < 200; k++) {
    const ox = (k % 15) * 40, oy = Math.floor(k / 15) * 40, pos = [], idx = [];
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) pos.push(ox + i + Math.sin(i * 7.1 + j * 3.3) * 0.3, oy + j + Math.cos(i * 2.9 + j * 5.7) * 0.3, 5);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1; idx.push(a, b, d, a, d, c); }
    bs.push({ id: k + 1, mesh: { positions: new Float32Array(pos), indices: new Uint32Array(idx) } });
  }
  const ms = best(() => buildBuildingLod(bs, 5000));
  assert.ok(ms <= 1000, `${ms.toFixed(1)} ms`);
});
