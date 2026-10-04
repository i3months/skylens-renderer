import test from 'node:test';
import assert from 'node:assert/strict';
import { extrudeBuilding, extrudeAll } from './index.mjs';
import { TowerAssetError } from '../../../contracts/tower_assets/index.mjs';

// 메시 통계: 지붕(z=높이)·벽·전체 부피(발산 정리), 삼각형 법선 방향 검사.
function stats(mesh, h) {
  const P = mesh.positions, I = mesh.indices;
  let roof = 0, wall = 0, floor = 0, vol = 0;
  for (let t = 0; t < I.length; t += 3) {
    const v = [0, 1, 2].map((k) => [P[3 * I[t + k]], P[3 * I[t + k] + 1], P[3 * I[t + k] + 2]]);
    const u = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
    const w = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
    const nx = u[1] * w[2] - u[2] * w[1], ny = u[2] * w[0] - u[0] * w[2], nz = u[0] * w[1] - u[1] * w[0];
    const a = Math.hypot(nx, ny, nz) / 2;
    vol += (v[0][0] * nx + v[0][1] * ny + v[0][2] * nz) / 6;
    if (v.every((p) => p[2] === h)) { roof += a; assert.ok(nz > 0, '지붕은 위를 향함'); }
    else if (v.every((p) => p[2] === 0)) { floor += a; assert.ok(nz < 0, '바닥은 아래를 향함'); }
    else wall += a;
  }
  return { roof, wall, floor, vol };
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-3, `${a} != ${b}`);

const L = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]]; // 넓이 7, 둘레 16
const U = [[0, 0], [5, 0], [5, 4], [4, 4], [4, 1], [1, 1], [1, 4], [0, 4]]; // 넓이 20-9=11, 둘레 24
const sq = [[0, 0], [2, 0], [2, 2], [0, 2]];

test('정사각형 2x2, 3층: 높이 9', () => {
  const m = extrudeBuilding({ id: 1, ring: sq, floors: 3 });
  const s = stats(m, 9);
  close(s.roof, 4); close(s.wall, 8 * 9); close(s.vol, 36);
  assert.equal(m.positions.length / 3, 8 + 16);
});

test('층 수 없으면 높이 6', () => {
  const s = stats(extrudeBuilding({ id: 1, ring: sq }), 6);
  close(s.vol, 24);
});

test('L자 오목: 넓이 7, 둘레 16, 높이 6', () => {
  const s = stats(extrudeBuilding({ id: 2, ring: L }), 6);
  close(s.roof, 7); close(s.wall, 96); close(s.vol, 42);
});

test('U자 오목, 2층: 넓이 11, 둘레 24', () => {
  const s = stats(extrudeBuilding({ id: 3, ring: U, floors: 2 }), 6);
  close(s.roof, 11); close(s.wall, 24 * 6); close(s.vol, 66);
});

test('시계/반시계 입력이 같은 결과', () => {
  for (const r of [L, U]) {
    const a = extrudeBuilding({ id: 1, ring: r });
    const b = extrudeBuilding({ id: 1, ring: [...r].reverse() });
    const sa = stats(a, 6), sb = stats(b, 6);
    close(sa.roof, sb.roof); close(sa.wall, sb.wall); close(sa.vol, sb.vol);
  }
});

test('닫힌 메시: 부피 양수(법선이 모두 바깥)', () => {
  assert.ok(stats(extrudeBuilding({ id: 1, ring: [...U].reverse() }), 6).vol > 0);
});

test('결정적: 같은 입력 같은 바이트', () => {
  const a = extrudeBuilding({ id: 1, ring: U }), b = extrudeBuilding({ id: 1, ring: U });
  assert.deepEqual(Buffer.from(a.positions.buffer), Buffer.from(b.positions.buffer));
  assert.deepEqual(Buffer.from(a.indices.buffer), Buffer.from(b.indices.buffer));
});

test('입력 ring 을 바꾸지 않는다', () => {
  const r = [...U].reverse().map((p) => [...p]);
  const copy = JSON.stringify(r);
  extrudeBuilding({ id: 1, ring: r });
  assert.equal(JSON.stringify(r), copy);
});

test('퇴화 다각형은 id 를 담은 TowerAssetError', () => {
  const bad = [
    [[0, 0], [1, 1]], [[0, 0], [1, 1], [2, 2]], [[0, 0], [1, 0], [1, 0]],
    [[0, 0], [2, 2], [2, 0], [0, 2]], [[0, 0], [NaN, 0], [1, 1]],
  ];
  for (const ring of bad) {
    assert.throws(() => extrudeBuilding({ id: 77, ring }), (e) => e instanceof TowerAssetError && e.message.includes('id=77'));
  }
});

test('extrudeAll: 한 동이라도 퇴화면 던지고 id 를 담음', () => {
  assert.throws(() => extrudeAll([{ id: 1, ring: sq }, { id: 9, ring: [[0, 0], [1, 1]] }]), (e) => e instanceof TowerAssetError && e.message.includes('id=9'));
});

test('100동 합성: 동 수·순서 보존, 넓이 합', () => {
  const fps = [];
  for (let i = 0; i < 100; i++) {
    const ox = (i % 10) * 20, oy = Math.floor(i / 10) * 20;
    const ring = (i % 2 ? L : [...U].reverse()).map(([x, y]) => [x + ox, y + oy]);
    fps.push({ id: 1000 + i * 7, ring, floors: i % 5 === 0 ? null : (i % 4) + 1 });
  }
  const out = extrudeAll(fps);
  assert.equal(out.length, 100);
  assert.deepEqual(out.map((o) => o.id), fps.map((f) => f.id));
  let roof = 0;
  out.forEach((o, i) => { roof += stats(o.mesh, fps[i].floors ? fps[i].floors * 3 : 6).roof; });
  close(roof, 50 * 7 + 50 * 11);
  assert.deepEqual(extrudeAll([]), []);
});
