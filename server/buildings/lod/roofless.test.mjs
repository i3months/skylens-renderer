// F-327: 위를 향한 넓이 있는 삼각형이 없는 건물은 상자로 바꾸지 않고 원본을 유지한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBuildingLod } from './index.mjs';

// z0~z1 직사각 기둥. ccw=false 면 모든 삼각형의 감김을 뒤집는다(계약과 반대인 시계 방향).
function column(x0, y0, x1, y1, z0, z1, ccw, withTop = true) {
  const pos = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const idx = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    idx.push(i, j, 4 + j, i, 4 + j, 4 + i);
  }
  if (withTop) idx.push(4, 5, 6, 4, 6, 7);
  const out = ccw ? idx : idx.map((_, k) => idx[k - (k % 3) + [0, 2, 1][k % 3]]);
  return { pos, idx: out };
}
function join(parts) {
  const pos = [], idx = [];
  for (const p of parts) {
    const off = pos.length / 3;
    pos.push(...p.pos);
    idx.push(...p.idx.map((v) => v + off));
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}
// 위를 향한 넓이 있는 삼각형 수(xy 투영이 반시계).
function upCount(m) {
  let n = 0;
  const p = m.positions, ix = m.indices;
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = [ix[t] * 3, ix[t + 1] * 3, ix[t + 2] * 3];
    const area = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[c] - p[a]) * (p[b + 1] - p[a + 1]);
    if (area > 1e-6) n++;
  }
  return n;
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

for (const dist of [3000, 5000]) {
  test(`${dist} m: 윗면 없는 벽 14삼각형 메시는 원본 유지`, () => {
    // 10 x 10 m 기둥의 벽 8삼각형 + 같은 벽 면 6삼각형 = 14삼각형, 윗면 0.
    const w = column(0, 0, 10, 10, 0, 30, true, false);
    const mesh = join([w]);
    mesh.indices = new Uint32Array([...w.idx, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6]);
    assert.equal(mesh.indices.length / 3, 14);
    assert.equal(upCount(mesh), 0);
    const out = buildBuildingLod([{ id: 1, mesh }], dist);
    assert.equal(out.length, 1);
    assert.ok(same(out[0].mesh.indices, mesh.indices) && same(out[0].mesh.positions, mesh.positions));
    assert.equal(upCount(out[0].mesh), 0);
  });

  test(`${dist} m: 시계 방향 기단+탑은 원본 유지`, () => {
    const mesh = join([column(0, 0, 40, 40, 0, 6, false), column(10, 10, 30, 30, 6, 110, false)]);
    assert.equal(upCount(mesh), 0);
    const out = buildBuildingLod([{ id: 7, mesh }], dist);
    assert.equal(out.length, 1);
    assert.ok(same(out[0].mesh.indices, mesh.indices) && same(out[0].mesh.positions, mesh.positions));
    assert.ok(upCount(out[0].mesh) <= upCount(mesh));
  });
}
