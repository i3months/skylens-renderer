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
    // 결합 주의: 이 계수는 parsePieceKey 가 key.split('.') 로 해석한다는 구현에 묶여 있다. parsePieceKey 가 정규식 exec 등
    // 다른 방식으로 바뀌면 n 이 0 이 되어 이 시험이 깨진다. 그때는 계수 방식을 새 구현에 맞추되 '한 key 한 번 해석' 의미는 유지한다.
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

// F-243 ④: 같은 (구간, 수준, 타일) 의 LOD 는 하나만 그린다(ASSET_FORMAT §10.1). 기준값은 손으로 적은 key 문자열이다.
describe('selectDrawable: 타일마다 LOD 하나(F-243 ④)', () => {
  const A = (segmentId, level, keys) => ({ segmentId, level, keys });

  test('두 LOD 가 모두 도착·상주: 가장 세밀한 lod 하나만 draw, 나머지는 discard(입력·도착 순서와 무관)', () => {
    const l0 = '7.1.3.-4.0.0';
    const l2 = '7.1.3.-4.2.0';
    const want = { draw: [l0], pending: [], discard: [l2] };
    assert.deepEqual(selectDrawable([l0, l2], [A(7, 1, [l0, l2])]), want);
    assert.deepEqual(selectDrawable([l2, l0], [A(7, 1, [l2, l0])]), want);
    // 같은 수준 항목이 둘로 나뉘어 와도(완료 집합 합집합) 같다
    assert.deepEqual(selectDrawable([l0, l2], [A(7, 1, [l2]), A(7, 1, [l0])]), want);
  });

  test('세 LOD·여러 chunk: 고른 LOD 의 chunk 는 모두 draw, 성긴 LOD 의 chunk 는 모두 discard', () => {
    const keys = ['7.1.0.0.5.0', '7.1.0.0.1.0', '7.1.0.0.3.0', '7.1.0.0.1.1', '7.1.0.0.5.1'];
    assert.deepEqual(selectDrawable(keys, [A(7, 1, keys)]), {
      draw: ['7.1.0.0.1.0', '7.1.0.0.1.1'], pending: [], discard: ['7.1.0.0.5.0', '7.1.0.0.3.0', '7.1.0.0.5.1'],
    });
  });

  test('완료 집합 밖의 세밀한 LOD 는 고르지 않는다: 도착한 LOD 를 draw, 집합 밖 key 는 discard', () => {
    const l0 = '7.1.0.0.0.0'; // 상주하지만 LEVEL_ARRIVED 창 밖(완료 아님)
    const l2 = '7.1.0.0.2.0';
    assert.deepEqual(selectDrawable([l0, l2], [A(7, 1, [l2])]), { draw: [l2], pending: [], discard: [l0] });
  });

  test('완료 집합에 있으나 상주하지 않는 세밀한 LOD 는 고르지 않는다: 상주한 성긴 LOD 를 계속 draw', () => {
    const l0 = '7.1.0.0.0.0';
    const l2 = '7.1.0.0.2.0';
    assert.deepEqual(selectDrawable([l2], [A(7, 1, [l0, l2])]), { draw: [l2], pending: [], discard: [] });
  });

  test('세밀한 LOD 가 일부 chunk 만 상주하면 완전한 성긴 LOD 를 draw, 세밀한 쪽은 pending. 완전해지면 바뀐다', () => {
    const f0 = '7.1.0.0.0.0';
    const f1 = '7.1.0.0.0.1';
    const c0 = '7.1.0.0.2.0';
    const arrived = [A(7, 1, [f0, f1, c0])];
    assert.deepEqual(selectDrawable([f0, c0], arrived), { draw: [c0], pending: [f0], discard: [] });
    assert.deepEqual(selectDrawable([f0, c0, f1], arrived), { draw: [f0, f1], pending: [], discard: [c0] });
  });

  test('완전한 LOD 가 없으면 상주 chunk 가 있는 가장 세밀한 LOD 를 draw(일부 chunk 만, 다른 LOD 로 메우지 않음)', () => {
    const f0 = '7.1.0.0.0.0';
    const f1 = '7.1.0.0.0.1';
    const c0 = '7.1.0.0.2.0';
    const c1 = '7.1.0.0.2.1';
    assert.deepEqual(selectDrawable([c0, f0], [A(7, 1, [f0, f1, c0, c1])]), { draw: [f0], pending: [], discard: [c0] });
  });

  test('타일·구간이 다르면 따로 고른다, 낮은 수준은 LOD 와 무관하게 discard', () => {
    const a0 = '7.1.0.0.0.0';
    const a2 = '7.1.0.0.2.0';
    const b2 = '7.1.1.0.2.0'; // 다른 타일: 그 타일의 유일한 LOD 라 draw
    const c3 = '8.1.0.0.3.0'; // 다른 구간의 같은 타일 좌표
    const low = '7.0.0.0.0.0'; // 낮은 수준
    const keys = [low, a2, b2, c3, a0];
    assert.deepEqual(selectDrawable(keys, [A(7, 0, [low]), A(7, 1, [a0, a2, b2]), A(8, 1, [c3])]), {
      draw: [b2, c3, a0], pending: [], discard: [low, a2],
    });
  });

  test('tileY 만 다른 타일도 따로 고른다', () => {
    const a0 = '7.1.5.6.0.0';
    const a2 = '7.1.5.6.2.0';
    const b2 = '7.1.5.7.2.0'; // tileY 만 다름: 그 타일의 유일한 LOD 라 draw
    assert.deepEqual(selectDrawable([a0, a2, b2], [A(7, 1, [a0, a2, b2])]), { draw: [a0, b2], pending: [], discard: [a2] });
  });

  test('같은 완료 key 가 여러 LEVEL_ARRIVED 항목에 있어도 완료 chunk 수를 두 번 세지 않는다', () => {
    const f0 = '7.1.0.0.0.0';
    const c0 = '7.1.0.0.2.0';
    // f0 이 두 항목에 겹쳐 있다. 두 번 세면 lod 0 이 '덜 상주'로 보여 c0 를 그리게 된다
    assert.deepEqual(selectDrawable([f0, c0], [A(7, 1, [f0, c0]), A(7, 1, [f0])]), { draw: [f0], pending: [], discard: [c0] });
  });

  test('중복 key 가 있어도 LOD 상주 수를 두 번 세지 않는다', () => {
    const f0 = '7.1.0.0.0.0';
    const f1 = '7.1.0.0.0.1';
    const c0 = '7.1.0.0.2.0';
    // f0 이 두 번 들어와도 f1 이 없으므로 lod 0 은 완전하지 않다
    assert.deepEqual(selectDrawable([f0, c0, f0], [A(7, 1, [f0, f1, c0])]), { draw: [c0], pending: [f0], discard: [] });
  });
});
