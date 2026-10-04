import test from 'node:test';
import assert from 'node:assert/strict';
import * as contract from './index.mjs';
import * as asset from '../asset/index.mjs';
import * as points from '../points/index.mjs';
import { pieceKeyString } from '../proto/index.mjs';
import { encodeChunkKey } from '../../server/asset/ids/index.mjs';

// 클라이언트 래스터라이저 계약 검사(F-215).
// 형식 상수 대조, K 축별 배율·dpr 손계산, key 형식, 서명 전체 문자열, 오류 형을 확인한다.

const { scaleIntrinsics, drawingBufferSize, ClientRasterError } = contract;

/** contracts/raster 투영식: u = fx·x/d + cx, v = fy·y/d + cy. */
const project = (K, [x, y, d]) => [K.fx * x / d + K.cx, K.fy * y / d + K.cy];
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const assertK = (got, want) => {
  for (const n of ['fx', 'fy', 'cx', 'cy']) assert(near(got[n], want[n]), `${n}: ${got[n]} != ${want[n]}`);
};

// 기준: 원본 사진 2048×1152 에서 보정된 K(renderer_basis §1-2 와 같은 크기).
const REF_W = 2048;
const REF_H = 1152;
const K_REF = Object.freeze({ fx: 1000, fy: 1000, cx: 1024, cy: 576 });
const XC = [1, 0.5, 10]; // 카메라 좌표 점. 기준 격자 투영 (1124, 626)

test('형식 상수는 contracts/asset·contracts/points 와 같다', () => {
  assert.equal(contract.FORMAT_POINT27, 1);
  assert.equal(contract.FORMAT_GAUSS56, 2);
  assert.equal(contract.FORMAT_POINT27, asset.FORMAT_POINT27);
  assert.equal(contract.FORMAT_GAUSS56, asset.FORMAT_GAUSS56);
  assert.equal(contract.FORMAT_POINT27, points.FORMAT_POINT27);
  assert.equal(contract.FORMAT_GAUSS56, points.FORMAT_GAUSS56);
  assert.deepEqual({ ...contract.RECORD_BYTES }, { 1: 27, 2: 56 });
  assert.deepEqual({ ...contract.RECORD_BYTES }, { ...asset.SOURCE_RECORD_BYTES });
  assert.deepEqual({ ...contract.RECORD_BYTES }, { ...points.RECORD_BYTES });
  assert.equal(Object.isFrozen(contract.RECORD_BYTES), true);
  // 형식 1 만 법선 평면을 가진다(법선 의미는 형식 1 에만 적용)
  const names = (f) => asset.PLANES[f].map((p) => p.name);
  assert(names(asset.FORMAT_POINT27).includes('normal_oct_x'));
  assert(!names(asset.FORMAT_GAUSS56).some((n) => n.startsWith('normal')));
  for (const f of [asset.FORMAT_POINT27, asset.FORMAT_GAUSS56]) {
    assert.deepEqual(names(f).slice(3, 6), ['color_r', 'color_g', 'color_b']);
    assert(asset.PLANES[f].slice(3, 6).every((p) => p.type === 'u8'));
  }
});

test('근거 없는 28 B 패딩 상수는 내보내지 않는다', () => {
  assert.equal('POINT27_PADDED_BYTES' in contract, false);
  assert.equal(Object.values(contract).includes(28), false);
});

test('scaleIntrinsics: 같은 가로세로비, dpr 2 (손계산)', () => {
  // CSS 960×540, dpr 2 → 버퍼 1920×1080, sx = sy = 1920/2048 = 0.9375
  assert.deepEqual(drawingBufferSize(960, 540, 2), { width: 1920, height: 1080 });
  const K = scaleIntrinsics(K_REF, REF_W, REF_H, 960, 540, 2);
  assertK(K, { fx: 937.5, fy: 937.5, cx: 960, cy: 540 });
  const [u, v] = project(K, XC);
  assert(near(u, 1053.75) && near(v, 586.875), `${u},${v}`);
  // 기준 투영 (1124, 626) 을 배율로 옮긴 값과의 차이 ≤ 0.5 px
  assert(Math.abs(u - 1124 * 0.9375) <= 0.5 && Math.abs(v - 626 * 0.9375) <= 0.5);
});

test('scaleIntrinsics: 가로세로비가 다르면 fx·cx 와 fy·cy 를 따로 늘린다(손계산)', () => {
  // CSS 800×600, dpr 1.5 → 버퍼 1200×900, sx = 1200/2048 = 0.5859375, sy = 900/1152 = 0.78125
  const K = scaleIntrinsics(K_REF, REF_W, REF_H, 800, 600, 1.5);
  assertK(K, { fx: 585.9375, fy: 781.25, cx: 600, cy: 450 });
  const [u, v] = project(K, XC);
  assert(near(u, 658.59375) && near(v, 489.0625), `${u},${v}`);
  assert(Math.abs(u - 1124 * 0.5859375) <= 0.5 && Math.abs(v - 626 * 0.78125) <= 0.5);
  // 예전 스칼라 배율(K·sx 하나)이면 v = 585.9375·0.05 + 576·0.5859375 = 366.796875 로 122 px 넘게 어긋난다
  const scalar = { fx: 1000 * 0.5859375, fy: 1000 * 0.5859375, cx: 1024 * 0.5859375, cy: 576 * 0.5859375 };
  const [, vs] = project(scalar, XC);
  assert(near(vs, 366.796875));
  assert(Math.abs(vs - v) > 0.5);
});

