import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTROLVIEW_METHOD_MAP, controlviewModulePath, isDrapeAligned, CONTROLVIEW_LIMITS } from './index.mjs';

test('대응표는 T15 모듈 9개를 빠짐없이, 중복 없이 가진다', () => {
  const mods = CONTROLVIEW_METHOD_MAP.map((r) => r.module).sort();
  assert.deepEqual(mods, ['buildings', 'chase', 'drape', 'e2e', 'fallback', 'input', 'overlay', 'streaming', 'terrain']);
  for (const r of CONTROLVIEW_METHOD_MAP) {
    assert.equal(typeof r.fn, 'string');
    assert.equal(r.origin, 'estimated');
  }
  assert.equal(controlviewModulePath('drape'), 'client/tower/drape/index.mjs');
  assert.equal(CONTROLVIEW_LIMITS.bundleBytes, 300_000);
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
