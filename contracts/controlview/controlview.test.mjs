import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTROLVIEW_METHOD_MAP, controlviewModulePath, isDrapeAligned, CONTROLVIEW_LIMITS } from './index.mjs';

test('대응표 자기 일관성: 모듈 9개, 모듈·fn 중복 없음', () => {
  const mods = CONTROLVIEW_METHOD_MAP.map((r) => r.module).sort();
  assert.deepEqual(mods, ['buildings', 'chase', 'drape', 'e2e', 'fallback', 'input', 'overlay', 'streaming', 'terrain']);
  for (const r of CONTROLVIEW_METHOD_MAP) {
    assert.equal(typeof r.fn, 'string');
    assert.equal(r.origin, 'estimated');
  }
  assert.equal(new Set(CONTROLVIEW_METHOD_MAP.map((r) => r.fn)).size, 9);
  for (const bad of ['nope', undefined, '../x', Object.create(null)]) assert.throws(() => controlviewModulePath(bad), RangeError);
  assert.equal(controlviewModulePath('drape'), 'client/tower/drape/index.mjs');
  // 모든 모듈에 대해 controlviewModulePath 가 올바른 경로를 반환하는지 확인
  assert.ok(CONTROLVIEW_METHOD_MAP.every((r) => controlviewModulePath(r.module) === `client/tower/${r.module}/index.mjs`));
  // CONTROLVIEW_LIMITS 는 동결됨
  assert.equal(Object.isFrozen(CONTROLVIEW_LIMITS), true);
  assert.deepEqual({ ...CONTROLVIEW_LIMITS }, { bundleBytes: 300_000, initialBytes: 15_000_000, segmentBytes: 3_000_000 });
});

test('isDrapeAligned: 이동량 모르는 local 블록이 있으면 통과가 아니다', () => {
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: 0 }, 1), true);
  assert.equal(isDrapeAligned({ maxMisalignPx: 1, unmeasuredLocalBlocks: 0 }, 1), true);
  assert.equal(isDrapeAligned({ maxMisalignPx: 1.01, unmeasuredLocalBlocks: 0 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.2, unmeasuredLocalBlocks: 1 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: NaN, unmeasuredLocalBlocks: NaN }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: NaN, unmeasuredLocalBlocks: 0 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.2 }, 1), false);
  assert.equal(isDrapeAligned(undefined, 1), false);
});

test('isDrapeAligned: 강제 변환·음수 입력은 통과가 아니다', () => {
  const j = JSON.parse(JSON.stringify({ maxMisalignPx: NaN, unmeasuredLocalBlocks: 0 }));
  assert.equal(isDrapeAligned(j, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: null, unmeasuredLocalBlocks: 0 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: '0.5', unmeasuredLocalBlocks: 0 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: -1, unmeasuredLocalBlocks: 0 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: 0 }, null), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.2, unmeasuredLocalBlocks: -1 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: -1 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: 0 }, 1), true);
  assert.equal(isDrapeAligned({ maxMisalignPx: 1, unmeasuredLocalBlocks: 0 }, 1), true);
});

test('isDrapeAligned: 비유한 입력(maxMisalignPx·tolPx Infinity)·문자열·소수·NaN·undefined 인 tolPx·unmeasuredLocalBlocks 는 통과가 아니다', () => {
  // maxMisalignPx Infinity → false (tolPx 도 Infinity 여도 false)
  assert.equal(isDrapeAligned({ maxMisalignPx: Infinity, unmeasuredLocalBlocks: 0 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: Infinity, unmeasuredLocalBlocks: 0 }, Infinity), false);
  // tolPx Infinity·문자열 → false
  assert.equal(isDrapeAligned({ maxMisalignPx: 5, unmeasuredLocalBlocks: 0 }, Infinity), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: 0 }, '1'), false);
  // tolPx null 은 위 시험에서 다룸
  // unmeasuredLocalBlocks 문자열·소수·NaN·undefined → false
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: '0' }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: 0.5 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: NaN }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: undefined }, 1), false);
  // 원본 유효 입력은 true 유지
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: 0 }, 1), true);
  assert.equal(isDrapeAligned({ maxMisalignPx: 1, unmeasuredLocalBlocks: 0 }, 1), true);
});

test('isDrapeAligned: 경계 0 — maxMisalignPx 0·tolPx 0 은 유효 입력이다 (F-397 ⑧)', () => {
  // maxMisalignPx 0(이동 없음)은 거부하면 안 된다: `maxMisalignPx <= 0` 거부 변이를 죽인다.
  assert.equal(isDrapeAligned({ maxMisalignPx: 0, unmeasuredLocalBlocks: 0 }, 1), true);
  // tolPx 0(허용 오차 없음)도 유효하다: `tolPx <= 0` 거부 변이를 죽인다. 이때 통과는 이동량이 정확히 0 일 때뿐이다.
  assert.equal(isDrapeAligned({ maxMisalignPx: 0, unmeasuredLocalBlocks: 0 }, 0), true);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.001, unmeasuredLocalBlocks: 0 }, 0), false);
  // 0 이어도 미측정 local 이 있으면 통과가 아니다.
  assert.equal(isDrapeAligned({ maxMisalignPx: 0, unmeasuredLocalBlocks: 1 }, 1), false);
  // 음수 경계: -0 은 0 과 같게 유효, 음수는 거부.
  assert.equal(isDrapeAligned({ maxMisalignPx: -0, unmeasuredLocalBlocks: 0 }, 0), true);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0, unmeasuredLocalBlocks: 0 }, -0.001), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: -0.001, unmeasuredLocalBlocks: 0 }, 1), false);
});
