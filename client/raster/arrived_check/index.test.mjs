// F-253 ②: 가벼운 도착 검사기. selectDrawable([], list) 와 거부 기준이 같은지, 단계 계수가 testHooks 로 보이는지 확인한다(벽시계 단언 없음).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkArrived } from './index.mjs';
import { createRenderer } from '../index.mjs';
import { selectDrawable, ClientRasterError } from '../../../contracts/client_raster/index.mjs';

function outcome(fn) {
  try { fn(); return 'ok'; } catch (e) { assert.ok(e instanceof ClientRasterError); return e.code ?? e.kind ?? 'err'; }
}
const item = (segmentId, level, keys) => ({ segmentId, level, keys });

const BAD_KEYS = [
  '1.1.0.0.0.0', '1.1.-1.5.7.65535', '1.1.2147483647.-2147483648.0.0', '1.1.2147483648.0.0.0', '1.1.0.-2147483649.0.0',
  '1.1.0.0.0.65536', '1.1.0.0.8.0', '1.1.0.0.0', '01.1.0.0.0.0', '1.1.00.0.0.0', '1.1.-0.0.0.0', '1.1.0.0.0.0.0', '1.4.0.0.0.0',
  '2.1.0.0.0.0', '1.2.0.0.0.0', '1073741824.1.0.0.0.0', '1.1.1e3.0.0.0', ' 1.1.0.0.0.0', '1.1.0.0.0.0\n', '', 5, null, undefined, {},
];
const ITEMS = [
  item(1, 1, ['1.1.0.0.0.0']), item(0, 0, ['0.0.0.0.0.0']), item(1073741823, 3, ['1073741823.3.0.0.7.65535']),
  item(-0, 1, ['0.1.0.0.0.0']), item(1.5, 1, ['1.1.0.0.0.0']), item(1, 1.5, ['1.1.0.0.0.0']), item(-1, 1, ['1.1.0.0.0.0']),
  item(1073741824, 1, ['1073741824.1.0.0.0.0']), item(1, 4, []), item(1, 1, []), item(1, 1, null), item(1, 1, 'x'), null, undefined, 3,
];

test('거부 기준이 selectDrawable([], list) 와 같다(key 변형·항목 변형)', () => {
  const lists = [[], 'x', null, undefined];
  for (const k of BAD_KEYS) { lists.push([item(1, 1, [k])]); lists.push([item(1, 1, ['1.1.9.9.1.1', k])]); }
  for (const it of ITEMS) { lists.push([it]); lists.push([item(1, 1, ['1.1.0.0.0.0']), it]); }
  lists.push([item(1, 1, ['1.1.0.0.0.0']), item(1, 2, ['1.2.0.0.0.0'])]);
  let rejected = 0;
  for (const list of lists) {
    const a = outcome(() => checkArrived(list));
    const b = outcome(() => selectDrawable([], list));
    assert.equal(a, b, JSON.stringify(list));
    if (a !== 'ok') rejected++;
  }
  assert.ok(rejected > 20);
});

test('난수 key 에서도 같은 판정', () => {
  let s = 12345;
  const rnd = (n) => { s = (s * 1103515245 + 12345) >>> 0; return s % n; };
  const pick = [0, 1, 7, 8, 65535, 65536, -1, 2147483647, 2147483648, -2147483648, -2147483649, 12];
  for (let i = 0; i < 2000; i++) {
    const k = `1.${rnd(5)}.${pick[rnd(pick.length)]}.${pick[rnd(pick.length)]}.${rnd(9)}.${pick[rnd(pick.length)]}`;
    const list = [item(1, 1 + (rnd(8) === 0 ? 1 : 0), [k])];
    assert.equal(outcome(() => checkArrived(list)), outcome(() => selectDrawable([], list)), k);
  }
});

test('틀린 key 는 계약과 같은 오류 메시지', () => {
  for (const list of [[item(1, 1, ['1.1.0.0.8.0'])], [item(1, 1, ['2.1.0.0.0.0'])]]) {
    let m1; let m2;
    try { checkArrived(list); } catch (e) { m1 = e.message.split(':')[0]; }
    try { selectDrawable([], list); } catch (e) { m2 = e.message.split(':')[0]; }
    assert.equal(m1, m2);
  }
});

function fakeCanvas() {
  const base = {
    createBuffer: () => ({}), deleteBuffer() {}, getShaderParameter: () => true, getProgramParameter: () => true,
    createShader: () => ({}), createProgram: () => ({}), createVertexArray: () => ({}),
    getUniformLocation: (_p, name) => ({ name }), getParameter: (p) => (p === 'ALIASED_POINT_SIZE_RANGE' ? [1, 1024] : 0),
    isContextLost: () => false,
  };
  const gl = new Proxy(base, { get(t, p) { if (p in t) return t[p]; if (typeof p === 'string' && /^[A-Z_0-9]+$/.test(p)) return p; return () => {}; } });
  return { width: 300, height: 150, getContext: () => gl, addEventListener() {}, removeEventListener() {} };
}

test('지연 setArrived 의 검사 단계는 key 수만큼 testHooks 로 보이고 selectDrawable 은 부르지 않는다', () => {
  const steps = { select: 0, check: 0 };
  const r = createRenderer({
    canvas: fakeCanvas(), maxPieceBytes: 1 << 10, maxResidentBytes: 1 << 26, now: () => 0,
    testHooks: { selectDrawable: (k, a) => { steps.select += 1; return selectDrawable(k, a); }, checkArrivedKey: () => { steps.check += 1; } },
  });
  const keys = Array.from({ length: 1000 }, (_, i) => `1.1.${i}.0.0.0`);
  r.setArrived([item(1, 1, keys)], { deferResult: true });
  assert.equal(steps.check, 1000);
  assert.equal(steps.select, 0);
  // 즉시 경로는 검사기를 거치지 않고 selectDrawable 1회
  r.setArrived([item(1, 1, keys)]);
  assert.equal(steps.check, 1000);
  assert.equal(steps.select, 1);
  // 틀린 입력: 첫 틀린 key 에서 멈추고 던진다
  assert.throws(() => r.setArrived([item(1, 1, ['1.1.0.0.0.0', '1.1.0.0.9.0', '1.1.1.0.0.0'])], { deferResult: true }), ClientRasterError);
  assert.equal(steps.check, 1002);
});
