import test from 'node:test';
import assert from 'node:assert/strict';
import { packSegLevel, unpackSegLevel, levelOfStep, encodeChunkKey, decodeChunkKey } from './index.mjs';

const MAX_SEG = 2 ** 30 - 1;

test('ids_roundtrip', () => {
  // 기준값(숫자 고정)
  assert.equal(packSegLevel(0, 0), 0);
  assert.equal(packSegLevel(7, 2), 30);
  assert.equal(packSegLevel(MAX_SEG, 3), 4294967295);
  assert.deepEqual(unpackSegLevel(30), { segmentId: 7, level: 2 });
  assert.deepEqual(unpackSegLevel(4294967295), { segmentId: 1073741823, level: 3 });
  assert.equal(levelOfStep(250), 0);
  assert.equal(levelOfStep(1000), 1);
  assert.equal(levelOfStep(3500), 2);
  assert.equal(levelOfStep(7000), 3);
  assert.equal(encodeChunkKey({ segmentId: 7, level: 2, tileX: 1, tileY: -2, lod: 0, chunkIndex: 0 }), '7.2.1.-2.0.0');
  assert.equal(encodeChunkKey({ segmentId: 7, level: 3, tileX: 0, tileY: 0, lod: 1, chunkIndex: 2 }), '7.3.0.0.1.2');
  assert.deepEqual(decodeChunkKey('7.2.1.-2.0.0'), { segmentId: 7, level: 2, tileX: 1, tileY: -2, lod: 0, chunkIndex: 0 });

  // 4수준 x 구간 1000개 (경계 포함) 왕복
  const segs = [0, MAX_SEG, 1, MAX_SEG - 1];
  for (let i = 0; segs.length < 1000; i++) segs.push((i * 1073741 + 12345) % (MAX_SEG + 1));
  assert.equal(segs.length, 1000);
  for (const seg of segs) {
    for (let level = 0; level < 4; level++) {
      const p = packSegLevel(seg, level);
      assert.equal(p, seg * 4 + level);
      assert.ok(Number.isInteger(p) && p >= 0 && p <= 0xffffffff);
      assert.deepEqual(unpackSegLevel(p), { segmentId: seg, level });
      const key = { segmentId: seg, level, tileX: -(2 ** 31), tileY: 2 ** 31 - 1, lod: 7, chunkIndex: 4294967295 };
      assert.equal(encodeChunkKey(key), `${seg}.${level}.-2147483648.2147483647.7.4294967295`);
      assert.deepEqual(decodeChunkKey(encodeChunkKey(key)), key);
    }
  }

  // 정규형이 아닌 문자열 거부
  for (const bad of [
    '07.2.1.-2.0.0', '7.02.1.-2.0.0', '7.2.01.-2.0.0', '7.2.1.-2.00.0', '7.2.1.-2.0.00',
    '+7.2.1.-2.0.0', '7.2.+1.-2.0.0', ' 7.2.1.-2.0.0', '7.2.1.-2.0.0 ', '7. 2.1.-2.0.0',
    '7.2.1.-0.0.0', '-0.2.1.-2.0.0', '7.2.-0.2.0.0',
    '1073741824.0.0.0.0.0', '-1.0.0.0.0.0', '7.4.0.0.0.0', '7.-1.0.0.0.0', '7.2.0.0.8.0',
    '7.2.0.0.0.4294967296', '7.2.0.0.0.-1', '7.2.2147483648.0.0.0', '7.2.-2147483649.0.0.0',
    '7.2.1.-2.0', '7.2.1.-2.0.0.0', '', '7.2.1.-2.0.', '7.2.1.-2.0.0.', '7.2.1.x.0.0', '7.2.1.1.5.0.0',
    '7.2.1.1e1.0.0', '7.2.1.1.5.0x1', '7.2.1.--2.0.0',
  ]) {
    assert.throws(() => decodeChunkKey(bad), { name: 'AssetFormatError' }, JSON.stringify(bad));
  }
  assert.throws(() => decodeChunkKey(null));

  // 범위 밖 입력은 던진다
  for (const [s, l] of [[-1, 0], [2 ** 30, 0], [0, -1], [0, 4], [1.5, 0], [0, 1.5], [NaN, 0], [0, NaN], [Infinity, 0]]) {
    assert.throws(() => packSegLevel(s, l), { name: 'AssetFormatError' });
  }
  for (const v of [-1, 2 ** 32, 1.5, NaN]) assert.throws(() => unpackSegLevel(v));
  const ok = { segmentId: 1, level: 1, tileX: 0, tileY: 0, lod: 0, chunkIndex: 0 };
  for (const patch of [
    { segmentId: 2 ** 30 }, { level: 4 }, { level: -1 }, { tileX: 2 ** 31 }, { tileY: -(2 ** 31) - 1 },
    { tileX: 0.5 }, { lod: 8 }, { lod: -1 }, { chunkIndex: 2 ** 32 }, { chunkIndex: -1 }, { chunkIndex: NaN },
  ]) {
    assert.throws(() => encodeChunkKey({ ...ok, ...patch }), { name: 'AssetFormatError' }, JSON.stringify(patch));
  }
  // 음수 0 타일은 '0' 으로 정규화된다
  assert.equal(encodeChunkKey({ ...ok, tileX: -0 }), '1.1.0.0.0.0');

  // 4개 스텝 외 던짐
  for (const step of [0, 249, 251, 500, 3501, 7001, -250, NaN, '250', undefined]) {
    assert.throws(() => levelOfStep(step), { name: 'AssetFormatError' }, String(step));
  }
});
