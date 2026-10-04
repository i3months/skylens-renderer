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
//   - 정렬은 큐가 바뀌어 순서가 흐트러졌을 때만 한다. nextBatch 가 앞에서 떼어내는 것은 순서를 깨지 않으므로 재정렬하지 않는다.

import { assertLevel } from '../../contracts/levels/index.mjs';
import { overtakeGroup } from '../../contracts/proto/index.mjs';

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
  const byKey = new Map(); // keyId -> entry
  const byGroup = new Map(); // groupId -> Set<entry>
  let seq = 0;
  let sorted = []; // 정렬된 entry 캐시
  let dirty = false;

  function remember(group, level) {
    const prev = sentLevel.get(group);
    if (prev !== undefined) sentLevel.delete(group); // 다시 넣어 가장 최근으로 옮긴다
    sentLevel.set(group, prev !== undefined && prev > level ? prev : level);
    if (sentLevel.size > maxSentGroups) sentLevel.delete(sentLevel.keys().next().value); // 가장 오래된 묶음 축출
  }

  function remove(entry, keepOrder = false) {
    byKey.delete(entry.id);
    const set = byGroup.get(entry.group);
    if (set) {
      set.delete(entry);
      if (set.size === 0) byGroup.delete(entry.group);
    }
    if (!keepOrder) dirty = true;
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

      const group = overtakeGroup(item.key);
      const sent = sentLevel.get(group);
      if (sent !== undefined && sent > level) return false; // 이미 더 높은 수준이 나갔다: 추월당한 항목은 받지 않는다
      const peers = byGroup.get(group);
      let lower = 0;
      if (peers) {
        for (const p of peers) {
          if (p.level > level) return false; // 이미 더 높은 수준이 대기 중: 추월당한 항목은 받지 않는다
          if (p.level < level) lower++;
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
      if (byKey.size - lower >= maxPending) return false; // 큐 상한
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
      // 앞에서 떼어내는 것은 나머지 순서를 깨지 않으므로 재정렬 표시 없이 캐시만 잘라낸다
      for (let i = 0; i < taken; i++) {
        remember(list[i].group, list[i].level);
        remove(list[i], true);
      }
      sorted = list.slice(taken);
      return batch;
    },

    pending() {
      return ordered().map(view);
    },
  };
}
