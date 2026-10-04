import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from './index.mjs';

const K = (segmentId, level, lod = 0, chunkIndex = 0, tileX = 0, tileY = 0) => ({ segmentId, level, lod, chunkIndex, tileX, tileY });
const I = (key, bytes, priority) => ({ key, bytes, priority, level: key.level });
const segs = (batch) => batch.map((b) => `${b.key.segmentId}/${b.key.level}/${b.key.chunkIndex}`);

test('손계산 1: 우선순위 > 수준 > 들어온 순서', () => {
  const s = createScheduler({ budgetBytesPerTick: 1000 });
  s.enqueue(I(K(1, 0), 10, 5));
  s.enqueue(I(K(2, 1), 10, 5)); // 같은 priority, level 높음 -> 먼저
  s.enqueue(I(K(3, 0), 10, 9)); // priority 최고
  s.enqueue(I(K(4, 0), 10, 5)); // 1 과 같음, 나중
  assert.deepEqual(segs(s.nextBatch()), ['3/0/0', '2/1/0', '1/0/0', '4/0/0']);
  assert.deepEqual(s.pending(), []);
});

test('손계산 2: 예산 100, 40+40+40 -> 배치 [40,40] 다음 [40]', () => {
  const s = createScheduler({ budgetBytesPerTick: 100 });
  for (let i = 0; i < 3; i++) s.enqueue(I(K(i, 0), 40, 3 - i));
  const b1 = s.nextBatch();
  assert.deepEqual(segs(b1), ['0/0/0', '1/0/0']);
  assert.equal(b1.oversize, false);
  assert.deepEqual(segs(s.nextBatch()), ['2/0/0']);
  assert.equal(s.nextBatch().length, 0);
});

test('손계산 3: 정확히 예산과 같은 합은 허용(60+40=100)', () => {
  const s = createScheduler({ budgetBytesPerTick: 100 });
  s.enqueue(I(K(1, 0), 60, 2));
  s.enqueue(I(K(2, 0), 40, 1));
  assert.equal(s.nextBatch().length, 2);
});

test('손계산 4: 예산 초과 항목은 단독 배치 + oversize, 뒤 작은 항목이 앞지르지 않음', () => {
  const s = createScheduler({ budgetBytesPerTick: 100 });
  s.enqueue(I(K(1, 0), 30, 9));
  s.enqueue(I(K(2, 0), 500, 8)); // 30 뒤에서 예산을 넘음 -> 이번 배치에서 멈춤
  s.enqueue(I(K(3, 0), 10, 7)); // 2 를 앞지르면 안 됨
  const b1 = s.nextBatch();
  assert.deepEqual(segs(b1), ['1/0/0']);
  assert.equal(b1.oversize, false);
  const b2 = s.nextBatch();
  assert.deepEqual(segs(b2), ['2/0/0']);
  assert.equal(b2.oversize, true);
  const b3 = s.nextBatch();
  assert.deepEqual(segs(b3), ['3/0/0']);
  assert.equal(b3.oversize, false);
});

test('손계산 5: 같은 key 중복은 하나, priority 큰 쪽 유지, 순번은 처음 것', () => {
  const s = createScheduler({ budgetBytesPerTick: 1000 });
  s.enqueue(I(K(1, 0), 10, 2));
  s.enqueue(I(K(2, 0), 10, 5));
  s.enqueue(I(K(1, 0), 10, 5)); // 1 의 priority 가 5 로 올라감, 순번은 2 보다 앞
  s.enqueue(I(K(2, 0), 10, 1)); // 낮은 쪽은 무시
  assert.deepEqual(s.pending().map((p) => [p.key.segmentId, p.priority]), [[1, 5], [2, 5]]);
});

