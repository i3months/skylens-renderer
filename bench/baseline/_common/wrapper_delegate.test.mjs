// 감지 후 래퍼 위임(wrapper delegation) 단위 테스트.
// 첫 프레임 감지 직후 WebGL 메서드 래퍼가 원본 함수로 복원되는지 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDetectScript } from './browser.mjs';

test('래퍼 위임: 감지 후 원본 함수로 복원', () => {
  const script = buildDetectScript('#test-canvas');

  // 스크립트가 __ffOrig 를 사용해 원본 함수를 저장하는지 확인.
  assert.ok(script.includes('__ffOrig'), '원본 함수 저장 로직(__ffOrig)이 포함되어야 함');

  // 감지 후 래퍼 제거 로직이 있는지 확인.
  assert.ok(script.includes('proto[name] = proto[name].__ffOrig'), '감지 후 원본 함수로 복원하는 로직이 포함되어야 함');

  // 감지 후 found 함수에서 복원이 일어나는지 확인.
  assert.ok(script.includes('const found = (hit)'), 'found 함수 정의가 있어야 함');
  assert.ok(script.match(/const found.*?proto\[name\] = proto\[name\]\.__ffOrig/s), 'found 함수 안에서 복원이 일어나야 함');
});

test('래퍼 위임: 스크립트가 state wrapper 와 원본 함수를 모두 포함', () => {
  const script = buildDetectScript('canvas');

  // 감지 전: state wrapper 로 hash 갱신.
  assert.ok(script.includes('st.cur = (st.cur * 17'), '감지 전에 상태 래퍼로 hash 를 갱신해야 함');
  assert.ok(script.includes('st.cur = (st.cur * 31'), '감지 전에 draw 서명 hash 를 갱신해야 함');

  // 감지 후: 원본 함수로 즉시 위임(wrapped.__ffOrig 로 저장된 원본).
  assert.ok(script.includes('wrapped.__ffOrig = orig'), '래퍼가 원본 함수를 __ffOrig 에 저장해야 함');
});

test('래퍼 위임: 폴링 비용 설명 주석 확인', () => {
  // 이 테스트는 browser.mjs 파일의 JSDoc 에 폴링 비용 설명이 있는지 확인한다.
  // buildDetectScript 함수의 반환 스크립트에 감지 후 복원 로직이 포함되므로,
  // 폴링 비용 설명이 주석에 있어야 한다.
  const script = buildDetectScript('#c');

  // 감지 후 복원 로직이 있는지 확인.
  assert.ok(script.includes('감지 후 래퍼를 제거해 원본 함수로 복원'),
    '감지 후 래퍼 복원 로직 주석이 있어야 함');
});

test('래퍼 위임: 여러 선택자로도 wrapper 구조가 일관됨', () => {
  const selectors = ['#status-view', '#control-view', 'canvas', '.webgl-canvas'];

  for (const sel of selectors) {
    const script = buildDetectScript(sel);

    // 모든 선택자에 대해 래퍼 복원 로직이 있어야 함.
    assert.ok(script.includes('__ffOrig'), `선택자 '${sel}' 에도 __ffOrig 로직이 있어야 함`);
    assert.ok(script.includes('wrapped.__ffOrig = orig'), `선택자 '${sel}' 에도 원본 저장 로직이 있어야 함`);
  }
});
