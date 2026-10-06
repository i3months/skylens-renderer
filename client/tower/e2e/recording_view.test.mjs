// replayRecording 의 view 인자 검사(F-456 ⑤): 잘못된 view 는 'view' 를 말하는 TypeError 로 거부한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlView } from './index.mjs';
import { replayRecording } from './recording.mjs';

const SIZE = Object.freeze({ width: 800, height: 600 });
const VIEW_ERR = (e) => e instanceof TypeError && /view/.test(e.message);

test('view 가 undefined·null·원시값이면 TypeError(view)', () => {
  for (const v of [undefined, null, 1, 'x', true]) {
    assert.throws(() => replayRecording(v, [], SIZE), VIEW_ERR);
  }
});

test('메서드가 없는 view 는 TypeError(view)', () => {
  assert.throws(() => replayRecording({}, [{ dtSec: 0 }], SIZE), VIEW_ERR);
  const real = createControlView();
  for (const m of ['keyDown', 'keyUp', 'releaseAll', 'step', 'setDrones', 'setDetections', 'setPath', 'setAvailable', 'arrived', 'failed', 'snapshot']) {
    const partial = { ...real, [m]: undefined };
    assert.throws(() => replayRecording(partial, [], SIZE), VIEW_ERR, m);
  }
});

test('올바른 view 는 그대로 재생된다', () => {
  const out = replayRecording(createControlView(), [{ dtSec: 0 }, { dtSec: 0.1 }], SIZE);
  assert.equal(out.length, 2);
});
