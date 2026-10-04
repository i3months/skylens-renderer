// T12.2 점 셰이더 단위 시험: 소스·유니폼 규약, 법선 복호·셰이딩 식이 참조와 같은지, 컴파일 도우미의 오류 경로, CPU 모사의 투영·크기.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VERTEX_SHADER, FRAGMENT_SHADER, UNIFORMS, ATTRIB, OCT_SNORM_MAX, DEFAULT_AMBIENT,
  createPointProgram, pointUniformValues, applyPointUniforms, PointShaderError,
} from './index.mjs';
import { emulatePointRender, shaderOctDecode, shaderShade } from './emulate.mjs';
import { referencePointRender } from './reference.mjs';
import { decodeOctNormal } from '../../../server/asset/unpack/index.mjs';
import { encodeOctNormal } from '../../../server/asset/pack/index.mjs';
import { lambert } from '../../../server/raster_ref/shade/index.mjs';
import { project } from '../../../server/raster_ref/project/index.mjs';
import { OCT_SNORM_MAX as ASSET_OCT_MAX } from '../../../contracts/asset/index.mjs';
import { cvToGlExtrinsics } from '../../../contracts/client_raster/index.mjs';
import { mulberry32 } from '../../../contracts/scenes/index.mjs';

const CAM = { width: 64, height: 48, K: { fx: 50, fy: 52, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const OPTS = { lightDirWorld: [0.3, -0.5, -0.8], pointSizeM: 0.2, ambient: 0.3, near: 0.01, far: 100, maxPointSize: 1023 };
const uniformsOf = (cam, o = OPTS) => pointUniformValues({ R: cam.R, t: cam.t, K: cam.K, bw: cam.width, bh: cam.height, ...o });

test('소스: GLSL ES 3.00, 유니폼 표의 이름이 모두 선언되어 있고 속성 위치가 ATTRIB 와 같다', () => {
  assert.ok(VERTEX_SHADER.startsWith('#version 300 es\n'));
  assert.ok(FRAGMENT_SHADER.startsWith('#version 300 es\n'));
  for (const [name, type] of Object.entries(UNIFORMS)) {
    assert.ok(VERTEX_SHADER.includes(`uniform ${type} ${name};`), name);
  }
  assert.ok(FRAGMENT_SHADER.includes('uniform float u_bh;'));
  assert.deepEqual(ATTRIB, { position: 0, color: 1, normalOct: 2 });
  assert.ok(VERTEX_SHADER.includes('layout(location = 0) in vec3 a_position;'));
  assert.ok(VERTEX_SHADER.includes('layout(location = 1) in vec3 a_color;'));
  assert.ok(VERTEX_SHADER.includes('layout(location = 2) in vec2 a_normalOct;'));
  assert.equal(OCT_SNORM_MAX, ASSET_OCT_MAX);
  assert.equal(OCT_SNORM_MAX, 127);
  assert.equal(DEFAULT_AMBIENT, 0.3);
  // 셰이더 안의 127 과 round 대체식
  assert.ok(VERTEX_SHADER.includes('q / 127.0'));
  assert.ok(VERTEX_SHADER.includes('floor(a_color * I + 0.5)'));
});

test('법선 복호: 셰이더 식이 decodeOctNormal 과 모든 255×255 부호값에서 1e-12 안에서 같다', () => {
  let worst = 0;
  for (let qx = -127; qx <= 127; qx += 1) {
    for (let qy = -127; qy <= 127; qy += 1) {
      const a = shaderOctDecode(qx, qy);
      const b = decodeOctNormal(qx, qy);
      for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(a[c] - b[c]));
      assert.ok(Math.abs(Math.hypot(...a) - 1) < 1e-12);
    }
  }
  assert.ok(worst < 1e-12, `최대 차 ${worst}`);
  // 알려진 값: 위(0,0,1)·아래(z<0 접기)
  assert.deepEqual(shaderOctDecode(0, 0), [0, 0, 1]);
  const down = shaderOctDecode(127, 127);
  assert.ok(Math.abs(down[2] + 1) < 1e-12 && Math.abs(down[0]) < 1e-12 && Math.abs(down[1]) < 1e-12);
});

test('셰이딩: 셰이더 식이 contracts/raster shade lambert 와 정수까지 같다(무작위 2만 개 + 경계)', () => {
  const rnd = mulberry32(12);
  let n = 0;
  for (let k = 0; k < 20000; k += 1) {
    const nv = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
    if (Math.hypot(...nv) < 1e-3) continue;
    const [qx, qy] = encodeOctNormal(nv[0], nv[1], nv[2]);
    const light = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
    const rgb = [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)];
    const ambient = k % 3 === 0 ? 0.3 : rnd();
    const ref = lambert(decodeOctNormal(qx, qy), light, rgb, { ambient });
    const sh = shaderShade(qx, qy, light, ambient, rgb);
    // .5 경계에서 부동소수 반올림 순서만 다를 수 있어 1 단계까지 허용하고 그런 경우의 수를 센다
    for (let c = 0; c < 3; c += 1) {
      assert.ok(Math.abs(ref[c] - sh[c]) <= 1, `${ref} vs ${sh}`);
      if (ref[c] !== sh[c]) n += 1;
    }
  }
  assert.ok(n <= 20, `1 단계 차이 ${n} 건`);
  // 광원 반대: ambient 만, 정면: 원색
  assert.deepEqual(shaderShade(0, 0, [0, 0, -1], 0.3, [200, 100, 10]), lambert([0, 0, 1], [0, 0, -1], [200, 100, 10]));
  assert.deepEqual(shaderShade(0, 0, [0, 0, 5], 0.3, [200, 100, 10]), [200, 100, 10]);
  assert.deepEqual(shaderShade(0, 0, [0, 0, -1], 0.3, [200, 100, 10]), [60, 30, 3]);
});

