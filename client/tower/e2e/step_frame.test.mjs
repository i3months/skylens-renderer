// 관제탑 화면 조립: step 이 돌려주는 프레임은 같은 시점의 snapshot 과 같고(직전 폴백 프레임 재사용 금지),
// 재생 도중 view 가 던져도 원래 오류가 정리 단계 오류에 가려지지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlView } from './index.mjs';
import { replayRecording } from './recording.mjs';

const SIZE = { width: 320, height: 240 };

test('재생의 모든 프레임에서 step 반환값은 직후 snapshot(size) 와 같다(모드 전환 직후 포함)', () => {
  const frames = Array.from({ length: 8 }, () => ({ dtSec: 0.1 }));
  frames[0].drones = [{ id: 'a', enu: [10, 50, 30], yaw: 0 }];
  frames[1].available = false; // F2 step 부터 폴백
  frames[2].drones = [{ id: 'a', enu: [200, 90, 30], yaw: 0 }]; // 폴백 프레임 내용이 프레임마다 달라진다
  frames[3].available = true; // F4 step 부터 live
  frames[5].available = false; // F6 step 부터 폴백
  const view = createControlView({ input: { pos: [32, 32, 50] } });
  const stepped = [];
  const proxy = new Proxy(view, {
    get(t, k) {
      if (k !== 'step') return t[k].bind(t);
      return (dt, size) => {
        const r = t.step(dt, size);
        stepped.push({ r: JSON.stringify(r), snap: JSON.stringify(t.snapshot(size)), mode: r.mode });
        return r;
      };
    },
  });
  replayRecording(proxy, { version: 1, frames }, SIZE);
  assert.equal(stepped.length, 8);
  stepped.forEach((x, i) => assert.equal(x.r, x.snap, `F${i} step 반환 = snapshot`));
  // 비교가 공허하지 않다: 모드 전환이 실제로 일어났고 폴백 프레임 내용이 바뀐다
  assert.deepEqual(stepped.map((x) => x.mode), ['live', 'live', 'fallback', 'fallback', 'live', 'live', 'fallback', 'fallback']);
  assert.notEqual(stepped[2].r, stepped[3].r);
});

test('재생 중 step 이 RangeError 를 던지면 그 오류가 그대로 나오고, releaseAll 이 없거나 던지는 view 여도 가려지지 않는다', () => {
  const frames = [{ dtSec: 0.1 }, { dtSec: 0.1 }];
  // 1) 실제 view: 두 번째 step 의 dt 가 잘못된 프레임은 검사 단계에서 RangeError (재생 시작 전)
  assert.throws(() => replayRecording(createControlView(), { version: 1, frames: [{ dtSec: 0.1 }, { dtSec: -1 }] }, SIZE), RangeError);
  // 2) step 이 RangeError 를 던지는 view, releaseAll 도 던진다 → 원래 RangeError 가 나온다
  const boom = new RangeError('step 실패');
  const mk = (releaseAll) => {
    const real = createControlView();
    return new Proxy(real, {
      get(t, k) {
        if (k === 'step') return () => { throw boom; };
        if (k === 'releaseAll') return releaseAll;
        return t[k].bind(t);
      },
    });
  };
  let released = 0;
  assert.throws(() => replayRecording(mk(() => { released += 1; throw new TypeError('정리 실패'); }), { version: 1, frames }, SIZE), (e) => e === boom);
  assert.equal(released, 1, 'releaseAll 은 시도됐다');
  // 3) 재생 전 검사는 통과하지만 정리 시점에는 releaseAll 이 없는 프록시 view: 정리의 TypeError 가 아니라 step 의 RangeError 가 나온다
  let reads = 0;
  const gone = new Proxy(createControlView(), {
    get(t, k) {
      if (k === 'step') return () => { throw boom; };
      if (k === 'releaseAll') { reads += 1; return reads === 1 ? () => {} : undefined; }
      return t[k].bind(t);
    },
  });
  assert.throws(() => replayRecording(gone, { version: 1, frames }, SIZE), (e) => e === boom);
  assert.equal(reads, 2);
});
