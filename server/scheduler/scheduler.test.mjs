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

test('합성 1만 항목(시드 고정): 예산 초과 0, 순서 위반 0, 추월 후 낮은 수준 전송 0', () => {
  const rand = rng(20240611);
  const BUDGET = 5000;
  const s = createScheduler({ budgetBytesPerTick: BUDGET });
  const id = (k) => `${k.segmentId}:${k.level}:${k.lod}:${k.chunkIndex}:${k.tileX}:${k.tileY}`;
  const grp = (k) => `${k.segmentId}:${k.tileX}:${k.tileY}:${k.lod}`;
  const sentMax = new Map(); // 독립 모델: 묶음별 나간 최고 level
  let notLiveSent = 0; // 큐에 있어야 할 것이 아닌데 나간 항목(취소됐거나 버려졌는데 나감)
  let cancelledSent = 0;
  const cancelled = new Set();
  const live = new Map(); // 독립 모델: 큐에 있었고 아직 안 나가고 취소 안 된 것(스케줄러가 버린 것도 포함)
  let enqueued = 0;
  let budgetViolations = 0;
  let orderViolations = 0;
  let overtakenSent = 0;
  let oversizeBad = 0;
  let sentTotal = 0;
  const sentIds = new Set();

  const drain = () => {
    const before = s.pending();
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
      if (!live.has(id(key)) || live.get(id(key)).priority < item.priority) live.set(id(key), item);
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
  assert.ok(sentIds.size > 100 && sentIds.size <= sentTotal, `나간 고유 key 수: ${sentIds.size}/${sentTotal}`);
  assert.ok(sentTotal > 100, `전송 수가 너무 적음: ${sentTotal}`);
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
