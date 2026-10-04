import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import * as contract from './index.mjs';
import * as asset from '../asset/index.mjs';
import { encodeChunkKey, decodeChunkKey } from '../../server/asset/ids/index.mjs';

// selectDrawable 보강 시험(F-232): key 한 번 해석, 중복 key, -0, 입력 형 거부, scaleIntrinsics sy 거부, 상수 대조.

const { selectDrawable, scaleIntrinsics, parsePieceKey, ClientRasterError } = contract;
const isPieceError = (e) => e instanceof ClientRasterError && e.code === 'piece';
const isViewError = (e) => e instanceof ClientRasterError && e.code === 'view';
const K = Object.freeze({ fx: 1000, fy: 1000, cx: 100, cy: 100 });

describe('selectDrawable: 해석 횟수', () => {
  test('key 마다 한 번만 해석한다(String.prototype.split 호출 횟수로 관측)', () => {
    const keys = [];
    for (let i = 0; i < 50; i++) keys.push(`7.1.${i}.0.0.0`);
    const orig = String.prototype.split;
    let n = 0;
    String.prototype.split = function (sep, ...rest) {
      if (sep === '.') n++;
      return orig.call(this, sep, ...rest);
    };
    let out;
    try {
      out = selectDrawable(keys, [{ segmentId: 7, level: 1, keys }]);
    } finally {
      String.prototype.split = orig;
    }
    assert.equal(out.draw.length, 50);
    assert.equal(n, 50); // 이전에는 100
  });
});

describe('selectDrawable: 중복 key·-0·입력 형', () => {
  test('같은 key 가 중복되면 첫 등장만 남는다(draw·pending·discard 모두)', () => {
    const a = '1.1.0.0.0.0';
    const b = '1.1.1.0.0.0';
    const lo = '2.0.0.0.0.0'; // 구간 2 는 수준 1 이 도착해 level 0 은 discard
    const hi = '3.2.0.0.0.0'; // 구간 3 은 도착 없음 → pending
    const out = selectDrawable([a, b, a, lo, hi, lo, hi, b], [{ segmentId: 1, level: 1, keys: [a, b] }, { segmentId: 2, level: 1, keys: ['2.1.0.0.0.0'] }]);
    assert.deepEqual(out, { draw: [a, b], pending: [hi], discard: [lo] });
  });

  test('segmentId -0 은 거부한다(0 은 통과)', () => {
    assert.throws(() => selectDrawable([], [{ segmentId: -0, level: 0, keys: ['0.0.0.0.0.0'] }]), isPieceError);
    assert.doesNotThrow(() => selectDrawable([], [{ segmentId: 0, level: 0, keys: ['0.0.0.0.0.0'] }]));
  });

  test('keys 가 배열이 아니면 piece 오류', () => {
    for (const bad of [5, {}, 'a', null, undefined]) assert.throws(() => selectDrawable(bad, []), isPieceError);
  });

  test('arrived 가 배열이 아니면 piece 오류', () => {
    for (const bad of [5, {}, null, undefined]) assert.throws(() => selectDrawable([], bad), isPieceError);
  });

  test('중복 해석 제거 뒤에도 틀린 key 는 piece 오류', () => {
    assert.throws(() => selectDrawable(['bad'], []), isPieceError);
    assert.throws(() => selectDrawable([], [{ segmentId: 1, level: 0, keys: ['2.0.0.0.0.0'] }]), isPieceError);
  });
});

describe('scaleIntrinsics: sy 거부', () => {
  test('sy 가 범위 밖이면 sx 가 정상이어도 view 오류', () => {
    // sy = H/refH: 너무 큼(5000/1), 너무 작음(1/1e6)
    assert.throws(() => scaleIntrinsics(K, 100, 1, 100, 5000, 1), isViewError);
    assert.throws(() => scaleIntrinsics(K, 100, 1e6, 100, 1, 1), isViewError);
    // 경계는 통과: sy = 4096 (H 는 4096 으로 버퍼 상한 안), sx = 1
    assert.doesNotThrow(() => scaleIntrinsics(K, 100, 1, 100, 4096, 1));
  });

  test('sy 가 0 이나 NaN 이 되는 입력은 거부된다', () => {
    assert.throws(() => scaleIntrinsics(K, 100, 100, 100, 0, 1), isViewError);
    assert.throws(() => scaleIntrinsics(K, 100, NaN, 100, 100, 1), isViewError);
    assert.throws(() => scaleIntrinsics(K, 100, -100, 100, 100, 1), isViewError);
  });
});

describe('상수 대조: contracts/asset', () => {
  test('SEGMENT_ID_LIMIT·chunkIndex 상한이 asset 과 같다', () => {
    assert.equal(contract.SEGMENT_ID_LIMIT, asset.SEGMENT_ID_LIMIT);
    const lim = asset.CHUNK_INDEX_LIMIT;
    assert.equal(lim, 65536);
    assert.doesNotThrow(() => parsePieceKey(`0.0.0.0.0.${lim - 1}`));
    assert.throws(() => parsePieceKey(`0.0.0.0.0.${lim}`), isPieceError);
    // asset 쪽 인코더도 같은 경계
    assert.doesNotThrow(() => encodeChunkKey({ segmentId: 0, level: 0, tileX: 0, tileY: 0, lod: 0, chunkIndex: lim - 1 }));
    assert.throws(() => encodeChunkKey({ segmentId: 0, level: 0, tileX: 0, tileY: 0, lod: 0, chunkIndex: lim }));
  });

  test('tile 의 i32 범위가 asset 의 ChunkKey 검사와 같다', () => {
    const I32_MIN = -(2 ** 31);
    const I32_MAX = 2 ** 31 - 1;
    for (const [x, ok] of [[I32_MIN, true], [I32_MAX, true], [I32_MIN - 1, false], [I32_MAX + 1, false]]) {
      const key = `0.0.${x}.0.0.0`;
      const clientOk = (() => { try { parsePieceKey(key); return true; } catch { return false; } })();
      const assetOk = (() => { try { decodeChunkKey(key); return true; } catch { return false; } })();
      assert.equal(clientOk, ok, `client ${key}`);
      assert.equal(assetOk, ok, `asset ${key}`);
    }
  });
});
