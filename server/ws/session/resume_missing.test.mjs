// 재전송 루프의 비용 시험(F-272). 벽시계 대신 결정적 횟수(loadPiece 호출 수·send 수)로 O(N+L) 을 고정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { replayAfterHello } from './resume.mjs';

const N = 60000;
// 가짜 저장소: PIECE N 개 사이사이에 LEVEL_ARRIVED(창 1개 = 조각 1개) 를 둔 계획을 돌려준다. 총 메시지 2N.
function fakeStore() {
  const plan = [];
  for (let i = 1; i <= N; i++) {
    plan.push({ type: 'PIECE', pieceSeq: i, key: { segmentId: i, level: 0, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0 } });
    plan.push({ type: 'LEVEL_ARRIVED', segmentId: i, level: 0, pieceCount: 1, firstPieceSeq: i });
  }
  return { open: () => ({ sessionId: 1, resumed: true, nextPieceSeq: N + 1, reason: null }), resendPlan: () => plan };
}
const encode = (m) => new Uint8Array([m.type === 'WELCOME' ? 0 : m.type === 'PIECE' ? 1 : 2]);

test('loadPiece 전부 성공: loadPiece N 회, send 1+2N 회(O(N+L))', () => {
  let loads = 0; let sends = 0;
  const r = replayAfterHello({ store: fakeStore(), hello: { sessionId: 1, lastPieceSeq: 0 }, send: () => { sends++; }, loadPiece: () => { loads++; return new Uint8Array(2); }, encode });
  assert.equal(loads, N);
  assert.equal(sends, 1 + 2 * N);
  assert.equal(r.replayed, 2 * N);
  assert.equal(r.replayedBytes, 2 * N);
  assert.equal(r.stoppedAt, null);
});

test('loadPiece 전부 null: 첫 조각에서 멈춘다 — loadPiece 1 회, send 는 WELCOME 뿐', () => {
  let loads = 0; let sends = 0;
  const r = replayAfterHello({ store: fakeStore(), hello: { sessionId: 1, lastPieceSeq: 0 }, send: () => { sends++; }, loadPiece: () => { loads++; return null; }, encode });
  assert.equal(loads, 1);
  assert.equal(sends, 1);
  assert.equal(r.replayed, 0);
  assert.equal(r.stoppedAt, 1);
});

test('중간에 하나 빠지면 그 앞까지만: loadPiece k 회, 보낸 수는 앞 메시지 수와 같다', () => {
  const k = 30000;
  let loads = 0; let sends = 0; let n = 0;
  const r = replayAfterHello({ store: fakeStore(), hello: { sessionId: 1, lastPieceSeq: 0 }, send: () => { sends++; }, loadPiece: () => (++n === k ? null : (loads++, new Uint8Array(1))), encode });
  assert.equal(n, k);
  assert.equal(loads, k - 1);
  assert.equal(r.stoppedAt, k);
  assert.equal(r.replayed, 2 * (k - 1));
  assert.equal(sends, 1 + 2 * (k - 1));
});

test('resendPlan 호출 횟수와 배열 접근 횟수 검사(O(N²) 변이 잡기): N=60000, resendPlan 1회, 색인 읽기 ≤ 2N+1', () => {
  const N = 60000;
  let resendPlanCalls = 0;
  let indexAccesses = 0;

  // 가짜 저장소: plan 배열에 Proxy 를 씌워서 색인 접근을 센다
  function fakeStoreWithTracking() {
    const plan = [];
    for (let i = 1; i <= N; i++) {
      plan.push({ type: 'PIECE', pieceSeq: i, key: { segmentId: i, level: 0, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0 } });
      plan.push({ type: 'LEVEL_ARRIVED', segmentId: i, level: 0, pieceCount: 1, firstPieceSeq: i });
    }

    // plan 배열을 Proxy 로 감싸서 색인 접근을 센다
    const planProxy = new Proxy(plan, {
      get(target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          indexAccesses++;
        }
        return Reflect.get(target, prop);
      }
    });

    return {
      open: () => ({ sessionId: 1, resumed: true, nextPieceSeq: N + 1, reason: null }),
      resendPlan: () => {
        resendPlanCalls++;
        return planProxy;
      }
    };
  }

  let sends = 0;
  const r = replayAfterHello({
    store: fakeStoreWithTracking(),
    hello: { sessionId: 1, lastPieceSeq: 0 },
    send: () => { sends++; },
    loadPiece: () => new Uint8Array(2),
    encode
  });

  // resendPlan 은 정확히 한 번 호출되어야 한다
  assert.equal(resendPlanCalls, 1, `resendPlan 호출 횟수: ${resendPlanCalls} (예상 1)`);

  // 색인 읽기는 O(N) 임. 루프에서 각 원소를 순회하면 대략 2N 번
  // (for...of 가 Symbol.iterator 와 next() 를 사용하는 경우) 또는
  // 직접 색인 접근시 0..2N-1 까지 접근하면 2N 번. 안전마진으로 2N+1 이하인지 검사
  const maxAccessesAllowed = 2 * N + 1;
  assert.ok(indexAccesses <= maxAccessesAllowed, `색인 접근 횟수: ${indexAccesses} (최대 ${maxAccessesAllowed}, O(N²) 아님)`);

  assert.equal(r.replayed, 2 * N);
});


