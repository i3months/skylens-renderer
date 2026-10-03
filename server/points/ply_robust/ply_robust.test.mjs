import test from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { countCopies } from '../test_util/copies.mjs';
import { readPlySafe } from './index.mjs';
import { PointsError, POINT27_PROPERTIES, GAUSS56_PROPERTIES } from '../../../contracts/points/index.mjs';

const props = (ps) => ps.map((p) => `property ${p.type} ${p.name}\n`).join('');
const hdr = ({ magic = 'ply', fmt = 'binary_little_endian 1.0', n = 1, p = props(POINT27_PROPERTIES), end = 'end_header\n' } = {}) =>
  Buffer.from(`${magic}\nformat ${fmt}\nelement vertex ${n}\n${p}${end}`, 'latin1');
const rec27 = (i) => {
  const b = Buffer.alloc(27);
  [1 + i, 2 + i, 3 + i, 0, 0, 1].forEach((v, k) => b.writeFloatLE(v, 4 * k));
  b[24] = 10 + i; b[25] = 20 + i; b[26] = 30 + i;
  return b;
};
const good27 = (n = 2) => Buffer.concat([hdr({ n }), ...Array.from({ length: n }, (_, i) => rec27(i))]);
const rec56 = (i) => {
  const b = Buffer.alloc(56);
  for (let k = 0; k < 14; k++) b.writeFloatLE(i + k * 0.5, 4 * k);
  return b;
};

const SLOW_MS = 1000; // 입력 1건 처리 한도(정상 처리는 1 ms 미만이라 매우 넉넉)
const rejects = (buf, code) => assert.throws(() => readPlySafe(buf), (e) => e instanceof PointsError && e.code === code, code);

test('정상 27 B 값 정확', () => {
  const c = readPlySafe(good27(2));
  assert.equal(c.format, 1); assert.equal(c.count, 2);
  assert.deepEqual([...c.positions], [1, 2, 3, 2, 3, 4]);
  assert.deepEqual([...c.normals], [0, 0, 1, 0, 0, 1]);
  assert.deepEqual([...c.colors], [10, 20, 30, 11, 21, 31]);
});
test('정상 56 B 값 정확(오프셋 있는 뷰 포함)', () => {
  const buf = Buffer.concat([hdr({ n: 2, p: props(GAUSS56_PROPERTIES) }), rec56(0), rec56(1)]);
  const padded = new Uint8Array(buf.length + 3); padded.set(buf, 3);
  for (const input of [buf, padded.subarray(3)]) {
    const c = readPlySafe(input);
    assert.equal(c.format, 2); assert.equal(c.count, 2);
    assert.deepEqual([...c.positions], [0, 0.5, 1, 1, 1.5, 2]);
    assert.deepEqual([...c.fdc], [1.5, 2, 2.5, 2.5, 3, 3.5]);
    assert.deepEqual([...c.opacity], [3, 4]);
    assert.deepEqual([...c.scales], [3.5, 4, 4.5, 4.5, 5, 5.5]);
    assert.deepEqual([...c.rotations], [5, 5.5, 6, 6.5, 6, 6.5, 7, 7.5]);
  }
});
test('정상 0점', () => assert.equal(readPlySafe(good27(0)).count, 0));

