// T12.6 클라이언트 확인. holes 장면(부분집합 도착 포함)을 셰이더 CPU 모사와 실제 WebGL2 로 그려
// 참조(server/raster_ref)에서 빈 픽셀이었던 곳을 후보가 칠하지 않았는지(filled == []) 단언한다.
// 그리고 missing/index.mjs 도우미가 틀린 입력을 실제로 잡는지(음성 시험) 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCoverage, compareWithReference, drawnMask, assertNoFilled, nonEmptyValuesInEmpty } from './index.mjs';
import { emptyResult } from '../../../contracts/raster/index.mjs';
import { generate } from '../../../fixtures/scenes/holes/index.mjs';
import { encodeOctNormal } from '../../../server/asset/pack/index.mjs';
import { cameraUniforms } from '../shader/scene.mjs';
import { emulatePointRender, DEPTH_BITS } from '../shader/emulate.mjs';
import { referencePointRender } from '../shader/reference.mjs';
import { findChromium, renderInChromium, glSkip } from '../shader/gl_harness.mjs';

// 아래를 내려다보는 카메라(높이 60 m). 참조·셰이더 모두 같은 카메라와 점 지름을 쓴다.
const CAM = { width: 320, height: 240, K: { fx: 400, fy: 400, cx: 160, cy: 120 }, R: [1, 0, 0, 0, 0, 1, 0, -1, 0], t: [0, 0, 60] };
const OPTS = { lightDirWorld: [0.4, 0.8, 0.3], pointSizeM: 0.5, ambient: 0.3, near: 0.01, far: 2000, maxPointSize: 1023 };
const scene = generate({ seed: 1, count: 20000 });

function toPlanes(cloud, keep) {
  const idx = keep ?? Array.from({ length: cloud.count }, (_, k) => k);
  const positions = new Float32Array(3 * idx.length);
  const colors = new Uint8Array(3 * idx.length);
  const normalOct = new Int8Array(2 * idx.length);
  idx.forEach((k, a) => {
    positions.set(cloud.positions.subarray(3 * k, 3 * k + 3), 3 * a);
    colors.set(cloud.colors.subarray(3 * k, 3 * k + 3), 3 * a);
    const [qx, qy] = encodeOctNormal(cloud.normals[3 * k], cloud.normals[3 * k + 1], cloud.normals[3 * k + 2]);
    normalOct[2 * a] = qx;
    normalOct[2 * a + 1] = qy;
  });
  return { positions, colors, normalOct };
}

function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

// 도착 상황: 전부, 무작위 절반, 앞쪽 연속 구간(조각 단위 도착).
const rnd = lcg(11);
const half = [];
for (let k = 0; k < scene.cloud.count; k += 1) if (rnd() < 0.5) half.push(k);
const prefix = Array.from({ length: Math.floor(scene.cloud.count / 3) }, (_, k) => k);
const CASES = [['전부 도착', null], ['무작위 절반 도착', half], ['앞쪽 3분의 1 구간만 도착', prefix]].map(([name, keep]) => {
  const pts = toPlanes(scene.cloud, keep);
  return { name, pts, ref: referencePointRender(CAM, pts, OPTS) };
});
const U = cameraUniforms(CAM, OPTS);

// 깊이 기준 마스크: CPU 모사는 빈 칸의 양자화 깊이를 DEPTH_MAX + 1 로 둔다. 깊이가 그 값이 아니면 칠해진 칸이다.
// 색 (0,0,0) 으로 판정하면 색이 0 인 점이 메워져도 놓친다.
const EMPTY_DEPTH_Q = 2 ** DEPTH_BITS;
function depthMask(em) {
  const drawn = new Uint8Array(em.width * em.height);
  for (let p = 0; p < drawn.length; p += 1) drawn[p] = em.depth[p] !== EMPTY_DEPTH_Q ? 1 : 0;
  return { width: em.width, height: em.height, drawn };
}

