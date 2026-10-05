// 입력 층이 네트워크·타이머를 쓰지 않는지 검사(계약: '이 층은 네트워크·타이머를 쓰지 않는다').
import test from 'node:test';
import assert from 'node:assert/strict';
import { installNetworkSpies } from '../buildings/network_spies.mjs';

test('no_network: 입력 층 전체 사용 중 전역 fetch·타이머·WebSocket 호출 0', async () => {
  const spies = installNetworkSpies();
  try {
    // 동적 import 로 index.mjs 불러오기. 아직 없으면 실패한다.
    let mod;
    try {
      mod = await import('./index.mjs');
    } catch (e) {
      assert.fail(`client/tower/input/index.mjs 를 불러올 수 없음(조립 전이면 정상 실패): ${e && e.message}`);
    }
    assert.equal(typeof mod.createTowerInput, 'function', 'createTowerInput 을 내보내야 함');

    // 입력 층 생성
    const input = mod.createTowerInput();

    // 여섯 키 keyDown (TOWER_INPUT_KEYS 의 모든 키)
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyE', 'KeyQ'];
    for (const key of keys) {
      const ok = input.keyDown(key);
      assert.equal(ok, true, `keyDown(${key}) 는 true 를 돌려야 함`);
    }

    // step(0.1) 을 10 회 실행
    for (let i = 0; i < 10; i += 1) {
      const pose = input.step(0.1);
      assert.equal(typeof pose, 'object', `step 은 객체를 돌려야 함`);
      assert.ok(Array.isArray(pose.pos) && pose.pos.length === 3, 'pose.pos 는 [x,y,z] 배열이어야 함');
      assert.equal(typeof pose.yaw, 'number', 'pose.yaw 는 숫자여야 함');
      assert.equal(typeof pose.pitch, 'number', 'pose.pitch 는 숫자여야 함');
    }

    // camera() 호출
    const camera = input.camera();
    assert.equal(typeof camera, 'object', 'camera 는 객체를 돌려야 함');
    assert.ok(Array.isArray(camera.pos) && camera.pos.length === 3, 'camera.pos 는 [x,y,z] 배열이어야 함');
    assert.ok(Array.isArray(camera.quat) && camera.quat.length === 4, 'camera.quat 는 [x,y,z,w] 배열이어야 함');
    assert.equal(typeof camera.fovY, 'number', 'camera.fovY 는 숫자여야 함');

    // releaseAll() 호출
    input.releaseAll();

    // 감시자가 아무 호출도 잡지 못했는지 확인
    assert.deepEqual(spies.calls, [], `네트워크 감시자가 호출을 기록했음: ${spies.calls.join(',')}`);
  } finally {
    await spies.restore();
  }
});

test('no_network: 감시자가 실제로 호출을 센다(양성 대조)', async (t) => {
  const spies = installNetworkSpies();
  t.after(() => spies.restore());

  // 직접 fetch 호출 - 감시자가 잡아야 함
  globalThis.fetch('http://127.0.0.1:1/test');
  assert.ok(spies.calls.includes('fetch'), '감시자가 fetch 호출을 기록해야 함');
});
