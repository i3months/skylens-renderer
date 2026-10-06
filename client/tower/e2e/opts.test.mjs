// createControlView 의 모듈 opts 검증: 비객체는 얕은 복사에서 걸러지지 않고 각 모듈 생성자의 TypeError 로 거부된다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlView } from './index.mjs';

const BAD = [5, null, [1], 'x', true];

for (const key of ['input', 'chase']) {
  test(`opts.${key} 가 비객체면 TypeError`, () => {
    for (const bad of BAD) {
      assert.throws(() => createControlView({ [key]: bad }), TypeError, `${key}=${JSON.stringify(bad)}`);
    }
  });
}

test('opts.input·opts.chase 가 undefined 나 객체면 만들어진다', () => {
  assert.ok(createControlView({ input: undefined, chase: undefined }));
  assert.ok(createControlView({ input: {}, chase: {} }));
  assert.ok(createControlView());
});
