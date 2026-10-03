import test from 'node:test';
import assert from 'node:assert/strict';
import { FORMAT_POINT27, FORMAT_GAUSS56, POINT27_PROPERTIES, GAUSS56_PROPERTIES, RECORD_BYTES, stride, detectFormat } from './index.mjs';
import { enuToScene, sceneToEnu } from '../geo/index.mjs';

test('레코드 크기는 27 B·56 B', () => {
  assert.equal(stride(POINT27_PROPERTIES), 27);
  assert.equal(stride(GAUSS56_PROPERTIES), 56);
  assert.equal(RECORD_BYTES[FORMAT_POINT27], 27);
  assert.equal(RECORD_BYTES[FORMAT_GAUSS56], 56);
});
test('형식 판별은 이름·순서·형이 정확히 같을 때만', () => {
  assert.equal(detectFormat(POINT27_PROPERTIES), FORMAT_POINT27);
  assert.equal(detectFormat(GAUSS56_PROPERTIES), FORMAT_GAUSS56);
  assert.equal(detectFormat([...POINT27_PROPERTIES].reverse()), null);
  assert.equal(detectFormat(POINT27_PROPERTIES.map((p) => (p.name === 'x' ? { name: 'x', type: 'double' } : p))), null);
  assert.equal(detectFormat([...GAUSS56_PROPERTIES, { name: 'extra', type: 'float' }]), null);
});
test('ENU ↔ 씬 좌표 축: x=동, y=위, z=−북', () => {
  assert.deepEqual(enuToScene([1, 2, 3]), [1, 3, -2]);
  assert.deepEqual(sceneToEnu([1, 3, -2]), [1, 2, 3]);
});
