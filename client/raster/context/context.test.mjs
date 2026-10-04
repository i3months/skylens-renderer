// createContext 시험: 가짜 canvas/gl 로 소실·복구 흐름, 중복 해제, dispose 후 무시. 실제 Chromium 시험은 context.browser.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from './index.mjs';
import { ClientRasterError } from '../../../contracts/client_raster/index.mjs';

function fakeCanvas({ gl = { isContextLost: () => false }, throwOnGet = false } = {}) {
  const ls = new Map();
  const calls = { getContext: [] };
  return {
    calls,
    listeners: ls,
    getContext(type, attrs) { calls.getContext.push([type, attrs]); if (throwOnGet) throw new Error('boom'); return gl; },
    addEventListener(n, f) { if (!ls.has(n)) ls.set(n, new Set()); ls.get(n).add(f); },
    removeEventListener(n, f) { ls.get(n)?.delete(f); },
    emit(n) {
      const ev = { prevented: 0, preventDefault() { this.prevented++; } };
      for (const f of [...(ls.get(n) ?? [])]) f(ev);
      return ev;
    },
  };
}

test('WebGL2 를 얻고 기본 속성을 넘긴다', () => {
  const c = fakeCanvas();
  const ctx = createContext({ canvas: c, attributes: { antialias: true } });
  assert.equal(c.calls.getContext.length, 1);
  assert.equal(c.calls.getContext[0][0], 'webgl2');
  assert.equal(c.calls.getContext[0][1].antialias, true);
  assert.equal(c.calls.getContext[0][1].depth, true);
  assert.ok(ctx.gl);
  assert.equal(ctx.isLost(), false);
});

test('문맥을 못 얻으면 ClientRasterError(context)', () => {
  for (const c of [fakeCanvas({ gl: null }), fakeCanvas({ throwOnGet: true }), null, {}]) {
    assert.throws(() => createContext({ canvas: c }), (e) => e instanceof ClientRasterError && e.code === 'context');
  }
});

test('소실 → 복구 흐름: preventDefault, 콜백 1회씩, isLost 전이', () => {
  const c = fakeCanvas();
  const ctx = createContext({ canvas: c });
  const log = [];
  ctx.onLost(() => log.push(`lost:${ctx.isLost()}`));
  ctx.onRestored(() => log.push(`restored:${ctx.isLost()}`));
  const ev = c.emit('webglcontextlost');
  assert.equal(ev.prevented, 1);
  assert.equal(ctx.isLost(), true);
  c.emit('webglcontextrestored');
  assert.equal(ctx.isLost(), false);
  assert.deepEqual(log, ['lost:true', 'restored:false']);
  // 두 번째 순환도 같다
  c.emit('webglcontextlost');
  c.emit('webglcontextrestored');
  assert.deepEqual(log, ['lost:true', 'restored:false', 'lost:true', 'restored:false']);
});

test('중복 해제: 소실 중 소실, 정상 중 복구는 콜백을 다시 부르지 않는다', () => {
  const c = fakeCanvas();
  const ctx = createContext({ canvas: c });
  let lost = 0, restored = 0;
  ctx.onLost(() => lost++);
  ctx.onRestored(() => restored++);
  c.emit('webglcontextrestored');
  assert.equal(restored, 0);
  const e1 = c.emit('webglcontextlost');
  const e2 = c.emit('webglcontextlost');
  assert.equal(lost, 1);
  assert.equal(e1.prevented + e2.prevented, 2); // 중복이어도 기본 동작은 막는다
  c.emit('webglcontextrestored');
  c.emit('webglcontextrestored');
  assert.equal(restored, 1);
});

test('구독 해제 함수와 콜백 예외 격리', () => {
  const c = fakeCanvas();
  const ctx = createContext({ canvas: c });
  let a = 0, b = 0;
  const off = ctx.onLost(() => a++);
  ctx.onLost(() => { throw new Error('x'); });
  ctx.onLost(() => b++);
  assert.throws(() => c.emit('webglcontextlost'), /x/);
  assert.equal(a, 1);
  assert.equal(b, 1); // 중간 콜백이 던져도 뒤 콜백은 불린다
  off();
  c.emit('webglcontextrestored');
  assert.throws(() => c.emit('webglcontextlost'), /x/);
  assert.equal(a, 1);
  assert.throws(() => ctx.onLost(1), (e) => e.code === 'context');
});

test('gl.isContextLost 가 참이면 isLost 도 참', () => {
  let l = false;
  const c = fakeCanvas({ gl: { isContextLost: () => l } });
  const ctx = createContext({ canvas: c });
  l = true;
  assert.equal(ctx.isLost(), true);
});

test('dispose 뒤: 리스너 제거, 이벤트 무시, 중복 dispose 무해, 새 구독은 무동작', () => {
  const c = fakeCanvas();
  const ctx = createContext({ canvas: c });
  let n = 0;
  ctx.onLost(() => n++);
  ctx.onRestored(() => n++);
  assert.equal(c.listeners.get('webglcontextlost').size, 1);
  ctx.dispose();
  ctx.dispose();
  assert.equal(c.listeners.get('webglcontextlost').size, 0);
  assert.equal(c.listeners.get('webglcontextrestored').size, 0);
  const ev = c.emit('webglcontextlost');
  assert.equal(ev.prevented, 0);
  c.emit('webglcontextrestored');
  assert.equal(n, 0);
  const off = ctx.onLost(() => n++);
  assert.equal(typeof off, 'function');
  off();
  // 늦게 도착한 이벤트를 직접 흘려도(리스너 참조 보유 가정) 무시되는지는 위 listeners 제거로 보장된다
  assert.equal(ctx.isLost(), false);
});

test('dispose 가 소실 중에 불려도 이후 복구 이벤트를 무시한다', () => {
  const c = fakeCanvas();
  const ctx = createContext({ canvas: c });
  let restored = 0;
  ctx.onRestored(() => restored++);
  const lostHandlers = [...c.listeners.get('webglcontextlost')];
  const restoredHandlers = [...c.listeners.get('webglcontextrestored')];
  c.emit('webglcontextlost');
  ctx.dispose();
  // 이미 디스패치 중이던 이벤트가 떼어진 핸들러에 도달하는 경우를 직접 모사
  for (const f of restoredHandlers) f({});
  for (const f of lostHandlers) f({ preventDefault() { throw new Error('호출되면 안 됨'); } });
  assert.equal(restored, 0);
});
