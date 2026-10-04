// T03.11 포맷 퍼저: 손상 입력에서 패닉·무한 루프·과도한 할당 0 을 확인한다.
// 허용 결과는 정상 반환 또는 AssetFormatError 뿐이다. 형제 모듈은 있을 때만 시험한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AssetFormatError, OFFSETS, HEADER_SIZE, parseHeader } from '../../../contracts/asset/index.mjs';

// 기준값(숫자로 고정)
const SEED = 0x5eed11;
const ITERATIONS = 100_000; // 입력 수. 각 입력을 모든 대상에 넣는다
const MAX_CALL_MS = 50; // 호출당 시간 상한
const MAX_ALLOC_BYTES = 1 << 20; // 호출 하나가 새로 잡는 ArrayBuffer 상한(1 MiB)
const MAX_OUT_FACTOR = 8; // 결과 배열 총 바이트 ≤ 입력 길이 × 8 + 4096
const TOTAL_BUDGET_MS = 60_000; // 퍼저 전체 CPU 시간 상한(병렬 부하에 흔들리지 않게 CPU 시간으로 잰다)
const WALL_GUARD_MS = TOTAL_BUDGET_MS * 2.5; // 대기·교착(CPU 시간이 안 흐름)을 잡는 벽시계 상한. 예산의 2~3 배
const cpuMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const MAX_REPORT = 3; // 대상별 실패 재현 입력 보고 수

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const goldens = ['point27', 'gauss56'].map((n) => new Uint8Array(readFileSync(here(`../../../fixtures/asset_golden/${n}.skla`))));

// 고정 시드 PRNG(mulberry32)
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 대상 목록: 경로가 있을 때만 동적 import ----
const SIBLINGS = [
  { path: '../header/index.mjs', names: ['readHeaderStrict'] },
  { path: '../checksum/index.mjs', names: ['verifyChecksum'] },
  { path: '../unpack/index.mjs', names: ['unpackChunk', 'toSourceRecords'] },
  { path: '../../../tools/asset_validate/index.mjs', names: ['validateAsset'] },
  { path: '../compat/index.mjs', names: ['checkCompat'] },
  { path: '../../../client/asset/index.mjs', names: ['readHeaderClient', 'readPlanesClient'] },
];

/** @type {Record<string, {fn: Function, noThrow: boolean}>} */
const targets = { parseHeader: { fn: parseHeader, noThrow: false } };
const skipped = [];
for (const { path, names } of SIBLINGS) {
  const file = here(path);
  if (!existsSync(file)) {
    for (const n of names) skipped.push(`${n}: ${path} 없음`);
    continue;
  }
  // 파일이 있는데 import 가 실패하면(문법 오류 등) skip 이 아니라 실패다
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (e) {
    throw new Error(`형제 모듈 ${path} 불러오기 실패(파일은 존재함): ${e?.message}`, { cause: e });
  }
  for (const n of names) {
    if (typeof mod[n] !== 'function') throw new Error(`형제 모듈 ${path} 에 export ${n} 없음`);
    else targets[n] = { fn: mod[n], noThrow: n === 'validateAsset' || n === 'checkCompat' };
  }
}
for (const s of skipped) console.log(`[fuzz] skip ${s}`);

// ---- 입력 생성 ----
// [이름, 오프셋, 크기, 종류, 축]. 이름은 OFFSETS 키(bboxMin·bboxMax 는 +8*축, anchor 는 anchorLat 기준 +8*축)
const FIELDS = [
  ['versionMajor', 4, 2, 'u16', 0], ['versionMinor', 6, 2, 'u16', 0], ['headerSize', 8, 2, 'u16', 0],
  ['format', 10, 1, 'u8', 0], ['codec', 11, 1, 'u8', 0], ['segLevel', 12, 4, 'u32', 0],
  ['pointCount', 16, 4, 'u32', 0], ['pointCount', 16, 4, 'u32', 0], ['tileX', 20, 4, 'i32', 0], ['tileY', 24, 4, 'i32', 0],
  ['tileSizeM', 28, 2, 'u16', 0], ['lod', 30, 1, 'u8', 0], ['quantExp', 31, 1, 'u8', 0],
  ['chunkIndex', 32, 4, 'u32', 0], ['bodyBytes', 36, 4, 'u32', 0], ['bodyBytes', 36, 4, 'u32', 0],
  ['bboxMin', 40, 8, 'f64', 0], ['bboxMin', 48, 8, 'f64', 1], ['bboxMin', 56, 8, 'f64', 2],
  ['bboxMax', 64, 8, 'f64', 0], ['bboxMax', 72, 8, 'f64', 1], ['bboxMax', 80, 8, 'f64', 2],
  ['anchor', 88, 8, 'f64', 0], ['anchor', 96, 8, 'f64', 1], ['anchor', 104, 8, 'f64', 2],
  ['checksum', 112, 4, 'u32', 0], ['reserved', 116, 4, 'u32', 0],
];
const BIG_FIELDS = new Set(['pointCount', 'bodyBytes']);
const INT_EDGES = [0, 1, 2, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff];
const F64_EDGES = [0, -0, 1, -1, NaN, Infinity, -Infinity, 1e308, -1e308, 5e-324, 65535, 2 ** 53, -(2 ** 31)];

