import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, before } from './index.mjs';

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

// ---- F-208·F-213·F-217 ② 성능(F-221: 시험 쪽 관측) ----
// 판정은 시간이 아니라 시험 쪽에서 센 결정적 수다. 구현이 스스로 세는 계수는 쓰지 않는다.
//   - compares: createScheduler({ compare }) 로 넣은 비교 함수(규칙 1 의 before 를 감싼 것)가 불린 횟수. 시험 쪽 클로저가 센다.
//   - moved: 측정 구간 동안 Array.prototype 의 splice/shift/unshift/copyWithin 이 자리를 옮긴 원소 수(앞쪽 삽입·삭제 비용).
//   - touched: moved + 그 밖의 배열 메서드(push/slice/filter/map/forEach/indexOf/sort 등)가 다룬 원소 수
//              + 배열·Map·Set 반복자(for-of, 펼침, keys/values/entries)와 forEach 가 내준 원소 수.
//   - stored: createScheduler({ wrapArray }) 로 내부 배열 저장소(힙, LRU 큐)를 Proxy 로 감싸 센 인덱스 대입(arr[i] = v) 횟수.
//             메서드 없이 for 루프로 heap[j] = heap[j-1] 을 옮기는 O(n) 삽입·삭제도 여기서 잡힌다(F-229 ①).
//             wrapArray 로 감쌀 때 들고 들어온 길이는 touched 에 더한다(F-233 ②: 지역 배열을 채운 뒤 새로 감싸는 우회).
// 측정 구간이 끝나면 패치한 프로토타입은 finally 에서 원래대로 되돌린다. 절대 시간은 bench/scheduler/index.mjs 가 보고만 한다.
// 상한: check(ops) 는 연산당 상한을, 각 계수기는 측정 전체의 상한(maxOps * 연산당 상한 + SLACK)을 넘는 순간 그 자리에서 던진다.
// 그래서 nextBatch 한 번 안의 O(n^2) 도 전체 상한에 닿으면 바로 멈춘다.
// 한계(관측이 못 보는 것): 위 계수기를 거치지 않는 일 - wrapArray 를 거치지 않고 새로 만든 지역 배열·객체에 대한 인덱스·속성 대입,
// 일반 객체/연결 리스트를 따라가는 루프, 모듈 로드 때 붙잡아 둔 프로토타입 메서드, 순수 산술 루프 - 는 세지 않는다.
// 그런 변이가 오래 돌 때를 위해 성능 시험마다 { timeout: PERF_TIMEOUT_MS } 를 두고, 측정 루프는 YIELD_EVERY 연산마다
// 이벤트 루프에 양보해 timeout 이 실제로 끼어들 수 있게 한다(양보하는 동안은 세지 않는다). timeout 은 안전망일 뿐 판정 기준이 아니다.
// timeout 은 실패 표시만 하므로 check 가 t.signal 의 aborted 를 보고 던져 루프 자체를 끊는다(F-233 ①).
// 단 nextBatch 한 번처럼 양보 없이 도는 동기 구간 안에서 계수기를 거치지 않는 변이는 timeout 으로도 끊지 못한다(구간이 끝나야 실패).
const perfKey = (i, extra = {}) => ({ segmentId: i, level: 0, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0, ...extra });
const log2 = Math.log2;
const PERF_TIMEOUT_MS = 120000;
const YIELD_EVERY = 4096;

const isIndexKey = (k) => typeof k === 'string' && k !== '' && String(k >>> 0) === k && (k >>> 0) !== 4294967295;

