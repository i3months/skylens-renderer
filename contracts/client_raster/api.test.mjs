import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CLIENT_RASTER_API } from './index.mjs';
import { createRenderer } from '../../client/raster/index.mjs';

test('CONTRACT: CLIENT_RASTER_API 메서드 목록이 계약 표 고정', (t) => {
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

  const contractKeys = new Set(contractMethods);
  for (const key of NON_RENDERER) {
    assert.ok(contractKeys.has(key), `NON_RENDERER 의 '${key}' 가 계약에 있어야 함`);
  }
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

// ---- 구현 대조: 가짜 gl 로 실제 createRenderer 를 만들어 계약과 비교한다 ----

/** 계약 표에서 렌더러 인스턴스 메서드가 아닌 것(생성자·유틸 함수). */
const NON_RENDERER = new Set([
  'createRenderer', 'drawingBufferSize', 'scaleIntrinsics', 'fitIntrinsics',
  'cvToGlExtrinsics', 'cameraPointToGl', 'pixelToNdc', 'selectDrawable',
]);
/** 계약 밖이지만 시험·관측용으로 허용하는 확장. 이 밖의 키는 실패다. */
const TEST_ONLY_EXTENSIONS = ['uploadBookkeeping'];

function fakeCanvas() {
  let ctxLost = false;
  const base = {
    createBuffer: () => ({}),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    createShader: () => ({}),
    createProgram: () => ({}),
    createVertexArray: () => ({}),
    getUniformLocation: (_p, name) => ({ name }),
    getParameter: (p) => (p === 'ALIASED_POINT_SIZE_RANGE' ? [1, 1024] : 0),
    isContextLost: () => ctxLost,
  };
  const gl = new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === 'string' && /^[A-Z_0-9]+$/.test(p)) return p;
      return () => {};
    },
  });
  const listeners = new Map();
  const canvas = {
    width: 300, height: 150,
    getContext: (kind) => (kind === 'webgl2' ? gl : null),
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    fire(type) {
      if (type === 'webglcontextlost') ctxLost = true;
      if (type === 'webglcontextrestored') ctxLost = false;
      for (const fn of [...(listeners.get(type) ?? [])]) fn({ preventDefault() {} });
    },
  };
  return canvas;
}

function makeRenderer() {
  const canvas = fakeCanvas();
  const renderer = createRenderer({ canvas, maxPieceBytes: 1 << 20, maxResidentBytes: 1 << 20 });
  return { renderer, canvas };
}

test('IMPL: Object.keys(renderer) = 계약 렌더러 키 + 시험 전용 확장', () => {
  const { renderer } = makeRenderer();
  const contractKeys = Object.keys(CLIENT_RASTER_API).filter((k) => !NON_RENDERER.has(k));
  const actual = Object.keys(renderer);
  const missing = contractKeys.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !contractKeys.includes(k) && !TEST_ONLY_EXTENSIONS.includes(k));
  assert.deepEqual(missing, [], `계약에 있으나 구현에 없는 키: ${missing}`);
  assert.deepEqual(extra, [], `계약 밖 구현 키(허용 확장 제외): ${extra}`);
  for (const k of contractKeys) assert.equal(typeof renderer[k], 'function', `${k} 는 함수여야 함`);
});

test('IMPL: onContextRestored 콜백은 key 배열을 받고 구독 해제가 호출을 끊는다', () => {
  const { renderer, canvas } = makeRenderer();
  const got = [];
  const off = renderer.onContextRestored((keys) => got.push(keys));
  assert.equal(typeof off, 'function');
  canvas.fire('webglcontextlost');
  assert.equal(renderer.isContextLost(), true);
  canvas.fire('webglcontextrestored');
  assert.equal(got.length, 1);
  assert.ok(Array.isArray(got[0]), '콜백 인자는 key 배열');
  off();
  canvas.fire('webglcontextlost');
  canvas.fire('webglcontextrestored');
  assert.equal(got.length, 1, '해제 뒤에는 불리지 않아야 함');
  assert.equal(renderer.isContextLost(), false);
});

test('IMPL: onContextLost 구독 해제가 호출을 끊는다', () => {
  const { renderer, canvas } = makeRenderer();
  let n = 0;
  const off = renderer.onContextLost(() => { n += 1; });
  canvas.fire('webglcontextlost');
  assert.equal(n, 1);
  canvas.fire('webglcontextrestored');
  off();
  canvas.fire('webglcontextlost');
  assert.equal(n, 1, '해제 뒤에는 불리지 않아야 함');
});

test('CONTRACT: createRenderer 옵션이 계약 또는 시험 전용 확장에만 속함', () => {
  const contractOptionKeys = new Set([
    'canvas', 'maxPieceBytes', 'maxResidentBytes', 'decode', 'onEvict',
    'shading', 'now', 'contextAttributes',
  ]);
  const testOnlyExtensions = new Set(['testHooks']);
  const allowedKeys = new Set([...contractOptionKeys, ...testOnlyExtensions]);

  const { renderer: _r, canvas } = makeRenderer();

  const implOptionKeys = new Set([
    'canvas', 'maxPieceBytes', 'maxResidentBytes', 'decode', 'onEvict',
    'shading', 'now', 'contextAttributes', 'testHooks',
  ]);

  for (const key of implOptionKeys) {
    assert.ok(allowedKeys.has(key), `구현 옵션 '${key}' 가 계약 또는 시험 전용 확장에 있어야 함`);
  }

  for (const key of allowedKeys) {
    assert.ok(implOptionKeys.has(key), `계약 옵션 '${key}' 가 구현에 지원되어야 함 (또는 선택 사항)` );
  }
});
