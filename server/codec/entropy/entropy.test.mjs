import test from 'node:test';
import assert from 'node:assert/strict';
import { entropyEncode, entropyDecode } from './index.mjs';
import { CodecError, ENTROPY_MODE, STREAM_RAW_BYTES_MAX } from '../../../contracts/codec/index.mjs';

const hex = (u) => Buffer.from(u).toString('hex');
const fromHex = (s) => new Uint8Array(Buffer.from(s, 'hex'));

/** 결정적 의사난수(xorshift32) */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

/** 무작위 바이트 */
function randomBytes(n, seed) {
  const r = rng(seed);
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = r() & 0xFF;
  return a;
}

/** 편향 분포: 90% 가 0, 나머지는 1..255 균등 */
function biasedBytes(n, seed) {
  const r = rng(seed);
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const x = r();
    a[i] = x % 10 !== 0 ? 0 : 1 + ((x >>> 8) % 255);
  }
  return a;
}

/**
 * 독립 참조 부호기: cache/cacheSize 대신 이미 낸 출력 배열에 자리올림을 직접 전파하는 방식.
 * 출력 = [0x00] + 정규화마다 low 최상위 바이트 + 끝에 low 4 바이트. 범위 부호 payload 만 돌려준다.
 */
function referenceRangePayload(raw) {
  const prob = new Array(256).fill(1024);
  const out = [0];
  let low = 0n;
  let range = 0xFFFFFFFFn;
  const carryAndEmit = () => {
    if (low >= 1n << 32n) {
      low -= 1n << 32n;
      let k = out.length - 1;
      while (out[k] === 0xFF) { out[k] = 0; k--; }
      out[k] += 1;
    }
    out.push(Number((low >> 24n) & 0xFFn));
    low = (low & 0xFFFFFFn) << 8n;
  };
  for (const b of raw) {
    let m = 1;
    for (let s = 7; s >= 0; s--) {
      const bit = (b >> s) & 1;
      const p = prob[m];
      const bound = (range >> 11n) * BigInt(p);
      if (bit) { low += bound; range -= bound; prob[m] = p - (p >> 5); } else { range = bound; prob[m] = p + ((2048 - p) >> 5); }
      m = m * 2 + bit;
      if (range < 1n << 24n) { range <<= 8n; carryAndEmit(); }
    }
  }
  for (let k = 0; k < 4; k++) carryAndEmit();
  return Uint8Array.from(out);
}

function lebBytes(v) {
  const o = [];
  while (v >= 128) { o.push((v % 128) | 0x80); v = Math.floor(v / 128); }
  o.push(v);
  return o;
}

function expectCodecError(fn, code) {
  assert.throws(fn, (e) => e instanceof CodecError && e.code === code);
}

test('골든: 빈 입력·1 바이트는 저장 모드, 헤더 손계산', () => {
  assert.equal(hex(entropyEncode(new Uint8Array(0))), '0000');
  assert.equal(hex(entropyEncode(Uint8Array.of(0x41))), '000141');
  assert.equal(hex(entropyDecode(fromHex('0000'))), '');
  assert.equal(hex(entropyDecode(fromHex('000141'))), '41');
  // rawLen 300 = LEB128 ac 02 → 저장(무작위라 범위 부호가 더 크다)
  const r = randomBytes(300, 9);
  const e = entropyEncode(r);
  assert.equal(e.length, 1 + 2 + 300);
  assert.equal(hex(e.subarray(0, 3)), '00ac02');
});