test('손계산 6: 높은 수준이 들어오면 같은 (구간,타일,lod) 낮은 수준을 버린다', () => {
  const s = createScheduler({ budgetBytesPerTick: 1000 });
  s.enqueue(I(K(7, 0, 1, 0, 3, 4), 10, 1));
  s.enqueue(I(K(7, 1, 1, 0, 3, 4), 10, 1));
  s.enqueue(I(K(7, 0, 2, 0, 3, 4), 10, 1)); // lod 다름 -> 유지
  s.enqueue(I(K(7, 0, 1, 0, 5, 4), 10, 1)); // 타일 다름 -> 유지
  s.enqueue(I(K(8, 0, 1, 0, 3, 4), 10, 1)); // 구간 다름 -> 유지
  assert.equal(s.enqueue(I(K(7, 0, 1, 1, 3, 4), 10, 99)), false); // 높은 수준이 있는 동안 낮은 수준은 받지 않음
  assert.equal(s.pending().length, 4);
  assert.equal(s.pending().some((p) => p.key.segmentId === 7 && p.level === 0 && p.key.lod === 1 && p.key.tileX === 3), false);
});

test('손계산 7: cancel 은 있으면 true, 없으면 false; 같은 수준은 서로 버리지 않음', () => {
  const s = createScheduler({ budgetBytesPerTick: 1000 });
  s.enqueue(I(K(1, 2, 0, 0), 10, 1));
  s.enqueue(I(K(1, 2, 0, 1), 10, 1));
  assert.equal(s.pending().length, 2);
  assert.equal(s.cancel(K(1, 2, 0, 0)), true);
  assert.equal(s.cancel(K(1, 2, 0, 0)), false);
  assert.equal(s.pending().length, 1);
});

test('입력 검사', () => {
  assert.throws(() => createScheduler({ budgetBytesPerTick: 0 }), RangeError);
  const s = createScheduler({ budgetBytesPerTick: 10 });
  assert.throws(() => s.enqueue({ key: K(1, 0), bytes: -1, priority: 0, level: 0 }), RangeError);
  assert.throws(() => s.enqueue({ key: K(1, 0), bytes: 1, priority: 0, level: 1 }), RangeError);
  assert.throws(() => s.enqueue({ key: { segmentId: 1 }, bytes: 1, priority: 0, level: 0 }), TypeError);
});

// 고정 시드 난수(mulberry32)
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

// 회귀 스냅숏(구현 출력을 고정한 값이며 손계산이 아니다. 정답 판정은 아래 독립 모델의 전체 순서 대조가 맡는다): [나간 항목 수, 나간 고유 key 수]
const EXPECTED = new Map([
  [20240611, [3973, 2616]],
  [1, [3921, 2615]],
  [7, [4035, 2632]],
  [424242, [3874, 2583]],
  [987654321, [3942, 2611]],
]);

