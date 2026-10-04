import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLevelMachine } from '../state/index.mjs';

const 금지어 = ['setTimeout', 'setInterval', 'setImmediate', 'Date.now', 'performance.now', 'new Date', 'requestAnimationFrame'];
const 모든_API = ['Date', 'setTimeout', 'setInterval', 'setImmediate'];
const 시간 = 3_600_000;

/** 문자열·템플릿 리터럴은 보존하고 주석만 지운다. */
export function 주석제거(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') { out += src[i++]; }
        out += src[i++];
      }
      out += src[i++] ?? '';
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** 소스 텍스트에서 발견된 금지어 목록(주석 제외). */
export function 금지어_찾기(src) {
  const body = 주석제거(src);
  return 금지어.filter((w) => body.includes(w));
}

const 소스 = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function 도착_먹이기(m) {
  m.expect(7);
  m.arrive(1, 0, [{ count: 10 }]);
  m.arrive(1, 2, [{ count: 30 }]);
  m.arrive(1, 1, [{ count: 99 }]);
  m.arrive(2, 3, [{ count: 5 }, { count: 6 }]);
  m.arrive(4, 1, [{ count: 8 }]);
}

function 전체_상태(m) {
  const ids = [...m.segments(), 100];
  return {
    segments: m.segments(),
    history: m.history(),
    snaps: ids.map((id) => m.snapshot(id)),
    counts: ids.map((id) => m.pointCount(id)),
  };
}

test('가짜 시계를 1시간 진행해도 모든 상태가 그대로', (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: 모든_API, now: 0 });
  const m = createLevelMachine({ recordHistory: true });
  도착_먹이기(m);
  const 전 = 전체_상태(m);
  assert.deepEqual(전.segments, [1, 2, 4, 7]);
  assert.equal(전.counts[0], 30);
  mock.timers.tick(시간);
  assert.equal(Date.now(), 시간);
  assert.deepEqual(전체_상태(m), 전);
  mock.timers.tick(시간);
  assert.deepEqual(전체_상태(m), 전);
});

test('시계를 켠 채 1시간 진행하는 동안 타이머를 등록하지 않음', (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: 모든_API, now: 0 });
  const 호출 = { setTimeout: 0, setInterval: 0, setImmediate: 0, now: 0 };
  const 원본 = { st: globalThis.setTimeout, si: globalThis.setInterval, sm: globalThis.setImmediate, now: Date.now };
  globalThis.setTimeout = (...a) => { 호출.setTimeout++; return 원본.st(...a); };
  globalThis.setInterval = (...a) => { 호출.setInterval++; return 원본.si(...a); };
  globalThis.setImmediate = (...a) => { 호출.setImmediate++; return 원본.sm(...a); };
  Date.now = () => { 호출.now++; return 원본.now(); };
  t.after(() => {
    globalThis.setTimeout = 원본.st; globalThis.setInterval = 원본.si; globalThis.setImmediate = 원본.sm; Date.now = 원본.now;
  });
  const m = createLevelMachine({ recordHistory: true });
  도착_먹이기(m);
  for (let k = 0; k < 60; k++) {
    mock.timers.tick(60_000);
    전체_상태(m);
  }
  assert.deepEqual(호출, { setTimeout: 0, setInterval: 0, setImmediate: 0, now: 0 });
});

// levels 소스 전부(F-180 ⑤): 서버·클라이언트·계약 디렉터리를 훑어 *.test.mjs 가 아닌 .mjs 를 모두 검사한다.
// 목록을 손으로만 적으면 새 소스(또는 이미 있던 client/levels·missing·replace·final·log)가 빠진다.
const 루트 = (rel) => fileURLToPath(new URL(rel, import.meta.url));
function 소스_모으기(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) 소스_모으기(p, out);
    else if (e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs')) out.push(p);
  }
  return out;
}
const 필수 = [
  'client/levels/index.mjs', 'client/levels/missing/index.mjs',
  'server/levels/state/index.mjs', 'server/levels/replace/index.mjs',
  'server/levels/final/index.mjs', 'server/levels/log/index.mjs',
  'contracts/levels/index.mjs',
];

test('검사 대상 목록에 levels 소스 7개가 모두 들어 있다', () => {
  const 찾음 = [...소스_모으기(루트('../../../client/levels')), ...소스_모으기(루트('../../../server/levels')), ...소스_모으기(루트('../../../contracts/levels'))]
    .map((p) => p.slice(루트('../../../').length));
  for (const f of 필수) assert.ok(찾음.includes(f), `목록에 없음: ${f}`);
});

test('levels 소스(서버·클라이언트·계약) 전부에 타이머·시계 호출 문자열이 없음', () => {
  const 파일 = [...소스_모으기(루트('../../../client/levels')), ...소스_모으기(루트('../../../server/levels')), ...소스_모으기(루트('../../../contracts/levels'))];
  assert.ok(파일.length >= 필수.length, `소스 ${파일.length}개`);
  for (const f of 파일) {
    assert.deepEqual(금지어_찾기(readFileSync(f, 'utf8')), [], f);
  }
});

test('정적 검사는 문제 문자열을 잡아내고 주석은 무시', () => {
  for (const w of 금지어) {
    assert.deepEqual(금지어_찾기(`export function f() { return ${w}(1); }`), [w], w);
  }
  assert.deepEqual(금지어_찾기('const t = `${setTimeout}`;'), ['setTimeout']);
  assert.deepEqual(금지어_찾기('// setTimeout 금지\n/* new Date\n setInterval */\nconst a = 1;'), []);
  assert.deepEqual(금지어_찾기('const a = 1; // Date.now\nsetImmediate(() => {});'), ['setImmediate']);
});