test('유니폼 값: R_gl·t_gl 은 cvToGlExtrinsics, 나머지는 그대로, 잘못된 값은 PointShaderError', () => {
  const R = [0, 0, 1, 1, 0, 0, 0, 1, 0];
  const t = [1, 2, 3];
  const U = pointUniformValues({ R, t, K: { fx: 10, fy: 11, cx: 5, cy: 6 }, bw: 20, bh: 12, lightDirWorld: [0, 1, 0], pointSizeM: 0.05, near: 0.1, far: 50, maxPointSize: 64 });
  const gl = cvToGlExtrinsics(R, t);
  assert.deepEqual(U.u_Rgl, gl.R);
  assert.deepEqual(U.u_tgl, gl.t);
  assert.deepEqual(U.u_tgl, [1, -2, -3]);
  assert.equal(U.u_ambient, 0.3);
  assert.equal(U.u_shade, true);
  assert.deepEqual(Object.keys(U).sort(), Object.keys(UNIFORMS).sort());
  const base = { R, t, K: { fx: 10, fy: 11, cx: 5, cy: 6 }, bw: 20, bh: 12, lightDirWorld: [0, 1, 0], pointSizeM: 0.05, near: 0.1, far: 50, maxPointSize: 64 };
  for (const bad of [
    { lightDirWorld: [0, 0, 0] }, { pointSizeM: 0 }, { near: 0 }, { far: 0.1 }, { ambient: 1.5 }, { bw: 0 }, { bh: 1.5 },
    { K: { fx: 0, fy: 1, cx: 0, cy: 0 } }, { maxPointSize: 0 },
  ]) {
    assert.throws(() => pointUniformValues({ ...base, ...bad }), PointShaderError, JSON.stringify(bad));
  }
});

