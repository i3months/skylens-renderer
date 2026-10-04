// 송출 스케줄러(T11.4). 순수 로직: 전송·타이머·시계 모듈 없음. 시간은 이 모듈에 들어오지 않는다(틱은 호출자가 센다).
//   createScheduler({ budgetBytesPerTick, maxPending?, maxSentGroups? }) -> { enqueue(item), cancel(key), nextBatch(), pending() }
//   item = { key: PieceKey, bytes, priority, level }   (PieceKey 는 contracts/proto 의 16 B 키와 같은 필드)
// 규칙:
//   1. 순서: priority 큰 것 먼저, 같으면 level 높은 것 먼저, 같으면 들어온 순서.
//   2. nextBatch() 는 정렬된 큐 앞에서부터 담고, 합계 바이트가 budgetBytesPerTick 을 넘는 항목을 만나면 거기서 멈춘다
//      (뒤의 작은 항목이 앞지르지 않는다 = 우선순위 순서 유지). 단 배치가 비어 있는데 맨 앞 항목이 예산보다 크면
//      굶지 않도록 그 항목 하나만 단독 배치로 내보내고 batch.oversize = true 로 표시한다.
//   3. 같은 key(여섯 필드 모두 같음) 중복 enqueue 는 하나로 합친다. priority 큰 쪽을 유지하고 순번은 처음 들어온 것을 지킨다.
//   4. 교체 원칙: 같은 (segmentId, tileX, tileY, lod) 에서 더 높은 level 이 큐에 있으면 낮은 level 항목은 추월당한 것이므로
//      큐에서 버린다(이미 있던 것은 높은 수준이 들어오는 순간 버리고, 높은 수준이 있는 동안 들어오는 낮은 수준은 받지 않는다).
//      묶음은 contracts/proto 의 overtakeGroup(key) 로만 정한다. chunkIndex 는 묶음 기준이 아니다. 같은 level 끼리는 서로 버리지 않는다.
//   5. 배치에서 나간 항목은 큐에서 빠진다. 묶음별로 이미 나간 최고 level 을 기억하고(F-190), 그보다 낮은 level 의
//      enqueue 는 false 로 거절한다(같은 level 은 받는다). 나간 level 기억은 level 이 높아질 때만 갱신한다.
// 상한(F-192):
//   - maxPending(기본 100000): 큐에 새 항목을 더해 이 수를 넘기면 enqueue 는 false(기존 항목은 건드리지 않는다).
//     같은 key 병합은 항목 수가 늘지 않으므로 항상 받는다. 낮은 level 을 밀어내서 자리가 나는 경우는 그 자리를 센다.
//   - maxSentGroups(기본 65536): 나간 level 기억 맵의 묶음 수 상한. 넘으면 가장 오래 쓰이지 않은(LRU: 그 묶음에서 마지막으로
//     항목이 나간 순) 묶음의 기억부터 버린다. 버려진 묶음은 낮은 level 이 다시 들어올 수 있다(상한을 크게 잡아 완화).
//   - 대기열은 최소 힙이다(F-208): enqueue·nextBatch 는 O(log n), 삭제·우선순위 상승은 lazy(dead 표시 후 루트에서 버림, 많이 쌓이면 일괄 정리).
//     순서는 전체 정렬과 같다: before() 는 seq 로 전순서. 묶음별로 최고 level 과 level 별 항목 집합을 따로 세어 enqueue 가 묶음 크기에 비례하지 않는다.

import { assertLevel } from '../../contracts/levels/index.mjs';
import { overtakeGroup } from '../../contracts/proto/index.mjs';

const KEY_FIELDS = ['segmentId', 'level', 'lod', 'chunkIndex', 'tileX', 'tileY'];

function keyId(key) {
  if (key === null || typeof key !== 'object') throw new TypeError('key 는 PieceKey 객체여야 한다');
  for (const f of KEY_FIELDS) {
    if (!Number.isInteger(key[f])) throw new TypeError(`key.${f} 는 정수여야 한다: ${key[f]}`);
  }
  return `${key.segmentId}:${key.level}:${key.lod}:${key.chunkIndex}:${key.tileX}:${key.tileY}`;
}

