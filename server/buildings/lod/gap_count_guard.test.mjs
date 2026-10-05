// gapCells 계수가 비정상 진입 예산(음수·Infinity·NaN)과 near 빈 호출에서 음수·NaN 이 되지 않음을 지키는 시험.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gapCellError, distStats } from './index.mjs';

const member = (x0, y0, x1, y1) => ({
  minX: x0, minY: y0, maxX: x1, maxY: y1,
  fill: Float64Array.from([x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1]),
  segs: Float64Array.from([x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0]),
});
const A = member(0, 0, 1, 2), B = member(2, 0, 3, 2);
const box = { minX: 0, minY: 0, maxX: 3, maxY: 2 };
const delta = (budget, members = [A, B]) => {
  distStats.gapCells = 0; // 시험마다 초기화: 앞 시험의 NaN 이 전역 차이를 오염시키지 않게
  const before = 0;
  const res = gapCellError(1, 0, 2, 2, members, 1, box, budget);
  return { res, d: distStats.gapCells - before };
};

test('음수 예산: 계수 증가 0', () => {
  const { res, d } = delta({ cells: -1 });
  assert.equal(res, null);
  assert.equal(d, 0);
});

test('near 빈 호출: 계수 증가 0', () => {
  const { res, d } = delta({ cells: -1 }, [member(100, 100, 101, 101)]);
  assert.equal(res, null);
  assert.equal(d, 0);
});

test('양수 예산 near 빈 호출: 칸을 쓰지 않는다', () => {
  const b = { cells: 5 };
  const { res, d } = delta(b, [member(100, 100, 101, 101)]);
  assert.equal(res, null);
  assert.equal(d, 0);
  assert.equal(b.cells, 5);
});

test('Infinity 예산: 계수가 유한 양수이고 예산은 Infinity 로 남는다', () => {
  const b = { cells: Infinity };
  const { res, d } = delta(b);
  assert.deepEqual(res, { e: 0.5, w: 1 });
  assert.equal(d, 5);
  assert.equal(b.cells, Infinity);
});

test('NaN 예산: 거부(null)하고 칸을 쓰지 않으며 계수는 NaN 아님', () => {
  const b = { cells: NaN };
  const { res, d } = delta(b);
  assert.equal(res, null);
  assert.equal(d, 0);
  assert.ok(b.cells <= 0); // 무제한으로 돌지 않음(0 으로 바뀐 뒤 거부 칸 하나 감소)
});

test('예산 없음(undefined): 무제한이 아니라 거부', () => {
  const b = {};
  const { res, d } = delta(b);
  assert.equal(res, null);
  assert.equal(d, 0);
  assert.ok(b.cells <= 0);
});

test('Infinity 예산 + 예외: finally 가 예산을 Infinity 로 되돌리고 소비한 만큼 센다', () => {
  const bad = member(0, 0, 1, 2);
  Object.defineProperty(bad, 'segs', { get() { throw new Error('boom'); } });
  const b = { cells: Infinity };
  distStats.gapCells = 0;
  assert.throws(() => gapCellError(1, 0, 2, 2, [A, bad], 1, box, b), /boom/);
  assert.equal(b.cells, Infinity);
  assert.equal(distStats.gapCells, 1); // 예외 전에 쓴 칸 하나를 센다(finally 계수, F-391 ⑩)
});

test('유한 예산 5 + 예외: 예산 4 가 남고 계수 1 (계수가 finally 에서 올라간다)', () => {
  const bad = member(0, 0, 1, 2);
  Object.defineProperty(bad, 'segs', { get() { throw new Error('boom'); } });
  const b = { cells: 5 };
  distStats.gapCells = 0;
  assert.throws(() => gapCellError(1, 0, 2, 2, [A, bad], 1, box, b), /boom/);
  assert.equal(b.cells, 4);
  assert.equal(distStats.gapCells, 1);
});