for (const [SEED, [EXPECT_SENT, EXPECT_UNIQUE]] of EXPECTED) test(`합성 1만 항목(시드 ${SEED}): 예산 초과 0, 순서 위반 0, 추월 후 낮은 수준 전송 0`, () => {
  const rand = rng(SEED);
  const BUDGET = 5000;
  const s = createScheduler({ budgetBytesPerTick: BUDGET });
  const id = (k) => `${k.segmentId}:${k.level}:${k.lod}:${k.chunkIndex}:${k.tileX}:${k.tileY}`;
  const grp = (k) => `${k.segmentId}:${k.tileX}:${k.tileY}:${k.lod}`;
  const sentMax = new Map(); // 독립 모델: 묶음별 나간 최고 level
  let notLiveSent = 0; // 큐에 있어야 할 것이 아닌데 나간 항목(취소됐거나 버려졌는데 나감)
  let cancelledSent = 0;
  const cancelled = new Set();
  const live = new Map(); // 독립 모델: 큐에 있었고 아직 안 나가고 취소 안 된 것(스케줄러가 버린 것도 포함)
  let ordCounter = 0; // 독립 모델의 '처음 들어온 순서'(스케줄러 seq 와 별개로 센다)
  let enqueued = 0;
  let budgetViolations = 0;
  let orderViolations = 0;
  let overtakenSent = 0;
  let oversizeBad = 0;
  let sentTotal = 0;
  const sentIds = new Set();

  const drain = () => {
    const before = s.pending();
    // 독립 모델이 예측한 전체 대기 순서(priority 내림, level 내림, 처음 들어온 순서)와 pending() 의 전체 순서·집합이 같아야 한다
    const expectedOrder = [...live.values()].sort((a, b) => b.priority - a.priority || b.level - a.level || a.ord - b.ord).map((m) => id(m.key));
    assert.deepEqual(before.map((p) => id(p.key)), expectedOrder);
    const batch = s.nextBatch();
    const sum = batch.reduce((a, b) => a + b.bytes, 0);
    if (batch.length > 1 && sum > BUDGET) budgetViolations++;
    if (batch.length === 1 && batch[0].bytes > BUDGET !== batch.oversize) oversizeBad++;
    if (batch.length > 1 && batch.oversize) oversizeBad++;
    // 우선순위 순서: 배치는 직전 pending 의 앞부분이어야 한다
    for (let i = 0; i < batch.length; i++) {
      if (id(batch[i].key) !== id(before[i].key)) orderViolations++;
      if (i > 0) {
        const a = batch[i - 1], b = batch[i];
        if (a.priority < b.priority || (a.priority === b.priority && a.level < b.level)) orderViolations++;
      }
    }
    // 배치에 안 들어간 나머지 중 더 앞서야 할 것이 있으면 위반
    if (batch.length > 0 && batch.length < before.length) {
      const last = batch[batch.length - 1], nxt = before[batch.length];
      if (nxt.priority > last.priority || (nxt.priority === last.priority && nxt.level > last.level)) orderViolations++;
    }
    for (const b of batch) {
      for (const m of live.values()) {
        if (grp(m.key) === grp(b.key) && m.level > b.level) { overtakenSent++; break; }
      }
      if (!live.has(id(b.key))) notLiveSent++;
      if (cancelled.has(id(b.key))) cancelledSent++;
      sentIds.add(id(b.key));
      if ((sentMax.get(grp(b.key)) ?? -1) < b.level) sentMax.set(grp(b.key), b.level);
    }
    for (const b of batch) live.delete(id(b.key));
    sentTotal += batch.length;
    return batch.length;
  };

  for (let i = 0; i < 10000; i++) {
    const key = K(Math.floor(rand() * 20), Math.floor(rand() * 4), Math.floor(rand() * 3), Math.floor(rand() * 2), Math.floor(rand() * 4), Math.floor(rand() * 4));
    const bytes = rand() < 0.02 ? BUDGET + 1 + Math.floor(rand() * 3000) : 1 + Math.floor(rand() * 2000);
    const item = I(key, bytes, Math.floor(rand() * 10));
    s.enqueue(item);
    enqueued++;
    // 독립 모델: 높은 수준이 큐에 있으면 받지 않고, 새 높은 수준은 낮은 수준을 밀어낸다
    const rejected = (sentMax.get(grp(key)) ?? -1) > key.level
      || [...live.values()].some((m) => grp(m.key) === grp(key) && m.level > key.level);
    if (!rejected) cancelled.delete(id(key)); // 다시 받아들여진 key 는 더 이상 취소 상태가 아니다
    if (!rejected) {
      for (const m of [...live.values()]) if (grp(m.key) === grp(key) && m.level < key.level) live.delete(id(m.key));
      const prev = live.get(id(key));
      if (!prev) live.set(id(key), { ...item, ord: ordCounter++ });
      else if (prev.priority < item.priority) live.set(id(key), { ...item, ord: prev.ord }); // 순번은 처음 것
    }
    const r = rand();
    if (r < 0.05) {
      const victim = [...live.values()][Math.floor(rand() * live.size)];
      if (victim) {
        assert.equal(s.cancel(victim.key), true);
        live.delete(id(victim.key));
        cancelled.add(id(victim.key));
      }
    }
    if (r > 0.7) drain();
  }
  while (s.pending().length > 0) drain();
  assert.equal(enqueued, 10000);
  assert.equal(budgetViolations, 0);
  assert.equal(orderViolations, 0);
  assert.equal(overtakenSent, 0);
  assert.equal(oversizeBad, 0);
  assert.equal(notLiveSent, 0); // 유실·유령 없음: 나간 것은 전부 큐에 살아 있던 것
  assert.equal(cancelledSent, 0); // 취소한 것은 나가지 않는다
  assert.equal(live.size, 0); // 취소·추월 되지 않은 것은 전부 나갔다(유실 0)
  assert.equal(sentTotal, EXPECT_SENT);
  assert.equal(sentIds.size, EXPECT_UNIQUE);
});