function observe() {
  const c = { moved: 0, touched: 0, stored: 0, on: true, cap: { moved: Infinity, touched: Infinity, stored: Infinity } };
  const over = () => {
    if (c.moved > c.cap.moved || c.touched > c.cap.touched || c.stored > c.cap.stored) {
      throw new Error(`관측 상한 초과: moved ${c.moved}/${c.cap.moved}, touched ${c.touched}/${c.cap.touched}, stored ${c.stored}/${c.cap.stored}`);
    }
  };
  const mv = (n) => { if (c.on) { c.moved += n; c.touched += n; over(); } };
  const tc = (n) => { if (c.on) { c.touched += n; over(); } };
  // 시험 전용 저장소: 인덱스 대입만 센다(push 가 안에서 하는 대입도 1 로 센다).
  // 감쌀 때 arr.length 를 touched 에 더한다(F-233 ②): 지역 배열을 다 채운 뒤 새로 감싸면 그 전 대입은 stored 에 안 잡히므로
  // 감싸는 순간 들고 들어온 칸 수로 센다. 정상 구현은 빈 배열이나 slice/filter 결과만 감싸므로 amortized 상수다.
  c.wrap = (arr) => {
    tc(arr.length);
    return new Proxy(arr, {
      set(t, k, v) {
        if (c.on && isIndexKey(k)) { c.stored++; over(); }
        t[k] = v;
        return true;
      },
    });
  };
  const restore = [];
  const patch = (proto, name, wrap) => {
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    restore.push(() => Object.defineProperty(proto, name, desc));
    Object.defineProperty(proto, name, { ...desc, value: wrap(desc.value) });
  };
  const countIter = (it) => ({
    next() { const r = it.next(); if (!r.done) tc(1); return r; },
    return(v) { return typeof it.return === 'function' ? it.return(v) : { done: true, value: v }; },
    [Symbol.iterator]() { return this; },
  });
  try {
    const A = Array.prototype;
    const idx = (v, len) => { const x = Math.trunc(Number(v) || 0); return x < 0 ? Math.max(len + x, 0) : Math.min(x, len); };
    patch(A, 'splice', (f) => function (start, del, ...ins) {
      const len = this.length;
      const st = idx(start, len);
      const d = arguments.length < 2 ? len - st : Math.min(Math.max(Math.trunc(Number(del) || 0), 0), len - st);
      mv((len - st - d) + d + ins.length); // 뒤쪽이 밀리거나 당겨지는 칸 + 지운 칸 + 넣은 칸
      return f.apply(this, arguments);
    });
    patch(A, 'shift', (f) => function () { mv(this.length); return f.apply(this, arguments); });
    patch(A, 'unshift', (f) => function () { mv(this.length + arguments.length); return f.apply(this, arguments); });
    patch(A, 'copyWithin', (f) => function () { mv(this.length); return f.apply(this, arguments); });
    patch(A, 'push', (f) => function () { tc(arguments.length); return f.apply(this, arguments); });
    patch(A, 'slice', (f) => function () { const r = f.apply(this, arguments); tc(r.length); return r; });
    patch(A, 'concat', (f) => function () { const r = f.apply(this, arguments); tc(r.length); return r; });
    for (const name of ['filter', 'map', 'forEach', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'indexOf', 'lastIndexOf', 'includes', 'reduce', 'reduceRight', 'sort', 'reverse', 'fill', 'join', 'flat', 'flatMap']) {
      patch(A, name, (f) => function () { tc(this.length); return f.apply(this, arguments); });
    }
    for (const name of ['values', 'keys', 'entries']) patch(A, name, (f) => function () { return countIter(f.apply(this, arguments)); });
    patch(A, Symbol.iterator, (f) => function () { return countIter(f.apply(this, arguments)); });
    for (const P of [Map.prototype, Set.prototype]) {
      for (const name of ['values', 'keys', 'entries']) if (Object.hasOwn(P, name)) patch(P, name, (f) => function () { return countIter(f.apply(this, arguments)); });
      patch(P, Symbol.iterator, (f) => function () { return countIter(f.apply(this, arguments)); });
      patch(P, 'forEach', (f) => function (cb, thisArg) { return f.call(this, function (...a) { tc(1); return cb.apply(thisArg, a); }); });
    }
  } catch (e) {
    for (const r of restore.reverse()) r();
    throw e;
  }
  c.restore = () => { c.on = false; for (const r of restore.reverse()) r(); restore.length = 0; };
  return c;
}