test('손계산: 0x00 한 바이트의 범위 부호는 정규화 1 번 → payload 6 B, 그래서 mode 1 로는 못 쓴다', () => {
  // range: ffffffff → 7ffffc00 → 3ffffc00 → 1ffffc00 → 0ffffc00 → 07fffc00 → 03fffc00 → 01fffc00 → 00fffc00(< 2^24, 정규화 1 번)
  // 따라서 payload = 1 + 5 = 6 B. 모두 비트 0 이라 low = 0 → 전부 0x00. 원본 1 B 보다 크므로 부호기는 저장을 고른다.
  assert.equal(hex(referenceRangePayload([0])), '000000000000');
  assert.equal(hex(entropyEncode(Uint8Array.of(0))), '000100');
  // payload 6 B > rawLen 1 인 mode 1 은 비정규라 복호기가 거부한다(부호기가 만들지 않는 출력)
  expectCodecError(() => entropyDecode(fromHex('0101000000000000')), 'stream');
  // 같은 계산을 정규 크기로: 0x00 이 64 개면 정규화가 더 일어나 payload 29 B(≤ 64)이고 mode 1 이 정규다. payload 는 전부 0x00.
  const z64 = new Uint8Array(64);
  const payload = referenceRangePayload(z64);
  assert.equal(hex(payload), '00'.repeat(29));
  const ok = Uint8Array.from([1, 64, ...payload]);
  assert.equal(hex(entropyDecode(ok)), hex(z64));
  // 끝 상태 code 는 0 이어야 한다: 마지막 바이트 01 이면 code ≠ 0 → 거부
  const badTail = ok.slice(); badTail[badTail.length - 1] = 1;
  expectCodecError(() => entropyDecode(badTail), 'stream');
  // payload 가 한 바이트 모자라면 정규화에 쓸 바이트가 없다
  expectCodecError(() => entropyDecode(ok.subarray(0, ok.length - 1)), 'stream');
  // payload 가 한 바이트 남으면 거부
  expectCodecError(() => entropyDecode(Uint8Array.from([...ok, 0])), 'stream');
  // 첫 바이트 ≠ 0
  const badHead = ok.slice(); badHead[2] = 1;
  expectCodecError(() => entropyDecode(badHead), 'stream');
});

test('골든: 반복 바이트 64 개는 범위 모드(16 진 고정)', () => {
  const cases = [
    [new Uint8Array(64), '01400000000000000000000000000000000000000000000000000000000000'],
    [new Uint8Array(64).fill(0xAA), '014000aaa8e2154a2b571ebac52d7bc5282c2d697f617179663d535ac8900c'],
    [new Uint8Array(64).map((_, i) => (i & 1 ? 0x42 : 0x41)), '0140004142b368f78616dba6b08bb4e20351d99dcc094f566a434740ebb9586c47f9ed947d'],
  ];
  for (const [raw, golden] of cases) {
    const e = entropyEncode(raw);
    assert.equal(hex(e), golden);
    assert.equal(e[0], ENTROPY_MODE.RANGE);
    // 독립 참조 부호기와 payload 일치
    assert.equal(hex(e.subarray(2)), hex(referenceRangePayload(raw)));
    assert.equal(hex(entropyDecode(e)), hex(raw));
  }
});

test('독립 참조 부호기와 무작위 짧은 입력 400 개에서 일치', () => {
  const r = rng(4242);
  let rangeCount = 0;
  for (let t = 0; t < 400; t++) {
    const n = 1 + (r() % 200);
    const skew = r() % 4; // 0: 균등, 1..3: 작은 값 위주
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = skew === 0 ? r() & 0xFF : (r() % (skew * 3)) === 0 ? r() & 0xFF : r() % (1 << skew);
    const ref = referenceRangePayload(a);
    const e = entropyEncode(a);
    const head = 1 + lebBytes(n).length;
    if (ref.length <= n) {
      rangeCount++;
      assert.equal(e[0], 1);
      assert.equal(hex(e.subarray(head)), hex(ref));
    } else {
      assert.equal(e[0], 0);
      assert.equal(e.length, head + n);
    }
    assert.equal(hex(entropyDecode(e)), hex(a));
    // 참조 부호기 출력을 mode 1 로 싸면 payload ≤ rawLen 일 때만 복호되고, 더 크면 비정규라 'stream' 으로 거부된다
    const wrapped = Uint8Array.from([1, ...lebBytes(n), ...ref]);
    if (ref.length <= n) assert.equal(hex(entropyDecode(wrapped)), hex(a));
    else expectCodecError(() => entropyDecode(wrapped), 'stream');
  }
  assert.ok(rangeCount >= 100, `범위 모드 사례 ${rangeCount}`);
});