test('F-190: 수준 3 이 나간 뒤 같은 묶음 수준 1 enqueue 는 false, pending 0', () => {
  const s = createScheduler({ budgetBytesPerTick: 1000 });
  assert.equal(s.enqueue(I(K(1, 3, 0, 0, 2, 2), 10, 1)), true);
  assert.equal(s.nextBatch().length, 1);
  assert.equal(s.enqueue(I(K(1, 1, 0, 0, 2, 2), 10, 9)), false);
  assert.equal(s.pending().length, 0);
  assert.equal(s.enqueue(I(K(1, 3, 0, 5, 2, 2), 10, 1)), true); // 같은 수준 다른 chunk 는 받는다
  assert.equal(s.enqueue(I(K(1, 1, 0, 0, 3, 2), 10, 1)), true); // 다른 타일 묶음은 영향 없음
  assert.equal(s.pending().length, 2);
});

test('F-192: maxPending 초과 enqueue 는 false, 병합·추월 교체는 받는다', () => {
  const s = createScheduler({ budgetBytesPerTick: 1000, maxPending: 2 });
  assert.equal(s.enqueue(I(K(1, 0), 10, 1)), true);
  assert.equal(s.enqueue(I(K(2, 0), 10, 1)), true);
  assert.equal(s.enqueue(I(K(3, 0), 10, 1)), false);
  assert.equal(s.pending().length, 2);
  assert.equal(s.enqueue(I(K(1, 0), 10, 5)), true); // 같은 key 병합: 수 불변
  assert.equal(s.enqueue(I(K(2, 1), 10, 1)), true); // 낮은 수준 밀어내고 그 자리 사용
  assert.deepEqual(segs(s.nextBatch()), ['1/0/0', '2/1/0']);
  assert.equal(s.enqueue(I(K(3, 0), 10, 1)), true); // 비워지면 다시 받는다
  assert.throws(() => createScheduler({ budgetBytesPerTick: 1, maxPending: 0 }), RangeError);
});

test('F-192: maxSentGroups 축출은 가장 오래된 묶음부터', () => {
  const s = createScheduler({ budgetBytesPerTick: 1000, maxSentGroups: 2 });
  for (const seg of [1, 2, 3]) { s.enqueue(I(K(seg, 3), 10, 1)); s.nextBatch(); }
  assert.equal(s.enqueue(I(K(3, 1), 10, 1)), false); // 최근 묶음은 기억
  assert.equal(s.enqueue(I(K(2, 1), 10, 1)), false);
  assert.equal(s.enqueue(I(K(1, 1), 10, 1)), true); // 묶음 1 은 축출되어 기억 없음
});

