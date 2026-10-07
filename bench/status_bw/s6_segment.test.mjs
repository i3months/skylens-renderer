// S6 송출 구성 시험(T13.HQ, 사람 결정: 대역폭 상한 없음, 화질 우선). 구간당 250만 점 합성(SPEC 규모)에서
// 송출 점 = 원본 점(솎기·구간 바이트 예산 없음)이고 압축은 무손실 codec 1 만이다. 구간당 바이트는 출력만 하고 단언하지 않는다.
// `node --test bench/status_bw/s6_segment.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureStatusBandwidth, S6_SEND_CONFIG } from './index.mjs';
import { generate as generateLevels, levelCloud } from '../../fixtures/scenes/levels/index.mjs';
import { packCloudPieces } from '../proto/measure.mjs';
import { encodeChunk } from '../../server/codec/chunk/index.mjs';
import { decodeChunkClient } from '../../client/codec/index.mjs';

test('S6 송출 구성: codec 1 만, 솎기·바이트 예산 항목 없음', () => {
  assert.deepEqual({ ...S6_SEND_CONFIG }, { codec: 1 });
});

for (const seed of [1, 42]) {
  test(`구간당 250만 점 합성(seed ${seed}): 4수준 송출 점 = 원본 점 [312500, 625000, 1250000, 2500000], 바이트는 출력만`, (t) => {
    const r6 = measureStatusBandwidth({ segments: 3, pointsPerSegment: 2500000, seed, ...S6_SEND_CONFIG });
    assert.equal(r6.rows.length, 3);
    assert.equal(r6.codec, 1);
    t.diagnostic(`초기 ${r6.initialBytes} B`);
    assert.ok(r6.initialBytes <= 15_000_000);
    for (const r of r6.rows) {
      t.diagnostic(`구간 ${r.segmentId}: ${r.frameBytes} B, 송출 점 ${r.points} / 원본 ${r.sourcePoints}, 수준별 바이트 ${r.levels.map((l) => l.frameBytes).join('/')}`);
      assert.deepEqual(r.levels.map((l) => l.sourcePoints), [312500, 625000, 1250000, 2500000]);
      assert.deepEqual(r.levels.map((l) => l.points), [312500, 625000, 1250000, 2500000]);
      assert.equal(r.points, r.sourcePoints);
      assert.equal(r.frameBytes, r.levels.reduce((s, l) => s + l.frameBytes, 0));
      for (const l of r.levels) {
        assert.ok(l.pieces >= 1);
        assert.equal(l.arrivedBytes, 23);
      }
    }
  });
}

test('구간 0 수준 0(312500 점) 복호 위치 다중집합 = 원본(양자화 한도 안)', () => {
  const scene = generateLevels({ seed: 1, segments: 1, count: 2500000 });
  const cloud = levelCloud(scene, 0, 0);
  assert.equal(cloud.count, 312500);
  // 원본을 ENU(동, 북, 위)로 바꾼다(packCloudPieces 의 sceneToEnu 와 같은 규칙).
  const src = new Float64Array(3 * cloud.count);
  for (let i = 0; i < cloud.count; i++) {
    src[3 * i] = cloud.positions[3 * i]; src[3 * i + 1] = -cloud.positions[3 * i + 2]; src[3 * i + 2] = cloud.positions[3 * i + 1];
  }
  const dec = [];
  let tol = 0;
  for (const p of packCloudPieces(cloud, { segmentId: 0, level: 0 })) {
    const { header, planes } = decodeChunkClient(encodeChunk(p.skla));
    const step = 2 ** -header.quantExp;
    tol = Math.max(tol, step);
    const pp = [planes.pos_e, planes.pos_n, planes.pos_u];
    for (let i = 0; i < header.pointCount; i++) dec.push([0, 1, 2].map((a) => header.bboxMin[a] + pp[a][i] * step));
  }
  assert.equal(dec.length, cloud.count);
  // 양자화로 정렬 순서가 바뀔 수 있어 정렬 대조 대신 격자 칸 해시로 짝짓는다: 복호 점마다 이웃 27 칸에서 가장 가까운 미사용 원본 하나(오차 ≤ tol)를 소비한다.
  const cell = (v) => Math.floor(v / tol);
  const grid = new Map();
  for (let i = 0; i < cloud.count; i++) {
    const k = `${cell(src[3 * i])},${cell(src[3 * i + 1])},${cell(src[3 * i + 2])}`;
    const list = grid.get(k);
    if (list) list.push(i); else grid.set(k, [i]);
  }
  let unmatched = 0;
  for (const d of dec) {
    const [cx, cy, cz] = d.map(cell);
    // 가장 가까운 미사용 원본을 소비한다(먼저 찾은 것을 쓰면 이웃 점을 가로챌 수 있다)
    let best = null, bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!list) continue;
      list.forEach((i, j) => {
        const e = Math.max(Math.abs(src[3 * i] - d[0]), Math.abs(src[3 * i + 1] - d[1]), Math.abs(src[3 * i + 2] - d[2]));
        if (e < bestD) { bestD = e; best = { list, j }; }
      });
    }
    if (best && bestD <= tol) best.list.splice(best.j, 1); else unmatched++;
  }
  assert.equal(unmatched, 0, `원본과 짝지어지지 않은 복호 점 ${unmatched} 개(양자화 한 칸 ${tol})`);
});