test('손상 10종', () => {
  const body = rec27(0);
  rejects(Buffer.concat([hdr({ magic: 'plx' }), body]), 'header');
  rejects(Buffer.concat([hdr({ end: 'end_hdr\n' }), body]), 'header');
  rejects(Buffer.concat([hdr({ fmt: 'ascii 1.0' }), body]), 'format');
  for (const n of ['-1', 'NaN', 'abc']) rejects(Buffer.concat([hdr({ n }), body]), 'size');
  rejects(Buffer.concat([hdr({ n: 2 ** 31 }), body]), 'size');
  rejects(Buffer.concat([hdr({ p: props(POINT27_PROPERTIES) + 'property list uchar int idx\n' }), body]), 'header');
  rejects(Buffer.concat([hdr({ p: 'property float x\nproperty float y\nproperty float z\nproperty quad w\n' }), body]), 'header');
  rejects(Buffer.concat([hdr({ p: 'property float x\nproperty float y\nproperty float z\n' }), Buffer.alloc(12)]), 'format');
  rejects(good27(2).subarray(0, good27(2).length - 1), 'truncated');
  rejects(Buffer.concat([good27(2), Buffer.alloc(1)]), 'size');
  rejects(hdr({ n: 3 }), 'truncated');
});
test('비 Uint8Array 입력', () => {
  for (const x of [null, undefined, 5, 'ply', [1], {}]) rejects(x, 'header');
});
test('거대 count 는 큰 할당 없이 즉시 거부', () => {
  // 벽시계 대신 할당량으로 단언: count 만큼(수십 GB) 할당했다면 arrayBuffers 가 크게 늘어난다.
  // 측정 전에 GC 를 강제해 앞선 테스트의 버퍼 회수가 섞이지 않게 하고, 증가량만(한쪽) 본다.
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const input = Buffer.concat([hdr({ n: 2 ** 31 - 1 }), rec27(0)]);
  for (let r = 0; r < 5; r++) {
    gc(); gc();
    const before = process.memoryUsage().arrayBuffers;
    // 결정적 계수: Buffer 로 복사·할당된 바이트도 입력 길이에 비해 무시할 만해야 한다
    const copied = countCopies(() => rejects(input, 'truncated'));
    // 호출 뒤에는 GC 하지 않는다: 만들어졌다 버려진 큰 버퍼도 증가량으로 보이게 한다(자연 GC 는 증가를 줄일 뿐이라 단언은 안전하다)
    const growth = process.memoryUsage().arrayBuffers - before;
    assert.ok(growth < 1 << 20, `arrayBuffers 증가량 ${growth} B`);
    assert.ok(copied < 1 << 16, `Buffer 복사량 ${copied} B`);
  }
});

test('고정 시드 변이 5천 회', () => {
  let s = 12345;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
  const bases = [good27(3), Buffer.concat([hdr({ n: 2, p: props(GAUSS56_PROPERTIES) }), rec56(0), rec56(1)])];
  let ok = 0, rej = 0;
  for (let it = 0; it < 5000; it++) {
    let b = Buffer.from(bases[it % 2]);
    const m = 1 + Math.floor(rnd() * 4);
    for (let j = 0; j < m; j++) {
      const kind = Math.floor(rnd() * 4);
      const pos = Math.floor(rnd() * b.length);
      if (kind === 0) b[pos] = Math.floor(rnd() * 256);
      else if (kind === 1) b = b.subarray(0, pos);
      else if (kind === 2) b = Buffer.concat([b.subarray(0, pos), Buffer.from([Math.floor(rnd() * 256)]), b.subarray(pos)]);
      else b = Buffer.concat([b.subarray(0, pos), b.subarray(pos + 1)]);
      if (b.length === 0) break;
    }
    const t = performance.now();
    try { readPlySafe(b); ok++; } catch (e) {
      assert.ok(e instanceof PointsError, `it ${it}: ${e && e.stack}`);
      rej++;
    }
    let dt = performance.now() - t;
    // 환경 정지(GC·스케줄링) 잡음 제외: 넉넉한 한도(1 s) 초과 시 같은 입력을 재측정해 최솟값을 쓴다
    for (let r = 0; r < 5 && dt > SLOW_MS; r++) {
      const t2 = performance.now();
      try { readPlySafe(b); } catch { /* 무시 */ }
      dt = Math.min(dt, performance.now() - t2);
    }
    assert.ok(dt <= SLOW_MS, `it ${it} slow ${dt}`);
  }
  assert.ok(ok > 0 && rej > 0);
});
