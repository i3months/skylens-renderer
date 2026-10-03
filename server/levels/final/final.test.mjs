import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isSegmentFinal, allFinal } from './index.mjs';
import { createLevelMachine } from '../state/index.mjs';

test("isSegmentFinal - 마지막 수준에만 true", () => {
  const machine = createLevelMachine();
  machine.arrive(0, 0);
  assert.equal(isSegmentFinal(machine, 0), false);
  machine.arrive(1, 1);
  assert.equal(isSegmentFinal(machine, 1), false);
  machine.arrive(2, 2);
  assert.equal(isSegmentFinal(machine, 2), false);
  machine.arrive(3, 3);
  assert.equal(isSegmentFinal(machine, 3), true);
});
test("isSegmentFinal - 도착 전 구간은 false", () => {
  const machine = createLevelMachine();
  assert.equal(isSegmentFinal(machine, 999), false);
});
test("isSegmentFinal - 수준 3 후 낮은 수준 무시", () => {
  const machine = createLevelMachine();
  machine.arrive(0, 3);
  assert.equal(isSegmentFinal(machine, 0), true);
  machine.arrive(0, 1);
  assert.equal(isSegmentFinal(machine, 0), true);
  machine.arrive(0, 0);
  assert.equal(isSegmentFinal(machine, 0), true);
});
test("isSegmentFinal - 낮은 수준 후 수준 3 도착 (추월당함)", () => {
  const machine = createLevelMachine();
  machine.arrive(0, 0);
  assert.equal(isSegmentFinal(machine, 0), false);
  machine.arrive(0, 1);
  assert.equal(isSegmentFinal(machine, 0), false);
  machine.arrive(0, 3);
  assert.equal(isSegmentFinal(machine, 0), true);
});
test("allFinal - 빈 목록은 false", () => {
  const machine = createLevelMachine();
  assert.equal(allFinal(machine, []), false);
});
test("allFinal - 모든 구간 최종", () => {
  const machine = createLevelMachine();
  machine.arrive(0, 3);
  machine.arrive(1, 3);
  machine.arrive(2, 3);
  assert.equal(allFinal(machine, [0, 1, 2]), true);
});
test("allFinal - 부분적으로 최종", () => {
  const machine = createLevelMachine();
  machine.arrive(0, 3);
  machine.arrive(1, 3);
  machine.arrive(2, 1);
  assert.equal(allFinal(machine, [0, 1, 2]), false);
});
test("allFinal - 모르는 구간 포함", () => {
  const machine = createLevelMachine();
  machine.arrive(0, 3);
  machine.arrive(1, 3);
  assert.equal(allFinal(machine, [0, 1, 999]), false);
});
test("allFinal - 단일 구간", () => {
  const machine = createLevelMachine();
  machine.arrive(0, 3);
  assert.equal(allFinal(machine, [0]), true);
  machine.arrive(1, 2);
  assert.equal(allFinal(machine, [1]), false);
});
