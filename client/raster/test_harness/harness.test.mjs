// 헤드리스 캡처 시험 틀 시험(T12.9). 합성 점군을 CPU 참조 래스터러로 8시점에서 그려 해시·SSIM 이 재현되는지 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildEightViews, ssim, diffStats, hashRgba, rgbToRgba, decodePngRgba, captureWithChromium } from './index.mjs';
import { ssim as serverSsim } from '../../../server/metrics/ssim/index.mjs';
import { renderPoints } from '../../../server/raster_ref/zbuffer/index.mjs';
import { project } from '../../../server/raster_ref/project/index.mjs';

const W = 160; const H = 90;

// 결정적 합성 점군: 선형 합동 난수로 반지름 6 m 안의 점 4000 개(장면 중심 (0,1.5,0) 둘레)
function makeCloud(n = 4000) {
  let s = 12345;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const positions = new Float32Array(3 * n); const colors = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) {
    positions[3 * i] = (rnd() - 0.5) * 12; positions[3 * i + 1] = 1.5 + (rnd() - 0.5) * 6; positions[3 * i + 2] = (rnd() - 0.5) * 12;
    colors[3 * i] = Math.floor(rnd() * 256); colors[3 * i + 1] = Math.floor(rnd() * 256); colors[3 * i + 2] = Math.floor(rnd() * 256);
  }
  return { format: 1, positions, colors };
}
function capture(cloud, views) {
  return views.map((v) => {
    const r = renderPoints(v.camera, cloud, { pointSizeM: 0.15 });
    return rgbToRgba(r.color, r.width, r.height);
  });
}

