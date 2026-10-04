import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInitialBundle, INITIAL_BUDGET_BYTES, WELCOME_FRAME_BYTES, LEVEL_ARRIVED_FRAME_BYTES, WS_HEADER_MAX_BYTES } from './index.mjs';
import { FRAME_HEADER_BYTES } from '../../../contracts/proto/index.mjs';
import { encodeMessage } from '../../proto/codec/index.mjs';
import { encodeFrame, OPCODES } from '../../ws/frame/index.mjs';

const s = Math.SQRT1_2;
const pose = { pos: [50, -50, 0.5], quat: [-s, 0, 0, s], fovY: 2.0 };
const item = (segmentId, tileX, bytes) => ({
  key: { segmentId, level: 0, lod: 0, chunkIndex: 0, tileX, tileY: 0 },
  bytes, bbox: { min: [45, 0, 0], max: [55, 10, 1] },
});
const wire = (m) => encodeFrame(OPCODES.BINARY, encodeMessage(m)).length;

test('F-209: bytes validation (negative, non-integer, NaN, string throw RangeError)', () => {
  for (const bad of [-100, -1, 1.5, NaN, Infinity, '5', undefined]) {
    assert.throws(() => buildInitialBundle({ pose, catalog: [item(1, 0, bad)] }), RangeError, String(bad));
  }
  assert.doesNotThrow(() => buildInitialBundle({ pose, catalog: [item(1, 0, 0)] }));
});

test('F-209: budgetBytes validation (integers >= WELCOME frame only)', () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, '10', null, 1, WELCOME_FRAME_BYTES - 1]) {
    assert.throws(() => buildInitialBundle({ pose, catalog: [item(1, 0, 5)], budgetBytes: bad }), RangeError, String(bad));
  }
  assert.doesNotThrow(() => buildInitialBundle({ pose, catalog: [item(1, 0, 5)], budgetBytes: WELCOME_FRAME_BYTES }));
});

test('F-217: WELCOME_FRAME_BYTES matches the real frame (contract header 8 B)', () => {
  assert.equal(FRAME_HEADER_BYTES, 8);
  assert.equal(WELCOME_FRAME_BYTES, encodeMessage({ type: 'WELCOME', sessionId: 1, resumed: false, nextPieceSeq: 1 }).length + WS_HEADER_MAX_BYTES);
  assert.equal(LEVEL_ARRIVED_FRAME_BYTES, encodeMessage({ type: 'LEVEL_ARRIVED', segmentId: 1, level: 0, pieceCount: 1 }).length + WS_HEADER_MAX_BYTES);
});

test('F-217: frameBytes never exceeds budgetBytes, even at the minimum budget', () => {
  const r = buildInitialBundle({ pose, catalog: [item(1, 0, 0)], budgetBytes: WELCOME_FRAME_BYTES });
  assert.ok(r.frameBytes <= WELCOME_FRAME_BYTES);
  assert.equal(r.droppedCount, 1);
});

test('F-209: negative bytes cannot enlarge the budget', () => {
  const cat = [item(1, 0, -100), item(1, 1, 14_999_000)];
  assert.throws(() => buildInitialBundle({ pose, catalog: cat }), RangeError);
});

test('F-209: WELCOME + PIECE + LEVEL_ARRIVED real frame sum <= 15,000,000 B', () => {
  assert.equal(INITIAL_BUDGET_BYTES, 15_000_000);
  for (const [nSeg, perSeg] of [[1, 4], [3, 4], [5, 5]]) {
    const n = nSeg * perSeg;
    const size = Math.floor(15_000_000 / n);
    const cat = [];
    for (let i = 0; i < n; i++) cat.push(item(1 + (i % nSeg), i, size));
    const r = buildInitialBundle({ pose, catalog: cat });
    assert.ok(r.items.length >= 1);
    assert.ok(r.droppedCount >= 1, `n=${n}: some pieces must be dropped`);
    let real = wire({ type: 'WELCOME', sessionId: 1, resumed: false, nextPieceSeq: 1 });
    const perSegment = new Map();
    r.items.forEach((it, i) => {
      real += wire({ type: 'PIECE', pieceSeq: i + 1, key: it.key, chunk: new Uint8Array(it.bytes) });
      perSegment.set(it.key.segmentId, (perSegment.get(it.key.segmentId) ?? 0) + 1);
    });
    for (const [segmentId, pieceCount] of perSegment) {
      real += wire({ type: 'LEVEL_ARRIVED', segmentId, level: 0, pieceCount });
    }
    assert.ok(real <= 15_000_000, `n=${n}: real sum ${real}`);
    assert.ok(r.frameBytes >= real && r.frameBytes <= 15_000_000);
  }
});
