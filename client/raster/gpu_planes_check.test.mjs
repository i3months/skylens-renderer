// F-248 ⑤: checkGpuPlanes 검증 확장 - origin 유한성, 그리고 Worker 신뢰 값 검사
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGpuPlanes, toGpuPlanes } from './index.mjs';
import { decodeChunkClient } from '../codec/index.mjs';
import { packChunk } from '../../server/asset/pack/index.mjs';
import { ClientRasterError, FORMAT_POINT27, FORMAT_GAUSS56 } from '../../contracts/client_raster/index.mjs';

const ANCHOR = { lat: 37.5, lon: 127, alt: 30 };

function piece1(key, positions, colors, normals) {
  const [segmentId, level, , , lod, chunkIndex] = key.split('.').map(Number);
  const n = positions.length / 3;
  return packChunk({
    format: FORMAT_POINT27, segmentId, level, lod, chunkIndex, anchor: ANCHOR,
    fields: {
      positions: Float32Array.from(positions),
      colors: Uint8Array.from(colors ?? Array(3 * n).fill(200)),
      normals: Float32Array.from(normals ?? Array.from({ length: n }, () => [0, 0, 1]).flat()),
    },
  });
}

// Worker 가 gpu 를 만드는 것을 시뮬레이트
function withGpu(k, edit) {
  const d = decodeChunkClient(piece1(k, [0.5, 0.5, 5, 1.5, 0.5, 5.25], [1, 2, 3, 4, 5, 6], [0, 0, 1, 0, 0, 1]));
  const gpu = toGpuPlanes(d, d.header.bboxMin);
  const out = { header: d.header, planes: d.planes, gpu };
  if (edit) edit(out);
  return out;
}

test('checkGpuPlanes: origin 이 유한하지 않으면 piece 오류', () => {
  const k = '3.1.0.0.0.0';
  const d = withGpu(k);

  // Infinity origin - 첫 번째 축
  const inf1 = { ...d, gpu: { ...d.gpu, origin: [Infinity, 0, 0] } };
  assert.throws(() => checkGpuPlanes(inf1), (e) => e instanceof ClientRasterError && e.code === 'piece' && /origin/.test(e.message));

  // Infinity origin - 두 번째 축
  const inf2 = { ...d, gpu: { ...d.gpu, origin: [0, Infinity, 0] } };
  assert.throws(() => checkGpuPlanes(inf2), (e) => e instanceof ClientRasterError && e.code === 'piece');

  // Infinity origin - 세 번째 축
  const inf3 = { ...d, gpu: { ...d.gpu, origin: [0, 0, Infinity] } };
  assert.throws(() => checkGpuPlanes(inf3), (e) => e instanceof ClientRasterError && e.code === 'piece');

  // NaN origin - 첫 번째 축
  const nan1 = { ...d, gpu: { ...d.gpu, origin: [NaN, 0, 0] } };
  assert.throws(() => checkGpuPlanes(nan1), (e) => e instanceof ClientRasterError && e.code === 'piece');

  // -Infinity origin
  const neginf = { ...d, gpu: { ...d.gpu, origin: [-Infinity, 0, 0] } };
  assert.throws(() => checkGpuPlanes(neginf), (e) => e instanceof ClientRasterError && e.code === 'piece');
});

test('checkGpuPlanes: origin 이 정상 유한 값이면 통과', () => {
  const k = '3.1.0.0.0.0';
  const d = withGpu(k);

  // bboxMin 과 같은 origin 은 정상
  assert.doesNotThrow(() => checkGpuPlanes(d));

  // 다른 유한 값이라도 문제 없음(origin equality 는 별도로 검증함)
  // 이 테스트는 origin 유한성만 검증
});

test('checkGpuPlanes: 형식 1 은 법선, 형식 2 는 법선 없음(기존 검증)', () => {
  const k1 = '3.1.0.0.0.0';
  const d1 = withGpu(k1);
  assert.doesNotThrow(() => checkGpuPlanes(d1));
  assert.equal(checkGpuPlanes(d1).format, FORMAT_POINT27);

  // 형식 2 는 법선이 없어야 함
  const k2 = '3.1.0.0.0.1';
  const d2 = decodeChunkClient(packChunk({
    format: FORMAT_GAUSS56, segmentId: 3, level: 1, lod: 0, chunkIndex: 1, anchor: ANCHOR,
    fields: {
      positions: Float32Array.from([0.25, 0.5, 2]),
      fdc: new Float32Array(3),
      opacity: new Float32Array(1),
      scales: new Float32Array(3).fill(-3),
      rotations: Float32Array.from([1, 0, 0, 0]),
    },
  }));
  const gpu2 = toGpuPlanes(d2, d2.header.bboxMin);
  const out2 = { header: d2.header, planes: d2.planes, gpu: gpu2 };
  assert.doesNotThrow(() => checkGpuPlanes(out2));
  assert.equal(checkGpuPlanes(out2).format, FORMAT_GAUSS56);
});

test('checkGpuPlanes: count·형식·평면 검증(기존)', () => {
  const k = '3.1.0.0.0.0';
  const d = withGpu(k);

  // count 불일치
  const badCount = { ...d, gpu: { ...d.gpu, count: 1 } };
  assert.throws(() => checkGpuPlanes(badCount), (e) => e.code === 'piece' && /count/.test(e.message));

  // format 불일치
  const badFormat = { ...d, gpu: { ...d.gpu, format: FORMAT_GAUSS56 } };
  assert.throws(() => checkGpuPlanes(badFormat), (e) => e.code === 'piece' && /format/.test(e.message));

  // 평면 길이 불일치
  const badPlaneLen = { ...d, gpu: { ...d.gpu, planes: { ...d.gpu.planes, position: new Float32Array(3) } } };
  assert.throws(() => checkGpuPlanes(badPlaneLen), (e) => e.code === 'piece' && /평면/.test(e.message));
});
