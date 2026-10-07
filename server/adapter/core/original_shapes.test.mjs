// T11.8L: skylens 원본 코어(NET-Challenge-S13/skylens, 커밋 0122bd4)의 이벤트 모양과 이 어댑터의 가정 대조.
//
// 픽스처는 원본 타입 정의를 손으로 그대로 옮긴 것이다(우리 코드를 돌려 얻은 값이 아니다). 줄 번호는 모두 0122bd4 기준.
//   Envelope        src/shared/protocol.ts:34-43   {seq, originTs(unix ms), from, payload}
//   SplatChunk      src/shared/protocol.ts:172-188 {kind:'splat-chunk', id, segment, level, steps, label, final, url, bytes, align}
//   SplatAlign      src/shared/protocol.ts:164-170 {anchor: Gps|null, position[3], rotation[4](쿼터니언), scale[3]}
//   SegmentStatus   src/shared/protocol.ts:211-219 {index, level(0 = 대기·처리 중), levels, steps, label}
//   ServerStatus    src/shared/protocol.ts:252-261 {kind:'server-status', ..., segments: SegmentStatus[]}
//   chunk 생성      src/skylens_core/server/orchestrator.ts:336-345 (id `seg${segment}-l${level}`, final = level >= top)
//   수준 번호       src/skylens_core/server/ladder.ts:8-9, 41-43 (1부터 세는 사다리 칸 번호, 스텝 수가 아니다)
//   송출            src/skylens_core/server/index.ts:80 (onChunk → distributor.broadcast), distributor.ts:185-194 (Envelope 로 감쌈)
//   늦은 뷰어 재생  src/skylens_core/server/index.ts:133-148, store.ts:200-207 (구간마다 최신 chunk 하나, 구간 오름차순)
//   받는 쪽 규칙    src/skylens_client/statusview/splatScene.ts:152-172 (구간마다 최고 수준만, 높은 수준이 교체)
//                   src/skylens_client/server/boards.ts:145-150 (재생 캐시: level >= 이전 이면 갈아끼움)
//
// 원본은 우리 어댑터 입력(segment_expected / level_arrived + 조각 bytes)을 내보내지 않는다. 원본 코어가 뷰어에 미는 재구성
// 이벤트는 splat-chunk 하나뿐이고, 조각 bytes 대신 url(PLY 파일 하나)과 bytes(파일 크기, 바이트 수)를 싣는다. 그래서
// 아래 bridge 는 "원본 → 어댑터 입력" 변환의 가정을 시험 안에만 적어 둔 것이다(구현물이 아니다, index.mjs 는 고치지 않았다).
//   splat-chunk  → level_arrived. 수준은 칸 번호가 아니라 steps 로 LEVEL_STEPS 색인을 찾는다(사다리가 바뀌어도 의미가 같도록).
//                  조각은 시험용 자리표시 한 개(원본은 url 의 PLY 를 받아 .skla 조각으로 잘라야 한다 — 미구현, 아래 todo).
//   server-status.segments[i].level === 0 → segment_expected(원본에는 "구간이 올 예정" 전용 이벤트가 없다).
// 일치하는 의미(상태 규칙)는 test 로, 불일치는 test.todo 로 적는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreAdapter } from './index.mjs';
import { createLevelMachine } from '../../levels/state/index.mjs';
import { LEVEL_STEPS, FINAL_LEVEL, NONE } from '../../../contracts/levels/index.mjs';

