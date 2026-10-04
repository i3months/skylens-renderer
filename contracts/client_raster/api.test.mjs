import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CLIENT_RASTER_API } from './index.mjs';

test('CONTRACT: CLIENT_RASTER_API 메서드 목록이 구현과 일치', (t) => {
  // 계약에 정의된 메서드 목록
  const contractMethods = Object.keys(CLIENT_RASTER_API).sort();

  // 구현에서 필수 메서드 (Renderer 인터페이스와 추가 메서드)
  const requiredMethods = [
    'createRenderer',
    'uploadPiece',
    'releasePiece',
    'setView',
    'draw',
    'memoryBytes',
    'dispose',
    'onContextLost',
    'onContextRestored',
    'setArrived',
    'residentKeys',
    'isContextLost',
    // 유틸 함수
    'drawingBufferSize',
    'scaleIntrinsics',
    'fitIntrinsics',
    'cvToGlExtrinsics',
    'cameraPointToGl',
    'pixelToNdc',
    'selectDrawable',
  ].sort();

  assert.deepEqual(contractMethods, requiredMethods, '계약 메서드 목록이 필수 메서드와 일치해야 함');
});

test('CONTRACT: 각 메서드가 fn 속성을 가짐', (t) => {
  for (const [name, meta] of Object.entries(CLIENT_RASTER_API)) {
    assert.ok(meta.fn, `메서드 ${name}이 fn 속성을 가져야 함`);
    assert.ok(typeof meta.fn === 'string', `${name}.fn은 문자열이어야 함`);
  }
});

test('CONTRACT: setArrived가 계약에 포함됨', (t) => {
  assert.ok(CLIENT_RASTER_API.setArrived, 'setArrived가 계약에 있어야 함');
  assert.ok(CLIENT_RASTER_API.setArrived.fn.includes('setArrived'), 'setArrived 설명 포함');
});

test('CONTRACT: residentKeys가 계약에 포함됨', (t) => {
  assert.ok(CLIENT_RASTER_API.residentKeys, 'residentKeys가 계약에 있어야 함');
  assert.ok(CLIENT_RASTER_API.residentKeys.fn.includes('residentKeys'), 'residentKeys 설명 포함');
});

test('CONTRACT: isContextLost가 계약에 포함됨', (t) => {
  assert.ok(CLIENT_RASTER_API.isContextLost, 'isContextLost가 계약에 있어야 함');
  assert.ok(CLIENT_RASTER_API.isContextLost.fn.includes('isContextLost'), 'isContextLost 설명 포함');
});

test('CONTRACT: onContextRestored 콜백이 인자(key 배열)를 받음', (t) => {
  const fn = CLIENT_RASTER_API.onContextRestored.fn;
  assert.ok(fn.includes('keys'), 'onContextRestored 콜백 인자 설명에 keys 포함');
});

test('CONTRACT: onContextLost 구독 해제 반환', (t) => {
  const fn = CLIENT_RASTER_API.onContextLost.fn;
  assert.ok(fn.includes('() => void') || fn.includes('해제'), '구독 해제 반환값 설명 포함');
});

test('CONTRACT: onContextRestored 구독 해제 반환', (t) => {
  const fn = CLIENT_RASTER_API.onContextRestored.fn;
  assert.ok(fn.includes('() => void') || fn.includes('해제'), '구독 해제 반환값 설명 포함');
});