test('buildEightViews: 8시점, 정답 카메라(손계산 기준값)', () => {
  const views = buildEightViews({ width: 1280, height: 720 });
  assert.equal(views.length, 8);
  assert.deepEqual(views.map((v) => v.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  const v0 = views[0].camera;
  // fy = 360/tan(25°) = 772.0224913834, 주점은 해상도 중심
  assert.ok(Math.abs(v0.K.fy - 772.0224913834) < 1e-6);
  assert.equal(v0.K.fx, v0.K.fy);
  assert.equal(v0.K.cx, 640); assert.equal(v0.K.cy, 360);
  // 시점 1: eye (0,10,25) 에서 target (0,1.5,0) 까지 거리 sqrt(8.5²+25²) = 26.40549...
  const target = project(v0, [0, 1.5, 0]);
  assert.ok(Math.abs(target.u - 640) < 0.01 && Math.abs(target.v - 360) < 0.01);
  assert.ok(Math.abs(target.d - 26.405491) < 1e-5, `d ${target.d}`);
  // 8시점 모두 target 이 화면 중앙 앞에 온다
  for (const v of views) {
    const p = project(v.camera, [0, 1.5, 0]);
    assert.ok(Math.abs(p.u - 640) < 0.01 && Math.abs(p.v - 360) < 0.01, v.name);
    assert.ok(p.d > 0);
  }
  // 해상도 바꾸기: 시야각 유지, fy = 45/tan(25°) = 96.50281142
  const small = buildEightViews({ width: W, height: H });
  assert.ok(Math.abs(small[0].camera.K.fy - 96.5028114) < 1e-5);
  assert.equal(small[0].camera.width, W);
});

test('ssim: 같은 영상 1, 반전 영상은 낮음, 서버 구현과 일치', () => {
  const cloud = makeCloud();
  const views = buildEightViews({ width: W, height: H });
  const [a] = capture(cloud, views);
  assert.equal(ssim(a, a, W, H), 1);
  const inv = a.map((v, i) => (i % 4 === 3 ? 255 : 255 - v));
  assert.ok(ssim(a, inv, W, H) < 0.1);
  // 서버 ssim(3채널 RGB)과 같은 정의라 1e-9 이내로 같아야 한다
  const rgb = new Uint8Array(W * H * 3); const rgb2 = new Uint8Array(W * H * 3);
  const b = a.slice(); b[4 * 500] ^= 40; b[4 * 1000 + 1] ^= 90;
  for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) { rgb[3 * i + c] = a[4 * i + c]; rgb2[3 * i + c] = b[4 * i + c]; }
  assert.ok(Math.abs(ssim(a, b, W, H) - serverSsim(rgb, rgb2, W, H, 3)) < 1e-9);
  assert.throws(() => ssim(new Uint8Array(40), new Uint8Array(40), 5, 2));
});

test('diffStats: 손으로 센 기준값', () => {
  const w = 4; const h = 2;
  const a = new Uint8Array(w * h * 4).fill(100); const b = a.slice();
  b[0] = 110; b[1] = 90; // 픽셀 0: R+10, G-10
  b[3] = 0; // 알파 차이는 무시
  b[4 * 5 + 2] = 103; // 픽셀 5: B+3
  const d = diffStats(a, b, w, h);
  assert.equal(d.maxAbs, 10);
  assert.equal(d.diffPixels, 2);
  assert.equal(d.diffRatio, 0.25);
  assert.equal(d.meanAbs, 23 / 24); // |10|+|10|+|3| = 23, 채널 수 8·3 = 24
  assert.equal(d.mse, 209 / 24); // 100+100+9
  assert.ok(Math.abs(d.psnr - 10 * Math.log10(65025 / (209 / 24))) < 1e-12);
  assert.equal(diffStats(a, a, w, h).psnr, Infinity);
});

test('재현성: 8시점 캡처가 같은 입력에서 같은 해시, 입력이 바뀌면 달라짐', () => {
  const views = buildEightViews({ width: W, height: H });
  const run1 = capture(makeCloud(), views).map((c) => hashRgba(c, W, H));
  const run2 = capture(makeCloud(), views).map((c) => hashRgba(c, W, H));
  assert.deepEqual(run1, run2);
  assert.equal(new Set(run1).size, 8); // 시점마다 다른 그림
  // 점 하나의 색을 바꾸면 그 점이 보이는 시점의 해시가 달라지고 SSIM 은 1 미만
  const cloud = makeCloud(); cloud.colors[0] ^= 255; cloud.positions[0] = 0; cloud.positions[1] = 1.5; cloud.positions[2] = 0;
  const changed = capture(cloud, views);
  const base = capture(makeCloud(), views);
  let diffViews = 0;
  for (let i = 0; i < 8; i++) if (hashRgba(changed[i], W, H) !== run1[i]) { diffViews++; assert.ok(ssim(base[i], changed[i], W, H) < 1); }
  assert.ok(diffViews >= 1, `바뀐 시점 ${diffViews}`);
  // 서버 참조 회귀 고정: 8시점 전부의 해시를 고정
  assert.deepEqual(run1, PINNED);
});

test('hashRgba: 크기가 다른 같은 바이트는 다른 해시, 길이 틀리면 던짐', () => {
  const buf = new Uint8Array(4 * 6);
  assert.notEqual(hashRgba(buf, 6, 1), hashRgba(buf, 3, 2));
  assert.throws(() => hashRgba(buf, 5, 1));
});

test('captureWithChromium: 단색 페이지 캡처가 정답 색과 같다(브라우저 없으면 skip)', async (t) => {
  const size = { width: 64, height: 32 };
  const html = '<!doctype html><body style="margin:0;background:rgb(10,200,30)"></body>';
  const r = await captureWithChromium({ html, size });
  if (r.skipped) { t.skip(r.reason); return; }
  assert.equal(r.width, 64); assert.equal(r.height, 32);
  const want = new Uint8Array(64 * 32 * 4);
  for (let i = 0; i < 64 * 32; i++) { want[4 * i] = 10; want[4 * i + 1] = 200; want[4 * i + 2] = 30; want[4 * i + 3] = 255; }
  assert.equal(diffStats(r.rgba, want, 64, 32).maxAbs, 0);
  // 같은 입력 → 같은 해시
  const r2 = await captureWithChromium({ html, size });
  assert.equal(hashRgba(r.rgba, 64, 32), hashRgba(r2.rgba, 64, 32));
});

test('decodePngRgba: 서명이 틀리면 던짐', () => {
  assert.throws(() => decodePngRgba(Buffer.from('not a png at all')));
});

// 서버 참조 회귀 고정: 8시점 CPU 참조 래스터러 출력 해시
const PINNED = [
  '2d25a371b501c4ee23fe2778cc84b88cb06a05b56c5d854ba818106848429a2c',
  'b5810be27406d2680282ba740453f2e64e14006e5240d5903fd8126707d57675',
  '1d94427fd76c0417e0f6da489fac07b53f0c4223835c664515a75f025fc86cab',
  'c19e8e4e062ea5127f2fb6f657b8d6ccee7ce6ff8d7282969d2e6df5a5dd96c8',
  '316c37d4c600bc8126035dedf17e066f4a75bda1c8b18685dc50f8d35bc9b246',
  '3f4035b7ab004f14dfc85115af4526243e38e8805d21e6877a5b7b6a791176dc',
  '1c53a7c46f474c0eb61d40827e878e2ba2eaf79e21fcff6d451161a2c6854085',
  '20c67ffdeed726d37b3bc5227162347c1f8b47b5f5cab44b62594764a69934ab',
];
