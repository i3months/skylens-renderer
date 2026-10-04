// T12.2 완료 기준: 참조 래스터라이저(server/raster_ref zbuffer + shade)와 점 셰이더의 8시점 SSIM ≥ 0.95.
// 장면: flat_boxes(seed 7, 20만 점), 시점: fixtures/viewpoints/synthetic.json 8개를 640×360 으로(fov 그대로).
// (가) 실제 WebGL2: 헤드리스 Chromium(ANGLE/SwiftShader)이 있으면 그 픽셀을 읽어 비교한다. 없으면 건너뛰고 이유를 남긴다.
// (나) CPU 모사(emulate.mjs): 셰이더 수식을 JS 로 옮긴 것으로 항상 돈다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scenePoints, sceneCameras, cameraUniforms } from './scene.mjs';
import { emulatePointRender } from './emulate.mjs';
import { referencePointRender } from './reference.mjs';
import { findChromium, renderInChromium, glSkip } from './gl_harness.mjs';
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

// 잘못된 SKYLENS_CHROMIUM 은 불러오는 시점에 던져 파일 전체가 실패한다. REQUIRE_GL=1 이고 Chromium 이 없으면 아래 시험이 실패한다.
const chrome = findChromium();

test('실제 WebGL2(헤드리스 Chromium SwiftShader): 8시점 모두 참조와 SSIM ≥ 0.95, 빈 칸을 메우지 않는다',
  { skip: glSkip(chrome ? null : 'Chromium 없음(SKYLENS_CHROMIUM 또는 Playwright 설치 필요): 실제 GL 검증 불가, CPU 모사만 검증됨') },
  (t) => {
    assert.ok(chrome, 'Chromium 없음: SKYLENS_REQUIRE_GL=1 에서는 실제 GL 검증을 건너뛸 수 없다');
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

// 판별력 음성 시험: 셰이더가 잘못 그리면 SSIM 이 기준 아래로 떨어져야 한다(SSIM_MIN 은 그대로).
// 변이는 셰이더 유니폼 쪽에만 건다. 참조(refs)는 원래 설정 그대로다.
const MUTATIONS = {
  '셰이딩 끄기': (o) => ({ ...o, shade: false }),
  '빛 방향 반전': (o) => ({ ...o, lightDirWorld: o.lightDirWorld.map((x) => -x) }),
  '점 크기 1.5배': (o) => ({ ...o, pointSizeM: o.pointSizeM * 1.5 }),
};

for (const [label, mutate] of Object.entries(MUTATIONS)) {
  test(`판별력: ${label} 변이는 8시점 중 적어도 한 시점에서 SSIM < SSIM_MIN`, (t) => {
    const scores = [];
    for (const [k, { camera }] of cams.entries()) {
      const em = emulatePointRender(cameraUniforms(camera, mutate(OPTS)), pts);
      scores.push(ssim(refs[k].color, em.color, camera.width, camera.height, 3));
    }
    t.diagnostic(`${label}: ${scores.map((s) => s.toFixed(3)).join(', ')}`);
    assert.ok(scores.some((s) => s < SSIM_MIN), `변이가 SSIM 을 못 떨어뜨림: ${scores.map((s) => s.toFixed(3)).join(', ')}`);
  });
}

// 시점별 점 반지름 진단: r = fx·pointSizeM/(2d) ≥ 1 인 점의 비율. 비율이 낮은 시점은 점 크기 공식이 중심 칸 규칙에만 기대어 검증이 약하다.
test('진단: 시점별 점 반지름 r ≥ 1 비율 출력, 점 크기 공식이 검증되는 시점이 있다', (t) => {
  const lines = [];
  let anyStrong = false;
  for (const { name, camera } of cams) {
    const U = cameraUniforms(camera, OPTS);
    const R = U.u_Rgl;
    let visible = 0;
    let big = 0;
    for (let k = 0; k < COUNT; k += 1) {
      const X = pts.positions[3 * k], Y = pts.positions[3 * k + 1], Z = pts.positions[3 * k + 2];
      const d = -(R[6] * X + R[7] * Y + R[8] * Z + U.u_tgl[2]);
      if (!(d >= U.u_near && d <= U.u_far)) continue;
      visible += 1;
      if ((U.u_fx * U.u_pointSizeM) / (2 * d) >= 1) big += 1;
    }
    const ratio = visible ? big / visible : 0;
    if (ratio >= 0.5) anyStrong = true;
    lines.push(`${name} ${(100 * ratio).toFixed(1)}%`);
  }
  t.diagnostic(`r ≥ 1 점 비율: ${lines.join(', ')}`);
  assert.ok(anyStrong, `r ≥ 1 점이 절반 이상인 시점이 없음: ${lines.join(', ')}`);
});