function writeField(buf, [, off, size, kind], rng) {
  if (off + size > buf.length) return;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (kind === 'f64') {
    dv.setFloat64(off, F64_EDGES[(rng() * F64_EDGES.length) | 0], true);
    return;
  }
  const v = INT_EDGES[(rng() * INT_EDGES.length) | 0];
  if (kind === 'i32') dv.setInt32(off, rng() < 0.5 ? v | 0 : -1 - ((rng() * 2 ** 31) | 0), true); // 음수 i32 포함
  else if (size === 4) dv.setUint32(off, v >>> 0, true);
  else if (size === 2) dv.setUint16(off, v & 0xffff, true);
  else dv.setUint8(off, v & 0xff);
}

/** @returns {{bytes: Uint8Array, huge: boolean}} */
function makeInput(i, rng) {
  const g = goldens[(rng() * goldens.length) | 0];
  const cat = i % 5;
  let b;
  let huge = false;
  if (cat === 0) { // 1~8바이트 무작위 변이
    b = g.slice();
    const n = 1 + ((rng() * 8) | 0);
    for (let k = 0; k < n; k++) b[(rng() * b.length) | 0] = (rng() * 256) | 0;
  } else if (cat === 1) { // 잘라내기(헤더 경계 근처 포함)
    const edge = [0, 1, 3, 4, 127, 128, 129, g.length - 1];
    const len = rng() < 0.3 ? edge[(rng() * edge.length) | 0] : (rng() * g.length) | 0;
    b = g.slice(0, len);
  } else if (cat === 2) { // 늘리기
    const extra = rng() < 0.2 ? 1 + ((rng() * 65536) | 0) : 1 + ((rng() * 64) | 0);
    b = new Uint8Array(g.length + extra);
    b.set(g);
    if (rng() < 0.5) for (let k = g.length; k < b.length; k++) b[k] = (rng() * 256) | 0;
  } else if (cat === 3) { // 헤더 필드 경계값 치환
    b = g.slice();
    const f = FIELDS[(rng() * FIELDS.length) | 0];
    writeField(b, f, rng);
    if (rng() < 0.2) writeField(b, FIELDS[(rng() * FIELDS.length) | 0], rng);
    if (BIG_FIELDS.has(f[0])) {
      huge = true;
      if (rng() < 0.5) b = b.slice(0, HEADER_SIZE + ((rng() * 16) | 0));
    }
  } else { // 완전 무작위(절반은 매직·버전 1 을 붙여 더 깊이 들어가게)
    b = new Uint8Array((rng() * 700) | 0);
    for (let k = 0; k < b.length; k++) b[k] = (rng() * 256) | 0;
    if (b.length >= 12 && rng() < 0.5) {
      b.set([0x53, 0x4b, 0x4c, 0x41, 1, 0, 0, 0]);
      b[8] = 128; b[9] = 0; b[10] = 1 + ((rng() * 2) | 0);
    }
  }
  return { bytes: b, huge };
}

// ---- 결과 검사 ----
function outBytes(v, seen = new Set()) {
  if (v === null || typeof v !== 'object' || seen.has(v)) return 0;
  seen.add(v);
  if (ArrayBuffer.isView(v)) return v.byteLength;
  let s = 0;
  for (const k of Object.keys(v)) s += outBytes(v[k], seen);
  return s;
}
const hex = (b) => Buffer.from(b).toString('hex').slice(0, 2048);
const arrayBuffers = () => process.memoryUsage().arrayBuffers;