function before(a, b) {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.level !== b.level) return b.level - a.level;
  return a.seq - b.seq;
}

export function createScheduler(options = {}) {
  const budget = options.budgetBytesPerTick;
  if (!Number.isFinite(budget) || budget <= 0) throw new RangeError(`budgetBytesPerTick 는 0 보다 큰 유한수여야 한다: ${budget}`);

  const maxPending = options.maxPending ?? 100000;
  const maxSentGroups = options.maxSentGroups ?? 65536;
  if (!Number.isInteger(maxPending) || maxPending < 1) throw new RangeError(`maxPending 은 1 이상 정수여야 한다: ${maxPending}`);
  if (!Number.isInteger(maxSentGroups) || maxSentGroups < 1) throw new RangeError(`maxSentGroups 는 1 이상 정수여야 한다: ${maxSentGroups}`);

  const sentLevel = new Map(); // group -> 나간 최고 level (삽입 순서 = LRU 순서)
  const byKey = new Map(); // keyId -> 살아 있는 entry
  const groups = new Map(); // groupId -> { maxLevel, levels: Map<level, Set<entry>> } (묶음별 최고 level·level별 항목)
  let seq = 0;
  // 최소 힙(before() 기준 맨 앞이 루트). 삭제는 dead 표시만 하고(lazy) 루트에 올라올 때 버린다. dead 가 많이 쌓이면 한 번에 정리한다.
  let heap = [];

  function remember(group, level) {
    const prev = sentLevel.get(group);
    if (prev !== undefined) sentLevel.delete(group); // 다시 넣어 가장 최근으로 옮긴다
    sentLevel.set(group, prev !== undefined && prev > level ? prev : level);
    if (sentLevel.size > maxSentGroups) sentLevel.delete(sentLevel.keys().next().value); // 가장 오래된 묶음 축출
  }

  function siftUp(i) {
    const e = heap[i];
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (before(e, heap[parent]) >= 0) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = e;
  }

  function siftDown(i) {
    const n = heap.length;
    const e = heap[i];
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && before(heap[c + 1], heap[c]) < 0) c++;
      if (before(heap[c], e) >= 0) break;
      heap[i] = heap[c];
      i = c;
    }
    heap[i] = e;
  }

  function heapPush(entry) {
    heap.push(entry);
    siftUp(heap.length - 1);
  }

  function heapPop() {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      siftDown(0);
    }
    return top;
  }

  function dropDeadTop() {
    while (heap.length > 0 && heap[0].dead) heapPop();
  }

  function compact() {
    if (heap.length <= 2 * byKey.size + 32) return;
    heap = heap.filter((e) => !e.dead);
    for (let i = (heap.length >>> 1) - 1; i >= 0; i--) siftDown(i);
  }

  // 묶음 = { maxLevel, bucket } (bucket 은 level 별 연결 리스트: { level, count, head, nextBucket }). 같은 level 항목은
  // 이중 연결 리스트(entry.prev/next)로 이어 추가·삭제가 O(1) 이고, 비용은 묶음 크기와 무관하게 level 수(적다)에만 비례한다.
  function addToGroup(entry) {
    let g = groups.get(entry.group);
    if (!g) groups.set(entry.group, (g = { maxLevel: entry.level, bucket: null }));
    let b = g.bucket;
    while (b && b.level !== entry.level) b = b.nextBucket;
    if (!b) g.bucket = b = { level: entry.level, count: 0, head: null, nextBucket: g.bucket };
    entry.prev = null;
    entry.next = b.head;
    if (b.head) b.head.prev = entry;
    b.head = entry;
    b.count++;
    if (entry.level > g.maxLevel) g.maxLevel = entry.level;
  }

  function removeFromGroup(entry) {
    const g = groups.get(entry.group);
    let b = g.bucket;
    let before = null;
    while (b.level !== entry.level) {
      before = b;
      b = b.nextBucket;
    }
    if (entry.prev) entry.prev.next = entry.next;
    else b.head = entry.next;
    if (entry.next) entry.next.prev = entry.prev;
    entry.prev = entry.next = null;
    if (--b.count > 0) return;
    if (before) before.nextBucket = b.nextBucket;
    else g.bucket = b.nextBucket;
    if (g.bucket === null) {
      groups.delete(entry.group);
    } else if (entry.level === g.maxLevel) {
      let m = -Infinity;
      for (let x = g.bucket; x; x = x.nextBucket) if (x.level > m) m = x.level;
      g.maxLevel = m;
    }
  }

  function remove(entry) {
    byKey.delete(entry.id);
    removeFromGroup(entry);
    entry.dead = true;
  }

  function view(entry) {
    return { key: { ...entry.key }, bytes: entry.bytes, priority: entry.priority, level: entry.level };
  }

  return {
    enqueue(item) {
      if (item === null || typeof item !== 'object') throw new TypeError('item 은 객체여야 한다');
      const id = keyId(item.key);
      const { bytes, priority, level } = item;
      if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError(`bytes 는 0 이상 유한수여야 한다: ${bytes}`);
      if (!Number.isFinite(priority)) throw new RangeError(`priority 는 유한수여야 한다: ${priority}`);
      assertLevel(level);
      if (level !== item.key.level) throw new RangeError(`level(${level}) 이 key.level(${item.key.level}) 과 다르다`);

      const group = overtakeGroup(item.key);
      const sent = sentLevel.get(group);
      if (sent !== undefined && sent > level) return false; // 이미 더 높은 수준이 나갔다: 추월당한 항목은 받지 않는다
      const g = groups.get(group);
      let lower = 0;
      if (g) {
        if (g.maxLevel > level) return false; // 이미 더 높은 수준이 대기 중: 추월당한 항목은 받지 않는다
        for (let b = g.bucket; b; b = b.nextBucket) if (b.level < level) lower += b.count;
      }
      const existing = byKey.get(id);
      if (existing) {
        if (priority > existing.priority) {
          // 힙 안의 값은 바꿀 수 없으니 이전 항목은 죽이고 같은 순번의 새 항목을 넣는다
          remove(existing);
          const entry = { id, group, key: existing.key, bytes, priority, level, seq: existing.seq, dead: false, prev: null, next: null };
          byKey.set(id, entry);
          addToGroup(entry);
          heapPush(entry);
          compact();
        }
        return true;
      }
      if (byKey.size - lower >= maxPending) return false; // 큐 상한
      if (lower > 0) {
        const victims = [];
        for (let b = g.bucket; b; b = b.nextBucket) {
          if (b.level < level) for (let p = b.head; p; p = p.next) victims.push(p);
        }
        for (const p of victims) remove(p); // 새 수준이 낮은 수준을 추월
      }
      const entry = { id, group, key: { ...item.key }, bytes, priority, level, seq: seq++, dead: false, prev: null, next: null };
      byKey.set(id, entry);
      addToGroup(entry);
      heapPush(entry);
      compact();
      return true;
    },

    cancel(key) {
      const entry = byKey.get(keyId(key));
      if (!entry) return false;
      remove(entry);
      compact();
      return true;
    },

    nextBatch() {
      const batch = [];
      batch.oversize = false;
      let total = 0;
      for (;;) {
        dropDeadTop();
        if (heap.length === 0) break;
        const entry = heap[0];
        if (total + entry.bytes > budget) {
          if (batch.length === 0) batch.oversize = true; // 예산보다 큰 항목: 단독 배치
          else break;
        } else {
          total += entry.bytes;
        }
        heapPop();
        batch.push(view(entry));
        remember(entry.group, entry.level);
        byKey.delete(entry.id);
        removeFromGroup(entry);
        entry.dead = true;
        if (batch.oversize) break;
      }
      return batch;
    },

    pending() {
      return heap.filter((e) => !e.dead).sort(before).map(view);
    },
  };
}
