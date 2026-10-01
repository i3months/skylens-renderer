import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRecords } from '../../../contracts/metrics/index.mjs';
import {
  run, rasterize, cameraExtrinsics, intrinsics, worldToCamera, cameraToWorld, projectCamera, decodePoints, encodePoints, syntheticPoints,
} from './index.mjs';

// 기준 카메라: 원점에 있고 -z 방향(OpenGL 식)을 본다. up=+y.
const base = { eye: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0], width: 1280, height: 720, fov_y_deg: 50 };
const one = (p) => decodePoints(encodePoints([{ p, rgb: [255, 255, 255] }]));
const px = (r, x, y) => r.rgb[(y * r.width + x) * 3];
const hitX = (r) => {
  for (let x = 0; x < r.width; x++) if (px(r, x, r.height / 2) === 255) return x - r.width / 2;
  return null;
};

test('(1) 카메라 앞 z=-10 의 흰 점이 주 점 픽셀에 찍힌다', () => {
  const r = rasterize(one([0, 0, -10]), base);
  assert.equal(r.drawn, 1);
  const white = [];
  for (let i = 0; i < r.width * r.height; i++) if (r.rgb[i * 3] === 255) white.push(i);
  assert.deepEqual(white, [360 * 1280 + 640]);
});

test('(1b) 눈 뒤의 점은 찍히지 않는다', () => {
  assert.equal(rasterize(one([0, 0, 10]), base).drawn, 0);
});

test('(2) 해상도 절반이면 f, c 가 절반이고 점은 중심에서 절반 거리에 찍힌다', () => {
  const half = { ...base, width: 640, height: 360 };
  const Kf = intrinsics(base);
  const Kh = intrinsics(half);
  assert.ok(Math.abs(Kh.f - Kf.f / 2) < 1e-9 && Kh.cx === Kf.cx / 2 && Kh.cy === Kf.cy / 2);
  const { R, t } = cameraExtrinsics(base);
  const c = worldToCamera(R, t, [3, 2, -10]);
  const a = projectCamera(Kf, c);
  const b = projectCamera(Kh, c);
  assert.ok(Math.abs(b.u - Kh.cx - (a.u - Kf.cx) / 2) < 1e-9);
  assert.ok(Math.abs(b.v - Kh.cy - (a.v - Kf.cy) / 2) < 1e-9);
  // 정수 픽셀로 확인: 같은 점이 절반 해상도에서 중심 오프셋 절반(±1px, 바닥 처리)에 찍힌다.
  const p = [2.5, 0, -10];
  const rf = rasterize(one(p), base);
  const rh = rasterize(one(p), half);
  assert.equal(rf.drawn, 1);
  assert.equal(rh.drawn, 1);
  assert.ok(Math.abs(hitX(rh) - hitX(rf) / 2) <= 1);
});

test('(3) 시점 8곳 PPM 8장, 재실행 시 바이트 동일', async () => {
  const d1 = await mkdtemp(join(tmpdir(), 'ref1-'));
  const d2 = await mkdtemp(join(tmpdir(), 'ref2-'));
  try {
    const commit = 'abcdef1';
    const rec1 = await run({ skylensDir: '.', outDir: d1, commit });
    const rec2 = await run({ skylensDir: '.', outDir: d2, commit });
    assertRecords(rec1);
    assert.deepEqual(rec1, rec2);
    const f1 = (await readdir(d1)).sort();
    assert.equal(f1.length, 8);
    assert.deepEqual(f1, (await readdir(d2)).sort());
    const head = 'P6\n1280 720\n255\n';
    for (const f of f1) {
      const a = await readFile(join(d1, f));
      assert.equal(a.subarray(0, head.length).toString('ascii'), head);
      assert.equal(a.length, head.length + 1280 * 720 * 3);
      assert.ok(a.equals(await readFile(join(d2, f))), f);
    }
    assert.ok(rec1.some((r) => r.metric.startsWith('ref_images.drawn_pixels') && r.value > 0));
  } finally {
    await rm(d1, { recursive: true, force: true });
    await rm(d2, { recursive: true, force: true });
  }
});

test('합성 점군은 결정적이다', () => {
  assert.ok(encodePoints(syntheticPoints(1)).equals(encodePoints(syntheticPoints(1))));
});

test('(4) 역투영 X_w = Rᵀ(X_c − t) 왕복 오차 < 1e-6', () => {
  const views = [
    base,
    { eye: [150, 150, 250], target: [0, 10, 0], up: [0, 1, 0] },
    { eye: [-300, 80, 200], target: [0, 10, 0], up: [0, 1, 0] },
  ];
  for (const v of views) {
    const { R, t } = cameraExtrinsics(v);
    for (const p of [[1, 2, 3], [-40.5, 7.25, -90], [100, 0, 100]]) {
      const q = cameraToWorld(R, t, worldToCamera(R, t, p));
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(q[k] - p[k]) < 1e-6);
    }
    // R 은 직교 행렬
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const dot = R[i * 3] * R[j * 3] + R[i * 3 + 1] * R[j * 3 + 1] + R[i * 3 + 2] * R[j * 3 + 2];
        assert.ok(Math.abs(dot - (i === j ? 1 : 0)) < 1e-12);
      }
    }
  }
});
