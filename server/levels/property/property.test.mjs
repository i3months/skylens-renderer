// 수준 상태 기계 무작위 순서 속성 시험(T10.8).
// 고정 시드 PRNG 로 무작위 열을 만들어 서버 기계를 돌리고, 시험 안의 독립 오라클과 매 단계 비교한다.
// 오라클은 "구간별 도착 기록" 만 들고, 현재 수준·보관 조각을 그 기록에서 매번 새로 계산한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLevelMachine } from '../state/index.mjs';

const MASTER_SEED = 0x5eed1e7e;
const SEQUENCE_COUNT = 100_000;

// mulberry32: 32비트 상태의 작은 결정적 PRNG.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function sequenceSeed(index) {
  return (MASTER_SEED ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
}

// 한 열: 구간 1~8 개, 도착 1~40 개, 수준 0..3, expect 섞임, 조각 {count,id} 는 열 안에서 유일 id.
function makeSequence(seed) {
  const rng = mulberry32(seed);
  const segCount = randInt(rng, 1, 8);
  const segIds = [];
  const used = new Set();
  while (segIds.length < segCount) {
    const id = rng() < 0.5 ? randInt(rng, 0, 15) : randInt(rng, 0, 0xffffffff);
    if (!used.has(id)) { used.add(id); segIds.push(id); }
  }
  const arrivals = randInt(rng, 1, 40);
  const ops = [];
  let nextPieceId = 0;
  let made = 0;
  while (made < arrivals) {
    const segmentId = segIds[randInt(rng, 0, segCount - 1)];
    if (rng() < 0.2) {
      ops.push({ kind: 'expect', segmentId });
      continue;
    }
    const level = randInt(rng, 0, 3);
    const n = randInt(rng, 0, 3);
    const pieces = [];
    for (let k = 0; k < n; k++) pieces.push({ count: randInt(rng, 1, 1000), id: nextPieceId++ });
    ops.push({ kind: 'arrive', segmentId, level, pieces });
    made++;
  }
  return { seed, segIds, ops };
}

// 독립 오라클: 구간별 도착 기록만 보관한다.
function makeOracle() {
  const known = new Set();
  const arrived = new Map(); // segmentId -> [{level, pieces}]
  return {
    known,
    record(op) {
      known.add(op.segmentId);
      if (op.kind === 'arrive') {
        if (!arrived.has(op.segmentId)) arrived.set(op.segmentId, []);
        arrived.get(op.segmentId).push({ level: op.level, pieces: op.pieces });
      }
    },
    level(segmentId) {
      const list = arrived.get(segmentId) || [];
      let max = -1;
      for (const a of list) if (a.level > max) max = a.level;
      return max;
    },
    // 최고 수준에 처음 도착한 것이 그 수준에서 accepted 된 마지막(유일한) 도착이다.
    pieces(segmentId) {
      const max = this.level(segmentId);
      if (max === -1) return [];
      const list = arrived.get(segmentId);
      for (const a of list) if (a.level === max) return a.pieces;
      return [];
    },
  };
}

function idsOf(pieces) {
  return pieces.map((p) => p.id);
}

