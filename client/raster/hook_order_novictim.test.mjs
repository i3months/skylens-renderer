// F-261: 희생 없는 makeRoom 의 위치를 onGlUploadStart 와 맞대어 고정한다.
// 한도 여유가 있으면 makeRoom 은 첫 줄(pool.residentBytes() - (meta.get(key)?.bytes ?? 0))만 하고 돌아가므로 onEvict·gl 호출·select 사건이
// 없어 hook_order.test.mjs 의 사건 기록만으로는 Start 가 makeRoom 앞으로 옮겨져도 구별되지 않는다. 제품 코드에는 이 구간의 다른 입구가 없다
// (maxResidentBytes 는 버퍼 풀이 양의 정수만 받아 getter 를 못 끼우고, options 는 생성 때 한 번만 읽힌다). 새 testHooks 는 만들지 않고 두 가지로 관측한다.
//  1) 결정적: 같은 key 를 다시 올리면 makeRoom 첫 줄의 meta.get(key) 가 {format,count,origin,bytes} 값을 돌려준다. 시험 중에만
//     Map.prototype.get 을 감싸 그 호출(풀의 pieces.get 은 {bytes,buffers}, 다른 표는 모양이 다르다)을 'makeRoom' 사건으로 기록하고,
//     그 사건이 Start 앞에 있음(= Start 시점에 makeRoom 의 계산이 끝났음)을 단언한다.
//  2) 시계: Start~End 는 pool.upload 뿐이므로 짧다. makeRoom 에 오래 걸리는 일이 들어가도 그 시간이 GL 구간에 섞이면 실패한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, toGpuPlanes } from './index.mjs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { FORMAT_POINT27 } from '../../contracts/client_raster/index.mjs';

function fakeCanvas(log) {
  const base = {
    getShaderParameter: () => true, getProgramParameter: () => true, createShader: () => ({}), createProgram: () => ({}),
    createVertexArray: () => ({}), getUniformLocation: (_p, name) => ({ name }),
    getParameter: () => [1, 1024], isContextLost: () => false,
  };
  const gl = new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === 'string' && /^[A-Z_0-9]+$/.test(p)) return p;
      if (p === 'createBuffer') return () => { log.push('gl.createBuffer'); return {}; };
      return () => { log.push(`gl.${String(p)}`); };
    },
  });
  return { width: 300, height: 150, getContext: (k) => (k === 'webgl2' ? gl : null), addEventListener() {}, removeEventListener() {} };
}

function piece(key) {
  const [segmentId, level, , , lod, chunkIndex] = key.split('.').map(Number);
  return packChunk({
    format: FORMAT_POINT27, segmentId, level, lod, chunkIndex, anchor: { lat: 37.5, lon: 127, alt: 30 },
    fields: { positions: Float32Array.from([0.5, 0.5, 5]), colors: Uint8Array.from([200, 200, 200]), normals: Float32Array.from([0, 0, 1]) },
  });
}
const K = '3.1.0.0.1.0';

function setup(log, clock) {
  return createRenderer({
    canvas: fakeCanvas(log), maxPieceBytes: 1 << 20, maxResidentBytes: 1 << 20, now: () => 1,
    onEvict: (keys) => log.push(`onEvict:${keys.join(',')}`),
    testHooks: {
      toGpuPlanes: (...a) => { log.push('toGpuPlanes'); return toGpuPlanes(...a); },
      selectDrawable: () => { log.push('select'); throw new Error('희생 없는 경로에서 select 가 불림'); },
      onGlUploadStart: () => { log.push('onGlUploadStart'); clock.start = performance.now(); },
      onGlUploadEnd: () => { log.push('onGlUploadEnd'); clock.end = performance.now(); },
    },
  });
}

// meta.get(key) 호출(값이 meta 항목 모양)만 'makeRoom' 으로 기록한다
async function withMetaProbe(log, fn) {
  const orig = Map.prototype.get;
  Map.prototype.get = function (k) {
    const v = orig.call(this, k);
    if (k === K && v !== undefined && v !== null && typeof v === 'object' && 'format' in v && 'count' in v && 'origin' in v && 'bytes' in v) log.push('makeRoom');
    return v;
  };
  try { return await fn(); } finally { Map.prototype.get = orig; }
}

test('희생 없는 업로드: makeRoom(meta.get)이 onGlUploadStart 앞이고 그 사이에 gl·onEvict·select 가 없다', async () => {
  const log = [];
  const clock = {};
  const r = setup(log, clock);
  await r.uploadPiece(K, piece(K)); // meta 에 K 를 둔다(다시 올릴 때 makeRoom 첫 줄이 항목을 돌려준다)
  log.length = 0;
  await withMetaProbe(log, () => r.uploadPiece(K, piece(K)));
  const m = log.indexOf('makeRoom');
  const s = log.indexOf('onGlUploadStart');
  assert.ok(m >= 0, `makeRoom 의 meta.get 이 관측되지 않음: ${log.join(' ')}`);
  assert.equal(log.indexOf('makeRoom', m + 1), -1, `업로드 1 회에 makeRoom 이 여러 번: ${log.join(' ')}`);
  assert.ok(s > m, `onGlUploadStart 가 makeRoom 앞: ${log.join(' ')}`);
  assert.deepEqual(log.slice(m + 1, s), [], `makeRoom 과 Start 사이에 다른 사건: ${log.join(' ')}`);
  assert.ok(m > log.indexOf('toGpuPlanes') || log.indexOf('toGpuPlanes') === -1, `makeRoom 이 변환 앞: ${log.join(' ')}`);
  assert.deepEqual(log.slice(0, m).filter((x) => x.startsWith('gl.') || x.startsWith('onEvict') || x === 'select'), [], '희생 없는 경로에 gl·onEvict·select 사건');
  r.dispose();
});

test('희생 없는 업로드: onGlUploadStart~End 시간은 짧다(makeRoom 의 시간이 GL 구간에 섞이지 않는다)', async () => {
  const log = [];
  const clock = {};
  const r = setup(log, clock);
  await r.uploadPiece(K, piece(K));
  // 일시 지연(GC·스케줄링)으로 거짓 실패가 나지 않게 3 회 중 최솟값에 상한을 건다(변이는 매번 느리므로 최솟값도 느리다)
  const spans = [];
  for (let i = 0; i < 3; i++) {
    await r.uploadPiece(K, piece(K));
    spans.push(clock.end - clock.start);
  }
  const span = Math.min(...spans);
  assert.ok(span < 60, `GL 구간 최솟값 ${span.toFixed(1)} ms(${spans.map((x) => x.toFixed(1))}): makeRoom 등 비-GL 작업이 Start~End 에 섞임`);
  r.dispose();
});