test('F-195: cancel 은 priority 0 항목도 지운다, 취소한 것은 나가지 않는다', () => {
  const s = createScheduler({ budgetBytesPerTick: 1000 });
  s.enqueue(I(K(1, 0), 10, 0));
  s.enqueue(I(K(2, 0), 10, 0));
  assert.equal(s.cancel(K(1, 0)), true);
  assert.deepEqual(s.pending().map((p) => p.key.segmentId), [2]);
  assert.deepEqual(segs(s.nextBatch()), ['2/0/0']);
  assert.equal(s.cancel(K(2, 0)), false); // 이미 나간 것
});

test('F-193 ③ oversize: 숫자로 고정(예산 100)', () => {
  const s = createScheduler({ budgetBytesPerTick: 100 });
  s.enqueue(I(K(1, 0), 101, 3)); // 맨 앞 + 예산 초과 -> 단독
  s.enqueue(I(K(2, 0), 1, 2));
  s.enqueue(I(K(3, 0), 100, 1)); // 정확히 예산 -> oversize 아님
  const b1 = s.nextBatch();
  assert.deepEqual(b1.map((b) => b.bytes), [101]);
  assert.equal(b1.oversize, true);
  const b2 = s.nextBatch(); // 1 + 100 = 101 > 100 -> 100 은 다음 배치
  assert.deepEqual(b2.map((b) => b.bytes), [1]);
  assert.equal(b2.oversize, false);
  const b3 = s.nextBatch();
  assert.deepEqual(b3.map((b) => b.bytes), [100]);
  assert.equal(b3.oversize, false);
  assert.equal(s.nextBatch().oversize, false); // 빈 배치
});

test('모델 순서: 같은 priority·level 은 들어온 순서 그대로(전체 순서 단언, FIFO 뒤집기 변이 검출)', () => {
  const s = createScheduler({ budgetBytesPerTick: 1e9 });
  const order = [];
  for (let i = 0; i < 50; i++) {
    const key = K(i, 0);
    order.push(i);
    s.enqueue(I(key, 1, i % 3 === 0 ? 5 : 2));
  }
  const expected = [...order.filter((i) => i % 3 === 0), ...order.filter((i) => i % 3 !== 0)];
  assert.deepEqual(s.pending().map((p) => p.key.segmentId), expected);
  assert.deepEqual(s.nextBatch().map((p) => p.key.segmentId), expected);
});

test('F-220 ③: chunkIndex 범위 밖(65536, -1)은 enqueue 가 거부한다, 경계 65535·0 은 받는다', () => {
  const s = createScheduler({ budgetBytesPerTick: 1000 });
  assert.throws(() => s.enqueue(I(K(1, 0, 0, 65536), 1, 1)), RangeError);
  assert.throws(() => s.enqueue(I(K(1, 0, 0, -1), 1, 1)), RangeError);
  assert.equal(s.enqueue(I(K(1, 0, 0, 65535), 1, 1)), true);
  assert.equal(s.enqueue(I(K(1, 0, 0, 0), 1, 1)), true);
  assert.equal(s.pending().length, 2);
  assert.throws(() => s.cancel(K(1, 0, 0, 65536)), RangeError);
});

// ---- F-208·F-213·F-217 ② 성능 ----
// 목표: 100000 오름차순 priority enqueue 0.3 s 이하, 한 묶음 20000 개 enqueue 50 ms 이하.
// 1차 판정은 결정적 연산 수(힙 비교 + 힙 밖 순회 칸 수)가 n log2 n 의 상수배 이하인 것, 2차는 같은 프로세스의 선형 기준선과의 비 이다.
// 벽시계 절대 목표는 CPU 시간(user+system)으로 3번 재 가장 빠른 값을 쓴다. 문턱은 목표 그대로다.
const cpuNow = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};
const perfKey = (i, extra = {}) => ({ segmentId: i, level: 0, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0, ...extra });
// 변이·회귀로 느려져도 파일이 멈추지 않게, 반복 안에서 경과가 한도를 넘으면 바로 던진다(F-217 ①과 같은 방식).
const GUARD_MS = 4000;
function guard(t0, i) {
  if ((i & 1023) === 0 && cpuNow() - t0 > GUARD_MS) throw new Error(`enqueue 가 ${GUARD_MS} ms 를 넘겨 중단(i=${i})`);
}
const best = (n, fn) => Math.min(...Array.from({ length: n }, fn));