// 처음 몇 연산의 고정 비용(첫 호출 준비 등)을 위한 여유. 상한은 누계 <= ops * 연산당 상한 + SLACK 이다.
const SLACK = 1024;
// 하한: enqueue 마다 힙에 항목을 하나 넣고(wrapArray 로 감싼 힙의 push 가 인덱스 대입 1 로 센다) nextBatch 로 비우는 측정도 있어
// check(ops) 의 ops 는 enqueue 수의 최대 2 배다(오름차순+비우기 시험의 2n). 그래서 연산당 stored >= 0.5 를 하한으로 둔다.
// wrapArray 를 아예 거치지 않는 지역 배열 O(n) 삽입 변이는 stored 가 거의 0 이라 이 하한에서 바로 실패한다(F-237 ⑧, 시간 단언 아님).
// SLACK 은 처음 몇 연산의 고정 비용과 같은 값을 쓴다(하한은 ops * 0.5 - SLACK).
const STORED_MIN_PER_OP = 0.5;
// 측정 구간: 시험 쪽 비교 계수기와 저장소 Proxy 를 넣은 스케줄러를 만들고 body(s, check) 를 관측 아래에서 돌린다.
// check(ops) 는 지금까지의 누계가 ops * 연산당 상한 + SLACK 을 넘으면 바로 실패한다(상한 = 연산당 상수 * log2 n).
// maxOps 는 body 가 마지막으로 check 할 ops 다. 계수기는 maxOps 기준 전체 상한을 넘는 순간 던진다(check 사이의 동기 구간 보호).
// check 는 YIELD_EVERY 번째마다 양보 Promise 를 돌려주므로 body 는 await check(...) 로 부른다.
// signal(시험의 t.signal)이 aborted 면 check 가 던져 측정 루프를 끊는다(F-233 ①). node:test 의 timeout 은 실패 표시만 하고
// 루프를 멈추지 않으므로 이것이 없으면 timed out 뒤에도 프로세스가 계속 돈다. 중단용일 뿐 판정 기준이 아니다.
async function measured(opts, body, bounds, maxOps, signal) {
  const cap = (k) => maxOps * bounds[k] + SLACK;
  const cmp = { n: 0 };
  const c = observe();
  c.cap = { moved: cap('moved'), touched: cap('touched'), stored: cap('stored') };
  const cmpCap = cap('compares');
  const s = createScheduler({
    ...opts,
    compare: (a, b) => {
      if (c.on && ++cmp.n > cmpCap) throw new Error(`비교 상한 초과: ${cmp.n}/${cmpCap}`);
      return before(a, b);
    },
    wrapArray: c.wrap,
  });
  let out;
  let calls = 0;
  try {
    out = await body(s, (ops) => {
      if (signal?.aborted) {
        c.restore();
        throw new Error(`측정 중단(ops=${ops}): ${signal.reason?.message ?? signal.reason}`);
      }
      if (c.stored < ops * STORED_MIN_PER_OP - SLACK) {
        const snap = { stored: c.stored };
        c.restore();
        assert.fail(`ops=${ops}: stored ${snap.stored} (>= ${ops} * ${STORED_MIN_PER_OP} - ${SLACK}) - 내부 배열이 wrapArray 를 거치지 않는다`);
      }
      if (c.moved > ops * bounds.moved + SLACK || c.touched > ops * bounds.touched + SLACK || c.stored > ops * bounds.stored + SLACK || cmp.n > ops * bounds.compares + SLACK) {
        const snap = { moved: c.moved, touched: c.touched, stored: c.stored, compares: cmp.n };
        c.restore();
        assert.fail(`ops=${ops}: moved ${snap.moved} (<= ${ops} * ${bounds.moved} + ${SLACK}), touched ${snap.touched} (<= ${ops} * ${bounds.touched} + ${SLACK}), stored ${snap.stored} (<= ${ops} * ${bounds.stored.toFixed(1)} + ${SLACK}), compares ${snap.compares} (<= ${ops} * ${bounds.compares.toFixed(1)} + ${SLACK})`);
      }
      if (++calls % YIELD_EVERY !== 0) return undefined;
      c.on = false; // 양보하는 동안 시험 실행기가 쓰는 배열·Map 은 세지 않는다
      return new Promise((resolve) => setImmediate(() => { c.on = true; resolve(); }));
    });
  } finally {
    c.restore();
  }
  return { s, out, moved: c.moved, touched: c.touched, stored: c.stored, compares: cmp.n };
}

