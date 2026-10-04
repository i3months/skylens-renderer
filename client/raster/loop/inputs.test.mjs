// 입력 검증 시험: frameMs, ev.data, decode subarray 처리.
// 각 시험은 fix 가 제거되면 실패하도록 설계됨(변이 테스트).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameLoop, createDecodeWorkerClient, DEFAULT_FRAME_MS } from './index.mjs';

function rig() {
  let t = 0, q = [];
  return {
    now: () => t, advance: (ms) => { t += ms; },
    requestFrame: (cb) => { q.push(cb); },
    step(ms = DEFAULT_FRAME_MS) { t += ms; const c = q; q = []; c.forEach((f) => f()); },
    queued: () => q.length,
  };
}

// frameMs 입력 검증: 0·음수·NaN·Infinity 가 droppedFrames 를 Infinity·NaN 으로 만들지 않도록.
test('frameMs 검증: 0 은 RangeError', () => {
  const base = { draw() {}, requestFrame() {}, now: () => 0 };
  assert.throws(() => createFrameLoop({ ...base, frameMs: 0 }), RangeError);
});

test('frameMs 검증: 음수는 RangeError', () => {
  const base = { draw() {}, requestFrame() {}, now: () => 0 };
  assert.throws(() => createFrameLoop({ ...base, frameMs: -1 }), RangeError);
});

test('frameMs 검증: NaN 은 RangeError', () => {
  const base = { draw() {}, requestFrame() {}, now: () => 0 };
  assert.throws(() => createFrameLoop({ ...base, frameMs: NaN }), RangeError);
});

test('frameMs 검증: Infinity 는 RangeError', () => {
  const base = { draw() {}, requestFrame() {}, now: () => 0 };
  assert.throws(() => createFrameLoop({ ...base, frameMs: Infinity }), RangeError);
});

test('frameMs 검증: 비숫자 문자열은 RangeError', () => {
  const base = { draw() {}, requestFrame() {}, now: () => 0 };
  assert.throws(() => createFrameLoop({ ...base, frameMs: '16' }), RangeError);
});

// droppedFrames 가 올바르게 계산되고 Infinity·NaN 이 되지 않는지 확인.
test('frameMs 유효값: droppedFrames 는 정수·Infinity·NaN 아님', () => {
  const r = rig();
  const loop = createFrameLoop({ draw() {}, requestFrame: r.requestFrame, now: r.now, frameMs: 16 });
  loop.start(); r.step(16);
  let s = loop.stats();
  assert.equal(typeof s.droppedFrames, 'number');
  assert.equal(Number.isFinite(s.droppedFrames), true);
  assert.equal(s.droppedFrames, 0);
  r.step(64);
  s = loop.stats();
  assert.equal(Number.isFinite(s.droppedFrames), true);
  assert.equal(s.droppedFrames, 3);
  assert.ok(!Number.isNaN(s.droppedFrames));
});