test('scaleIntrinsics: dpr 은 한 번만 적용되고 단계를 나눠도 결과가 같다', () => {
  // CSS 960×540·dpr 2 와 CSS 1920×1080·dpr 1 은 같은 장치 격자다
  assert.deepEqual(scaleIntrinsics(K_REF, REF_W, REF_H, 960, 540, 2), scaleIntrinsics(K_REF, REF_W, REF_H, 1920, 1080, 1));
  // 원본 → CSS(dpr 1) → 장치(dpr) 두 단계 = 원본 → 장치 한 단계
  for (const [W, H, dpr] of [[960, 540, 2], [800, 600, 1.5], [333, 222, 1.25]]) {
    const css = scaleIntrinsics(K_REF, REF_W, REF_H, W, H, 1);
    const two = scaleIntrinsics(css, W, H, W, H, dpr);
    const one = scaleIntrinsics(K_REF, REF_W, REF_H, W, H, dpr);
    for (const n of ['fx', 'fy', 'cx', 'cy']) assert(near(two[n], one[n], 1e-9), `${W}×${H}@${dpr} ${n}`);
  }
});

test('scaleIntrinsics: 버퍼 반올림이 있는 dpr 에서 CSS 위치 차이 ≤ 0.5 장치 픽셀(손계산)', () => {
  // CSS 333×222, dpr 1.25 → 416.25×277.5 → 버퍼 416×278
  assert.deepEqual(drawingBufferSize(333, 222, 1.25), { width: 416, height: 278 });
  // 가로 쪽 반올림도 고정: 333·1.5 = 499.5 → 500, 223·1.5 = 334.5 → 335, 333·1.7 = 566.1 → 566
  assert.deepEqual(drawingBufferSize(333, 223, 1.5), { width: 500, height: 335 });
  assert.deepEqual(drawingBufferSize(333, 223, 1.7), { width: 566, height: 379 });
  const Kd = scaleIntrinsics(K_REF, REF_W, REF_H, 333, 222, 1.25);
  assertK(Kd, { fx: 203.125, fy: 1000 * 278 / 1152, cx: 208, cy: 139 });
  const Kc = scaleIntrinsics(K_REF, REF_W, REF_H, 333, 222, 1);
  assertK(Kc, { fx: 162.59765625, fy: 1000 * 222 / 1152, cx: 166.5, cy: 111 });
  // 안쪽 점: 장치 (228.3125, 151.0659…) 대 CSS×dpr (228.4497…, 150.7942…) → 차이 0.137, 0.272
  const [ud, vd] = project(Kd, XC);
  const [uc, vc] = project(Kc, XC);
  assert(near(ud, 228.3125) && near(vd, 139 + 50 * 278 / 1152));
  assert(near(uc, 182.759765625) && near(vc, 111 + 50 * 222 / 1152));
  assert(Math.abs(ud - uc * 1.25) <= 0.5 && Math.abs(vd - vc * 1.25) <= 0.5);
  // 오른쪽·아래 끝 점(기준 u = 2048, v = 1152): 장치 (416, 278) 대 CSS×dpr (416.25, 277.5) → 0.25, 0.5 (상한에 닿음)
  const edge = [1.024, 0.576, 1];
  const [ue, ve] = project(Kd, edge);
  const [uce, vce] = project(Kc, edge);
  assert(near(ue, 416) && near(ve, 278));
  assert(near(uce * 1.25, 416.25) && near(vce * 1.25, 277.5));
  assert(Math.abs(ue - uce * 1.25) <= 0.5 + 1e-9 && Math.abs(ve - vce * 1.25) <= 0.5 + 1e-9);
});

test('scaleIntrinsics: 픽셀 규약은 contracts/raster 와 같다(정수 = 칸 모서리, 중심 u=i+0.5, cx·sx)', () => {
  const K = scaleIntrinsics(K_REF, REF_W, REF_H, 960, 540, 2);
  // 영상 중심(기준 cx = 2048/2)은 버퍼 중심 1920/2 로 간다. 칸 중심 규약('half')이면 959.96875 가 된다
  assert.equal(K.cx, 960);
  assert.notEqual(K.cx, (1024 + 0.5) * 0.9375 - 0.5);
  // 기준 픽셀 1123 의 중심 1123.5 는 장치 좌표 1053.28125 → 칸 floor = 1053
  assert.equal(Math.floor(1123.5 * 0.9375), 1053);
  const [u] = project(K, XC);
  assert.equal(Math.floor(u), 1053);
});