test('무작위 1 MB 왕복: 저장 모드, 크기 = 원본 + 헤더 4 B, 시간 제한', () => {
  const N = 1 << 20;
  const a = randomBytes(N, 12345);
  const t0 = performance.now();
  const e = entropyEncode(a);
  const t1 = performance.now();
  const d = entropyDecode(e);
  const t2 = performance.now();
  assert.equal(e[0], ENTROPY_MODE.STORED);
  assert.equal(e.length, 1048580); // 1 + LEB(2^20)=3 + 2^20
  assert.equal(hex(e.subarray(0, 4)), '00808040');
  assert.equal(Buffer.compare(d, a), 0);
  // [회귀 감시] 시간 상한은 기계 성능에 달린 느슨한 값(실측의 수 배)이라 이론 근거가 없다. 큰 퇴행만 잡는다.
  // 부하 시 흔들림을 줄이기 위해 큰 여유(3s)를 둔다.
  assert.ok(t1 - t0 < 3000, `부호화 ${t1 - t0} ms`);
  assert.ok(t2 - t1 < 3000, `복호 ${t2 - t1} ms`);
  // 결정적
  assert.equal(Buffer.compare(entropyEncode(a), e), 0);
});

test('편향 분포(0 이 90%) 1 MB: 범위 모드, 원본의 0.6 배 이하, 이론 엔트로피 대비', () => {
  const N = 1 << 20;
  const a = biasedBytes(N, 777);
  // 이론 엔트로피(분포 식): H = −0.9·log2 0.9 − 0.1·log2(0.1/255) = 1.26844 비트/바이트
  const Htheory = -0.9 * Math.log2(0.9) - 0.1 * Math.log2(0.1 / 255);
  assert.ok(Math.abs(Htheory - 1.26844) < 1e-4);
  // 표본 0 차 엔트로피(바이트)
  const cnt = new Float64Array(256);
  for (const v of a) cnt[v]++;
  let Hs = 0;
  for (const c of cnt) if (c) Hs -= c * Math.log2(c / N);
  const HsBytes = Hs / 8;
  assert.ok(Math.abs(HsBytes - 165731.31) < 1, `표본 엔트로피 ${HsBytes}`);

  const t0 = performance.now();
  const e = entropyEncode(a);
  const t1 = performance.now();
  const d = entropyDecode(e);
  const t2 = performance.now();
  assert.equal(e[0], ENTROPY_MODE.RANGE);
  assert.equal(e.length, 178520); // [회귀 감시] 결정적 출력 크기 스냅샷(이론 근거 없음). 아래 이론 엔트로피 대비 1.08 배 상한이 근거 있는 검사
  assert.ok(e.length <= 0.6 * N);
  // 이론 엔트로피 대비: 이론 하한(N·H/8 = 166256 B)의 1.08 배 이하, 표본 엔트로피 이상
  assert.ok(e.length <= 1.08 * (N * Htheory / 8), `비율 ${e.length / (N * Htheory / 8)}`);
  assert.ok(e.length >= HsBytes);
  assert.equal(Buffer.compare(d, a), 0);
  // [회귀 감시] 시간 상한은 기계 성능에 달린 느슨한 값(실측의 수 배)이라 이론 근거가 없다. 큰 퇴행만 잡는다.
  // 부하 시 흔들림을 줄이기 위해 큰 여유(3s)를 둔다.
  assert.ok(t1 - t0 < 3000, `부호화 ${t1 - t0} ms`);
  assert.ok(t2 - t1 < 3000, `복호 ${t2 - t1} ms`);
});

test('전부 0 1 MB: 최대 압축비가 조기 거부 상한(64 배)보다 작다', () => {
  const N = 1 << 20;
  const e = entropyEncode(new Uint8Array(N));
  assert.equal(e[0], ENTROPY_MODE.RANGE);
  assert.equal(e.length, 23123); // [회귀 감시] 스냅샷. 근거 있는 검사는 아래 64 배 조기 거부 상한과의 관계
  const payload = e.length - 4;
  assert.ok(N <= 64 * payload + 64);
  assert.equal(entropyDecode(e).every((v) => v === 0), true);
});

