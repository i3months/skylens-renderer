// 합성 건물 번들·카메라(test_support/fixtures.mjs) 시험: 결정성, 계약 형태, uv 관례, 카메라.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeBundle, makeCameras, makeFootprints, makeAerialImage, bundleFromFootprints, bundleBytes, flipV, AERIAL_BOUNDS,
} from './test_support/fixtures.mjs';
import { assertCamera } from '../../../contracts/raster/index.mjs';
import { buildingHeightM } from '../../../contracts/tower_assets/index.mjs';

test('makeBundle: 같은 시드는 같은 바이트, 다른 시드는 다른 바이트', () => {
  for (const seed of [1, 2, 7, 123456]) {
    assert.ok(bundleBytes(makeBundle(seed)).equals(bundleBytes(makeBundle(seed))), `시드 ${seed}`);
    assert.ok(bundleBytes(makeBundle(seed, { count: 9, image: false })).equals(bundleBytes(makeBundle(seed, { count: 9, image: false }))));
  }
  assert.ok(!bundleBytes(makeBundle(1)).equals(bundleBytes(makeBundle(2))));
  assert.ok(Buffer.from(makeAerialImage().rgb).equals(Buffer.from(makeAerialImage().rgb)));
});

test('makeBundle: 동 수·묶음 수, count 범위 검사', () => {
  for (const count of [1, 3, 6, 9]) {
    const b = makeBundle(5, { count });
    assert.equal(b.groups.length, count); // 가까운 거리(lodDistM 100)라 한 동 한 묶음
    const ids = b.groups.flatMap((g) => g.ids);
    assert.equal(new Set(ids).size, count);
  }
  for (const bad of [0, 10, 2.5, -1]) assert.throws(() => makeBundle(1, { count: bad }), RangeError);
  assert.throws(() => makeBundle(1, { uv: 'other' }), RangeError);
  assert.equal(makeBundle(1, { image: false }).image, null);
});

test('makeBundle: 서버 가공 결과가 계약 형태(BuildingGroup)와 일치', () => {
  for (const seed of [1, 2, 3, 4]) {
    const fps = makeFootprints(seed, 9);
    const b = makeBundle(seed, { count: 9 });
    b.groups.forEach((g, gi) => {
      const { positions: p, indices: idx } = g.mesh;
      assert.ok(p instanceof Float32Array && idx instanceof Uint32Array);
      assert.equal(p.length % 3, 0);
      assert.equal(idx.length % 3, 0);
      const nV = p.length / 3;
      for (const i of idx) assert.ok(i < nV);
      for (const v of p) assert.ok(Number.isFinite(v));
      assert.ok(g.uv instanceof Float32Array && g.uv.length === 2 * nV);
      for (const v of g.uv) assert.ok(v >= 0 && v <= 1, `uv ${v}`);
      assert.ok(g.wallMask instanceof Uint8Array && g.wallMask.length === nV);
      for (const m of g.wallMask) assert.ok(m === 0 || m === 1);
      assert.ok(g.edgeLines instanceof Float32Array && g.edgeLines.length > 0 && g.edgeLines.length % 6 === 0);
      assert.ok(g.points instanceof Float32Array && g.points.length >= 3 * 8 && g.points.length % 3 === 0);
      // 지붕 정점(z = 높이)은 mask 0, 그 밖(바닥·벽)은 1. 높이 규칙은 계약 buildingHeightM.
      const h = Math.fround(buildingHeightM(fps[gi].floors));
      assert.equal(g.ids[0], fps[gi].id);
      let roof = 0;
      for (let v = 0; v < nV; v++) {
        const z = p[3 * v + 2];
        assert.ok(z === 0 || z === h, `z ${z}`);
        // 벽 정점은 지붕 높이에도 있으므로, mask 0 이면 반드시 지붕 높이여야 한다.
        if (g.wallMask[v] === 0) { assert.equal(z, h); roof++; }
        if (z === 0) assert.equal(g.wallMask[v], 1);
      }
      assert.equal(roof, fps[gi].ring.length);
      // 점은 모두 메시 경계 상자 안(바닥 덮개 제외라 z ≥ 0)
      for (let k = 0; k < g.points.length; k += 3) assert.ok(g.points[k + 2] >= 0 && g.points[k + 2] <= h + 1e-4);
    });
  }
});