function callTarget(name, t, bytes, measureAlloc, stat) {
  let args = [bytes];
  if (name === 'readPlanesClient') {
    let h;
    try { h = parseHeader(bytes); } catch (e) {
      if (!(e instanceof AssetFormatError)) return { kind: 'fail', why: `헤더 준비 단계 예외 ${e?.name}: ${e?.message}` };
      stat.skipped++;
      return null;
    }
    args = [bytes, h];
  }
  const a0 = measureAlloc ? arrayBuffers() : 0;
  const t0 = performance.now();
  let res;
  let kind = 'ok';
  let why = '';
  try {
    res = t.fn(...args);
  } catch (e) {
    if (e instanceof AssetFormatError && !t.noThrow) kind = 'err';
    else { kind = 'fail'; why = `${e?.name}: ${e?.message}`; }
  }
  let ms = performance.now() - t0;
  // 상한(MAX_CALL_MS)은 유지한다. 부하·GC 정지로 한 번 튄 값은 최대 3회 재시도해 그중 최솟값으로 판정한다.
  // 진짜 느린 입력은 매번 느려 최솟값도 상한을 넘으므로 잡히고, 일시 지연은 한 번이라도 빠르면 통과한다.
  const retried = ms > MAX_CALL_MS;
  if (retried) {
    for (let r = 0; r < 3 && ms > MAX_CALL_MS; r++) {
      const t1 = performance.now();
      try { t.fn(...args); } catch { /* 첫 호출에서 이미 분류함 */ }
      ms = Math.min(ms, performance.now() - t1);
    }
  }
  if (ms > stat.maxMs) stat.maxMs = ms;
  if (retried && ms <= MAX_CALL_MS) stat.retryPass++; // 일시 지연으로 재시도해서 통과한 호출
  if (ms > MAX_CALL_MS) { stat.slow++; if (kind !== 'fail') { kind = 'fail'; why = `느림 ${ms.toFixed(1)} ms`; } }
  if (measureAlloc) {
    const d = arrayBuffers() - a0;
    if (d > MAX_ALLOC_BYTES) { kind = 'fail'; why = `과도한 할당 ${d} B`; }
  }
  // 검증기의 내부 예외는 던지지 않고 위반 메시지로 나오므로 따로 걸러낸다
  if (kind === 'ok' && name === 'validateAsset' && Array.isArray(res) && res.some((v) => /validator failure/.test(v?.message ?? ''))) {
    kind = 'fail';
    why = `validator failure(내부 예외): ${res.find((v) => /validator failure/.test(v?.message ?? '')).message}`;
  }
  if (kind === 'ok' && res !== undefined) {
    const ob = outBytes(res);
    if (ob > bytes.length * MAX_OUT_FACTOR + 4096) { kind = 'fail'; why = `결과 ${ob} B > 입력 ${bytes.length} B 의 ${MAX_OUT_FACTOR}배`; }
  }
  return { kind, why };
}