// 시간 비율 시험(F-280 ④): 결정적 횟수 시험이 못 잡는 "복사 뒤 항목마다 재스캔" 류 O(N²) 변이를 잡는다.
// 작은 n 과 8n 의 replayAfterHello 시간 중앙값 비율: 선형 ≈ 8, O(N²) ≈ 64. 문턱 24.
// 작은 쪽 표본은 8번 돌린 시간의 1/8(잡음 완화), 큰 쪽은 1번. 동기 루프는 {timeout} 으로 끊기지 않으므로 n 을 작게 잡고,
// 큰 쪽이 작은 쪽 중앙값의 72배를 넘으면 즉시 실패한다.
test('시간 비율: 8n 의 재전송 시간 / n 의 재전송 시간 중앙값 < 24 (선형 ≈ 8, O(N²) ≈ 64)', () => {
  const SMALL = 600;
  const REPEATS = 11;
  const THRESHOLD = 24;
  const ABORT_RATIO = 72;
  const mkStore = (n) => {
    const plan = [];
    for (let i = 1; i <= n; i++) {
      plan.push({ type: 'PIECE', pieceSeq: i, key: { segmentId: i, level: 0, lod: 0, chunkIndex: 0, tileX: 0, tileY: 0 } });
      plan.push({ type: 'LEVEL_ARRIVED', segmentId: i, level: 0, pieceCount: 1, firstPieceSeq: i });
    }
    return { open: () => ({ sessionId: 1, resumed: true, nextPieceSeq: n + 1, reason: null }), resendPlan: () => plan };
  };
  const chunk = new Uint8Array(2);
  const timeIt = (store, times) => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < times; i++) {
      replayAfterHello({ store, hello: { sessionId: 1, lastPieceSeq: 0 }, send: () => {}, loadPiece: () => chunk, encode });
    }
    return Number(process.hrtime.bigint() - t0) / times;
  };
  const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  const small = mkStore(SMALL);
  const big = mkStore(SMALL * 8);
  const SMALL_TIMES = 8;
  let smallMed = Infinity;
  // 큰 쪽 한 번 재기. 72배를 넘으면 한 번 더 재서 둘 다 넘을 때만 즉시 실패한다(GC·스케줄링 튐은 봐준다. 동기 루프라 timeout 으로 못 끊는다).
  const timeBig = () => {
    const t = timeIt(big, 1);
    if (t <= smallMed * ABORT_RATIO) return t;
    const t2 = timeIt(big, 1);
    assert.ok(t2 <= smallMed * ABORT_RATIO, `큰 쪽 ${Math.round(t)}ns·${Math.round(t2)}ns 가 작은 쪽 중앙값 ${Math.round(smallMed)}ns 의 ${ABORT_RATIO}배 초과 — O(N²) 의심`);
    return t2;
  };
  const measure = () => {
    smallMed = median([timeIt(small, SMALL_TIMES), timeIt(small, SMALL_TIMES)]); // 예열 겸 초기 중앙값
    timeBig(); timeBig(); // 예열(변이가 있으면 여기서도 실패한다)
    const smalls = [];
    const bigs = [];
    for (let r = 0; r < REPEATS; r++) {
      smalls.push(timeIt(small, SMALL_TIMES));
      smallMed = median(smalls);
      bigs.push(timeBig());
    }
    return median(bigs) / median(smalls);
  };
  // 공유 장비의 잡음 대비: 첫 측정이 문턱을 넘으면 한 번 더 재고, 둘 다 넘을 때만 실패한다.
  const ratios = [measure()];
  if (ratios[0] >= THRESHOLD) ratios.push(measure());
  const ratio = Math.min(...ratios);
  assert.ok(ratio < THRESHOLD, `시간 비율 ${ratios.map((r) => r.toFixed(1)).join('·')} (문턱 ${THRESHOLD}; 선형 ≈ 8, O(N²) ≈ 64)`);
});