function sameIds(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function snapKey(s) {
  return `${s.segmentId}|${s.level}|${s.missing}|${s.final}|${idsOf(s.pieces).join(',')}`;
}

// 열 하나를 돌리며 매 단계 불변식을 검사한다. 위반이면 문자열, 아니면 null.
// trace 에는 결정성 비교용 결과를 쌓는다.
function runChecked(seq, trace) {
  const m = createLevelMachine();
  const oracle = makeOracle();
  const released = new Set();
  const pieceLevel = new Map(); // piece id -> 도착 수준
  const prevLevel = new Map();
  const probeIds = [...seq.segIds];

  let before = new Map();
  for (const id of probeIds) before.set(id, snapKey(m.snapshot(id)));

  for (let step = 0; step < seq.ops.length; step++) {
    const op = seq.ops[step];
    const at = `seed=${seq.seed} 단계=${step}`;
    const priorPieces = op.kind === 'arrive' ? oracle.pieces(op.segmentId) : null;
    const priorLevel = oracle.level(op.segmentId);
    let result = null;

    if (op.kind === 'expect') {
      m.expect(op.segmentId);
    } else {
      for (const p of op.pieces) pieceLevel.set(p.id, op.level);
      result = m.arrive(op.segmentId, op.level, op.pieces);
    }
    oracle.record(op);
    trace.push(result ? `${result.action}:${result.previousLevel}:${idsOf(result.released).join(',')}` : 'expect');

    if (result) {
      const expectAction = priorLevel === -1 ? 'first' : op.level > priorLevel ? 'replace' : 'skip';
      if (result.action !== expectAction) return `${at}: action ${result.action} ≠ 오라클 ${expectAction}`;
      if (result.previousLevel !== priorLevel) return `${at}: previousLevel ${result.previousLevel} ≠ ${priorLevel}`;
      if (result.accepted !== (expectAction !== 'skip')) return `${at}: accepted 불일치`;
      // (4) skip 이면 released 빈 배열
      if (expectAction === 'skip' && result.released.length !== 0) return `${at}: skip 인데 released ${result.released.length}개`;
      if (expectAction === 'first' && result.released.length !== 0) return `${at}: first 인데 released ${result.released.length}개`;
      if (expectAction === 'replace' && !sameIds(idsOf(result.released), idsOf(priorPieces))) {
        return `${at}: replace released [${idsOf(result.released)}] ≠ 이전 조각 [${idsOf(priorPieces)}]`;
      }
      for (const p of result.released) released.add(p.id);
    }

    const after = new Map();
    for (const id of probeIds) {
      const s = m.snapshot(id);
      after.set(id, snapKey(s));
      const lv = oracle.level(id);
      // (1) 단조 비감소
      const pl = prevLevel.has(id) ? prevLevel.get(id) : -1;
      if (s.level < pl) return `${at}: 구간 ${id} 수준 감소 ${pl}→${s.level}`;
      prevLevel.set(id, s.level);
      // (2) 현재 수준 = 도착 수준 최댓값
      if (s.level !== lv) return `${at}: 구간 ${id} 수준 ${s.level} ≠ 도착 최댓값 ${lv}`;
      // (6) final ⇔ 3, missing ⇔ -1
      if (s.final !== (s.level === 3)) return `${at}: 구간 ${id} final=${s.final} level=${s.level}`;
      if (s.missing !== (s.level === -1)) return `${at}: 구간 ${id} missing=${s.missing} level=${s.level}`;
      // (3) 보관 조각 = 현재 수준의 마지막 accepted 조각, 낮은 수준 조각 0개
      const want = oracle.pieces(id);
      if (!sameIds(idsOf(s.pieces), idsOf(want))) return `${at}: 구간 ${id} 조각 [${idsOf(s.pieces)}] ≠ 오라클 [${idsOf(want)}]`;
      for (const p of s.pieces) {
        if (pieceLevel.get(p.id) !== s.level) return `${at}: 구간 ${id} 에 수준 ${pieceLevel.get(p.id)} 조각 ${p.id} 남음(현재 ${s.level})`;
        // (5) released 조각은 이후 snapshot 에 없음
        if (released.has(p.id)) return `${at}: 구간 ${id} 에 해제된 조각 ${p.id} 가 다시 보임`;
      }
      let sum = 0;
      for (const p of want) sum += p.count;
      if (m.pointCount(id) !== sum) return `${at}: 구간 ${id} pointCount ${m.pointCount(id)} ≠ ${sum}`;
      // (8) 구간 간 독립 / (4) skip·expect 면 snapshot 불변
      const changedAllowed = result && result.action !== 'skip' && id === op.segmentId;
      if (!changedAllowed && after.get(id) !== before.get(id)) {
        return `${at}: 구간 ${id} snapshot 이 바뀜(${op.kind} 대상 ${op.segmentId}${result ? ' ' + result.action : ''})`;
      }
    }
    const segs = m.segments();
    const knownSorted = [...oracle.known].sort((a, b) => a - b);
    if (!sameIds(segs, knownSorted)) return `${at}: segments [${segs}] ≠ [${knownSorted}]`;
    trace.push([...after.values()].join(';'));
    before = after;
  }
  return null;
}

// 결과만 돌린다(결정성·순열 비교용).
function finalLevels(seq, ops) {
  const m = createLevelMachine();
  for (const op of ops) {
    if (op.kind === 'expect') m.expect(op.segmentId);
    else m.arrive(op.segmentId, op.level, op.pieces);
  }
  return seq.segIds.map((id) => m.snapshot(id).level).join(',');
}

function shuffled(ops, rng) {
  const out = ops.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function checkSequence(index) {
  const seed = sequenceSeed(index);
  const seq = makeSequence(seed);
  const t1 = [];
  const v = runChecked(seq, t1);
  if (v) return v;
  // (7) 결정성: 같은 열(다시 생성)을 다시 돌리면 결과 동일
  const t2 = [];
  const v2 = runChecked(makeSequence(seed), t2);
  if (v2) return `재실행 ${v2}`;
  if (t1.length !== t2.length || t1.some((x, i) => x !== t2[i])) return `seed=${seed}: 재실행 결과가 다름`;
  // (9) 도착 순열 불변: 순서를 섞어도 구간별 최종 수준 같음
  const base = finalLevels(seq, seq.ops);
  const rng = mulberry32(seed ^ 0xa5a5a5a5);
  for (let k = 0; k < 2; k++) {
    const other = finalLevels(seq, shuffled(seq.ops, rng));
    if (other !== base) return `seed=${seed}: 순서를 섞은 최종 수준 [${other}] ≠ [${base}]`;
  }
  return null;
}

test('무작위 열 10만 개: 매 단계 불변식·결정성·순열 불변 위반 0', () => {
  let violations = 0;
  let first = null;
  for (let i = 0; i < SEQUENCE_COUNT; i++) {
    const v = checkSequence(i);
    if (v) {
      violations++;
      if (!first) first = `열 인덱스=${i} ${v}`;
    }
  }
  assert.equal(violations, 0, `위반 ${violations}/${SEQUENCE_COUNT} 열. 첫 위반: ${first}`);
});

test('열 생성은 시드에 대해 결정적이고 범위를 지킨다', () => {
  for (let i = 0; i < 1000; i++) {
    const a = makeSequence(sequenceSeed(i));
    const b = makeSequence(sequenceSeed(i));
    assert.deepEqual(a, b);
    assert.ok(a.segIds.length >= 1 && a.segIds.length <= 8);
    const arr = a.ops.filter((o) => o.kind === 'arrive');
    assert.ok(arr.length >= 1 && arr.length <= 40);
    const ids = arr.flatMap((o) => o.pieces.map((p) => p.id));
    assert.equal(new Set(ids).size, ids.length);
    for (const o of arr) assert.ok(o.level >= 0 && o.level <= 3);
  }
});
