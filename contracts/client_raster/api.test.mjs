import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_RASTER_API } from './index.mjs';
import { createRenderer } from '../../client/raster/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  // 계약에 정의된 옵션 키
  const contractOptionKeys = new Set([
    'canvas', 'maxPieceBytes', 'maxResidentBytes', 'decode', 'onEvict',
    'shading', 'now', 'contextAttributes',
  ]);
  // 시험 전용 확장
  const testOnlyExtensions = new Set(['testHooks']);
  const allowedKeys = new Set([...contractOptionKeys, ...testOnlyExtensions]);

  // Proxy 로 createRenderer 가 읽는 옵션 키를 추적한다
  const accessLog = { get: new Set(), has: new Set(), ownKeys: [] };
  const canvas = fakeCanvas();
  const baseOptions = {
    canvas,
    maxPieceBytes: 1 << 20,
    maxResidentBytes: 1 << 20,
    decode: (bytes) => ({ header: { format: 3, pointCount: 1, bboxMin: [0, 0, 0], quantExp: 0 }, planes: { pos_e: new Float32Array(1), pos_n: new Float32Array(1), pos_u: new Float32Array(1), color_r: new Uint8Array(1), color_g: new Uint8Array(1), color_b: new Uint8Array(1), normal_oct_x: new Int8Array(1), normal_oct_y: new Int8Array(1) } }),
    shading: { lightDirWorld: [0, 0, 1] },
    contextAttributes: {},
    onEvict: () => {},
    now: () => 0,
    testHooks: {},
  };

  const proxiedOptions = new Proxy(baseOptions, {
    get(target, key) {
      if (typeof key === 'string' && key !== 'toJSON' && key !== 'constructor') {
        accessLog.get.add(key);
      }
      return target[key];
    },
    has(target, key) {
      if (typeof key === 'string') {
        accessLog.has.add(key);
      }
      return key in target;
    },
    ownKeys(target) {
      accessLog.ownKeys.push(Object.getOwnPropertyNames(target));
      return Object.getOwnPropertyNames(target);
    },
  });

  // createRenderer 호출해 읽힌 옵션 추적
  const renderer = createRenderer(proxiedOptions);
  if (renderer) renderer.dispose?.();

  // 읽힌 옵션이 모두 허용된 것인지 확인
  for (const key of accessLog.get) {
    assert.ok(allowedKeys.has(key), `createRenderer 옵션 '${key}' 가 계약 또는 시험 전용 확장에 있어야 함`);
  }
  for (const key of accessLog.has) {
    assert.ok(allowedKeys.has(key), `has 로 확인한 옵션 '${key}' 가 계약 또는 시험 전용 확장에 있어야 함`);
  }
  for (const keyList of accessLog.ownKeys) {
    for (const key of keyList) {
      assert.ok(allowedKeys.has(key), `ownKeys 에 포함된 옵션 '${key}' 가 계약 또는 시험 전용 확장에 있어야 함`);
    }
  }

  // 계약 옵션이 모두 읽혀야 함
  for (const key of contractOptionKeys) {
    assert.ok(accessLog.get.has(key), `계약 옵션 '${key}' 가 createRenderer 에서 읽혀야 함`);
  }
});

test('CONTRACT: draw 중 options deferred 접근 추적', () => {
  const contractOptionKeys = new Set([
    'canvas', 'maxPieceBytes', 'maxResidentBytes', 'decode', 'onEvict',
    'shading', 'now', 'contextAttributes',
  ]);
  const testOnlyExtensions = new Set(['testHooks']);
  const allowedKeys = new Set([...contractOptionKeys, ...testOnlyExtensions]);

  const accessLog = { get: new Set(), has: new Set(), ownKeys: [] };
  const canvas = fakeCanvas();
  const baseOptions = {
    canvas,
    maxPieceBytes: 1 << 20,
    maxResidentBytes: 1 << 20,
    decode: (bytes) => ({
      header: {
        format: 1, pointCount: 1, bboxMin: [0, 0, 0], quantExp: 0,
        segmentId: 1, level: 0, tileX: 0, tileY: 0, lod: 0, chunkIndex: 0,
      },
      planes: {
        pos_e: new Float32Array(1), pos_n: new Float32Array(1), pos_u: new Float32Array(1),
        color_r: new Uint8Array(1), color_g: new Uint8Array(1), color_b: new Uint8Array(1),
        normal_oct_x: new Int8Array(1), normal_oct_y: new Int8Array(1),
      },
    }),
    shading: { lightDirWorld: [0, 0, 1] },
    contextAttributes: {},
    onEvict: () => {},
    now: () => 0,
    testHooks: {},
  };

  const proxiedOptions = new Proxy(baseOptions, {
    get(target, key) {
      if (typeof key === 'string' && key !== 'toJSON' && key !== 'constructor') {
        accessLog.get.add(key);
      }
      return target[key];
    },
    has(target, key) {
      if (typeof key === 'string') {
        accessLog.has.add(key);
      }
      return key in target;
    },
    ownKeys(target) {
      accessLog.ownKeys.push(Object.getOwnPropertyNames(target));
      return Object.getOwnPropertyNames(target);
    },
  });

  const renderer = createRenderer(proxiedOptions);
  renderer.draw();
  renderer.dispose();

  const getList = [...accessLog.get];
  for (const key of getList) {
    assert.ok(
      allowedKeys.has(key),
      `get 으로 접근한 옵션 '${key}' 가 계약 또는 시험 전용 확장에 있어야 함 (추적: ${getList})`,
    );
  }
  for (const key of accessLog.has) {
    assert.ok(
      allowedKeys.has(key),
      `has 로 확인한 옵션 '${key}' 가 계약 또는 시험 전용 확장에 있어야 함`,
    );
  }
});

