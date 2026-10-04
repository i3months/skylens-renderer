import test from 'node:test';
import assert from 'node:assert/strict';
import * as contract from './index.mjs';

// 클라이언트 래스터라이저 계약 검사.
// 내보낸 상수·에러·함수가 기대한 대로인지 확인한다.

test('상수: POINT27_BYTES = 27, CLIENT_RASTER_API frozen', () => {
  assert.equal(typeof contract.POINT27_BYTES, 'number');
  assert.equal(contract.POINT27_BYTES, 27);
  assert.equal(Object.isFrozen(contract.CLIENT_RASTER_API), true);
});

test('ClientRasterError 는 code 와 client_raster: 접두를 가진다', () => {
  const err = new contract.ClientRasterError('test', 'test message');
  assert(err instanceof Error);
  assert.equal(err.name, 'ClientRasterError');
  assert.equal(err.code, 'test');
  assert.match(err.message, /^client_raster: /);
});

test('createRenderer 는 함수이고 CLIENT_RASTER_API 에 서명이 있다', () => {
  assert.equal(typeof contract.createRenderer, 'function');
  const sig = contract.CLIENT_RASTER_API.createRenderer.fn;
  assert(sig.includes('createRenderer'));
  assert(sig.includes('Renderer'));
});

test('CLIENT_RASTER_API 는 9 개의 메서드 서명을 가진다', () => {
  const required = [
    'createRenderer',
    'uploadPiece',
    'releasePiece',
    'setView',
    'draw',
    'memoryBytes',
    'dispose',
    'onContextLost',
    'onContextRestored',
  ];
  assert.equal(Object.keys(contract.CLIENT_RASTER_API).length, 9);
  for (const name of required) {
    assert(contract.CLIENT_RASTER_API[name], `${name} 가 없음`);
    assert.equal(typeof contract.CLIENT_RASTER_API[name].fn, 'string');
  }
});

test('draw 는 FrameStats 를 반환하고 drawnPoints, drawnPieces, droppedFrames, drawMs 를 포함한다', () => {
  const drawSig = contract.CLIENT_RASTER_API.draw.fn;
  assert(drawSig.includes('FrameStats'));
  assert(drawSig.includes('drawnPoints'));
  assert(drawSig.includes('drawnPieces'));
  assert(drawSig.includes('droppedFrames'));
  assert(drawSig.includes('drawMs'));
});

test('setView 는 R, t, K, width, height, devicePixelRatio 를 포함한다', () => {
  const sig = contract.CLIENT_RASTER_API.setView.fn;
  assert(sig.includes('R'));
  assert(sig.includes('t'));
  assert(sig.includes('K'));
  assert(sig.includes('width'));
  assert(sig.includes('height'));
  assert(sig.includes('devicePixelRatio'));
});

test('uploadPiece 는 Promise 를 반환한다(비동기)', () => {
  const sig = contract.CLIENT_RASTER_API.uploadPiece.fn;
  assert(sig.includes('Promise'));
});

test('releasePiece, memoryBytes, dispose 는 동기식이다', () => {
  const releaseSig = contract.CLIENT_RASTER_API.releasePiece.fn;
  assert(!releaseSig.includes('Promise'));

  const memorySig = contract.CLIENT_RASTER_API.memoryBytes.fn;
  assert(memorySig.includes('number'));

  const disposeSig = contract.CLIENT_RASTER_API.dispose.fn;
  assert(!disposeSig.includes('Promise'));
});

test('onContextLost 와 onContextRestored 는 컨텍스트 이벤트 핸들러다', () => {
  assert(contract.CLIENT_RASTER_API.onContextLost);
  assert(contract.CLIENT_RASTER_API.onContextRestored);
});
