// F-255 3차: GL 구간 경계 hook(testHooks.onGlUploadStart/End·onDrawStart/End)의 위치를 고정한다.
// T12.5 실측(loop/worker.browser.test.mjs)은 GL 구간과 겹친 시간을 long task 에서 빼므로, 경계 안에 비-GL 작업이 들어가면
// 그 시간이 판정에서 빠진다. 그래서 가짜 gl(버퍼 풀의 GL 호출 기록)과 spy 로 한 줄 사건 기록을 만들어 순서를 단언한다.
//  - 업로드: toGpuPlanes·지역 선택·makeRoom(희생 deleteBuffer·onEvict) → onGlUploadStart → pool.upload(createBuffer·bindBuffer·
//    bufferData 만) → onGlUploadEnd. Start 바로 다음이 pool.upload 의 첫 GL 호출이고, 그 사이 다른 작업이 없다.
//  - draw: currentSelection(지연 선택 select)이 onDrawStart 앞이고, Start~End 안에는 select 가 없다.
// 시간 단언은 없다(사건 순서만 본다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, toGpuPlanes } from './index.mjs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { FORMAT_POINT27, selectDrawable } from '../../contracts/client_raster/index.mjs';

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

// 점 1개 형식 1 = 17 B(평면 3 개)
function piece(key) {
  const [segmentId, level, , , lod, chunkIndex] = key.split('.').map(Number);
  return packChunk({
    format: FORMAT_POINT27, segmentId, level, lod, chunkIndex, anchor: { lat: 37.5, lon: 127, alt: 30 },
    fields: { positions: Float32Array.from([0.5, 0.5, 5]), colors: Uint8Array.from([200, 200, 200]), normals: Float32Array.from([0, 0, 1]) },
  });
}
const VIEW = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [-1, -1, 0], K: { fx: 20, fy: 20, cx: 16.5, cy: 12.5 }, width: 32, height: 24, devicePixelRatio: 1 };
const C0 = '3.1.0.0.1.0'; // 성긴 LOD(완전)
const V1 = '3.1.0.0.0.0'; // 세밀한 LOD 첫 chunk
const N1 = '3.1.0.0.0.1'; // 세밀한 LOD 둘째 chunk: 올리면 C0 가 희생된다
const POOL_UPLOAD = new Set(['gl.createBuffer', 'gl.bindBuffer', 'gl.bufferData']);

function setup(maxResidentBytes) {
  const log = [];
  const r = createRenderer({
    canvas: fakeCanvas(log), maxPieceBytes: 1 << 20, maxResidentBytes, now: () => 1,
    onEvict: (keys) => log.push(`onEvict:${keys.join(',')}`),
    testHooks: {
      toGpuPlanes: (...a) => { log.push('toGpuPlanes'); return toGpuPlanes(...a); },
      selectDrawable: (...a) => { log.push('select'); return selectDrawable(...a); },
      onGlUploadStart: () => log.push('onGlUploadStart'),
      onGlUploadEnd: () => log.push('onGlUploadEnd'),
      onDrawStart: () => log.push('onDrawStart'),
      onDrawEnd: () => log.push('onDrawEnd'),
    },
  });
  return { r, log };
}

// onGlUploadStart~End 안은 pool.upload 의 GL 호출뿐이고, Start 바로 다음이 첫 createBuffer, End 바로 앞이 마지막 bufferData 다
function assertUploadSpan(log, planes) {
  const s = log.indexOf('onGlUploadStart');
  const e = log.indexOf('onGlUploadEnd');
  assert.ok(s >= 0 && e > s, `업로드 경계 hook 짝이 없음: ${log.join(' ')}`);
  assert.equal(log.lastIndexOf('onGlUploadStart'), s, '업로드 1 회에 onGlUploadStart 가 여러 번');
  const inside = log.slice(s + 1, e);
  assert.equal(inside[0], 'gl.createBuffer', `onGlUploadStart 와 pool.upload 사이에 다른 작업: ${log.join(' ')}`);
  assert.equal(inside.at(-1), 'gl.bufferData', `pool.upload 와 onGlUploadEnd 사이에 다른 작업: ${log.join(' ')}`);
  assert.deepEqual(inside.filter((x) => !POOL_UPLOAD.has(x)), [], `업로드 GL 구간에 pool.upload 밖 작업: ${log.join(' ')}`);
  assert.equal(inside.filter((x) => x === 'gl.bufferData').length, planes);
  return { s, e };
}

test('업로드: makeRoom(희생 해제·onEvict) → onGlUploadStart → pool.upload → onGlUploadEnd, 경계 안은 pool.upload 뿐', async () => {
  const { r, log } = setup(34);
  r.setView(VIEW);
  await r.uploadPiece(C0, piece(C0));
  await r.uploadPiece(V1, piece(V1));
  r.setArrived([{ segmentId: 3, level: 1, keys: [C0, V1, N1] }]);
  assert.equal(r.draw().drawnPieces, 1);
  log.length = 0;
  await r.uploadPiece(N1, piece(N1));
  const { s } = assertUploadSpan(log, 3);
  const before = log.slice(0, s);
  // 변환·지역 선택·희생 해제·알림이 모두 Start 앞이고, makeRoom 의 마지막 일(onEvict) 바로 다음이 Start 다
  assert.deepEqual(before, ['toGpuPlanes', 'select', 'gl.deleteBuffer', 'gl.deleteBuffer', 'gl.deleteBuffer', `onEvict:${C0}`], `Start 앞 순서: ${log.join(' ')}`);
  assert.equal(log[s - 1], `onEvict:${C0}`);
  assert.deepEqual(log.slice(log.indexOf('onGlUploadEnd') + 1), [], 'onGlUploadEnd 뒤 기록 없음');
  r.dispose();
});

test('업로드(한도 여유, 희생 없음): toGpuPlanes 는 Start 앞, Start 바로 다음이 pool.upload', async () => {
  const { r, log } = setup(1 << 20);
  log.length = 0; // createRenderer 의 셰이더 준비 호출은 뺀다
  await r.uploadPiece(C0, piece(C0));
  const { s } = assertUploadSpan(log, 3);
  assert.deepEqual(log.slice(0, s), ['toGpuPlanes']);
  r.dispose();
});

test('draw: currentSelection(select)이 onDrawStart 앞이고 GL 구간 안에는 select 가 없다', async () => {
  const { r, log } = setup(1 << 20);
  r.setView(VIEW);
  await r.uploadPiece(C0, piece(C0));
  r.setArrived([{ segmentId: 3, level: 1, keys: [C0] }], { deferResult: true }); // 선택은 다음 draw 에서 돈다
  log.length = 0;
  assert.equal(r.draw().drawnPieces, 1);
  const s = log.indexOf('onDrawStart');
  const e = log.indexOf('onDrawEnd');
  assert.ok(s >= 0 && e > s, `draw 경계 hook 짝이 없음: ${log.join(' ')}`);
  assert.deepEqual(log.slice(0, s), ['select'], `onDrawStart 앞은 선택 계산뿐: ${log.join(' ')}`);
  const inside = log.slice(s + 1, e);
  assert.ok(!inside.includes('select'), 'draw GL 구간 안에서 선택이 돎');
  assert.ok(inside.includes('gl.drawArrays'), 'draw GL 구간 안에 drawArrays 가 없음');
  assert.deepEqual(log.slice(e + 1), []);
  r.dispose();
});