test('scaleIntrinsics·drawingBufferSize 는 잘못된 입력을 ClientRasterError(view)로 거부한다', () => {
  const bad = [
    () => scaleIntrinsics(null, REF_W, REF_H, 960, 540, 1),
    () => scaleIntrinsics({ ...K_REF, fx: 0 }, REF_W, REF_H, 960, 540, 1),
    () => scaleIntrinsics({ ...K_REF, cy: NaN }, REF_W, REF_H, 960, 540, 1),
    () => scaleIntrinsics(K_REF, 0, REF_H, 960, 540, 1),
    () => scaleIntrinsics(K_REF, REF_W, REF_H, 960.5, 540, 1),
    () => scaleIntrinsics(K_REF, REF_W, REF_H, 960, 540, 0),
    () => scaleIntrinsics(K_REF, REF_W, REF_H, 960, 540, Infinity),
    () => drawingBufferSize(1, 1, 0.1),
  ];
  for (const f of bad) {
    assert.throws(f, (e) => e instanceof ClientRasterError && e.code === 'view' && /^client_raster: view: /.test(e.message));
  }
  // 입력 K 를 바꾸지 않는다(순수)
  const K = { ...K_REF };
  scaleIntrinsics(K, REF_W, REF_H, 800, 600, 1.5);
  assert.deepEqual(K, K_REF);
});

test('key 는 ASSET_FORMAT §11 정규 문자열(server/asset/ids encodeChunkKey)이고 proto 의 a:b 형식이 아니다', () => {
  const golden = [
    [{ segmentId: 7, level: 2, tileX: 1, tileY: -2, lod: 0, chunkIndex: 0 }, '7.2.1.-2.0.0'],
    [{ segmentId: 7, level: 3, tileX: 0, tileY: 0, lod: 1, chunkIndex: 2 }, '7.3.0.0.1.2'],
  ];
  for (const [k, s] of golden) {
    assert.equal(encodeChunkKey(k), s);
    assert.match(s, contract.PIECE_KEY_PATTERN);
    assert.doesNotMatch(pieceKeyString(k), contract.PIECE_KEY_PATTERN);
  }
  for (const s of ['07.2.1.-2.0.0', '7.2.1.-0.0.0', '7.4.0.0.0.0', '7.2.0.0.8.0', '7:2:0:0:0:0', '7.2.0.0.0', '']) {
    assert.doesNotMatch(s, contract.PIECE_KEY_PATTERN, s);
  }
});

test('createRenderer 는 ClientRasterError(unimplemented)를 던진다', () => {
  assert.throws(
    () => contract.createRenderer({}),
    (e) => e instanceof ClientRasterError && e.code === 'unimplemented' && e.name === 'ClientRasterError' && /^client_raster: unimplemented: /.test(e.message),
  );
});

test('ClientRasterError 는 code 와 client_raster: 접두를 가진다', () => {
  const err = new ClientRasterError('piece', 'bad');
  assert(err instanceof Error);
  assert.equal(err.name, 'ClientRasterError');
  assert.equal(err.code, 'piece');
  assert.equal(err.message, 'client_raster: piece: bad');
});

test('CLIENT_RASTER_API 서명은 문자열 전체가 기대값과 같다(순서 포함)', () => {
  const expected = {
    createRenderer: 'createRenderer(options) -> Renderer  options: {canvas, maxPieceBytes, maxResidentBytes}',
    uploadPiece: 'renderer.uploadPiece(key, bytes) -> Promise<void>  key: ASSET_FORMAT §11 "seg.level.tileX.tileY.lod.chunk", bytes: .skla piece (format 1|2)',
    releasePiece: 'renderer.releasePiece(key) -> void',
    setView: 'renderer.setView(view) -> void  view: {R, t, K, width, height, devicePixelRatio}  K·width·height in CSS px',
    draw: 'renderer.draw() -> FrameStats  {drawnPoints, drawnPieces, droppedFrames, drawMs}',
    memoryBytes: 'renderer.memoryBytes() -> number',
    dispose: 'renderer.dispose() -> void',
    onContextLost: 'renderer.onContextLost(callback?) -> void',
    onContextRestored: 'renderer.onContextRestored(callback?) -> void',
    drawingBufferSize: 'drawingBufferSize(width, height, dpr) -> {width, height}  = round(width·dpr), round(height·dpr)',
    scaleIntrinsics: 'scaleIntrinsics(K, refW, refH, W, H, dpr) -> Intrinsics  sx = round(W·dpr)/refW, sy = round(H·dpr)/refH',
  };
  assert.equal(Object.isFrozen(contract.CLIENT_RASTER_API), true);
  assert.deepEqual(Object.keys(contract.CLIENT_RASTER_API), Object.keys(expected));
  for (const [name, fn] of Object.entries(expected)) {
    assert.deepEqual(Object.keys(contract.CLIENT_RASTER_API[name]), ['fn'], name);
    assert.equal(contract.CLIENT_RASTER_API[name].fn, fn, name);
  }
  // 내보낸 함수 이름과 표가 맞는다
  for (const name of ['createRenderer', 'drawingBufferSize', 'scaleIntrinsics']) assert.equal(typeof contract[name], 'function', name);
});
