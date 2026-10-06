// 관제탑 폴백 frame 호출 횟수 시험(T15.9, F-454 ①). step 1 회 = fallback.frame 1 회, snapshot 1 회 = 1 회.
// 모듈 파일은 바꾸지 않는다: 로더 훅이 읽는 순간 폴백 모듈 소스에 호출 계수 래퍼를 덧붙인다(디스크 불변).
// 기대값은 구조에서 나온다: step 은 크기 검사(가벼운 검사)를 하고 마지막에 snapshotOf 가 frame 을 한 번 부른다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const HOOK = `
export async function load(url, context, next) {
  const r = await next(url, context);
  if (url.endsWith('/tower/fallback/index.mjs')) {
    let src = String(r.source);
    src = src.replace('export function createTowerFallback(', 'function __orig(');
    src += '\\nexport function createTowerFallback(o) { const f = __orig(o);' +
      ' return { ...f, frame(s) { globalThis.__towerFrameCalls = (globalThis.__towerFrameCalls ?? 0) + 1; return f.frame(s); } }; }\\n';
    return { ...r, source: src, shortCircuit: true };
  }
  return r;
}`;
register('data:text/javascript,' + encodeURIComponent(HOOK));
const { createControlView } = await import('./index.mjs');

const SIZE = { width: 800, height: 600 };
const calls = () => globalThis.__towerFrameCalls ?? 0;
const count = (fn) => { const b = calls(); fn(); return calls() - b; };

function scene(view) {
  view.setDrones([{ id: 'd1', enu: [0, 0, 30], yaw: 0.5 }, { id: 'd2', enu: [200, 100, 40] }]);
  view.setDetections([{ id: 't1', enu: [100, 50, 0] }]);
  view.setPath({ id: 'p1', points: [[0, 0, 0], [100, 50, 0]] });
}

test('계수 래퍼가 동작한다(snapshot 1 회 = frame 1 회)', () => {
  const view = createControlView();
  assert.equal(count(() => view.snapshot(SIZE)), 1);
});

test('live: step 1 회 = frame 1 회', () => {
  const view = createControlView();
  scene(view);
  for (let i = 0; i < 5; i++) assert.equal(count(() => view.step(0.1, SIZE)), 1, `step ${i}`);
});

test('fallback: step 1 회 = frame 1 회', () => {
  const view = createControlView();
  scene(view);
  view.setAvailable(false);
  assert.equal(view.mode(), 'fallback');
  for (let i = 0; i < 5; i++) assert.equal(count(() => view.step(0.1, SIZE)), 1, `step ${i}`);
});

test('드론 없는 입력 카메라 경로에서도 step 1 회 = frame 1 회, 키 입력 중에도 같다', () => {
  const view = createControlView();
  view.keyDown('KeyW');
  assert.equal(count(() => view.step(0.1, SIZE)), 1);
  assert.equal(count(() => view.step(0, SIZE)), 1);
});

test('snapshot 은 scene 에 상관없이 frame 1 회, 던지는 step 은 frame 0 회', () => {
  const view = createControlView();
  scene(view);
  assert.equal(count(() => view.snapshot(SIZE)), 1);
  assert.equal(count(() => assert.throws(() => view.step(0.1, { width: 0, height: 600 }))), 0);
  assert.equal(count(() => assert.throws(() => view.step(-1, SIZE))), 0);
});
