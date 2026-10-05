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
  assert.ok(rec.frames.length >= 60);
  const a = replayRecording(newView(), rec, SIZE);
  const b = replayRecording(newView(), rec, SIZE);
  assert.equal(a.length, rec.frames.length);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  // 시드가 다르면 다른 녹화이고 결과도 다르다(비교가 공허하지 않음)
  const c = replayRecording(newView(), makeRecording(7), SIZE);
  assert.notEqual(JSON.stringify(a), JSON.stringify(c));
});

test('손계산 기대값: 모드·held·드론 마커·카메라 이동', () => {
  const rec = makeRecording(20240615);
  const s = replayRecording(newView(), rec, SIZE);
  // 가용성: 프레임 0~4 live, 5~7 fallback, 8 이후 live
  for (let i = 0; i < s.length; i += 1) assert.equal(s[i].mode, i >= 5 && i < 8 ? 'fallback' : 'live', `frame ${i}`);
  // 프레임 0 에서 드론 2기를 넣었다 → 3D 층 오버레이 드론 2개
  assert.equal(s[0].overlay.drones.length, 2);
  // 타일 (0,0) 은 카메라 바로 아래라 첫 프레임에 요청되고, 프레임 1 도착으로 held 에 든다
  assert.ok(s[0].streaming.inflight.some((t) => t.tx === 0 && t.ty === 0));
  assert.ok(s[1].streaming.held.some((t) => t.tx === 0 && t.ty === 0));
  // 프레임 0 에서 ArrowUp(앞)을 눌러 두고 프레임 0 의 dt 만큼 북쪽(+y)으로 간다: y = 32 + 10·dt0, x = 32, 고도 50
  const dt0 = rec.frames[0].dtSec;
  assert.ok(Math.abs(s[0].camera.pos[0] - 32) < 1e-9);
  assert.ok(Math.abs(s[0].camera.pos[1] - (32 + 10 * dt0)) < 1e-9);
  assert.equal(s[0].camera.pos[2], 50);
});

test('중간에 던지는 입력을 한 프레임 넣어도 이후 스냅샷은 그 프레임을 건너뛴 재생과 같다', () => {
  const rec = makeRecording(99);
  const k = 30;
  const full = replayRecording(newView(), rec, SIZE);

  const view = newView();
  const head = replayRecording(view, { version: 1, frames: rec.frames.slice(0, k) }, SIZE);
  const before = JSON.stringify(view.snapshot(SIZE));
  // 잘못된 입력: dt 비유한·음수, 크기 위반, id 중복 드론 목록 — 모두 던지고 상태는 그대로
  assert.throws(() => view.step(Number.NaN, SIZE));
  assert.throws(() => view.step(-1, SIZE));
  assert.throws(() => view.step(0.1, { width: 0, height: 10 }));
  assert.throws(() => view.setDrones([{ id: 'dup', enu: [0, 0, 0] }, { id: 'dup', enu: [1, 1, 1] }]));
  assert.equal(JSON.stringify(view.snapshot(SIZE)), before);
  const tail = replayRecording(view, { version: 1, frames: rec.frames.slice(k) }, SIZE);

  assert.equal(JSON.stringify([...head, ...tail]), JSON.stringify(full));
});

test('같은 view 에서 재생 → clear → 다시 재생하면 첫 재생과 같다', () => {
  const rec = makeRecording(4242);
  const view = newView();
  const first = replayRecording(view, rec, SIZE);
  view.clear();
  // reset 이 있는 구현이면 타일·입력 상태까지 되돌린다(없으면 clear 만으로 같아야 한다)
  if (typeof view.reset === 'function') view.reset();
  view.setAvailable(true);
  const second = replayRecording(view, rec, SIZE);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});
