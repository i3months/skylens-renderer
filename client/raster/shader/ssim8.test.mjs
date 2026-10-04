// T12.2 완료 기준: 참조 래스터라이저(server/raster_ref zbuffer + shade)와 점 셰이더의 8시점 SSIM ≥ 0.95.
// 장면: flat_boxes(seed 7, 20만 점), 시점: fixtures/viewpoints/synthetic.json 8개를 640×360 으로(fov 그대로).
// (가) 실제 WebGL2: 헤드리스 Chromium(ANGLE/SwiftShader)이 있으면 그 픽셀을 읽어 비교한다. 없으면 건너뛰고 이유를 남긴다.
// (나) CPU 모사(emulate.mjs): 셰이더 수식을 JS 로 옮긴 것으로 항상 돈다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scenePoints, sceneCameras, cameraUniforms } from './scene.mjs';
import { emulatePointRender } from './emulate.mjs';
import { referencePointRender } from './reference.mjs';
import { findChromium, renderInChromium } from './gl_harness.mjs';
import { ssim } from '../../../server/metrics/ssim/index.mjs';

const SSIM_MIN = 0.95;
// 빈 칸(참조에 점 없음)을 셰이더가 칠한 비율 상한. 메우기 금지 확인용(깊이 정밀도·f32 경계 차이만 허용).
const FILL_RATIO_MAX = 0.002;
const SEED = 7;
const COUNT = 200000;
const SCALE_DOWN = 2;
const OPTS = { lightDirWorld: [0.4, 0.8, 0.3], pointSizeM: 0.4, ambient: 0.3, near: 0.01, far: 2000, maxPointSize: 1023 };

const pts = scenePoints(SEED, COUNT);
const cams = sceneCameras(SCALE_DOWN);
const refs = cams.map(({ camera }) => referencePointRender(camera, pts, OPTS));

function filledEmpty(ref, rgb) {
  let n = 0;
  for (let p = 0; p < ref.index.length; p += 1) {
    if (ref.index[p] === -1 && (rgb[3 * p] | rgb[3 * p + 1] | rgb[3 * p + 2]) !== 0) n += 1;
  }
  return n / ref.index.length;
}

test('장면: 8시점, 640×360, 시점마다 참조에 점이 충분히 그려진다', () => {
  assert.equal(cams.length, 8);
  for (const [k, { camera }] of cams.entries()) {
    assert.equal(camera.width, 640);
    assert.equal(camera.height, 360);
    const drawn = refs[k].index.filter((i) => i !== -1).length;
    assert.ok(drawn > 0.2 * 640 * 360, `${cams[k].name}: 그린 칸 ${drawn}`);
  }
});

test('CPU 모사: 8시점 모두 참조와 SSIM ≥ 0.95, 빈 칸을 메우지 않는다', () => {
  for (const [k, { name, camera }] of cams.entries()) {
    const U = cameraUniforms(camera, OPTS);
    const em = emulatePointRender(U, pts);
    const s = ssim(refs[k].color, em.color, camera.width, camera.height, 3);
    assert.ok(s >= SSIM_MIN, `${name}: SSIM ${s}`);
    assert.ok(filledEmpty(refs[k], em.color) <= FILL_RATIO_MAX, name);
  }
});

test('CPU 모사(중심 클립 구현을 가정): 화면 가장자리 원판이 빠져도 8시점 SSIM ≥ 0.95', () => {
  for (const [k, { name, camera }] of cams.entries()) {
    const em = emulatePointRender(cameraUniforms(camera, OPTS), pts, { clipPointCenter: true });
    const s = ssim(refs[k].color, em.color, camera.width, camera.height, 3);
    assert.ok(s >= SSIM_MIN, `${name}: SSIM ${s}`);
  }
});

const chrome = findChromium();

test('실제 WebGL2(헤드리스 Chromium SwiftShader): 8시점 모두 참조와 SSIM ≥ 0.95, 빈 칸을 메우지 않는다',
  { skip: chrome ? false : 'Chromium 없음(SKYLENS_CHROMIUM 또는 Playwright 설치 필요): 실제 GL 검증 불가, CPU 모사만 검증됨' },
  (t) => {
    const views = cams.map(({ camera }) => cameraUniforms(camera, OPTS));
    const gl = renderInChromium(chrome, views, pts);
    assert.equal(gl.glError, 0);
    assert.equal(gl.views.length, 8);
    const scores = [];
    for (const [k, { name, camera }] of cams.entries()) {
      const s = ssim(refs[k].color, gl.views[k], camera.width, camera.height, 3);
      scores.push(`${name} ${s.toFixed(4)}`);
      assert.ok(s >= SSIM_MIN, `${name}: SSIM ${s}`);
      assert.ok(filledEmpty(refs[k], gl.views[k]) <= FILL_RATIO_MAX, name);
    }
    t.diagnostic(`${gl.renderer}, depthBits ${gl.depthBits}, maxPointSize ${gl.maxPointSize}: ${scores.join(', ')}`);
  });
