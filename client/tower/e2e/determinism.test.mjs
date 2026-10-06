// 관제탑 화면 조립(T15.9) 결정성 시험: 같은 녹화는 새 view 마다 같은 Snapshot[] 을 낸다.
// 계약: contracts/controlview/e2e.mjs. 사용 서명:
//   createControlView(opts?) -> view,  replayRecording(view, recording, size) -> Snapshot[],
//   view.step(dtSec, size)·setDrones·setDetections·setPath·clear·arrived·failed·setAvailable·snapshot(size)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlView } from './index.mjs';
import { replayRecording } from './recording.mjs';

const SIZE = Object.freeze({ width: 800, height: 600 });
const FRAMES = 72;
const KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyE', 'KeyQ'];

/** 시드 고정 의사난수(mulberry32). 벽시계·Math.random 을 쓰지 않는다. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 시드로 만든 녹화. 키 입력(눌림 상태와 맞게 down/up), 드론 이동, 탐지, 경로, 가용성 전환, 타일 도착·실패를 섞는다.
 * 손계산 고정 구간은 시드와 무관하게 정한다:
 *  프레임 0: 드론 2기·ArrowUp 누름, 프레임 1: 타일 (0,0) 도착, 프레임 5: available=false, 프레임 8: available=true.
 */
function makeRecording(seed) {
  const r = rng(seed);
  const held = new Set();
  const frames = [];
  for (let i = 0; i < FRAMES; i += 1) {
    const f = { dtSec: 0.05 + Math.floor(r() * 4) * 0.025 };
    const down = [];
    const up = [];
    if (i > 0 && r() < 0.35) {
      const k = KEYS[Math.floor(r() * KEYS.length)];
      if (held.has(k)) { held.delete(k); up.push(k); } else { held.add(k); down.push(k); }
    }
    if (i === 0) { held.add('ArrowUp'); down.push('ArrowUp'); }
    if (down.length || up.length) f.keys = { down, up };
    if (i === 0 || i % 3 === 0) {
      f.drones = [0, 1].map((n) => ({ id: `d${n}`, enu: [Math.round(r() * 200 - 100), Math.round(r() * 200 + 20), 30 + n * 5] }));
    }
    if (i % 7 === 2) f.detections = [{ id: 'x1', enu: [Math.round(r() * 100), Math.round(r() * 100 + 30), 5], kind: r() < 0.5 ? 'alert' : 'detection', confidence: 0.5 }];
    if (i === 10) f.paths = [{ id: 'p1', points: [[0, 20, 30], [40, 80, 30], [90, 150, 35]] }];
    if (i === 5) f.available = false;
    if (i === 8) f.available = true;
    if (i === 1) f.arrivedTiles = [[0, 0]];
    else if (i > 9 && r() < 0.3) f.arrivedTiles = [[Math.floor(r() * 5) - 2, Math.floor(r() * 5) - 1]];
    if (i > 9 && r() < 0.1) f.failedTiles = [[Math.floor(r() * 5) - 2, Math.floor(r() * 5) - 1]];
    frames.push(f);
  }
  return { version: 1, frames };
}

// 입력 층 초기 위치를 고정해 손계산이 되게 한다(타일 (0,0) 한가운데, 고도 50 m, 북향).
const newView = () => createControlView({ input: { pos: [32, 32, 50], yaw: 0 } });

test('같은 녹화를 새 view 두 개로 재생하면 Snapshot[] 이 JSON 으로 완전히 같다', () => {
  const rec = makeRecording(20240615);
  assert.equal(rec.frames.length, FRAMES);
  const a = replayRecording(newView(), rec, SIZE);
  const b = replayRecording(newView(), rec, SIZE);
  assert.equal(a.length, rec.frames.length);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // 시드가 다르면 다른 녹화이고 결과도 다르다(비교가 공허하지 않음)
  const c = replayRecording(newView(), makeRecording(7), SIZE);
  assert.notEqual(JSON.stringify(a), JSON.stringify(c));
});

