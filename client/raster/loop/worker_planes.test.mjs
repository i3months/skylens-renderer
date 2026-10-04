// T12.5 복호 Worker 의 handleDecodeRequest 단위 시험(Worker 없이 직접 호출).
// 응답이 {header, planes: undefined, gpu} 이고 gpu 평면이 메인의 toGpuPlanes 결과와 같으며, transfer 에 gpu 버퍼만 중복 없이 들어가는지 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { packChunk } from '../../../server/asset/pack/index.mjs';
import { encodeChunk } from '../../../server/codec/chunk/index.mjs';
import { FORMAT_POINT27 } from '../../../contracts/asset/index.mjs';
import { decodeChunkClient } from '../../codec/index.mjs';
import { toGpuPlanes } from '../index.mjs';
import { handleDecodeRequest } from './worker.mjs';

function makeChunk(n) {
  const pos = new Float32Array(3 * n), nor = new Float32Array(3 * n), col = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) {
    pos.set([64 + (i % 17) * 1.5, -128 + (i % 13) * 2.25, 20 + (i % 7) * 0.5], 3 * i);
    nor.set([0, 0, 1], 3 * i);
    col.set([(i * 3) & 255, (i * 5) & 255, (i * 7) & 255], 3 * i);
  }
  const raw = packChunk({ format: FORMAT_POINT27, segmentId: 7, level: 2, lod: 0, chunkIndex: 0, anchor: { lat: 37.5, lon: 127.0, alt: 30.0 }, fields: { positions: pos, normals: nor, colors: col } });
  return encodeChunk(raw, { lossyColor: false });
}

test('handleDecodeRequest: gpu 평면 값이 toGpuPlanes(복호, bboxMin) 와 같다', () => {
  const bytes = makeChunk(500);
  const { message } = handleDecodeRequest({ id: 3, bytes: bytes.slice() });
  assert.equal(message.id, 3);
  assert.equal(message.error, undefined);
  const dec = decodeChunkClient(bytes.slice());
  const want = toGpuPlanes(dec, dec.header.bboxMin);
  const { header, planes, gpu } = message.result;
  assert.deepEqual(header, dec.header);
  assert.equal(planes, undefined, '복호 평면은 응답에서 뺀다');
  assert.equal(gpu.count, want.count);
  assert.equal(gpu.format, want.format);
  assert.deepEqual(gpu.origin, header.bboxMin);
  assert.deepEqual(Object.keys(gpu.planes).sort(), Object.keys(want.planes).sort());
  for (const k of Object.keys(want.planes)) {
    assert.equal(gpu.planes[k].constructor, want.planes[k].constructor, k);
    assert.deepEqual(Array.from(gpu.planes[k]), Array.from(want.planes[k]), k);
  }
});

test('handleDecodeRequest: transfer 에는 gpu 평면 버퍼만, 중복 없이', () => {
  const { message, transfer } = handleDecodeRequest({ id: 1, bytes: makeChunk(100) });
  const gpuBuffers = Object.values(message.result.gpu.planes).map((v) => v.buffer);
  assert.equal(transfer.length, gpuBuffers.length);
  assert.equal(new Set(transfer).size, transfer.length, '중복 없음');
  for (const b of transfer) assert.ok(b instanceof ArrayBuffer && gpuBuffers.includes(b));
  // 실제로 structuredClone 전송이 던지지 않는다
  assert.doesNotThrow(() => structuredClone(message, { transfer }));
});

test('handleDecodeRequest: 잘못된 입력은 error 응답이고 transfer 는 비어 있다', () => {
  for (const bad of [null, undefined, 5, { id: 9 }, { id: 9, bytes: new Uint8Array([1, 2, 3]) }, { id: 9, bytes: makeChunk(10).subarray(0, 20) }]) {
    const { message, transfer } = handleDecodeRequest(bad);
    assert.equal(typeof message.error, 'string', JSON.stringify(bad));
    assert.ok(message.error.length > 0);
    assert.equal(message.result, undefined);
    assert.deepEqual(transfer, []);
  }
  assert.equal(handleDecodeRequest({ id: 9, bytes: new Uint8Array(0) }).message.id, 9);
});