// 실제 GL 하네스(읽기 전용)는 색만 돌려주고 깊이 버퍼를 읽지 않는다. 그래서 GL 쪽만 색 마스크를 쓰되,
// 이 장면에서 색 마스크가 깊이 마스크와 칸마다 같다는 것을 CPU 모사로 먼저 확인한다(칠한 칸의 색이 0 이 되지 않음).
function rgbMask(rgb) {
  const drawn = new Uint8Array(CAM.width * CAM.height);
  for (let p = 0; p < drawn.length; p += 1) drawn[p] = (rgb[3 * p] | rgb[3 * p + 1] | rgb[3 * p + 2]) !== 0 ? 1 : 0;
  return { width: CAM.width, height: CAM.height, drawn };
}

function check(name, cand, ref) {
  const cmp = compareWithReference(cand, ref);
  assert.deepEqual(cmp.filled, [], `${name}: 참조가 빈 픽셀을 ${cmp.filled.length} 개 칠함`);
  const rd = computeCoverage(ref).drawn;
  const cd = computeCoverage(cand).drawn;
  assert.ok(rd > 0, `${name}: 참조가 아무것도 그리지 않음`);
  // 빈 후보로 통과하는 것을 막는다. 측정값: 세 도착 상황 모두(CPU 모사·실제 GL) 후보 칠한 수 = 참조 칠한 수
  // (6500, 3190, 2255)이고 lost 0 이다. 점 크기 식이 참조와 같아 정확히 같아야 하므로 허용치 없이 같음을 단언한다.
  assert.deepEqual(cmp.lost, [], `${name}: 참조가 칠한 픽셀 ${cmp.lost.length} 개를 후보가 못 칠함`);
  assert.equal(cd, rd, `${name}: 후보가 ${cd} 칠함, 참조 ${rd}`);
}

test('holes 장면은 빈자리가 실제로 있다(시험 전제)', () => {
  const c = computeCoverage(CASES[0].ref);
  assert.ok(c.empty > 0.5 * c.total, `빈 픽셀 비율 ${c.emptyFraction}`);
  assert.ok(CASES[1].pts.positions.length < CASES[0].pts.positions.length);
});

for (const { name, pts, ref } of CASES) {
  test(`CPU 모사: holes ${name} → 참조의 빈 픽셀을 메우지 않는다`, () => {
    const em = emulatePointRender(U, pts);
    // 색 마스크와 깊이 마스크가 칸마다 같아야 GL 쪽 색 마스크 판정이 깊이 판정을 대신할 수 있다
    assert.deepEqual(rgbMask(em.color).drawn, depthMask(em).drawn, `${name}: 색 마스크와 깊이 마스크가 다름`);
    check(name, depthMask(em), ref);
  });
}

const chrome = findChromium();
for (const { name, pts, ref } of CASES) {
  test(`실제 WebGL2: holes ${name} → 참조의 빈 픽셀을 메우지 않는다`,
    { skip: glSkip(chrome ? null : 'Chromium 없음(SKYLENS_CHROMIUM 또는 Playwright 설치 필요): 실제 GL 검증 불가') },
    () => {
      // SKYLENS_REQUIRE_GL=1 이면 glSkip 이 false 를 돌려 여기까지 오고, Chromium 이 없으면 실패한다
      assert.ok(chrome, 'Chromium 없음: SKYLENS_REQUIRE_GL=1 에서는 실제 GL 검증을 건너뛸 수 없다');
      const gl = renderInChromium(chrome, [U], pts);
      assert.equal(gl.glError, 0);
      check(name, rgbMask(gl.views[0]), ref);
    });
}

// 아래는 도우미 음성 시험. 도우미를 틀리게 고치면(루프 시작 변경, 검사 제거 등) 실패해야 한다.
const m = (w, h, ones) => { const d = new Uint8Array(w * h); for (const p of ones) d[p] = 1; return { width: w, height: h, drawn: d }; };