// 연산당 상한. 힙은 연산당 비교 <= 2 log2 n(siftDown 은 층당 2번), 옮김은 0 이어야 한다(앞쪽 삽입·삭제 없음).
// touched 는 keyId 의 KEY_FIELDS 6 칸 + push 몇 칸 + 일괄 정리(amortized) 같은 상수다. log2 n 의 상수배로 둔다.
// stored 는 siftUp/siftDown 이 층마다 한 번 대입하므로 연산당 log2 n + 몇 칸이다. 2 log2 n 으로 둔다.
const boundsFor = (n) => ({ compares: 2 * log2(n), moved: 2, touched: 2 * log2(n), stored: 2 * log2(n) });
const ASC_N = 100000;
const GROUP_N = 20000;

// 같은 n 의 오름차순 측정은 결정적이라 한 번만 돌리고 결과를 나눠 쓴다(F-233 ③: F-208 이 100k 측정을 다시 돌지 않게).
// 처음 부른 시험의 signal 로 돈다. 그 측정이 실패·중단되면 나중에 부른 시험도 같은 오류로 실패한다.
const ascMemo = new Map();
function ascendingObserved(n, signal) {
  if (!ascMemo.has(n)) {
    ascMemo.set(n, measured({ budgetBytesPerTick: 1e9, maxPending: Math.max(n, 100000) }, async (s, check) => {
      for (let i = 0; i < n; i++) {
        if (!s.enqueue({ key: perfKey(i), bytes: 1, priority: i, level: 0 })) throw new Error('rejected');
        await check(i + 1);
      }
    }, boundsFor(n), n, signal));
  }
  return ascMemo.get(n);
}
function oneGroupObserved(n, signal) {
  return measured({ budgetBytesPerTick: 1e9 }, async (s, check) => {
    for (let i = 0; i < n; i++) {
      if (!s.enqueue({ key: perfKey(1, { chunkIndex: i }), bytes: 1, priority: i % 7, level: 0 })) throw new Error('rejected');
      await check(i + 1);
    }
  }, boundsFor(n), n, signal);
}

test('F-221 시험 쪽 관측: 100k 오름차순 enqueue 에서 splice/shift/unshift/copyWithin 로 옮긴 원소 수 연산당 <= 2, 배열·Map·Set 이 다룬 원소 수와 주입 비교 횟수 연산당 <= 2 log2 n, 저장소 인덱스 대입 연산당 <= 2 log2 n', { timeout: PERF_TIMEOUT_MS }, async (t) => {
  const r = await ascendingObserved(ASC_N, t.signal);
  console.log(`# asc ${ASC_N}: moved=${r.moved} touched=${r.touched} (${(r.touched / ASC_N).toFixed(2)}/op) stored=${r.stored} (${(r.stored / ASC_N).toFixed(2)}/op) compares=${r.compares} (${(r.compares / ASC_N).toFixed(2)}/op, log2 n=${log2(ASC_N).toFixed(1)})`);
  const b = boundsFor(ASC_N);
  assert.ok(r.moved <= b.moved * ASC_N, `moved ${r.moved}`);
  assert.ok(r.touched <= b.touched * ASC_N, `touched ${r.touched}`);
  assert.ok(r.compares <= b.compares * ASC_N, `compares ${r.compares}`);
  assert.ok(r.stored <= b.stored * ASC_N, `stored ${r.stored}`);
  assert.equal(r.s.pending().length, ASC_N);
});

test('F-221 시험 쪽 관측: 100k 오름차순 enqueue 뒤 nextBatch 한 번으로 비우기 - enqueue+pop 2n 연산에 옮긴 원소 수 연산당 <= 2, 다룬 원소·주입 비교 연산당 <= 2 log2 n, 순서는 priority 내림차순', { timeout: PERF_TIMEOUT_MS }, async (t) => {
  const b = boundsFor(ASC_N);
  const r = await measured({ budgetBytesPerTick: 1e9, maxPending: ASC_N }, async (s, check) => {
    for (let i = 0; i < ASC_N; i++) {
      if (!s.enqueue({ key: perfKey(i), bytes: 1, priority: i, level: 0 })) throw new Error('rejected');
      await check(i + 1);
    }
    const batch = s.nextBatch();
    await check(2 * ASC_N);
    return batch;
  }, b, 2 * ASC_N, t.signal);
  console.log(`# asc+drain ${ASC_N}: moved=${r.moved} touched=${r.touched} stored=${r.stored} compares=${r.compares} (${(r.compares / (2 * ASC_N)).toFixed(2)}/op)`);
  const batch = r.out;
  assert.equal(batch.length, ASC_N);
  assert.equal(batch[0].priority, ASC_N - 1);
  assert.equal(batch[ASC_N - 1].priority, 0);
  for (let i = 1; i < batch.length; i++) assert.ok(batch[i - 1].priority > batch[i].priority);
});

