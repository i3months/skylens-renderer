// F-066 unpack 음성 시험: 정상 파일의 바이트를 고쳐 AssetFormatError 코드를 단언한다. 체크섬은 보지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packChunk } from '../pack/index.mjs';
import { unpackChunk, toSourceRecords } from './index.mjs';
import {
  FORMAT_POINT27, FORMAT_GAUSS56, OFFSETS, AssetFormatError, bodyLayout, HEADER_SIZE,
} from '../../../contracts/asset/index.mjs';

const ANCHOR = { lat: 37.5, lon: 127, alt: 10 };
const N = 4;

function make(format) {
  const positions = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) positions.set([64 + i, 10 + i, 1 + i], 3 * i);
  const fields = format === FORMAT_POINT27
    ? { positions, normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), colors: new Uint8Array(3 * N).fill(100) }
    : {
      positions, fdc: new Float32Array(3 * N), opacity: new Float32Array(N),
      scales: new Float32Array(3 * N).fill(-3), rotations: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    };
  return packChunk({ format, segmentId: 1, level: 0, lod: 0, chunkIndex: 0, anchor: ANCHOR, fields });
}

const dvOf = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const planeOffset = (format, name) => HEADER_SIZE + bodyLayout(format, N).planes.find((p) => p.name === name).offset;

/** AssetFormatError 이고 코드가 같아야 한다(TypeError·RangeError 불가). */
function expectCode(bytes, code) {
  for (const fn of [unpackChunk, toSourceRecords]) {
    assert.throws(() => fn(bytes), (e) => {
      assert.ok(e instanceof AssetFormatError, `AssetFormatError 아님: ${e && e.constructor.name} ${e && e.message}`);
      assert.equal(e.code, code);
      return true;
    });
  }
}

test('정상 파일은 두 형식 모두 통과(기준선)', () => {
  for (const f of [FORMAT_POINT27, FORMAT_GAUSS56]) assert.doesNotThrow(() => unpackChunk(make(f)));
});

for (const format of [FORMAT_POINT27, FORMAT_GAUSS56]) {
  const tag = `형식 ${format}`;

  test(`${tag}: pointCount 0 → field`, () => {
    const b = make(format);
    dvOf(b).setUint32(OFFSETS.pointCount, 0, true);
    expectCode(b, 'field');
  });

  for (const [name, v] of [['NaN', NaN], ['+Infinity', Infinity], ['-Infinity', -Infinity]]) {
    for (const axis of [0, 1, 2]) {
      test(`${tag}: bboxMin[${axis}] ${name} → bbox`, () => {
        const b = make(format);
        dvOf(b).setFloat64(OFFSETS.bboxMin + 8 * axis, v, true);
        expectCode(b, 'bbox');
      });
    }
  }

  test(`${tag}: codec ≠ 0 → codec`, () => {
    for (const c of [1, 2, 127, 255]) {
      const b = make(format);
      b[OFFSETS.codec] = c;
      expectCode(b, 'codec');
    }
  });

  test(`${tag}: quantExp 7·11 → field`, () => {
    for (const q of [7, 11]) {
      const b = make(format);
      b[OFFSETS.quantExp] = q;
      expectCode(b, 'field');
    }
  });

  test(`${tag}: 본문 길이 부족 → body`, () => {
    const full = make(format);
    // 파일을 잘라내거나 bodyBytes 를 줄이는 두 방식
    expectCode(full.slice(0, full.length - 1), 'body');
    expectCode(full.slice(0, HEADER_SIZE), 'body');
    const b = full.slice();
    dvOf(b).setUint32(OFFSETS.bodyBytes, bodyLayout(format, N).requiredBytes - 4, true);
    expectCode(b, 'body');
  });
}

test('점 형식: snorm −128 → range', () => {
  for (const name of ['normal_oct_x', 'normal_oct_y']) {
    const b = make(FORMAT_POINT27);
    b[planeOffset(FORMAT_POINT27, name) + 1] = 0x80;
    expectCode(b, 'range');
  }
});

test('가우시안 형식: 회전 성분 1023 → range', () => {
  // 가장 큰 성분 인덱스 0, 나머지 세 성분 중 하나가 1023
  for (const shift of [20, 10, 0]) {
    const b = make(FORMAT_GAUSS56);
    const packed = ((0 << 30) | (512 << 20) | (512 << 10) | 512) >>> 0;
    const bad = ((packed & ~(1023 << shift)) | (1023 << shift)) >>> 0;
    dvOf(b).setUint32(planeOffset(FORMAT_GAUSS56, 'rotation') + 4, bad, true);
    expectCode(b, 'range');
  }
});