test('도우미: 0번 픽셀도 센다(루프 시작 i=0)', () => {
  assert.equal(computeCoverage(m(3, 3, [0])).drawn, 1);
  const r = emptyResult(3, 3);
  r.index[0] = 5;
  r.depth[0] = 1;
  assert.equal(drawnMask(r)[0], 1);
  assert.deepEqual(compareWithReference(m(3, 3, [0]), m(3, 3, [])).filled, [0]);
  assert.deepEqual(compareWithReference(m(3, 3, []), m(3, 3, [0])).lost, [0]);
  assert.throws(() => assertNoFilled(m(3, 3, [0]), m(3, 3, [])), /^Error: missing:/);
  // nonEmptyValuesInEmpty 는 이제 유효한 RenderResult 만 받아들임
  assert.deepEqual(nonEmptyValuesInEmpty(emptyResult(3, 3), [0]), []);
  // 칠해진 픽셀을 빈 것으로 표시하면 감지됨
  const z = emptyResult(3, 3);
  z.index[0] = 1;
  z.depth[0] = 1;  // depth 도 설정해야 함
  // z는 이제 픽셀 0이 칠해진 유효한 RenderResult 이고, 픽셀 0을 빈 것으로 표시하면 감지됨
  assert.deepEqual(nonEmptyValuesInEmpty(z, [0]), [0]);
});

test('도우미: filled 는 메운 픽셀 전부를 오름차순으로 돌려준다(마지막만 아님)', () => {
  const r = compareWithReference(m(4, 4, [0, 3, 7, 15]), m(4, 4, [3]));
  assert.deepEqual(r.filled, [0, 7, 15]);
  assert.deepEqual(compareWithReference(m(4, 4, [1, 2]), m(4, 4, [2, 5, 6])).lost, [5, 6]);
});

test('도우미: nonEmptyValuesInEmpty 는 번호·깊이·색 중 하나라도 어긋나면 잡는다', () => {
  const mk = () => emptyResult(3, 3);
  // 빈 결과는 검출하지 않음
  assert.deepEqual(nonEmptyValuesInEmpty(mk(), [0, 1, 2]), []);

  // 픽셀 1을 칠하면(번호 설정) 감지됨
  const a = mk(); a.index[1] = 3; a.depth[1] = 5;
  assert.deepEqual(nonEmptyValuesInEmpty(a, [0, 1, 2]), [1]);

  // 픽셀 2의 깊이를 설정하면(하지만 빈 번호는 유지) 감지됨
  // 유효한 RenderResult 를 위해 색도 설정하고 깊이를 설정할 때는 색이 0 이어야 함
  const b = mk(); b.depth[2] = 4; b.index[2] = 0;  // 칠한 픽셀로 만들기
  assert.deepEqual(nonEmptyValuesInEmpty(b, [0, 1, 2]), [2]);

  // 색이 0이 아닌 픽셀 0을 설정하면 감지됨
  for (const c of [0, 1, 2]) {
    const d = mk(); d.index[0] = 1; d.depth[0] = 1; d.color[c] = 7;
    assert.deepEqual(nonEmptyValuesInEmpty(d, [0, 1]), [0], `색 채널 ${c}`);
  }

  // 여러 픽셀이 칠해져 있으면 모두 감지됨
  const e = mk();
  e.index[0] = 1; e.depth[0] = 1;  // 픽셀 0 칠함
  e.index[1] = 2; e.depth[1] = 2;  // 픽셀 1 칠함
  e.index[2] = 3; e.depth[2] = 3;  // 픽셀 2 칠함
  assert.deepEqual(nonEmptyValuesInEmpty(e, [0, 1, 2]), [0, 1, 2]);
});

test('도우미: 마스크 모양이 틀리면 오류(길이·소수 크기)', () => {
  const ok = m(2, 2, []);
  assert.throws(() => computeCoverage({ width: 2, height: 3, drawn: new Uint8Array(4) }), /^Error: missing:/);
  assert.throws(() => computeCoverage({ width: 2.5, height: 2, drawn: new Uint8Array(5) }), /^Error: missing:/);
  assert.throws(() => compareWithReference({ width: 2, height: 3, drawn: new Uint8Array(4) }, ok), /^Error: missing:/);
  assert.throws(() => compareWithReference(ok, { width: 4, height: 1, drawn: new Uint8Array(3) }), /^Error: missing:/);
});