test('F-221 시험 쪽 관측: 한 묶음 20000 개 enqueue 와 nextBatch 비우기 - 옮긴 원소 수 연산당 <= 2, 배열·Map·Set 이 다룬 원소 수와 주입 비교 횟수 연산당 <= 2 log2 n, 저장소 인덱스 대입 연산당 <= 2 log2 n', { timeout: PERF_TIMEOUT_MS }, async (t) => {
  const b = boundsFor(GROUP_N);
  const r = await measured({ budgetBytesPerTick: 1e9 }, async (s, check) => {
    for (let i = 0; i < GROUP_N; i++) {
      if (!s.enqueue({ key: perfKey(1, { chunkIndex: i }), bytes: 1, priority: i % 7, level: 0 })) throw new Error('rejected');
      await check(i + 1);
    }
    const batch = s.nextBatch();
    await check(2 * GROUP_N);
    return batch;
  }, b, 2 * GROUP_N, t.signal);
  console.log(`# group ${GROUP_N}: moved=${r.moved} touched=${r.touched} (${(r.touched / GROUP_N).toFixed(2)}/enqueue) stored=${r.stored} compares=${r.compares} (${(r.compares / GROUP_N).toFixed(2)}/enqueue)`);
  assert.equal(r.out.length, GROUP_N);
  // 순서: priority 내림, 같은 priority 안에서는 들어온 순서(chunkIndex 오름)
  for (let i = 1; i < r.out.length; i++) {
    const a = r.out[i - 1], c = r.out[i];
    assert.ok(a.priority > c.priority || (a.priority === c.priority && a.key.chunkIndex < c.key.chunkIndex), `order at ${i}`);
  }
});

test('F-221 주입 비교가 순서를 정한다: compare 를 seq 내림(LIFO)으로 주면 nextBatch·pending 이 그 순서를 따른다(비교 계수가 우회되지 않음)', () => {
  let calls = 0;
  const s = createScheduler({ budgetBytesPerTick: 1e9, compare: (a, b) => { calls++; return b.seq - a.seq; } });
  for (let i = 0; i < 64; i++) s.enqueue(I(K(i, 0), 1, i % 5));
  const expected = Array.from({ length: 64 }, (_, i) => 63 - i);
  assert.deepEqual(s.pending().map((p) => p.key.segmentId), expected);
  assert.deepEqual(s.nextBatch().map((p) => p.key.segmentId), expected);
  assert.ok(calls > 0);
  assert.throws(() => createScheduler({ budgetBytesPerTick: 1, compare: 1 }), TypeError);
  assert.throws(() => createScheduler({ budgetBytesPerTick: 1, wrapArray: 1 }), TypeError);
});

