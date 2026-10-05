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

// F-355: 부분 지붕·감김 혼재 입력. 기단 위 6 m 에 없는 110 m 지붕이 생기면 안 된다.
const MIXED = {
  cwBaseTopCcwTower: () => join([column(0, 0, 40, 40, 0, 6, false), column(10, 10, 30, 30, 6, 110, true)]),
  wallOnlyBaseCcwTower: () => join([column(0, 0, 40, 40, 0, 6, true, false), column(10, 10, 30, 30, 6, 110, true)]),
  // F-355 다시 열림: 안쪽 법선 기단 벽(−1 고리) + z=0 아래 향한 바닥(뒤집으면 +1) 은 한 감김수로 합치면 서로 지워진다. 위 향한 지붕은 탑 위에만 있다.
  innerWallFloorBaseCcwTower: () => {
    const wall = column(0, 0, 40, 40, 0, 6, false, false);
    const floor = { pos: wall.pos, idx: [0, 2, 1, 0, 3, 2] }; // z=0 4정점, 아래를 향함(xy 투영 시계)
    return join([wall, floor, column(10, 10, 30, 30, 6, 110, true)]);
  },
  // 3000 m 에서도 변경 전 코드가 상자로 바꾸는 작은 크기(귀퉁이 거리 2.8 m < tol 5.8 m)
  smallCwBase: () => join([column(0, 0, 12, 12, 0, 6, false), column(2, 2, 10, 10, 6, 110, true)]),
  smallWallOnlyBase: () => join([column(0, 0, 12, 12, 0, 6, true, false), column(2, 2, 10, 10, 6, 110, true)]),
};

for (const dist of [3000, 5000, 20000]) {
  for (const [name, make] of Object.entries(MIXED)) {
    test(`${dist} m: ${name} 는 원본 유지`, () => {
      const mesh = make();
      const out = buildBuildingLod([{ id: 7, mesh }], dist);
      assert.equal(out.length, 1);
      assert.ok(same(out[0].mesh.indices, mesh.indices) && same(out[0].mesh.positions, mesh.positions));
    });
  }
}

test('정상 반시계 기둥은 지붕을 덮으므로 상자 10삼각형이 된다(막지 않는다)', () => {
  const mesh = join([column(0, 0, 40, 40, 0, 6, true)]);
  const out = buildBuildingLod([{ id: 1, mesh }], 5000);
  assert.equal(out[0].mesh.indices.length / 3, 10);
});

for (const dist of [3000, 5000]) {
  // 대조용: 이 3000 m 벽만 경우는 감김 합산을 되돌린 변이에서도 통과하므로 F-355 를 지키지 않는다. 지키는 시험은 위 MIXED 의 innerWallFloorBaseCcwTower 다.
  test(`${dist} m: 윗면 없는 벽 14삼각형 메시(3x3 m)는 원본 유지`, () => {
    // 3 x 3 m 기둥의 벽 8삼각형 + 같은 벽 면 6삼각형 = 14삼각형, 윗면 0. 변경 전 코드에서는 상자 10삼각형이 된다.
    const w = column(0, 0, 3, 3, 0, 3, true, false);
    const mesh = join([w]);
    mesh.indices = new Uint32Array([...w.idx, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6]);
    assert.equal(mesh.indices.length / 3, 14);
    assert.equal(upCount(mesh), 0);
    const out = buildBuildingLod([{ id: 1, mesh }], dist);
    assert.equal(out.length, 1);
    assert.ok(same(out[0].mesh.indices, mesh.indices) && same(out[0].mesh.positions, mesh.positions));
  });

  test(`${dist} m: 시계 방향 기단+탑은 원본 유지`, () => {
    const mesh = join([column(0, 0, 40, 40, 0, 6, false), column(10, 10, 30, 30, 6, 110, false)]);
    assert.equal(upCount(mesh), 0);
    const out = buildBuildingLod([{ id: 7, mesh }], dist);
    assert.equal(out.length, 1);
    assert.ok(same(out[0].mesh.indices, mesh.indices) && same(out[0].mesh.positions, mesh.positions));
  });

  test(`${dist} m: 부분 지붕(지붕 삼각형 하나만 반시계, 하나는 시계)은 원본 유지`, () => {
    const c = column(0, 0, 40, 40, 0, 20, true);
    const n = c.idx.length;
    // 지붕 두 삼각형 중 둘째의 감김을 뒤집는다: 위를 향한 삼각형은 있으나 외곽 절반만 덮는다.
    const idx = c.idx.slice();
    [idx[n - 2], idx[n - 1]] = [idx[n - 1], idx[n - 2]];
    const mesh = join([{ pos: c.pos, idx }]);
    assert.equal(upCount(mesh), 1);
    const out = buildBuildingLod([{ id: 3, mesh }], dist);
    assert.ok(same(out[0].mesh.indices, mesh.indices) && same(out[0].mesh.positions, mesh.positions));
  });
}