test('uv 규약: 기본은 서버 출력 그대로(v = 0 이 북), flipped 는 v 를 뒤집음', () => {
  const b = makeBundle(3);
  const s = makeBundle(3, { uv: 'flipped' });
  const { minX, minY, maxX, maxY } = AERIAL_BOUNDS;
  b.groups.forEach((g, gi) => {
    const p = g.mesh.positions;
    for (let v = 0; v < p.length / 3; v++) {
      const ue = (p[3 * v] - minX) / (maxX - minX), ve = (p[3 * v + 1] - minY) / (maxY - minY);
      assert.ok(Math.abs(g.uv[2 * v] - ue) < 1e-6);
      assert.ok(Math.abs(g.uv[2 * v + 1] - (1 - ve)) < 1e-6, '계약: v = 1 − 북쪽 비율(v = 0 이 북)');
      assert.ok(Math.abs(s.groups[gi].uv[2 * v + 1] - ve) < 1e-6, 'flipped: v 는 북쪽으로 증가');
    }
  });
  assert.deepEqual([...flipV(Float32Array.of(0.25, 0.25, 1, 0))], [0.25, 0.75, 1, 1]);
});

test('makeAerialImage: 행 0 = 북, r 동쪽 증가, g 북쪽 증가', () => {
  const im = makeAerialImage();
  assert.equal(im.rgb.length, 96 * 96 * 3);
  const at = (c, r, k) => im.rgb[3 * (r * im.width + c) + k];
  assert.ok(at(95, 50, 0) > at(0, 50, 0));
  assert.ok(at(50, 0, 1) > at(50, 95, 1), '북쪽(행 0) 의 g 가 크다');
});

test('bundleFromFootprints: 상자 하나, 영상 null 이어도 uv 형태 유지', () => {
  const b = bundleFromFootprints([{ id: 7, ring: [[-5, -5], [5, -5], [5, 5], [-5, 5]], floors: 4 }], { image: null });
  assert.equal(b.image, null);
  assert.equal(b.groups.length, 1);
  assert.deepEqual(b.groups[0].ids, [7]);
  assert.equal(b.groups[0].mesh.indices.length / 3, 12);
  assert.equal(b.groups[0].edgeLines.length / 6, 12); // 상자 모서리 12개
  assert.equal(b.groups[0].uv.length, 2 * b.groups[0].mesh.positions.length / 3);
});

test('makeCameras: 3종, 계약 카메라, 목표점이 주점에 투영', () => {
  const cams = makeCameras();
  assert.deepEqual(cams.map((c) => c.name), ['top', 'oblique', 'eye17']);
  const targets = { top: [0, 0, 0], oblique: [0, 0, 0], eye17: [0, 0, 8] };
  const eyes = { top: [0, 0, 120], oblique: [-60, -80, 60], eye17: [0, -70, 17] };
  for (const c of cams) {
    assertCamera(c);
    assert.equal(c.width, 80);
    assert.equal(c.height, 45);
    const { R, t } = c;
    const C = [0, 1, 2].map((k) => -(R[k] * t[0] + R[3 + k] * t[1] + R[6 + k] * t[2]));
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(C[k] - eyes[c.name][k]) < 1e-9);
    const X = targets[c.name];
    const xc = [0, 1, 2].map((r) => R[3 * r] * X[0] + R[3 * r + 1] * X[1] + R[3 * r + 2] * X[2] + t[r]);
    assert.ok(xc[2] > 0);
    assert.ok(Math.abs(c.K.fx * xc[0] / xc[2] + c.K.cx - 40) < 1e-9);
    assert.ok(Math.abs(c.K.fy * xc[1] / xc[2] + c.K.cy - 22.5) < 1e-9);
  }
  // top: 화면 오른쪽 = 동, 아래 = 남
  const top = cams[0];
  assert.deepEqual(top.R.slice(0, 3).map((v) => v + 0), [1, 0, 0]);
  assert.deepEqual(top.R.slice(3, 6).map((v) => v + 0), [0, -1, 0]);
  assert.equal(makeCameras({ width: 160, height: 90 })[1].width, 160);
});