test('형식 오류: mode·LEB128·상한·인자', () => {
  expectCodecError(() => entropyDecode(new Uint8Array(0)), 'stream');
  expectCodecError(() => entropyDecode(fromHex('02')), 'mode');
  expectCodecError(() => entropyDecode(fromHex('ff0000')), 'mode');
  expectCodecError(() => entropyDecode(fromHex('00')), 'stream'); // rawLen 없음
  expectCodecError(() => entropyDecode(fromHex('0080')), 'stream'); // LEB 잘림
  expectCodecError(() => entropyDecode(fromHex('008000')), 'stream'); // 비최소 표현(0 을 2 바이트로)
  expectCodecError(() => entropyDecode(fromHex('0081004142')), 'stream'); // 비최소 표현(1)
  expectCodecError(() => entropyDecode(fromHex('0080808080808001')), 'limit'); // 8 바이트 LEB
  expectCodecError(() => entropyDecode(fromHex('000541424344')), 'stream'); // 저장 payload 모자람
  expectCodecError(() => entropyDecode(fromHex('00024142ff')), 'stream'); // 저장 payload 남음
  expectCodecError(() => entropyDecode(fromHex('00054142434445'), 4), 'limit');
  assert.equal(hex(entropyDecode(fromHex('00054142434445'), 5)), '4142434445');
  // 기본 상한 = STREAM_RAW_BYTES_MAX(2^26): rawLen 2^26 + 1 은 limit
  expectCodecError(() => entropyDecode(Uint8Array.from([0, ...lebBytes(STREAM_RAW_BYTES_MAX + 1)])), 'limit');
  // 범위 부호 첫 바이트 ≠ 0
  expectCodecError(() => entropyDecode(fromHex('0101010000000000')), 'stream');
  // rawLen 이 payload 로 낼 수 있는 양(64·L + 64)을 넘으면 할당 전에 거부(아래 경계 시험)
  expectCodecError(() => entropyDecode(Uint8Array.from([1, ...lebBytes(STREAM_RAW_BYTES_MAX), 0, 0, 0, 0, 0, 0])), 'stream');
  expectCodecError(() => entropyEncode([1, 2, 3]), 'range');
  expectCodecError(() => entropyDecode([0, 0]), 'range');
  expectCodecError(() => entropyDecode(fromHex('0000'), -1), 'range');
});

test('할당 전 거부 경계: rawLen = 64·L+64 는 가드를 통과, +65 는 가드가 즉시 거부', () => {
  // 두 경우 모두 결국 'stream' 이므로 코드만으로는 가드 유무를 가를 수 없다. 가드의 메시지('너무 짧다')로 가른다.
  // 가드 없는 변이에서는 +65 가 나중 검사(범위 복호 중 payload 모자람)로 거부되어 메시지가 달라져 실패한다.
  const guard = (e) => e instanceof CodecError && e.code === 'stream' && /너무 짧다/.test(e.message);
  const later = (e) => e instanceof CodecError && e.code === 'stream' && !/너무 짧다/.test(e.message);
  for (const L of [5, 6, 37, 1000]) {
    const payload = new Uint8Array(L); // 첫 바이트 0, 나머지 0 — 가드만 보는 시험이라 내용은 상관없다
    const mk = (rawLen) => Uint8Array.from([1, ...lebBytes(rawLen), ...payload]);
    assert.throws(() => entropyDecode(mk(64 * L + 64)), later, `L=${L}: 경계값은 가드를 통과해야 한다`);
    assert.throws(() => entropyDecode(mk(64 * L + 65)), guard, `L=${L}: 경계+1 은 가드가 거부해야 한다`);
  }
  // 상한 가까이의 거대한 rawLen 도 할당·복호 없이 즉시(가드로) 거부
  const t0 = performance.now();
  assert.throws(() => entropyDecode(Uint8Array.from([1, ...lebBytes(STREAM_RAW_BYTES_MAX), 0, 0, 0, 0, 0, 0])), guard);
  assert.ok(performance.now() - t0 < 50, '가드 거부는 거의 즉시여야 한다');
});