test('fuzz_no_panic', { timeout: WALL_GUARD_MS + 10_000 }, () => {
  assert.ok(targets.parseHeader, 'parseHeader 는 항상 돈다');
  const stats = Object.fromEntries(Object.keys(targets).map((n) => [n, { calls: 0, ok: 0, err: 0, fail: 0, slow: 0, retryPass: 0, skipped: 0, maxMs: 0, repros: [] }]));

  // 변이 없는 골든은 모든 대상에서 정상이어야 한다(퍼저가 의미 있는지 확인)
  for (const g of goldens) {
    for (const [n, t] of Object.entries(targets)) {
      const r = callTarget(n, t, g.slice(), false, stats[n]);
      assert.ok(r === null || r.kind === 'ok', `${n} 골든 실패: ${r?.why}`);
      stats[n].maxMs = 0; stats[n].skipped = 0; stats[n].slow = 0; stats[n].retryPass = 0;
    }
  }

  const rng = makeRng(SEED);
  const start = performance.now();
  const cpuStart = cpuMs();
  let done = 0;
  let abortWhy = null; // 반복 중단 원인(없으면 끝까지 돈 것)
  for (let i = 0; i < ITERATIONS; i++) {
    // 예산을 넘기면 중단하고 아래 단언에서 실패시킨다(끝없이 도는 것을 막는다)
    if (performance.now() - start > WALL_GUARD_MS) { abortWhy = `벽시계 상한 ${WALL_GUARD_MS} ms 초과`; break; } // 벽시계는 매 입력 확인
    if (i % 256 === 0 && cpuMs() - cpuStart > TOTAL_BUDGET_MS) { abortWhy = `CPU 예산 ${TOTAL_BUDGET_MS} ms 초과`; break; }
    done++;
    const { bytes, huge } = makeInput(i, rng);
    const measure = huge || i % 64 === 0;
    for (const [n, t] of Object.entries(targets)) {
      const st = stats[n];
      const r = callTarget(n, t, new Uint8Array(bytes), measure, st);
      if (r === null) continue;
      st.calls++;
      st[r.kind]++;
      if (r.kind === 'fail' && st.repros.length < MAX_REPORT) st.repros.push(`${r.why} :: ${hex(bytes)}`);
    }
  }
  const elapsed = cpuMs() - cpuStart;
  const wall = performance.now() - start;

  console.log(`[fuzz] seed=0x${SEED.toString(16)} inputs=${ITERATIONS} cpu=${(elapsed / 1000).toFixed(1)}s wall=${(wall / 1000).toFixed(1)}s`);
  console.log('[fuzz] target            calls      ok     err    fail  slow retry  skip  maxMs');
  for (const [n, s] of Object.entries(stats)) {
    console.log(`[fuzz] ${n.padEnd(18)}${String(s.calls).padStart(6)}${String(s.ok).padStart(8)}${String(s.err).padStart(8)}${String(s.fail).padStart(8)}${String(s.slow).padStart(6)}${String(s.retryPass).padStart(6)}${String(s.skipped).padStart(6)}${s.maxMs.toFixed(2).padStart(8)}`);
  }
  for (const [n, s] of Object.entries(stats)) for (const r of s.repros) console.log(`[fuzz] REPRO ${n}: ${r}`);

  assert.equal(done, ITERATIONS, `${done}/${ITERATIONS} 회에서 중단: ${abortWhy ?? '원인 미상'} (cpu=${(elapsed / 1000).toFixed(1)}s wall=${(wall / 1000).toFixed(1)}s). 호출별 ${MAX_CALL_MS} ms 상한은 아래 slow 단언이 따로 본다`);
  for (const [n, s] of Object.entries(stats)) {
    assert.equal(s.ok + s.err + s.fail, s.calls, `${n} 집계`);
    assert.equal(s.fail, 0, `${n}: 허용 밖 결과 ${s.fail}건(재현 입력은 위 REPRO 줄)`);
    assert.equal(s.slow, 0, `${n}: ${MAX_CALL_MS} ms 초과 ${s.slow}건`);
  }
  // 변이가 양쪽 경로(정상·오류)를 모두 탔는지
  assert.ok(stats.parseHeader.ok > 1000 && stats.parseHeader.err > 1000, 'parseHeader 정상·오류 분포가 한쪽으로 쏠림');
});

for (const s of skipped) {
  const name = s.split(':')[0];
  test(`fuzz_target_${name}`, { skip: s }, () => {});
}

// 변이 필드 오프셋이 계약 OFFSETS 와 정확히 같은지
test('fuzz_field_table', () => {
  const ANCHOR = ['anchorLat', 'anchorLon', 'anchorAlt'];
  const covered = new Set();
  for (const [name, off, size, kind, axis] of FIELDS) {
    const key = name === 'anchor' ? ANCHOR[axis] : name;
    assert.ok(OFFSETS[key] !== undefined, `${name}: OFFSETS 에 없음`);
    // bbox 는 OFFSETS[key]+8*축, anchor 는 축별 키의 값과 직접 비교
    const expected = name === 'anchor' ? OFFSETS[key] : OFFSETS[key] + 8 * axis;
    assert.equal(expected, off, `${name}[${axis}] 오프셋이 계약과 다름`);
    if (axis > 0) assert.equal(kind, 'f64', `${name}: 축은 f64 만`);
    assert.equal(size, { u8: 1, u16: 2, u32: 4, i32: 4, f64: 8 }[kind], `${name}: 크기·종류 불일치`);
    assert.ok(off + size <= HEADER_SIZE, `${name}: 헤더 밖`);
    covered.add(key);
  }
  // 계약의 모든 필드(magic 제외)가 변이 대상에 들어 있어야 한다
  for (const k of Object.keys(OFFSETS)) {
    if (k !== 'magic') assert.ok(covered.has(k), `${k}: 변이 대상에서 빠짐`);
  }
});