function ascending(n) {
  const s = createScheduler({ budgetBytesPerTick: 1e9, maxPending: Math.max(n, 100000) });
  const t0 = cpuNow();
  for (let i = 0; i < n; i++) {
    guard(t0, i);
    if (!s.enqueue({ key: perfKey(i), bytes: 1, priority: i, level: 0 })) throw new Error('rejected');
  }
  return [cpuNow() - t0, s];
}
function oneGroup(n) {
  const s = createScheduler({ budgetBytesPerTick: 1e9 });
  const t0 = cpuNow();
  for (let i = 0; i < n; i++) {
    guard(t0, i);
    if (!s.enqueue({ key: perfKey(1, { chunkIndex: i }), bytes: 1, priority: i % 7, level: 0 })) throw new Error('rejected');
  }
  return [cpuNow() - t0, s];
}
const ops = (s) => { const c = s.counters(); return c.compares + c.steps; };
const nlogn = (n) => n * Math.log2(n);

test('F-208 결정적: 100k 오름차순 enqueue 연산 수 <= 2 n log2 n, 2배 크기에서 증가율 <= 2.3', () => {
  const [, s1] = ascending(50000);
  const [, s2] = ascending(100000);
  console.log(`# ops asc 50k=${ops(s1)} 100k=${ops(s2)} (n log2 n = ${nlogn(100000) | 0})`);
  assert.ok(ops(s2) <= 2 * nlogn(100000), `ops ${ops(s2)}`);
  assert.ok(ops(s2) / ops(s1) <= 2.3, `ratio ${ops(s2) / ops(s1)}`);
});

test('F-208 결정적: 한 묶음 20000 개 enqueue 연산 수 <= 2 n log2 n, 2배 크기에서 증가율 <= 2.3', () => {
  const [, s1] = oneGroup(10000);
  const [, s2] = oneGroup(20000);
  console.log(`# ops group 10k=${ops(s1)} 20k=${ops(s2)}`);
  assert.ok(ops(s2) <= 2 * nlogn(20000), `ops ${ops(s2)}`);
  assert.ok(ops(s2) / ops(s1) <= 2.3, `ratio ${ops(s2) / ops(s1)}`);
});

test('F-208 선형 기준선: 같은 프로세스의 Map 100k 삽입(키 문자열·객체 포함)의 k 배 이내이고 n 4배에서 시간비 <= 8', () => {
  const baseline = (n) => best(3, () => {
    const m = new Map();
    const t0 = cpuNow();
    for (let i = 0; i < n; i++) { const k = `${i}:0:0:0:0:0`; m.set(k, { id: k, a: i, b: 1, c: 0, d: i, e: null }); m.get(`${i}:0:0:0`); }
    return cpuNow() - t0;
  });
  const base = baseline(100000);
  const t100 = best(3, () => ascending(100000)[0]);
  const t25 = best(3, () => ascending(25000)[0]);
  console.log(`# asc 100k ${t100.toFixed(1)} ms, baseline ${base.toFixed(1)} ms (x${(t100 / base).toFixed(1)}), 25k ${t25.toFixed(1)} ms (x${(t100 / t25).toFixed(1)})`);
  assert.ok(t100 <= 12 * base + 20, `asc ${t100} vs baseline ${base}`);
  assert.ok(t100 / t25 <= 8, `growth ${t100 / t25}`);
});