test('CONTRACT: setView-uploadPiece-setArrived-draw-dispose 시퀀스 중 options 지연 접근 추적', async () => {
  const contractOptionKeys = new Set([
    'canvas', 'maxPieceBytes', 'maxResidentBytes', 'decode', 'onEvict',
    'shading', 'now', 'contextAttributes',
  ]);
  const testOnlyExtensions = new Set(['testHooks']);
  const allowedKeys = new Set([...contractOptionKeys, ...testOnlyExtensions]);

  const accessLog = { get: new Set(), has: new Set(), ownKeys: [] };
  const canvas = fakeCanvas();
  const baseOptions = {
    canvas,
    maxPieceBytes: 1 << 20,
    maxResidentBytes: 1 << 20,
    decode: (bytes) => ({
      header: {
        format: 1, pointCount: 1, bboxMin: [0, 0, 0], quantExp: 0,
        segmentId: 1, level: 0, tileX: 0, tileY: 0, lod: 0, chunkIndex: 0,
      },
      planes: {
        pos_e: new Float32Array(1), pos_n: new Float32Array(1), pos_u: new Float32Array(1),
        color_r: new Uint8Array(1), color_g: new Uint8Array(1), color_b: new Uint8Array(1),
        normal_oct_x: new Int8Array(1), normal_oct_y: new Int8Array(1),
      },
    }),
    shading: { lightDirWorld: [0, 0, 1] },
    contextAttributes: {},
    onEvict: () => {},
    now: () => 0,
    testHooks: {},
  };

  const proxiedOptions = new Proxy(baseOptions, {
    get(target, key) {
      if (typeof key === 'string' && key !== 'toJSON' && key !== 'constructor') {
        accessLog.get.add(key);
      }
      return target[key];
    },
    has(target, key) {
      if (typeof key === 'string') {
        accessLog.has.add(key);
      }
      return key in target;
    },
    ownKeys(target) {
      accessLog.ownKeys.push(Object.getOwnPropertyNames(target));
      return Object.getOwnPropertyNames(target);
    },
  });

  // createRenderer 호출 (생성 중 options 읽기는 정상)
  const renderer = createRenderer(proxiedOptions);

  // 생성 후 accesses 초기화 (지연 접근 추적용)
  const creationGetCount = accessLog.get.size;
  const creationHasCount = accessLog.has.size;
  const creationOwnKeysCount = accessLog.ownKeys.length;

  // 생성 후에는 options 에 접근하지 않아야 함을 확인하기 위해 초기화
  accessLog.get.clear();
  accessLog.has.clear();
  accessLog.ownKeys = [];

  // setView 호출
  renderer.setView({ R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], K: { fx: 1, fy: 1, cx: 0, cy: 0 }, width: 300, height: 150, devicePixelRatio: 1 });

  // uploadPiece 호출
  const key = '1.0.0.0.0.0';
  const bytes = new Uint8Array(100);
  await renderer.uploadPiece(key, bytes);

  // setArrived 호출 (지연 경로, 선택은 다음 draw 에서)
  renderer.setArrived([{ segmentId: 1, level: 0, keys: [key] }], { deferResult: true });

  // draw 호출 (GL 경로 포함)
  renderer.draw();

  // dispose 호출
  renderer.dispose();

  // 시퀀스 중 deferred accesses 확인 (생성 후 접근이 있으면 안 됨)
  assert.equal(accessLog.get.size, 0, `setView-uploadPiece-setArrived-draw-dispose 중 options get 호출 없어야 함 (기록: ${[...accessLog.get]})`);
  assert.equal(accessLog.has.size, 0, 'setView-uploadPiece-setArrived-draw-dispose 중 options has 호출 없어야 함');
  assert.equal(accessLog.ownKeys.length, 0, 'setView-uploadPiece-setArrived-draw-dispose 중 options ownKeys 호출 없어야 함');
});
