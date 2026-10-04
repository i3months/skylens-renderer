// scheduler 와 resume 이 같은 키 쌍 표에 같은 추월 판정을 내는지 고정한다(F-185).
// 판정 기준은 contracts/proto 의 overtakeGroup 하나다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from './index.mjs';
import { createSessionStore } from '../ws/resume/index.mjs';

const k = (segmentId, level, chunkIndex, tileX = 0, tileY = 0, lod = 0) => ({ segmentId, level, lod, chunkIndex, tileX, tileY });

// [먼저 나간 키, 나중 키, 나중 키가 나가도 되는가]
const TABLE = [
  [k(1, 3, 0), k(1, 1, 1), false],
  [k(1, 3, 0), k(1, 1, 0), false],
  [k(1, 3, 0), k(1, 3, 1), true],
  [k(1, 1, 0), k(1, 3, 1), true],
  [k(1, 3, 0), k(2, 1, 0), true],
  [k(1, 3, 0), k(1, 1, 0, 1, 0), true],
  [k(1, 3, 0), k(1, 1, 0, 0, 1), true],
  [k(1, 3, 0), k(1, 1, 0, 0, 0, 1), true],
];

test('scheduler·resume 이 같은 키 쌍 표에 같은 판정', () => {
  TABLE.forEach(([first, second, ok], n) => {
    const s = createScheduler({ budgetBytesPerTick: 1000 });
    assert.equal(s.enqueue({ key: first, bytes: 10, priority: 0, level: first.level }), true, `표 ${n} 첫 enqueue`);
    s.nextBatch();
    assert.equal(s.enqueue({ key: second, bytes: 10, priority: 0, level: second.level }), ok, `scheduler 표 ${n}`);

    const store = createSessionStore({ maxSessions: 4, ttlMs: 1000, now: () => 0 });
    const { sessionId } = store.open({ sessionId: 0, lastPieceSeq: 0 });
    store.recordSent(sessionId, first, 1, 10);
    assert.equal(store.shouldSend(sessionId, second), ok, `resume 표 ${n}`);
  });
});