test('F-208 절대 목표: 100k 오름차순 enqueue <= 0.3 s, 한 묶음 20000 개 <= 50 ms (5회 중 최소 CPU 시간)', () => {
  const ms = best(5, () => ascending(100000)[0]);
  const gms = best(3, () => oneGroup(20000)[0]);
  console.log(`# 100k asc ${ms.toFixed(1)} ms, 20k one-group ${gms.toFixed(1)} ms`);
  assert.ok(ms <= 300, `${ms} ms`);
  assert.ok(gms <= 50, `${gms} ms`);
  const [, s] = ascending(100000);
  const t1 = cpuNow();
  const batch = s.nextBatch();
  console.log(`# 100k nextBatch drain: ${(cpuNow() - t1).toFixed(1)} ms`);
  assert.equal(batch.length, 100000);
  assert.equal(batch[0].priority, 99999);
  assert.equal(batch[99999].priority, 0);
  assert.equal(oneGroup(20000)[1].pending().length, 20000);
});

// F-213: 상한에 닿은 뒤 교체가 계속돼도 한 번당 비용이 상한 크기에 비례하지 않아야 한다.
function replacements(cap, n) {
  const s = createScheduler({ budgetBytesPerTick: 1e9, maxSentGroups: cap });
  const t0 = cpuNow();
  for (let i = 0; i < n; i++) {
    guard(t0, i);
    s.enqueue({ key: perfKey(i), bytes: 1, priority: 0, level: 0 });
    s.nextBatch();
  }
  return [cpuNow() - t0, s];
}

test('F-213: maxSentGroups 65536 에서 25만 회 교체의 회당 시간이 상한 1000 일 때의 2배 이내(같은 프로세스)', () => {
  const N = 250000;
  const small = best(3, () => replacements(1000, N)[0]);
  const big = best(3, () => replacements(65536, N)[0]);
  console.log(`# replacements: cap1000 ${(small / N * 1000).toFixed(2)} us/op, cap65536 ${(big / N * 1000).toFixed(2)} us/op (x${(big / small).toFixed(2)})`);
  assert.ok(big <= 2 * small, `cap65536 ${big} ms vs cap1000 ${small} ms`);
});

test('F-213 결정적: 교체 25만 회의 힙 밖 순회 칸 수가 회당 상수(<= 4)이고 상한 이후 기억 묶음 수는 상한', () => {
  const [, s] = replacements(65536, 250000);
  assert.ok(s.counters().steps <= 4 * 250000, `steps ${s.counters().steps}`);
  // 기억 묶음 수가 상한을 넘지 않는다: 가장 오래된 65536 개 이전 묶음은 낮은 level 이 다시 들어올 수 있다
  const t = createScheduler({ budgetBytesPerTick: 1e9, maxSentGroups: 4 });
  for (let i = 0; i < 10; i++) { t.enqueue(I(K(i, 3), 1, 0)); t.nextBatch(); }
  const accepted = [];
  for (let i = 0; i < 10; i++) accepted.push(t.enqueue(I(K(i, 1), 1, 0)));
  assert.deepEqual(accepted, [true, true, true, true, true, true, false, false, false, false]);
});

test('F-213: 같은 묶음만 계속 쓰여도 큐가 무한히 자라지 않고 LRU 순서가 맞다', () => {
  const s = createScheduler({ budgetBytesPerTick: 1e9, maxSentGroups: 3 });
  for (const seg of [1, 2, 3]) { s.enqueue(I(K(seg, 3), 1, 0)); s.nextBatch(); }
  for (let i = 0; i < 100000; i++) { s.enqueue(I(K(1, 3, 0, i % 5), 1, 0)); s.nextBatch(); } // 묶음 1 만 계속 최신으로
  s.enqueue(I(K(4, 3), 1, 0)); s.nextBatch(); // 묶음 2 가 가장 오래됨 -> 축출
  assert.equal(s.enqueue(I(K(2, 1), 1, 0)), true);
  assert.equal(s.enqueue(I(K(1, 1), 1, 0)), false);
  assert.equal(s.enqueue(I(K(3, 1), 1, 0)), false);
});