// ev.data 가 null 이거나 객체가 아닐 때의 처리.
test('ev.data null: TypeError 대신 조용히 버린다', () => {
  const w = { postMessage() {}, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  c.decode(new Uint8Array(1));
  assert.doesNotThrow(() => w.onmessage({ data: null }));
  // pending 은 여전히 1이어야 한다(응답을 받은 게 아니므로).
  assert.equal(c.stats().pending, 1);
});

test('ev.data 정의되지 않음: TypeError 대신 조용히 버린다', () => {
  const w = { postMessage() {}, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  c.decode(new Uint8Array(1));
  assert.doesNotThrow(() => w.onmessage({ data: undefined }));
  assert.equal(c.stats().pending, 1);
});

test('ev.data 숫자: TypeError 대신 조용히 버린다', () => {
  const w = { postMessage() {}, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  c.decode(new Uint8Array(1));
  assert.doesNotThrow(() => w.onmessage({ data: 42 }));
  assert.equal(c.stats().pending, 1);
});

test('ev.data 배열: TypeError 대신 조용히 버린다', () => {
  const w = { postMessage() {}, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  c.decode(new Uint8Array(1));
  assert.doesNotThrow(() => w.onmessage({ data: [1, 2, 3] }));
  assert.equal(c.stats().pending, 1);
});

test('ev 자체가 null: TypeError 대신 조용히 버린다', () => {
  const w = { postMessage() {}, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  c.decode(new Uint8Array(1));
  assert.doesNotThrow(() => w.onmessage(null));
  assert.equal(c.stats().pending, 1);
});

// subarray 뷰가 버퍼 전체가 아닐 때: 범위만 복사, 전체 버퍼 아님.
test('subarray 부분: 복사본 생성·작은 버퍼 전송', () => {
  const sent = [];
  const w = { postMessage(m, tr) { sent.push([m, tr]); }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  const big = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
  c.decode(big.subarray(2, 5));
  const [m, tr] = sent[0];
  // 복사본이어야 함: 원본과 다른 버퍼.
  assert.notEqual(m.bytes.buffer, big.buffer);
  // 내용은 부분 범위만.
  assert.deepEqual([...m.bytes], [30, 40, 50]);
  // 전송 대상은 복사본 버퍼.
  assert.equal(tr[0], m.bytes.buffer);
  // 원본 버퍼는 원래 크기 유지.
  assert.equal(big.buffer.byteLength, 8);
  assert.equal(big.length, 8);
});

test('subarray 처음부터: 복사본 생성·작은 버퍼 전송', () => {
  const sent = [];
  const w = { postMessage(m, tr) { sent.push([m, tr]); }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  const big = new Uint8Array([11, 12, 13, 14, 15]);
  c.decode(big.subarray(0, 3));
  const [m, tr] = sent[0];
  assert.notEqual(m.bytes.buffer, big.buffer);
  assert.deepEqual([...m.bytes], [11, 12, 13]);
  assert.equal(tr[0], m.bytes.buffer);
  assert.equal(big.length, 5);
});

test('subarray 끝부터: 복사본 생성·작은 버퍼 전송', () => {
  const sent = [];
  const w = { postMessage(m, tr) { sent.push([m, tr]); }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  const big = new Uint8Array([21, 22, 23, 24, 25, 26]);
  c.decode(big.subarray(3, 6));
  const [m, tr] = sent[0];
  assert.notEqual(m.bytes.buffer, big.buffer);
  assert.deepEqual([...m.bytes], [24, 25, 26]);
  assert.equal(tr[0], m.bytes.buffer);
  assert.equal(big.length, 6);
});

test('subarray 단일 요소: 복사본 생성·길이 1 전송', () => {
  const sent = [];
  const w = { postMessage(m, tr) { sent.push([m, tr]); }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  const big = new Uint8Array([100, 101, 102]);
  c.decode(big.subarray(1, 2));
  const [m, tr] = sent[0];
  assert.notEqual(m.bytes.buffer, big.buffer);
  assert.deepEqual([...m.bytes], [101]);
  assert.equal(m.bytes.byteLength, 1);
  assert.equal(tr[0], m.bytes.buffer);
});

// 전체 뷰: 복사 없음, 원본 버퍼 그대로 transfer.
test('전체 Uint8Array: 복사 없음·원본 버퍼 transfer', () => {
  const sent = [];
  const w = { postMessage(m, tr) { sent.push([m, tr]); }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  const whole = new Uint8Array([1, 2, 3]);
  c.decode(whole);
  const [m, tr] = sent[0];
  // 복사 없음: 같은 버퍼.
  assert.equal(m.bytes.buffer, whole.buffer);
  assert.equal(tr[0], whole.buffer);
});

test('전체 Uint16Array: 복사 없음·원본 버퍼 transfer', () => {
  const sent = [];
  const w = { postMessage(m, tr) { sent.push([m, tr]); }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  const whole = new Uint16Array([256, 512]);
  c.decode(whole);
  const [m, tr] = sent[0];
  assert.equal(m.bytes.buffer, whole.buffer);
  assert.equal(tr[0], whole.buffer);
});

test('subarray(0, length): 전체 뷰·복사 없음·원본 버퍼 transfer', () => {
  const sent = [];
  const w = { postMessage(m, tr) { sent.push([m, tr]); }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  const whole = new Uint8Array([5, 6, 7, 8]);
  c.decode(whole.subarray(0, whole.length));
  const [m, tr] = sent[0];
  // byteOffset=0 && byteLength=buffer.byteLength 이므로 전체로 판단.
  assert.equal(m.bytes.buffer, whole.buffer);
  assert.equal(tr[0], whole.buffer);
});

// subarray 와 byteOffset 조합.
test('offset 있는 subarray: 복사본 생성', () => {
  const sent = [];
  const w = { postMessage(m, tr) { sent.push([m, tr]); }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const view = new Uint8Array(buf.buffer, 2, 3); // offset=2, length=3 → [3, 4, 5]
  c.decode(view);
  const [m, tr] = sent[0];
  // offset 이 있으면 부분뷰 → 복사.
  assert.notEqual(m.bytes.buffer, buf.buffer);
  assert.deepEqual([...m.bytes], [3, 4, 5]);
  assert.equal(tr[0], m.bytes.buffer);
});

test('offset 0·전체 길이: 복사 없음·원본 transfer', () => {
  const sent = [];
  const w = { postMessage(m, tr) { sent.push([m, tr]); }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  const buf = new Uint8Array([10, 11, 12]);
  const view = new Uint8Array(buf.buffer, 0, 3); // offset=0, full length
  c.decode(view);
  const [m, tr] = sent[0];
  // offset=0 && length=buffer.byteLength → 전체.
  assert.equal(m.bytes.buffer, buf.buffer);
  assert.equal(tr[0], buf.buffer);
});

// 빈 subarray.
test('빈 subarray: 복사본 생성·길이 0', () => {
  const sent = [];
  const w = { postMessage(m, tr) { sent.push([m, tr]); }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  const big = new Uint8Array([1, 2, 3, 4, 5]);
  c.decode(big.subarray(2, 2));
  const [m, tr] = sent[0];
  assert.notEqual(m.bytes.buffer, big.buffer);
  assert.equal(m.bytes.byteLength, 0);
  assert.equal(tr[0], m.bytes.buffer);
});

// 빈 전체 배열.
test('빈 배열 decode: 복사·크기 0·transfer', () => {
  const sent = [];
  const w = { postMessage(m, tr) { sent.push([m, tr]); }, terminate() {} };
  const c = createDecodeWorkerClient({ spawn: () => w });
  const empty = new Uint8Array(0);
  c.decode(empty);
  const [m, tr] = sent[0];
  // 전체 버퍼(크기 0)는 복사 없음.
  assert.equal(m.bytes.buffer, empty.buffer);
  assert.equal(tr[0], empty.buffer);
  assert.equal(m.bytes.byteLength, 0);
});