test('기대값(손계산 + 회귀 고정 구분): 모드·held·드론 마커·카메라 이동', () => {
  // 난수 없이 손으로 정한 10프레임(dt 0.1 s): 프레임 0 에서 ArrowUp 을 누른 채 유지, 드론 2기, 프레임 1 에서 (0,0) 도착
  const frames = Array.from({ length: 10 }, () => ({ dtSec: 0.1 }));
  frames[0].keys = { down: ['ArrowUp'] };
  frames[0].drones = [{ id: 'a', enu: [10, 50, 30], yaw: 0 }, { id: 'b', enu: [-20, 80, 35], yaw: 0 }];
  frames[1].arrivedTiles = [[0, 0]];
  frames[5].available = false;
  frames[8].available = true;
  const s = replayRecording(newView(), { version: 1, frames }, SIZE);
  assert.equal(s.length, 10);
  // 가용성: 프레임 0~4 live, 5~7 fallback, 8 이후 live
  for (let i = 0; i < 10; i += 1) assert.equal(s[i].mode, i >= 5 && i < 8 ? 'fallback' : 'live', `frame ${i}`);
  // 카메라: 프레임 0 은 아직 드론이 없어(데이터는 step 뒤에 들어간다) 입력 카메라가 북쪽으로 10 m/s·0.1 s = 1 m 가서 [32, 33, 50].
  // 프레임 1 부터는 첫 드론 a(10,50,30, 방위 0)를 추적: 뒤 30 m·위 10 m 라 [10, 20, 40]
  const r9 = (p) => p.map((x) => Math.round(x * 1e9) / 1e9);
  assert.deepEqual(r9(s[0].camera.pos), [32, 33, 50]);
  assert.deepEqual(r9(s[1].camera.pos), [10, 20, 40]);
  assert.deepEqual(r9(s[9].camera.pos), [10, 20, 40]);
  // fallback 모드에서는 3D 층 결과를 내지 않는다
  for (const i of [5, 6, 7]) {
    assert.equal(s[i].camera, null);
    assert.equal(s[i].overlay, null);
    assert.equal(s[i].streaming, null);
    assert.equal(s[i].fallback.banner, '실시간 3D 불가');
    assert.equal(s[i].fallback.drones.length, 2);
  }
  // 프레임 0 에서 드론 2기를 넣었다 → 3D 층 오버레이 드론 2개
  assert.equal(s[0].overlay.drones.length, 2);
  // 프레임 0 의 요청 목록. 손으로 유도할 수 있는 성질만 단언한다:
  //  - 한 번에 요청하는 수는 maxInflight 기본값 16 이 상한이고, 보이는 타일은 그보다 많아 모두 찬다 → 정확히 16개
  //  - state() 는 (tx,ty) 사전순으로 내준다
  //  - 카메라 [32,33,50] 의 지면 투영점은 타일 (0,0)=[0,64)² 안이라 가장 가까운 needed 로 먼저 요청된다
  // 시야 사각뿔과 타일 상자의 교차 16개 전체는 손으로 유도하지 않았다(구현 출력은 아래 회귀 고정으로만 둔다).
  const inflight0 = s[0].streaming.inflight.map((t) => [t.tx, t.ty]);
  assert.equal(inflight0.length, 16);
  assert.deepEqual(inflight0, [...inflight0].sort((p, q) => p[0] - q[0] || p[1] - q[1]));
  assert.ok(inflight0.some(([tx, ty]) => tx === 0 && ty === 0));
  // 회귀 고정(구현 출력을 받아 적은 값, 손계산 아님)
  const tiles0 = [[-2, 2], [-2, 3], [-1, 1], [-1, 2], [-1, 3], [-1, 4], [0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [1, 1], [1, 2], [1, 3], [2, 2], [2, 3]];
  assert.deepEqual(inflight0, tiles0);
  assert.deepEqual(s[0].streaming.held, []);
  // 프레임 1: 같은 프레임에서 step(update) 뒤에 도착을 적용한다(replayRecording 순서). update 시점에 inflight 는 16 으로 가득 차
  // 새 요청이 없고, 이어서 (0,0) 이 도착해 held 로 옮겨지므로 inflight = 16 − 1 = 15
  assert.deepEqual(s[1].streaming.held, [{ tx: 0, ty: 0 }]);
  assert.equal(s[1].streaming.inflight.length, 15);
});

test('중간에 던지는 입력을 한 프레임 넣어도 이후 스냅샷은 그 프레임을 건너뛴 재생과 같다', () => {
  const rec = makeRecording(99);
  const k = 30;
  const full = replayRecording(newView(), rec, SIZE);

  const view = newView();
  const head = replayRecording(view, { version: 1, frames: rec.frames.slice(0, k) }, SIZE);
  const before = JSON.stringify(view.snapshot(SIZE));
  // 잘못된 입력: dt 비유한·음수, 크기 위반, id 중복 드론 목록 — 모두 던지고 상태는 그대로
  assert.throws(() => view.step(Number.NaN, SIZE), RangeError);
  assert.throws(() => view.step(-1, SIZE), RangeError);
  assert.throws(() => view.step(0.1, { width: 0, height: 10 }), RangeError);
  assert.throws(() => view.setDrones([{ id: 'dup', enu: [0, 0, 0] }, { id: 'dup', enu: [1, 1, 1] }]), RangeError);
  assert.equal(JSON.stringify(view.snapshot(SIZE)), before);
  const tail = replayRecording(view, { version: 1, frames: rec.frames.slice(k) }, SIZE);

  assert.equal(JSON.stringify([...head, ...tail]), JSON.stringify(full));
});

test('다른 시드의 녹화도 새 view 두 개에서 같은 Snapshot[] 을 낸다', () => {
  const rec = makeRecording(4242);
  const a = replayRecording(newView(), rec, SIZE);
  const b = replayRecording(newView(), rec, SIZE);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('clear() 뒤 snapshot 의 overlay 목록과 fallback 목록이 비어 있다(입력 자세·타일 상태는 유지)', () => {
  const view = newView();
  const s = replayRecording(view, makeRecording(4242), SIZE);
  const last = s[s.length - 1];
  // 비우기 전에는 비어 있지 않아야 시험이 공허하지 않다(드론은 프레임 69 에 2기, 경로는 프레임 10 의 p1)
  assert.equal(last.overlay.drones.length, 2);
  assert.equal(last.overlay.paths.length, 1);
  view.clear();
  const after = view.snapshot(SIZE);
  assert.deepEqual(after.overlay.drones, []);
  assert.deepEqual(after.overlay.detections, []);
  assert.deepEqual(after.overlay.paths, []);
  assert.deepEqual(after.fallback.drones, []);
  assert.deepEqual(after.fallback.detections, []);
  assert.deepEqual(after.fallback.paths, []);
  // 입력 자세(추적 카메라 포함)와 타일 상태는 clear 가 건드리지 않는다
  assert.deepEqual(after.camera, last.camera);
  assert.deepEqual(after.streaming, last.streaming);
  // fallback 으로 바꾸면 비어 있는 목록과 배너만 나온다
  view.setAvailable(false);
  const fb = view.snapshot(SIZE);
  assert.equal(fb.mode, 'fallback');
  assert.equal(fb.fallback.empty, true);
  assert.deepEqual(fb.fallback.drones, []);
});

test('추적 중 streaming.update 가 던진 프레임은 입력·추적을 되돌려 이후 스냅샷이 그 프레임을 건너뛴 재생과 같다', () => {
  // 입력 카메라는 바로 아래를 봐 타일이 적고, 드론이 높이 40000 m 에 있으면 추적 카메라도 타일이 없다(maxDistM 30 km).
  // 드론을 50 m 로 내리면 추적 카메라가 거의 수평이라 needed 가 상한을 넘어 update 가 RangeError 를 던진다(추적 감쇠 뒤에 던짐).
  const size = { width: 160, height: 120 };
  const mk = () => createControlView({ input: { pitchRad: -Math.PI / 2 }, streaming: { maxDistM: 30000 } });
  const head = [
    { dtSec: 0.25, drones: [{ id: 'z', enu: [0, 0, 40000], yaw: 0 }] },
    { dtSec: 0.25, drones: [{ id: 'z', enu: [40, 0, 40000], yaw: 0 }] },
  ];
  const tail = [{ dtSec: 0.25 }, { dtSec: 0.25 }, { dtSec: 0.25, drones: [] }, { dtSec: 0.25 }];

  const ref = mk();
  const refHead = replayRecording(ref, { version: 1, frames: head }, size);
  ref.keyDown('ArrowUp');
  ref.setDrones([{ id: 'z', enu: [0, 0, 50], yaw: 0 }]);
  ref.setDrones([{ id: 'z', enu: [40, 0, 40000], yaw: 0 }]);
  const refTail = replayRecording(ref, { version: 1, frames: tail }, size);

  const view = mk();
  const viewHead = replayRecording(view, { version: 1, frames: head }, size);
  view.keyDown('ArrowUp');
  view.setDrones([{ id: 'z', enu: [0, 0, 50], yaw: 0 }]);
  const before = JSON.stringify(view.snapshot(size));
  assert.throws(() => view.step(0.25, size), RangeError);
  assert.equal(JSON.stringify(view.snapshot(size)), before);
  view.setDrones([{ id: 'z', enu: [40, 0, 40000], yaw: 0 }]);
  const viewTail = replayRecording(view, { version: 1, frames: tail }, size);

  assert.equal(JSON.stringify([...viewHead, ...viewTail]), JSON.stringify([...refHead, ...refTail]));
  // 비교가 공허하지 않다: 추적 중이던 카메라는 드론 위(높이 40010 m 부근)에 있다
  assert.ok(viewTail[0].camera.pos[2] > 40000);
});