// ── 원본 모양 픽스처 ─────────────────────────────────────────────────
// protocol.ts:390-395 IDENTITY_ALIGN 과 같은 모양(anchor 는 Gps|null).
const ALIGN = Object.freeze({ anchor: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

// ladder.ts:22-29 MEASURED_LABEL(표 8) 문구.
const LABEL = new Map([[250, '형상 윤곽 식별'], [1000, '골격 배치'], [3500, '표면 형성'], [7000, '실용 품질']]);

/**
 * 원본 SplatChunk(protocol.ts:172-188). ladderSteps 는 코어 설정 SKYLENS_CORE_LEVEL_STEPS(config.ts:97-101) 를 흉내 낸다.
 * level 은 1부터 세는 칸 번호(ladder.ts:42), final 은 level >= top(orchestrator.ts:343, top = ladder.length, ladder.ts:49-51).
 */
function splatChunk(ladderSteps, segment, level, kib) {
  const steps = ladderSteps[level - 1];
  return {
    kind: 'splat-chunk',
    id: `seg${segment}-l${level}`,
    segment,
    level,
    steps,
    label: LABEL.get(steps) ?? '개략 형상',
    final: level >= ladderSteps.length,
    url: `seg${segment}-l${level}.ply`, // 모델 API 가 돌려주는 주소 자리(값 자체는 시험과 무관)
    bytes: kib * 1024,
    align: { ...ALIGN },
  };
}

/** distributor.ts:185-194 가 감싸는 Envelope. */
function envelope(seq, payload) {
  return { seq, originTs: 1_700_000_000_000 + seq, from: 'core', payload };
}

/** ServerStatus(protocol.ts:252-261), segments 는 store.ts:209-219 와 같은 모양. */
function serverStatus(levels, segs) {
  return {
    kind: 'server-status', connected: true, receiving: true, chunks: 0, detections: 0, lastSeq: 0, latencyMs: null,
    segments: segs.map(([index, level, steps, label]) => ({ index, level, levels, steps, label })),
  };
}

// ── 시험 전용 변환 가정(bridge) ──────────────────────────────────────
function bridgeChunk(chunk) {
  const level = LEVEL_STEPS.indexOf(chunk.steps);
  if (level < 0) throw new RangeError(`steps ${chunk.steps} 는 LEVEL_STEPS 에 없다`);
  const key = { segmentId: chunk.segment, level, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0 };
  return { kind: 'level_arrived', segmentId: chunk.segment, level, pieces: [{ key, bytes: new Uint8Array([level + 1]) }] };
}
function bridgeStatus(status) {
  return status.segments.filter((s) => s.level === 0).map((s) => ({ kind: 'segment_expected', segmentId: s.index }));
}

function rig() {
  const machine = createLevelMachine();
  const out = [];
  const adapter = createCoreAdapter({ levelMachine: machine, emit: (m) => out.push(m) });
  return { machine, out, adapter };
}

/**
 * 원본 받는 쪽 규칙(splatScene.ts:152-172)을 그대로 옮긴 기대 상태: 구간마다 처음 온 chunk 를 기록하고, 더 높은 level 만
 * 올리며, final 은 한 번 참이면 참. 우리 어댑터 상태와 비교할 "원본 의미" 쪽 값이다.
 */
function originalBoardState(chunks) {
  const by = new Map();
  for (const c of chunks) {
    const prev = by.get(c.segment);
    if (prev) {
      if (c.level > prev.level) prev.level = c.level;
      prev.final = prev.final || c.final;
      continue;
    }
    by.set(c.segment, { level: c.level, final: c.final });
  }
  return by;
}

const LADDER4 = [250, 1000, 3500, 7000]; // SKYLENS_CORE_LEVEL_STEPS=250,1000,3500,7000 로 띄운 코어

test('원본 사다리가 LEVEL_STEPS 와 같으면(4칸) 칸 번호 L 은 우리 색인 L-1 이고 steps 매핑과 일치한다', () => {
  // ladder.ts:41-43 buildLadder: level = i + 1.
  for (let L = 1; L <= LADDER4.length; L++) {
    const c = splatChunk(LADDER4, 0, L, 1);
    assert.equal(bridgeChunk(c).level, L - 1);
  }
  assert.deepEqual([...LEVEL_STEPS], LADDER4);
});

test('README §4.3 실측 순서(구간 2 정제 중 구간 3 수준 1)를 원본 의미대로 소비한다', () => {
  // README.md §4.3 의 관측 순서를 4칸 사다리로 늘렸다: s2 L1, s2 L2, s3 L1, s2 L3, s2 L4(final).
  const seq = [
    splatChunk(LADDER4, 2, 1, 125), splatChunk(LADDER4, 2, 2, 339), splatChunk(LADDER4, 3, 1, 170),
    splatChunk(LADDER4, 2, 3, 3362), splatChunk(LADDER4, 2, 4, 9000),
  ];
  const { machine, out, adapter } = rig();
  const actions = seq.map((c, i) => adapter.handle(bridgeChunk(envelope(i + 1, c).payload)).action);
  // 원본에서 새 구간의 첫 chunk 는 그대로 놓이고, 높은 수준은 낮은 수준을 교체한다(protocol.ts:177, splatScene.ts:156-158).
  assert.deepEqual(actions, ['first', 'replace', 'first', 'replace', 'replace']);
  // 받아들인 chunk 하나마다 PIECE 1 + LEVEL_ARRIVED 1.
  assert.equal(out.length, seq.length * 2);
  const want = originalBoardState(seq);
  for (const [segment, s] of want) {
    const snap = machine.snapshot(segment);
    assert.equal(snap.level, s.level - 1, `구간 ${segment} 수준`);
    assert.equal(snap.final, s.final, `구간 ${segment} final`);
  }
  assert.equal(want.get(2).final, true);
  assert.equal(want.get(3).final, false);
});

test('늦게 붙은 뷰어 재생(구간마다 최신 chunk 하나, 구간 오름차순)은 중간 수준 없이 바로 그 수준으로 놓인다', () => {
  // index.ts:133-148 onJoin → store.chunks()(store.ts:200-207): 구간 오름차순, 구간마다 마지막으로 놓인 chunk 하나.
  const replay = [splatChunk(LADDER4, 0, 4, 9000), splatChunk(LADDER4, 1, 3, 3000), splatChunk(LADDER4, 2, 1, 100)];
  const { machine, adapter } = rig();
  for (const c of replay) assert.equal(adapter.handle(bridgeChunk(c)).action, 'first');
  assert.deepEqual(machine.segments(), [0, 1, 2]);
  assert.deepEqual([0, 1, 2].map((s) => machine.snapshot(s).level), [3, 2, 0]);
  assert.equal(machine.snapshot(0).final, true);
});

test('같은 chunk 가 다시 와도(재연결 재생) 상태는 그대로다', () => {
  // boards.ts:145-150 은 같은 수준을 캐시에서 갈아끼우기만 하고, splatScene.ts:156 은 level > prev 일 때만 올린다.
  const c = splatChunk(LADDER4, 5, 2, 300);
  const { machine, out, adapter } = rig();
  adapter.handle(bridgeChunk(c));
  const before = out.length;
  const r = adapter.handle(bridgeChunk(c));
  assert.equal(r.action, 'skip');
  assert.equal(out.length, before);
  assert.equal(machine.snapshot(5).level, 1);
});

test('높은 수준 뒤에 늦게 온 낮은 수준은 상태를 내리지 않는다(R3 안전망과 받는 쪽 규칙)', () => {
  // orchestrator.ts:217-226 R3: 이미 더 높은 수준이 배달된 구간의 잡은 버린다. 받는 쪽(splatScene.ts:156)도 낮은 수준을 무시.
  const { machine, adapter } = rig();
  adapter.handle(bridgeChunk(splatChunk(LADDER4, 7, 3, 3000)));
  assert.equal(adapter.handle(bridgeChunk(splatChunk(LADDER4, 7, 1, 100))).action, 'skip');
  assert.equal(machine.snapshot(7).level, 2);
});

test('server-status 의 수준 0 구간은 "없음"(MISSING), 이미 배달된 구간은 MISSING 이 아니다', () => {
  // protocol.ts:214 "Highest level delivered; 0 = queued/processing", store.ts:155 deliveredLevel 시작값 0.
  const { machine, out, adapter } = rig();
  adapter.handle(bridgeChunk(splatChunk(LADDER4, 1, 1, 100)));
  out.length = 0;
  const st = serverStatus(4, [[0, 0, 0, '대기'], [1, 1, 250, '형상 윤곽 식별'], [2, 0, 0, '대기']]);
  for (const ev of bridgeStatus(st)) adapter.handle(ev);
  // 수준 1 이상인 구간 1 은 bridge 가 segment_expected 로 만들지 않는다. 만든다 해도 어댑터는 MISSING 을 내지 않는다.
  adapter.handle({ kind: 'segment_expected', segmentId: 1 });
  assert.deepEqual(out, [{ type: 'MISSING', segmentId: 0 }, { type: 'MISSING', segmentId: 2 }]);
  assert.equal(machine.snapshot(0).missing, true);
  assert.equal(machine.snapshot(1).level, 0);
});

test('원본 구간 번호(floor(호 길이 / 구간 길이), 0 이상 정수)는 어댑터 구간 범위 안이다', () => {
  // segmenter.ts:133-137 segmentIndexFor: 유한하지 않거나 음수면 0, 아니면 floor. 구간 0 도 정상 값.
  const { machine, adapter } = rig();
  assert.equal(adapter.handle(bridgeChunk(splatChunk(LADDER4, 0, 1, 1))).action, 'first');
  assert.equal(machine.snapshot(0).level, 0);
});

test('원본 모양을 변환 없이 넣으면 어댑터는 받지 않는다(변환 계층이 반드시 필요하다)', () => {
  const { out, adapter } = rig();
  const c = splatChunk(LADDER4, 0, 1, 1);
  assert.throws(() => adapter.handle(c), RangeError); // kind 'splat-chunk' 은 모르는 이벤트
  assert.throws(() => adapter.handle(envelope(1, c)), RangeError); // Envelope 에는 kind 가 없다
  assert.equal(out.length, 0);
});

// ── 불일치(고치지 않음, 보고) ─────────────────────────────────────────
test.todo('불일치: 원본 level 은 1부터 세는 사다리 칸 번호(ladder.ts:8-9), 우리는 0..3 LEVEL_STEPS 색인 — 변환 계층이 steps 로 매핑해야 한다');
test.todo('불일치: 원본 기본 사다리 1000,7000,30000(config.ts:97, 3칸) — 30000 은 LEVEL_STEPS 에 없고 칸 수도 다르다. 녹화는 SKYLENS_CORE_LEVEL_STEPS=250,1000,3500,7000 로');
test.todo('불일치: 원본 final 은 chunk 에 실린 값(level >= top, orchestrator.ts:343) — 우리는 level === FINAL_LEVEL(3) 고정. 3칸 사다리(README §4.3 250,1000,3500)의 L3 final 을 우리는 final 로 보지 않는다');
test.todo('불일치: 원본은 조각 bytes 가 아니라 url(PLY 파일 하나)+bytes(크기)를 보낸다(protocol.ts:185-186) — PLY 받기·.skla 조각 자르기·PieceKey(lod/chunkIndex/tile) 부여가 없다');
test.todo('불일치: 원본 align(GPS anchor, position, rotation 쿼터니언 xyzw, scale; protocol.ts:164-170)은 어댑터 이벤트에 자리가 없다(배치 정보 유실)');
test.todo('불일치: 원본에는 segment_expected 이벤트가 없다 — 구간은 드론이 들어갈 때 생기고(ingest.ts:247-256) server-status(주기 하트비트) segments 에 level 0 으로만 보인다');
test.todo('불일치: 원본 Envelope.seq(송신자 단조 증가)·originTs(ms)를 어댑터가 보지 않는다 — 빈칸·순서 검사는 변환 계층 몫');

// 위 상수가 실제로 이 파일의 가정과 맞는지(계약이 바뀌면 이 파일을 다시 봐야 한다).
test('대조 전제: 계약 상수', () => {
  assert.equal(FINAL_LEVEL, LADDER4.length - 1);
  assert.equal(NONE, -1);
});