// 호출만 기록하는 가짜 GL. 컴파일·링크 결과를 고를 수 있다.
function fakeGl({ vsOk = true, fsOk = true, linkOk = true } = {}) {
  const log = [];
  let id = 0;
  const kinds = new Map();
  return {
    log,
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    createShader(type) { const s = { id: ++id }; kinds.set(s, type); log.push(['createShader', type]); return s; },
    shaderSource(s, src) { log.push(['shaderSource', kinds.get(s), src]); },
    compileShader() {},
    getShaderParameter(s) { return kinds.get(s) === 1 ? vsOk : fsOk; },
    getShaderInfoLog(s) { return `log${kinds.get(s)}`; },
    deleteShader(s) { log.push(['deleteShader', kinds.get(s)]); },
    createProgram() { log.push(['createProgram']); return { id: ++id }; },
    attachShader() {}, detachShader() {}, linkProgram() {},
    getProgramParameter() { return linkOk; },
    getProgramInfoLog() { return 'linklog'; },
    deleteProgram() { log.push(['deleteProgram']); },
    getUniformLocation(p, name) { return { name }; },
    uniformMatrix3fv(loc, tr, v) { log.push(['m3', loc.name, tr, [...v]]); },
    uniform3f(loc, a, b, c) { log.push(['3f', loc.name, a, b, c]); },
    uniform1i(loc, a) { log.push(['1i', loc.name, a]); },
    uniform1f(loc, a) { log.push(['1f', loc.name, a]); },
  };
}

test('createPointProgram: 성공하면 모든 유니폼 위치, 실패하면 단계별 PointShaderError 와 자원 정리', () => {
  const ok = fakeGl();
  const { uniforms } = createPointProgram(ok);
  assert.deepEqual(Object.keys(uniforms).sort(), Object.keys(UNIFORMS).sort());
  assert.ok(ok.log.some((e) => e[0] === 'shaderSource' && e[1] === 1 && e[2] === VERTEX_SHADER));
  assert.ok(ok.log.some((e) => e[0] === 'shaderSource' && e[1] === 2 && e[2] === FRAGMENT_SHADER));
  assert.equal(ok.log.filter((e) => e[0] === 'deleteShader').length, 2);

  const vs = fakeGl({ vsOk: false });
  assert.throws(() => createPointProgram(vs), (e) => e instanceof PointShaderError && e.stage === 'vertex' && e.message.includes('log1'));
  const fs = fakeGl({ fsOk: false });
  assert.throws(() => createPointProgram(fs), (e) => e instanceof PointShaderError && e.stage === 'fragment');
  assert.equal(fs.log.filter((e) => e[0] === 'deleteShader').length, 2); // 정점·조각 둘 다 지움
  const ln = fakeGl({ linkOk: false });
  assert.throws(() => createPointProgram(ln), (e) => e instanceof PointShaderError && e.stage === 'link' && e.message.includes('linklog'));
  assert.equal(ln.log.filter((e) => e[0] === 'deleteProgram').length, 1);
});

test('applyPointUniforms: mat3 는 행 우선 + transpose, bool 은 1i, 위치 없는 이름은 건너뛴다', () => {
  const gl = fakeGl();
  const { uniforms } = createPointProgram(gl);
  uniforms.u_far = null;
  const U = uniformsOf(CAM);
  applyPointUniforms(gl, uniforms, U);
  const m3 = gl.log.find((e) => e[0] === 'm3');
  assert.deepEqual(m3, ['m3', 'u_Rgl', true, [1, 0, 0, -0, -1, -0, -0, -0, -1]]);
  assert.deepEqual(gl.log.find((e) => e[1] === 'u_shade'), ['1i', 'u_shade', 1]);
  assert.equal(gl.log.some((e) => e[1] === 'u_far'), false);
  assert.equal(gl.log.filter((e) => ['m3', '3f', '1i', '1f'].includes(e[0])).length, Object.keys(UNIFORMS).length - 1);
});

