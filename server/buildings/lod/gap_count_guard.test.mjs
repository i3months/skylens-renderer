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

test('Infinity 예산: 계수가 유한 양수이고 예산은 Infinity 로 남는다', () => {
  const b = { cells: Infinity };
  const { res, d } = delta(b);
  assert.deepEqual(res, { e: 0.5, w: 1 });
  assert.equal(d, 5);
  assert.equal(b.cells, Infinity);
});

test('NaN 예산: 계수 NaN 아님', () => {
  const { d } = delta({ cells: NaN });
  assert.ok(Number.isFinite(d) && d >= 0);
});