test('손상 퍼징 5000 회: CodecError 아니면 정상 스트림뿐, 큰 할당·긴 실행 없음', () => {
  const sources = [
    biasedBytes(2048, 1),
    biasedBytes(700, 2),
    new Uint8Array(1500).map((_, i) => (i * 7) & 0x0F),
    randomBytes(300, 3),
    new Uint8Array(64).fill(0xAA),
    Uint8Array.of(5),
  ].map((raw) => ({ raw, enc: entropyEncode(raw) }));
  assert.deepEqual(sources.map((s) => s.enc[0]), [1, 1, 1, 0, 1, 0]);
  const r = rng(20261003);
  const stats = { trunc: 0, flip: 0, inflate: 0, flipOk: 0, inflateOk: 0 };
  const ALLOWED = new Set(['stream', 'mode', 'limit']);
  const t0 = performance.now();
  let worst = 0;
  for (let it = 0; it < 5000; it++) {
    const { raw, enc } = sources[r() % sources.length];
    const kind = it % 3;
    let bad;
    if (kind === 0) {
      bad = enc.slice(0, r() % enc.length);
      stats.trunc++;
    } else if (kind === 1) {
      bad = enc.slice();
      const flips = 1 + (r() % 3);
      for (let f = 0; f < flips; f++) bad[r() % bad.length] ^= 1 << (r() % 8);
      stats.flip++;
    } else {
      // rawLen 을 1 .. 2^40 만큼 부풀려 다시 쓴다
      let p = 1;
      while (enc[p] & 0x80) p++;
      const add = r() % 4 === 0 ? 1 + (r() % 64) : Math.floor((r() / 2 ** 32) * 2 ** 40) + 1;
      bad = Uint8Array.from([enc[0], ...lebBytes(raw.length + add), ...enc.subarray(p + 1)]);
      stats.inflate++;
    }
    const s = performance.now();
    let result = null;
    let err = null;
    try { result = entropyDecode(bad); } catch (e) { err = e; }
    worst = Math.max(worst, performance.now() - s);
    if (err) {
      assert.ok(err instanceof CodecError, `CodecError 아님: ${err}`);
      assert.ok(ALLOWED.has(err.code), `코드 ${err.code}`);
    } else {
      assert.ok(result instanceof Uint8Array && result.length <= 64 * bad.length + 64);
      assert.notEqual(kind, 0, '자르기는 반드시 거부돼야 한다');
      if (kind === 2) {
        // 부풀림이 통과하는 유일한 경우: 늘어난 바이트를 정규화 없이 복호할 수 있어(확률이 쏠린 모델) 원본 뒤에 0x00 만 붙고,
        // 그 결과를 부호화하면 손상 입력과 바이트 단위로 같다 — 즉 다른 원본의 정상 스트림이라 형식상 구별할 수 없다.
        assert.equal(hex(result.subarray(0, raw.length)), hex(raw));
        assert.ok(result.subarray(raw.length).every((v) => v === 0));
        assert.equal(hex(entropyEncode(result)), hex(bad));
        stats.inflateOk++;
      } else {
        // 비트 뒤집기는 (체크섬이 없는 층이므로) 다른 바이트로 복호될 수 있다. 길이는 rawLen 그대로다.
        // 받아들인 입력은 그 결과의 정상 부호화와 바이트 단위로 같아야 한다(복호기가 비정규 스트림을 통과시키지 않음).
        assert.equal(hex(entropyEncode(result)), hex(bad));
        stats.flipOk++;
      }
    }
  }
  assert.deepEqual(stats, { trunc: 1667, flip: 1667, inflate: 1666, flipOk: 311, inflateOk: 53 }); // [회귀 감시] 씨앗 고정 → 결정적 집계 스냅샷(구현을 바꾸면 의도한 변화인지 확인 후 갱신)
  // [회귀 감시] 시간 상한: 근거 있는 값이 아니라 느슨한 퇴행 감시
  assert.ok(worst < 100, `한 번 복호 최대 ${worst} ms`);
  assert.ok(performance.now() - t0 < 10000);
});