test('F-221 관측기 자체 검사: splice 앞쪽 삽입·shift 는 옮긴 칸으로, Map 반복은 다룬 칸으로, 저장소 인덱스 대입 루프는 stored 로 세고 끝나면 프로토타입을 되돌린다', () => {
  const origSplice = Array.prototype.splice;
  const origMapIter = Map.prototype[Symbol.iterator];
  const c = observe();
  let h;
  try {
    const a = [1, 2, 3, 4];
    a.splice(0, 0, 0); // 4 칸 밀림 + 1 칸 넣음
    a.shift(); // 5 칸
    const m = new Map([[1, 1], [2, 2], [3, 3]]);
    for (const _ of m) void _; // 3 칸
    h = c.wrap([1, 2, 3, 4, 5]);
    for (let j = h.length; j > 0; j--) h[j] = h[j - 1]; // 메서드 없이 한 칸씩 밀기: 인덱스 대입 5 번
    h[0] = 0; // 1 번
    h.length = 3; // length 는 인덱스가 아니라 세지 않는다
  } finally {
    c.restore();
  }
  assert.equal(c.moved, 10);
  assert.ok(c.touched >= 13);
  assert.equal(c.stored, 6);
  assert.deepEqual([...h], [0, 1, 2]);
  // 이미 채워진 배열을 감싸면 그 길이를 touched 로 센다(F-233 ②)
  const e = observe();
  let wrapped;
  try {
    const filled = [];
    filled.length = 7;
    const t0 = e.touched;
    e.wrap(filled);
    wrapped = e.touched - t0;
  } finally {
    e.restore();
  }
  assert.equal(wrapped, 7);
  // 전체 상한을 넘는 순간 그 자리에서 던진다(동기 구간 안의 O(n^2) 를 끝까지 돌리지 않는다)
  const d = observe();
  let i = 0;
  let err = null;
  try {
    d.cap.stored = 10;
    const g = d.wrap([]);
    for (; i < 1e9; i++) g[i] = i;
  } catch (e) {
    err = e;
  } finally {
    d.restore(); // 단언(assert 내부도 배열을 쓴다)은 관측을 끈 뒤에
  }
  assert.match(String(err?.message), /관측 상한 초과/);
  assert.equal(i, 10);
  assert.equal(Array.prototype.splice, origSplice);
  assert.equal(Map.prototype[Symbol.iterator], origMapIter);
});

test('F-208 2배 크기 증가율(시험 쪽 관측): 다룬 원소 수·저장소 인덱스 대입·주입 비교 횟수 합이 n 2배에서 2.3배 이하', { timeout: PERF_TIMEOUT_MS }, async (t) => {
  const a1 = await ascendingObserved(ASC_N / 2, t.signal), a2 = await ascendingObserved(ASC_N, t.signal); // a2 는 위 100k 시험의 측정을 재사용
  const g1 = await oneGroupObserved(GROUP_N / 2, t.signal), g2 = await oneGroupObserved(GROUP_N, t.signal);
  const w = (r) => r.touched + r.stored + r.compares;
  console.log(`# growth asc ${(w(a2) / w(a1)).toFixed(3)} group ${(w(g2) / w(g1)).toFixed(3)}`);
  assert.ok(w(a2) / w(a1) <= 2.3, `asc ratio ${w(a2) / w(a1)}`);
  assert.ok(w(g2) / w(g1) <= 2.3, `group ratio ${w(g2) / w(g1)}`);
});

// F-213: 상한에 닿은 뒤 교체가 계속돼도 한 번당 비용이 상한 크기에 비례하지 않아야 한다.
// 교체 한 번 = 힙 push 1 + 루트 비우기 + LRU 큐 push 2 + 축출 머리 지우기 1 + 일괄 잘라 내기(amortized) 정도의 상수 대입이다.
const STORED_PER_REPLACEMENT = 12;
test('F-213 시험 쪽 관측: maxSentGroups 65536 에서 교체 25만 회의 옮긴 원소 수 0·다룬 원소 수 회당 <= 24(상수), 주입 비교 회당 <= 4, 저장소 인덱스 대입 회당 <= STORED_PER_REPLACEMENT(상수)', { timeout: PERF_TIMEOUT_MS }, async (ctx) => {
  const N = 250000;
  const r = await measured({ budgetBytesPerTick: 1e9, maxSentGroups: 65536 }, async (s, check) => {
    for (let i = 0; i < N; i++) {
      s.enqueue({ key: perfKey(i), bytes: 1, priority: 0, level: 0 });
      s.nextBatch();
      await check(i + 1);
    }
  }, { moved: 0, touched: 24, compares: 4, stored: STORED_PER_REPLACEMENT }, N, ctx.signal);
  console.log(`# replacements ${N}: moved=${r.moved} touched=${r.touched} (${(r.touched / N).toFixed(2)}/op) stored=${r.stored} (${(r.stored / N).toFixed(2)}/op) compares=${r.compares}`);
  // 기억 묶음 수가 상한을 넘지 않는다: 가장 오래된 묶음부터 버려져 낮은 level 이 다시 들어올 수 있다
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
