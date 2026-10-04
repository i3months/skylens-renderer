import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBlackBuilding, EDGE_ANGLE_THRESHOLD_DEG } from './index.mjs';

const H = 30;

// 귀 자르기 삼각분할(반시계 단순 다각형, 오목 허용)
function triangulate(ring) {
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  const idx = ring.map((_, i) => i);
  const out = [];
  while (idx.length > 3) {
    let cut = false;
    for (let i = 0; i < idx.length && !cut; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (cross(ring[a], ring[b], ring[c]) <= 1e-9) continue;
      if (idx.some((k) => k !== a && k !== b && k !== c && inside(ring[k], ring[a], ring[b], ring[c]))) continue;
      out.push([a, b, c]); idx.splice(i, 1); cut = true;
    }
    assert.ok(cut, '삼각분할 실패');
  }
  out.push([idx[0], idx[1], idx[2]]);
  return out;
}

// 벽·지붕·바닥이 정점을 따로 가지는 프리즘 (반시계 링, 벽 사각형 2삼각형 = 대각선 포함)
function prism(ring) {
  const n = ring.length, pos = [], ind = [];
  const tris = triangulate(ring);
  const base = pos.length / 3;
  ring.forEach(([x, y]) => pos.push(x, y, H)); // 지붕
  tris.forEach(([a, b, c]) => ind.push(base + a, base + b, base + c));
  const fb = pos.length / 3;
  ring.forEach(([x, y]) => pos.push(x, y, 0)); // 바닥(아래를 향함)
  tris.forEach(([a, b, c]) => ind.push(fb + a, fb + c, fb + b));
  for (let i = 0; i < n; i++) { // 벽
    const j = (i + 1) % n, w = pos.length / 3;
    pos.push(ring[i][0], ring[i][1], 0, ring[j][0], ring[j][1], 0, ring[j][0], ring[j][1], H, ring[i][0], ring[i][1], H);
    ind.push(w, w + 1, w + 2, w, w + 2, w + 3);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(ind) };
}

const rect = [[0, 0], [40, 0], [40, 20], [0, 20]];
const lShape = [[0, 0], [40, 0], [40, 15], [15, 15], [15, 40], [0, 40]];
const uShape = [[0, 0], [60, 0], [60, 40], [45, 40], [45, 15], [15, 15], [15, 40], [0, 40]];
const circle = Array.from({ length: 32 }, (_, i) => [50 * Math.cos((2 * Math.PI * i) / 32), 50 * Math.sin((2 * Math.PI * i) / 32)]);

const cases = [['사각', rect, 4], ['L자', lShape, 6], ['U자', uShape, 8], ['원 근사', circle, 32]];

for (const [name, ring, n] of cases) {
  test(`${name} ${n}각 프리즘: 선 수 = 3n`, () => {
    const { edgeLines } = buildBlackBuilding(prism(ring));
    assert.equal(edgeLines.length / 6, 3 * n);
  });

  test(`${name}: 대각선 미포함, 모든 선이 지붕·바닥 외곽 변 또는 수직 모서리`, () => {
    const { edgeLines } = buildBlackBuilding(prism(ring));
    const q = (v) => Math.round(v * 100) + 0; // -0 제거
    const key = (x, y) => `${q(x)},${q(y)}`;
    const ringEdges = new Set();
    for (let i = 0; i < n; i++) {
      const a = key(...ring[i]), b = key(...ring[(i + 1) % n]);
      ringEdges.add(`${a}|${b}`); ringEdges.add(`${b}|${a}`);
    }
    for (let i = 0; i < edgeLines.length; i += 6) {
      const [x0, y0, z0, x1, y1, z1] = edgeLines.subarray(i, i + 6);
      if (x0 === x1 && y0 === y1) { // 수직 모서리
        assert.deepEqual([z0, z1].sort(), [0, H]);
      } else {
        assert.equal(z0, z1);
        assert.ok(z0 === 0 || z0 === H);
        assert.ok(ringEdges.has(`${key(x0, y0)}|${key(x1, y1)}`), '링 변이 아닌 대각선');
      }
    }
  });

  test(`${name}: 같은 입력 → 같은 바이트, mesh 는 그대로`, () => {
    const m = prism(ring);
    const a = buildBlackBuilding(m), b = buildBlackBuilding(prism(ring));
    assert.equal(a.mesh, m);
    assert.deepEqual(Buffer.from(a.edgeLines.buffer), Buffer.from(b.edgeLines.buffer));
  });
}

test('임계는 5도', () => assert.equal(EDGE_ANGLE_THRESHOLD_DEG, 5));

test('정점을 공유하는 프리즘(지붕·벽 공용 정점)도 선 수 = 3n', () => {
  // 사각 육면체, 정점 8개 공유
  const pos = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, H, 10, 0, H, 10, 10, H, 0, 10, H]);
  const ind = new Uint32Array([4, 5, 6, 4, 6, 7, 0, 3, 2, 0, 2, 1, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  assert.equal(buildBlackBuilding({ positions: pos, indices: ind }).edgeLines.length / 6, 12);
});