test('CPU 모사: 투영 위치가 server/raster_ref project 와 f32 오차(1e-3 px) 안에서 같고 빈 칸은 (0,0,0)', () => {
  const rnd = mulberry32(5);
  for (let k = 0; k < 200; k += 1) {
    const xw = [(rnd() - 0.5) * 4, (rnd() - 0.5) * 3, 2 + rnd() * 8];
    const p = project(CAM, xw);
    if (!(p.u >= 0 && p.u < CAM.width && p.v >= 0 && p.v < CAM.height)) continue;
    // 아주 작은 점: 중심 칸 하나만 칠해진다
    const pts = { positions: Float32Array.from(xw), colors: Uint8Array.from([255, 255, 255]), normalOct: Int8Array.from([0, 0]) };
    const U = uniformsOf(CAM, { ...OPTS, pointSizeM: 1e-6, shade: false });
    const r = emulatePointRender(U, pts);
    const on = [...r.drawn.keys()].filter((q) => r.drawn[q]);
    assert.equal(on.length, 1);
    const [i, j] = [on[0] % CAM.width, Math.floor(on[0] / CAM.width)];
    // 칸 경계에 1e-3 px 이내로 붙은 점은 f32 오차로 이웃 칸이 될 수 있다
    assert.ok(Math.abs(i - Math.floor(p.u)) <= (Math.abs(p.u - Math.round(p.u)) < 1e-3 ? 1 : 0), `${i} vs ${p.u}`);
    assert.ok(Math.abs(j - Math.floor(p.v)) <= (Math.abs(p.v - Math.round(p.v)) < 1e-3 ? 1 : 0), `${j} vs ${p.v}`);
    for (let q = 0; q < r.drawn.length; q += 1) if (!r.drawn[q]) assert.equal(r.color[3 * q] | r.color[3 * q + 1] | r.color[3 * q + 2], 0);
  }
});

test('CPU 모사: 원판 크기 r = fx·pointSizeM/(2d) 가 참조 splat 과 같은 칸을 덮고, 앞 점이 이기며, 카메라 뒤·near 앞은 버린다', () => {
  // 깊이 5 m, 지름 1 m → r = 50·1/10 = 5 px. 중심 (32.25, 24.25)
  const pts = {
    positions: Float32Array.from([0.025, 0.0240384615, 5, 0.025, 0.0240384615, 4, 0, 0, -3]),
    colors: Uint8Array.from([10, 20, 30, 200, 100, 50, 255, 255, 255]),
    normalOct: Int8Array.from([0, 0, 0, 0, 0, 0]),
  };
  const opts = { ...OPTS, pointSizeM: 1, shade: false };
  const U = uniformsOf(CAM, opts);
  const em = emulatePointRender(U, pts);
  const ref = referencePointRender(CAM, pts, opts);
  // 둘째 점(4 m, r = 6.25 px)이 첫 점을 가린다. 셋째(카메라 뒤)는 없다.
  let drawnRef = 0;
  for (let q = 0; q < CAM.width * CAM.height; q += 1) {
    assert.equal(em.drawn[q] === 1, ref.index[q] !== -1, `칸 ${q}`);
    if (ref.index[q] !== -1) {
      drawnRef += 1;
      assert.equal(ref.index[q], 1);
      assert.deepEqual([...em.color.subarray(3 * q, 3 * q + 3)], [200, 100, 50]);
    }
  }
  // 중심 (32.3125, 24.3125), 반경 6.25 원 안의 칸 중심 수(따로 센 기준값)
  assert.equal(drawnRef, 125);
  // near(0.01 m) 앞의 점(d = 0.001): 셰이더는 깊이 클립으로 버린다(참조는 d > 0 이면 그린다, index.mjs 머리 주석의 차이)
  const nearPt = { positions: Float32Array.from([0, 0, 0.001]), colors: Uint8Array.from([9, 9, 9]), normalOct: Int8Array.from([0, 0]) };
  assert.equal(emulatePointRender(U, nearPt).drawn.reduce((a, b) => a + b, 0), 0);
  assert.equal(referencePointRender(CAM, nearPt, opts).index.filter((k) => k === 0).length, CAM.width * CAM.height);
});
