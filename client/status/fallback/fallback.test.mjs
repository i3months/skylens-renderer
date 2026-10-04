import test from 'node:test';
import assert from 'node:assert/strict';
import { createFallbackController } from './index.mjs';

test('처음은 live/null/null', () => {
  assert.deepEqual(createFallbackController().state(), { mode: 'live', reason: null, message: null });
});
test('error code 5 는 fallback/unavailable', () => {
  const c = createFallbackController();
  const s = c.handle({ kind: 'error', code: 5 });
  assert.equal(s.mode, 'fallback');
  assert.equal(s.reason, 'unavailable');
  assert.equal(typeof s.message, 'string');
});
test('closed 1006 은 fallback/closed, connected 로 live 복귀', () => {
  const c = createFallbackController();
  assert.equal(c.handle({ kind: 'closed', code: 1006 }).reason, 'closed');
  assert.equal(c.handle({ kind: 'closed' }).reason, 'closed');
  assert.deepEqual(c.handle({ kind: 'connected' }), { mode: 'live', reason: null, message: null });
});
test('closed 1000 은 live 유지, 폴백 중에도 유지', () => {
  const c = createFallbackController();
  assert.equal(c.handle({ kind: 'closed', code: 1000 }).mode, 'live');
  c.handle({ kind: 'timeout' });
  assert.equal(c.handle({ kind: 'closed', code: 1000 }).reason, 'timeout');
});
test('error code 1 은 live 유지', () => {
  const c = createFallbackController();
  assert.equal(c.handle({ kind: 'error', code: 1 }).mode, 'live');
  assert.equal(c.handle({ kind: 'error' }).mode, 'live');
});
test('timeout 은 fallback/timeout', () => {
  assert.equal(createFallbackController().handle({ kind: 'timeout' }).reason, 'timeout');
});
test('같은 fallback 에서 최신 reason 으로 바뀌고 문장이 다르다', () => {
  const c = createFallbackController();
  const a = c.handle({ kind: 'timeout' });
  const b = c.handle({ kind: 'closed', code: 1006 });
  assert.equal(b.reason, 'closed');
  assert.notEqual(a.message, b.message);
});
test('잘못된 입력은 TypeError 이고 상태 불변', () => {
  const c = createFallbackController();
  c.handle({ kind: 'timeout' });
  const before = c.state();
  for (const bad of [{ kind: 'x' }, {}, null, 'closed', { kind: 'closed', code: '1' }]) {
    assert.throws(() => c.handle(bad), TypeError);
  }
  assert.deepEqual(c.state(), before);
});
test('helloTimeoutMs 검사와 보관', () => {
  for (const bad of [0, -1, 1.5, NaN, '5']) assert.throws(() => createFallbackController({ helloTimeoutMs: bad }), RangeError);
  const c = createFallbackController({ helloTimeoutMs: 3000 });
  assert.equal(c.helloTimeoutMs(), 3000);
  assert.equal('helloTimeoutMs' in c.state(), false);
  assert.equal(createFallbackController().helloTimeoutMs(), undefined);
});
test('돌려준 객체를 바꿔도 내부 상태는 그대로', () => {
  const c = createFallbackController();
  const s = c.handle({ kind: 'timeout' });
  s.mode = 'live'; s.reason = null;
  c.state().message = 'x';
  assert.deepEqual(c.state().reason, 'timeout');
  assert.equal(c.state().mode, 'fallback');
});
