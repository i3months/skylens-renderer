// 실제 송출 경로 바이트 측정 시험(T11.11, F-187 ③). 표의 수치를 숫자로 고정한다.
// `node --test bench/proto/measure.test.mjs` 로 실행한다.

import test from 'node:test';
import assert from 'node:assert';
import { generate as generateLevels, levelCloud } from '../../fixtures/scenes/levels/index.mjs';
import { measureSyntheticScene, formatSegmentTable, packCloudPieces } from './measure.mjs';
import { syntheticSceneReport } from './report.mjs';
import { SEGMENT_BUDGET_BYTES } from './index.mjs';
import { decodeMessage as clientDecode } from '../../client/proto/index.mjs';

// 합성 장면 levels(seed 1, 구간 4 개, 구간 최고 수준 100000 점) 의 실제 프레임 바이트(손으로 고정한 값).
const EXPECTED = [
  { segmentId: 0, pieces: 14, frameBytes: 2064896 },
  { segmentId: 1, pieces: 18, frameBytes: 2065620 },
  { segmentId: 2, pieces: 20, frameBytes: 2065876 },
  { segmentId: 3, pieces: 22, frameBytes: 2066292 },
];

test('합성 장면 구간 4 개의 실제 프레임 바이트가 고정 수치와 같다', () => {
  const { rows, ledger } = measureSyntheticScene();
  assert.deepEqual(rows.map(({ segmentId, pieces, frameBytes }) => ({ segmentId, pieces, frameBytes })), EXPECTED);
  // 장부에도 같은 값이 기록된다
  for (const e of EXPECTED) assert.equal(ledger.perSegment().get(e.segmentId), e.frameBytes);
  assert.equal(ledger.initialBytes(), 0);
});

test('프레임 바이트 = 조각 바이트 + PIECE 머리(8+4+16) + ws 프레임 머리(4: 길이 126..65535 은 2+2 B)', () => {
  const { rows } = measureSyntheticScene();
  for (const r of rows) {
    // 조각마다 ws 머리가 4 B(본문 ≥ 126 B, ≤ 65535 B)이거나 10 B(> 65535 B)이므로 하한·상한만 확인한다.
    const perPieceMin = 28 + 4, perPieceMax = 28 + 10;
    assert.ok(r.frameBytes >= r.sklaBytes + r.pieces * perPieceMin);
    assert.ok(r.frameBytes <= r.sklaBytes + r.pieces * perPieceMax);
  }
});

test('모든 구간이 3,000,000 B 이하이고 표에 충족으로 나온다', () => {
  const { rows } = measureSyntheticScene();
  for (const r of rows) assert.ok(r.frameBytes <= SEGMENT_BUDGET_BYTES);
  assert.equal(syntheticSceneReport(), [
    '구간\t조각\t프레임바이트\t예산%(3000000 B)\t판정',
    '0\t14\t2064896\t68.83%\t충족',
    '1\t18\t2065620\t68.85%\t충족',
    '2\t20\t2065876\t68.86%\t충족',
    '3\t22\t2066292\t68.88%\t충족',
  ].join('\n'));
});

test('formatSegmentTable - 상한 초과는 미달로 표시, 정확히 상한은 충족', () => {
  const t = formatSegmentTable([
    { segmentId: 0, pieces: 1, frameBytes: 3_000_000 },
    { segmentId: 1, pieces: 1, frameBytes: 3_000_001 },
  ]).split('\n');
  assert.equal(t[1], '0\t1\t3000000\t100.00%\t충족');
  assert.equal(t[2], '1\t1\t3000001\t100.00%\t미달(초과 1 B)');
});

test('packCloudPieces - 한 조각은 maxPoints 이하, 점 수 합이 보존된다', () => {
  const n = 25;
  const positions = new Float32Array(3 * n);
  const normals = new Float32Array(3 * n);
  const colors = new Uint8Array(3 * n);
  for (let i = 0; i < n; i++) { positions[3 * i] = i; normals[3 * i + 1] = 1; }
  const pieces = packCloudPieces({ count: n, positions, normals, colors }, { segmentId: 5, level: 2, maxPoints: 10 });
  assert.deepEqual(pieces.map((p) => p.key.chunkIndex), [0, 1, 2]);
  assert.ok(pieces.every((p) => p.key.segmentId === 5 && p.key.level === 2 && p.key.tileX === 0 && p.key.tileY === 0));
});

test('기록된 프레임은 ws 프레임 머리 + 클라이언트 복호기로 읽히는 PIECE 이며 키·조각이 같다', () => {
  let checked = 0;
  measureSyntheticScene({
    segments: 1,
    onFrame(frame, key, skla) {
      const head = frame.length - skla.length - 28; // PIECE 머리 8 + pieceSeq 4 + 키 16
      assert.ok(head === 4 || head === 10, `ws 머리 ${head} B`);
      assert.equal(frame[0], 0x82, 'FIN + BINARY');
      const msg = clientDecode(frame.subarray(head));
      assert.equal(msg.type, 'PIECE');
      assert.deepEqual(msg.key, key);
      assert.equal(msg.pieceSeq, ++checked);
      assert.deepEqual(Buffer.from(msg.chunk), Buffer.from(skla));
    },
  });
  assert.equal(checked, 14, '구간 0 의 조각 14 개');
});

test('levels 장면은 ENU(동, 북)로 타일을 나눈다: 북쪽 [-50, 50] m 는 tileY {-1, 0}, 구간 0 은 동쪽 [0, 50] m 라 tileX 0', () => {
  const scene = generateLevels({ seed: 1, segments: 1, count: 20000 });
  for (let level = 0; level < 4; level++) {
    const pieces = packCloudPieces(levelCloud(scene, 0, level), { segmentId: 0, level });
    assert.deepEqual([...new Set(pieces.map((p) => p.key.tileY))].sort((a, b) => a - b), [-1, 0]);
    assert.deepEqual([...new Set(pieces.map((p) => p.key.tileX))], [0]);
  }
});
