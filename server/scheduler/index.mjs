// 송출 스케줄러(T11.4). 순수 로직: 전송·타이머·시계 모듈 없음. 시간은 이 모듈에 들어오지 않는다(틱은 호출자가 센다).
//   createScheduler({ budgetBytesPerTick }) -> { enqueue(item), cancel(key), nextBatch(), pending() }
//   item = { key: PieceKey, bytes, priority, level }   (PieceKey 는 contracts/proto 의 16 B 키와 같은 필드)
// 규칙:
//   1. 순서: priority 큰 것 먼저, 같으면 level 높은 것 먼저, 같으면 들어온 순서.
//   2. nextBatch() 는 정렬된 큐 앞에서부터 담고, 합계 바이트가 budgetBytesPerTick 을 넘는 항목을 만나면 거기서 멈춘다
//      (뒤의 작은 항목이 앞지르지 않는다 = 우선순위 순서 유지). 단 배치가 비어 있는데 맨 앞 항목이 예산보다 크면
//      굶지 않도록 그 항목 하나만 단독 배치로 내보내고 batch.oversize = true 로 표시한다.
//   3. 같은 key(여섯 필드 모두 같음) 중복 enqueue 는 하나로 합친다. priority 큰 쪽을 유지하고 순번은 처음 들어온 것을 지킨다.
//   4. 교체 원칙: 같은 (segmentId, tileX, tileY, lod) 에서 더 높은 level 이 큐에 있으면 낮은 level 항목은 추월당한 것이므로
//      큐에서 버린다(이미 있던 것은 높은 수준이 들어오는 순간 버리고, 높은 수준이 있는 동안 들어오는 낮은 수준은 받지 않는다).
//      chunkIndex 는 묶음 기준이 아니다(계약 지시문 그대로). 같은 level 끼리는 서로 버리지 않는다.
//   5. 배치에서 나간 항목은 큐에서 빠진다. 이미 나간 수준은 기억하지 않는다(도착 쪽 level machine 이 skip 한다).

import { assertLevel } from '../../contracts/levels/index.mjs';

const KEY_FIELDS = ['segmentId', 'level', 'lod', 'chunkIndex', 'tileX', 'tileY'];

function keyId(key) {
  if (key === null || typeof key !== 'object') throw new TypeError('key 는 PieceKey 객체여야 한다');
  const parts = [];
  for (const f of KEY_FIELDS) {
    if (!Number.isInteger(key[f])) throw new TypeError(`key.${f} 는 정수여야 한다: ${key[f]}`);
    parts.push(key[f]);
  }
  return parts.join(':');
}

function groupId(key) {
  return `${key.segmentId}:${key.tileX}:${key.tileY}:${key.lod}`;
}

function before(a, b) {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.level !== b.level) return b.level - a.level;
  return a.seq - b.seq;
}

export function createScheduler(options = {}) {
  const budget = options.budgetBytesPerTick;
  if (!Number.isFinite(budget) || budget <= 0) throw new RangeError(`budgetBytesPerTick 는 0 보다 큰 유한수여야 한다: ${budget}`);

  const byKey = new Map(); // keyId -> entry
  const byGroup = new Map(); // groupId -> Set<entry>
  let seq = 0;
  let sorted = []; // 정렬된 entry 캐시
  let dirty = false;

  function remove(entry) {
    byKey.delete(entry.id);
    const set = byGroup.get(entry.group);
    if (set) {
      set.delete(entry);
      if (set.size === 0) byGroup.delete(entry.group);
    }
    dirty = true;
  }

  function view(entry) {
    return { key: { ...entry.key }, bytes: entry.bytes, priority: entry.priority, level: entry.level };
  }

  function ordered() {
    if (dirty) {
      sorted = [...byKey.values()].sort(before);
      dirty = false;
    }
    return sorted;
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

      const group = groupId(item.key);
      const peers = byGroup.get(group);
      if (peers) {
        for (const p of peers) {
          if (p.level > level) return false; // 이미 더 높은 수준이 대기 중: 추월당한 항목은 받지 않는다
        }
      }
      const existing = byKey.get(id);
      if (existing) {
        if (priority > existing.priority) {
          existing.priority = priority;
          existing.bytes = bytes;
          dirty = true;
        }
        return true;
      }
      if (peers) {
        for (const p of [...peers]) {
          if (p.level < level) remove(p); // 새 수준이 낮은 수준을 추월
        }
      }
      const entry = { id, group, key: { ...item.key }, bytes, priority, level, seq: seq++ };
      byKey.set(id, entry);
      let set = byGroup.get(group);
      if (!set) byGroup.set(group, (set = new Set()));
      set.add(entry);
      dirty = true;
      return true;
    },

    cancel(key) {
      const entry = byKey.get(keyId(key));
      if (!entry) return false;
      remove(entry);
      return true;
    },

    nextBatch() {
      const list = ordered();
      const batch = [];
      batch.oversize = false;
      let total = 0;
      let taken = 0;
      for (const entry of list) {
        if (total + entry.bytes > budget) {
          if (batch.length === 0) {
            batch.oversize = true; // 예산보다 큰 항목: 단독 배치
            batch.push(view(entry));
            taken = 1;
          }
          break;
        }
        total += entry.bytes;
        batch.push(view(entry));
        taken++;
      }
      for (let i = 0; i < taken; i++) remove(list[i]);
      return batch;
    },

    pending() {
      return ordered().map(view);
    },
  };
}
