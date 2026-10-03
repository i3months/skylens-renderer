// T09.8 손상 블록 거부: decodeChunk(서버)·decodeChunkClient(클라이언트)를 10만 회 변이 퍼징한다.
// 허용 결과는 정상 반환 또는 CodecError/AssetFormatError 뿐이다(다른 예외·무한 루프·큰 할당 0).
// 정상 반환이면 서버·클라이언트가 같은 점 집합(pointMultiset)을 내야 한다. 시드 고정.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { packChunk } from '../../asset/pack/index.mjs';
import { encodeChunk, decodeChunk } from '../chunk/index.mjs';
import { entropyEncode, entropyDecode } from '../entropy/index.mjs';
import { decodeChunkClient } from '../../../client/codec/index.mjs';
import {
  FORMAT_POINT27, AssetFormatError, OFFSETS, HEADER_SIZE, bodyLayout, parseHeader,
} from '../../../contracts/asset/index.mjs';
import { CodecError, pointMultiset, BODY_FIXED_BYTES, POINT_COUNT_MAX, STREAM_RAW_BYTES_MAX } from '../../../contracts/codec/index.mjs';

// ---- 기준값(숫자로 고정) ----
const SEED = 0x0908c0de;
const ITERATIONS = 100_000;
const MAX_CALL_MS = 100; // 변이 1회(서버 호출 1 + 클라 호출 1) 각각의 시간 상한
const MAX_ALLOC_BYTES = 4 * 1024 * 1024; // 호출 1회가 만드는 타입 배열·ArrayBuffer 총량 상한(4 MiB). 기본 점 수 상한 값 부풀림이 이를 넘기면 실패
const MIN_FIXED_CRC = 50_001; // 체크섬을 다시 계산해 바깥 검사를 통과시킨 변이 수의 하한(절반 초과)
const MIN_INNER_REACHED = 50_001; // 내부 복호기(엔트로피·스트림·색)까지 도달한 변이 수 하한(절반 초과)
const MAX_REPORT = 3;

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
const rng = makeRng(SEED);
const ri = (n) => Math.floor(rng() * n); // 0..n-1
const pick = (a) => a[ri(a.length)];

// ---- 기준 파일 만들기(손으로 정한 합성 장면) ----
const ANCHOR = { lat: 37.5, lon: 127.0, alt: 30.0 };
function scene(n, colorKind) {
  const positions = new Float32Array(3 * n);
  const normals = new Float32Array(3 * n);
  const colors = new Uint8Array(3 * n);
  const NORMALS = [[0, 0, 1], [0.6, 0, 0.8], [0, -0.6, -0.8], [0.36, 0.48, 0.8], [1, 0, 0]];
  for (let i = 0; i < n; i++) {
    positions.set([64 + (i % 9) * 0.31 + (i % 5) * 0.07, -128 + Math.floor(i / 9) * 0.43, 1 + i * 0.037], 3 * i);
    normals.set(NORMALS[i % 5], 3 * i);
    if (colorKind === 'palette') colors.set([[10, 20, 30], [200, 100, 50], [255, 255, 0]][i % 3], 3 * i);
    else colors.set([(i * 8) & 255, (255 - i * 5) & 255, (i * 37) % 256], 3 * i);
  }
  return { format: FORMAT_POINT27, segmentId: 7, level: 2, lod: 0, chunkIndex: 0, anchor: ANCHOR, fields: { positions, normals, colors } };
}
const SPECS = [
  [1, 'delta', false], [2, 'palette', false], [5, 'delta', false], [17, 'palette', false], [33, 'delta', false],
  [64, 'delta', true], [150, 'delta', false], [120, 'palette', false],
];
const rawFiles = SPECS.map(([n, ck]) => packChunk(scene(n, ck)));
const bases = SPECS.map(([, , lossy], i) => encodeChunk(rawFiles[i], { lossyColor: lossy }));

// ---- 독립 도우미: 본문 분해·재조립 ----
function setCrc(file) {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  dv.setUint32(OFFSETS.checksum, 0, true);
  dv.setUint32(OFFSETS.checksum, crc32(file) >>> 0, true);
}
function split(file) {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const b = HEADER_SIZE;
  const pl = dv.getUint32(b + 4, true), nl = dv.getUint32(b + 8, true), cl = dv.getUint32(b + 12, true);
  const s0 = b + BODY_FIXED_BYTES;
  return {
    head: file.slice(0, b), pre: file.slice(b, b + 4),
    streams: [file.slice(s0, s0 + pl), file.slice(s0 + pl, s0 + pl + nl), file.slice(s0 + pl + nl, s0 + pl + nl + cl)],
  };
}
/** 헤더·고정 4 B·스트림 셋 → 길이 필드·body_bytes·체크섬이 모두 맞는 파일 */
function assemble({ head, pre, streams }, lens = null) {
  const L = lens ?? streams.map((s) => s.length);
  const total = streams.reduce((a, s) => a + s.length, 0);
  const out = new Uint8Array(HEADER_SIZE + BODY_FIXED_BYTES + total);
  out.set(head, 0);
  out.set(pre, HEADER_SIZE);
  const dv = new DataView(out.buffer);
  dv.setUint32(OFFSETS.bodyBytes, BODY_FIXED_BYTES + total, true);
  for (let k = 0; k < 3; k++) dv.setUint32(HEADER_SIZE + 4 + 4 * k, L[k] >>> 0, true);
  let o = HEADER_SIZE + BODY_FIXED_BYTES;
  for (const s of streams) { out.set(s, o); o += s.length; }
  setCrc(out);
  return out;
}
function lebBytes(v) { // v: BigInt
  const out = [];
  do { let x = Number(v & 127n); v >>= 7n; if (v > 0n) x |= 128; out.push(x); } while (v > 0n);
  return out;
}
const setU32 = (f, off, v) => new DataView(f.buffer, f.byteOffset).setUint32(off, v >>> 0, true);

// ---- 변이 ----
const KINDS = [
  ['bitflip', 1], ['substitute', 1], ['truncate', 1], ['append', 1], ['streamLen', 2],
  ['pointCount', 2], ['rawLenInflate', 2], ['colorMode', 2], ['innerStream', 5], ['header', 2],
];
const KIND_BAG = KINDS.flatMap(([k, w]) => Array(w).fill(k));

function mutateRawBytes(raw) {
  let r = Uint8Array.from(raw);
  switch (ri(7)) {
    case 0: if (r.length) r[ri(r.length)] ^= 1 << ri(8); break;
    case 1: if (r.length) r[ri(r.length)] = ri(256); break;
    case 2: r = r.slice(0, ri(r.length + 1)); break;
    case 3: r = Uint8Array.from([...r, ...Array.from({ length: 1 + ri(8) }, () => ri(256))]); break;
    case 4: { // 이어짐 비트가 계속 켜진 가변길이(끝나지 않는 LEB128)
      const p = ri(r.length + 1);
      r = Uint8Array.from([...r.slice(0, p), ...Array(1 + ri(12)).fill(0xff), ...r.slice(p)]);
      break;
    }
    case 5: { // 연속 0x80(최소 길이 위반) 삽입
      const p = ri(r.length + 1);
      r = Uint8Array.from([...r.slice(0, p), 0x80, 0x00, ...r.slice(p)]);
      break;
    }
    default: for (let i = 0; i < 1 + ri(4); i++) if (r.length) r[ri(r.length)] = pick([0, 1, 127, 128, 254, 255]); break;
  }
  return r;
}

/** @returns {{file: Uint8Array, kind: string, crcFixed: boolean}} */
function mutate(kind) {
  const base = bases[ri(bases.length)];
  const n = new DataView(base.buffer).getUint32(OFFSETS.pointCount, true);
  let file = base.slice();
  let crcFixed = false;
  const fix = () => { setCrc(file); crcFixed = true; };
  switch (kind) {
    case 'bitflip': {
      for (let i = 0; i < 1 + ri(3); i++) { const p = ri(file.length); file[p] ^= 1 << ri(8); }
      if (rng() < 0.5) fix();
      break;
    }
    case 'substitute': {
      for (let i = 0; i < 1 + ri(4); i++) file[ri(file.length)] = ri(256);
      if (rng() < 0.5) fix();
      break;
    }
    case 'truncate': {
      file = file.slice(0, ri(file.length));
      if (rng() < 0.5 && file.length >= HEADER_SIZE) { setU32(file, OFFSETS.bodyBytes, file.length - HEADER_SIZE); fix(); }
      break;
    }
    case 'append': {
      const extra = Array.from({ length: 1 + ri(16) }, () => ri(256));
      const f2 = new Uint8Array(file.length + extra.length);
      f2.set(file); f2.set(extra, file.length);
      file = f2;
      if (rng() < 0.5) { setU32(file, OFFSETS.bodyBytes, file.length - HEADER_SIZE); fix(); }
      break;
    }
    case 'streamLen': {
      const sp = split(base);
      const L = sp.streams.map((s) => s.length);
      const k = ri(3);
      const mode = ri(4);
      if (mode === 0) L[k] = (L[k] + pick([1, -1, 5, 1000, -1000])) >>> 0; // 합이 어긋남
      else if (mode === 1) { const j = (k + 1 + ri(2)) % 3; const d = 1 + ri(Math.max(1, L[k])); if (L[k] >= d) { L[k] -= d; L[j] += d; } } // 합 유지, 경계만 이동
      else if (mode === 2) L[k] = pick([0xffffffff, 0x80000000, 0x7fffffff, 0xffff0000]);
      else { const j = ri(3); L[k] = L[j] >>> 0; L[(k + 1) % 3] = 0; }
      // 합 유지 변형이 아니면 body_bytes 도 길이 합에 맞추지 않은 채 둔다(합 불일치 거부 경로)
      file = assemble(sp, L);
      if (mode >= 1 && rng() < 0.5) { // body_bytes 를 길이 합에 맞춰 일관되게(큰 값 오버플로 경로)
        const sum = BODY_FIXED_BYTES + L[0] + L[1] + L[2];
        setU32(file, OFFSETS.bodyBytes, sum >>> 0);
        file = file.slice();
        setCrc(file);
      }
      crcFixed = true;
      break;
    }
    case 'pointCount': {
      const v = pick([0, 1, n - 1, n + 1, n * 2, n + 1000, 1 << 16, 1 << 20, POINT_COUNT_MAX - 1, POINT_COUNT_MAX, POINT_COUNT_MAX + 1,
        2 ** 24, 2 ** 31, 0xffffffff, ri(2 ** 32), ri(POINT_COUNT_MAX)]);
      setU32(file, OFFSETS.pointCount, v);
      fix();
      break;
    }
    case 'rawLenInflate': {
      const sp = split(base);
      const k = ri(3);
      const s = sp.streams[k];
      let p = 1; while (s[p] & 128) p++; // 기존 rawLen LEB128 끝
      const big = pick([STREAM_RAW_BYTES_MAX, STREAM_RAW_BYTES_MAX + 1, 2n ** 32n, 2n ** 49n, 2n ** 56n - 1n, BigInt(ri(2 ** 30)) * 1000n, 1n << 22n, 100000n, 7n * BigInt(n) + 1n]);
      const out = [s[0], ...lebBytes(BigInt(big)), ...s.slice(p + 1)];
      sp.streams[k] = Uint8Array.from(out);
      file = assemble(sp);
      crcFixed = true;
      break;
    }
    case 'colorMode': {
      const sp = split(base);
      const m = pick([0, 1, 2, 3, 4, 127, 255]);
      const how = ri(3);
      if (how !== 1) sp.pre[1] = m;
      if (how !== 0) { // 색 스트림 원바이트 첫 바이트(모드)를 바꿔 다시 엔트로피 부호화
        const raw = Uint8Array.from(entropyDecode(sp.streams[2]));
        if (raw.length) raw[0] = m;
        sp.streams[2] = entropyEncode(raw);
      }
      file = assemble(sp);
      crcFixed = true;
      break;
    }
    case 'innerStream': {
      const sp = split(base);
      const k = ri(3);
      if (rng() < 0.65) { // 원스트림 변조 → 엔트로피 재부호화 → 내부 복호기까지 도달
        sp.streams[k] = entropyEncode(mutateRawBytes(entropyDecode(sp.streams[k])));
      } else { // 엔트로피 컨테이너·범위 부호 payload 변조
        const s = Uint8Array.from(sp.streams[k]);
        const c = ri(3);
        if (c === 0) s[ri(s.length)] ^= 1 << ri(8);
        else if (c === 1) s[ri(s.length)] = ri(256);
        else sp.streams[k] = s.slice(0, ri(s.length + 1));
        if (c !== 2) sp.streams[k] = s;
      }
      file = assemble(sp);
      crcFixed = true;
      break;
    }
    case 'header': {
      const f = ri(7);
      if (f === 0) file[OFFSETS.format] = pick([0, 2, 3, 255]);
      else if (f === 1) file[OFFSETS.codec] = pick([0, 2, 3, 255]);
      else if (f === 2) file[OFFSETS.quantExp] = ri(256);
      else if (f === 3) new DataView(file.buffer).setUint16(OFFSETS.headerSize, pick([0, 4, 127, 128, 132, 256, 65532]), true);
      else if (f === 4) new DataView(file.buffer).setUint16(OFFSETS.versionMajor, pick([0, 2, 65535]), true);
      else if (f === 5) { const sp = split(base); sp.pre[0] = pick([0, 2, 255]); sp.pre[2] = 1 + ri(255); sp.pre[3] = ri(256); file = assemble(sp); }
      else setU32(file, OFFSETS.bodyBytes, pick([0, 15, 16, 0xffffffff, file.length, file.length - HEADER_SIZE + 1]));
      fix();
      break;
    }
    default: throw new Error(kind);
  }
  return { file, kind, crcFixed };
}

// ---- 호출 감시: 시간·할당(타입 배열 생성 바이트 합) ----
const TA = ['Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'Uint8ClampedArray', 'BigInt64Array', 'BigUint64Array'];
let allocBytes = 0;
const origs = {};
function bytesOf(T, a0) {
  const bpe = T.BYTES_PER_ELEMENT;
  if (typeof a0 === 'number') return a0 * bpe;
  if (a0 && typeof a0 === 'object') {
    if (typeof a0.byteLength === 'number') return a0.byteLength; // 버퍼·타입 배열 복사
    if (typeof a0.length === 'number') return a0.length * bpe;
  }
  return 0;
}
function install() {
  for (const name of TA) {
    const T = globalThis[name];
    origs[name] = T;
    globalThis[name] = new Proxy(T, { construct(t, args) { allocBytes += bytesOf(t, args[0]); return Reflect.construct(t, args); } });
  }
  const AB = globalThis.ArrayBuffer;
  origs.ArrayBuffer = AB;
  globalThis.ArrayBuffer = new Proxy(AB, { construct(t, args) { allocBytes += typeof args[0] === 'number' ? args[0] : 0; return Reflect.construct(t, args); } });
}
function uninstall() { for (const [k, v] of Object.entries(origs)) globalThis[k] = v; }

function run(fn, input) {
  allocBytes = 0;
  const t0 = performance.now();
  let res, err;
  try { res = fn(input); } catch (e) { err = e; }
  return { res, err, ms: performance.now() - t0, alloc: allocBytes };
}
const allowed = (e) => e instanceof CodecError || e instanceof AssetFormatError;
const outcomeKey = (e) => (e instanceof CodecError ? `Codec:${e.code}` : `Asset:${e.code}`);

function planesOfRaw(file) { // 서버가 낸 codec 0 파일의 평면(계약 bodyLayout 기준)
  const h = parseHeader(file);
  const { planes } = bodyLayout(h.format, h.pointCount);
  const out = {};
  for (const p of planes) {
    const raw = file.slice(h.headerSize + p.offset, h.headerSize + p.offset + p.bytes);
    out[p.name] = p.type === 'u16' ? new Uint16Array(raw.buffer) : p.type === 'i8' ? new Int8Array(raw.buffer) : raw;
  }
  return out;
}
const b64 = (u8) => Buffer.from(u8).toString('base64');

test('기준 파일 무변형 복호: 서버·클라이언트 모두 원본 점 집합과 같다(퍼저 전제 확인)', () => {
  for (let i = 0; i < bases.length; i++) {
    const expect = pointMultiset(planesOfRaw(rawFiles[i]));
    assert.equal(expect.length, SPECS[i][0]);
    const lossy = SPECS[i][2];
    const srv = pointMultiset(planesOfRaw(decodeChunk(bases[i])));
    const cli = pointMultiset(decodeChunkClient(bases[i]).planes);
    assert.deepEqual(cli, srv);
    if (!lossy) assert.deepEqual(srv, expect); // 무손실 색은 원본과 같은 점 집합
  }
});

const finding = { 큰할당: [], 수용거부불일치: [], counts: {} }; // 첫 시험이 채우고 뒤 시험이 단언한다

test('변이 10만 회: 서버·클라이언트가 CodecError/AssetFormatError 만 던지거나 같은 점 집합을 낸다', { timeout: 240_000 }, () => {
  const fails = { 다른예외: [], 시간초과: [], 큰할당: [], 점집합불일치: [], 수용거부불일치: [] };
  const whyCount = {}, whyFirst = {};
  const rep = (cat, info) => { const wk = cat + ' | ' + info.kind + ' | ' + info.why.replace(/[0-9]+ B/, 'N B').replace(/[0-9.]+ ms/, 'N ms'); whyCount[wk] = (whyCount[wk] ?? 0) + 1; whyFirst[wk] ??= info.base64; if (fails[cat].length < MAX_REPORT) fails[cat].push(info); fails[cat].count = (fails[cat].count ?? 0) + 1; };
  const dist = { server: {}, client: {} };
  const byKind = {};
  let okBoth = 0, fixedCrc = 0, inner = 0, maxMs = 0, maxAlloc = 0, inflatedMaxAlloc = 0;
  const INNER_CODES = new Set(['stream', 'range', 'limit', 'mode']);
  const cpu0 = process.cpuUsage();

  install();
  try {
    for (let it = 0; it < ITERATIONS; it++) {
      const kind = pick(KIND_BAG);
      let m = mutate(kind);
      if (rng() < 0.2) { // 20% 는 변이를 한 번 더 겹친다(결과 파일을 새 기준으로 쓰기 어려우므로 비트 한 개 추가)
        m.file[ri(m.file.length)] ^= 1 << ri(8);
        if (m.crcFixed && rng() < 0.7) setCrc(m.file);
      }
      const { file } = m;
      if (m.crcFixed) fixedCrc++;
      byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
      const info = (why) => ({ kind: m.kind, why, base64: b64(file) });

      const tag = {};
      for (const [name, fn] of [['server', decodeChunk], ['client', decodeChunkClient]]) {
        let r = run(fn, file);
        if (r.ms > MAX_CALL_MS) r = run(fn, file); // 일시적 GC·스케줄링 잡음은 같은 입력 재시도로 거른다
        maxMs = Math.max(maxMs, r.ms);
        maxAlloc = Math.max(maxAlloc, r.alloc);
        if (m.kind === 'pointCount' || m.kind === 'rawLenInflate') inflatedMaxAlloc = Math.max(inflatedMaxAlloc, r.alloc);
        if (r.err && !allowed(r.err)) rep('다른예외', info(`${name}: ${r.err?.constructor?.name} ${String(r.err?.message).slice(0, 120)}`));
        if (r.ms > MAX_CALL_MS) rep('시간초과', info(`${name}: ${r.ms.toFixed(1)} ms`));
        if (r.alloc > MAX_ALLOC_BYTES) rep('큰할당', info(`${name}: ${r.alloc} B`));
        const key = r.err ? outcomeKey(r.err) : 'ok';
        dist[name][key] = (dist[name][key] ?? 0) + 1;
        tag[name] = r;
      }
      const s = tag.server, c = tag.client;
      if (!s.err && !c.err) {
        okBoth++;
        const a = pointMultiset(planesOfRaw(s.res));
        const b = pointMultiset(c.res.planes);
        if (a.length !== b.length || a.some((v, i) => v !== b[i])) rep('점집합불일치', info('서버·클라 점 집합 다름'));
      } else if (!s.err !== !c.err && file[OFFSETS.codec] === 1) { // codec 바이트가 바뀐 입력은 제외: 클라이언트는 codec 0 도 읽으므로 서버(codec 1 전용)와 계약상 다르다
        rep('수용거부불일치', info(`server=${s.err ? outcomeKey(s.err) : 'ok'} client=${c.err ? outcomeKey(c.err) : 'ok'}`));
      }
      if (m.crcFixed && (!s.err || (s.err instanceof CodecError && INNER_CODES.has(s.err.code)))) inner++;
    }
  } finally { uninstall(); }

  const cpu = process.cpuUsage(cpu0);
  const cpuS = (cpu.user + cpu.system) / 1e6;
  console.log(JSON.stringify({ whyCount, ITERATIONS, okBoth, fixedCrc, inner, byKind, dist, maxMs: +maxMs.toFixed(2), maxAllocBytes: maxAlloc, inflatedMaxAllocBytes: inflatedMaxAlloc, cpuSeconds: +cpuS.toFixed(1) }, null, 1));

  if (process.env.ROBUST_DUMP) writeFileSync(process.env.ROBUST_DUMP, JSON.stringify(whyFirst, null, 1)); // 진단용: 실패 종류별 첫 재현 입력
  finding.큰할당 = fails.큰할당; finding.수용거부불일치 = fails.수용거부불일치; finding.counts = { whyCount };
  delete fails.큰할당; delete fails.수용거부불일치; // 아래 두 시험이 따로 단언한다
  const failMsg = Object.entries(fails).filter(([, v]) => v.length).map(([k, v]) => `${k} ${v.count}건: ${JSON.stringify(v)}`).join('\n');
  assert.equal(failMsg, '', `퍼징 실패 재현 입력(base64):\n${failMsg}`);
  assert.ok(fixedCrc >= MIN_FIXED_CRC, `체크섬 재계산 변이 ${fixedCrc} < ${MIN_FIXED_CRC}`);
  assert.ok(inner >= MIN_INNER_REACHED, `내부 복호기 도달 ${inner} < ${MIN_INNER_REACHED}`);
  assert.ok(okBoth >= 5000, `정상 반환 ${okBoth} < 5000(비교 단언이 얇다)`);
  for (const code of ['stream', 'range', 'limit', 'mode', 'length', 'checksum', 'format']) {
    assert.ok(dist.server[`Codec:${code}`] > 0, `서버 거부 코드 ${code} 가 한 번도 안 나왔다(변이가 그 경로에 못 닿는다)`);
  }
});

test('변이 퍼징 중 서버·클라이언트 수용/거부 일치(불일치 0건)', () => {
  const f = finding.수용거부불일치;
  assert.equal(f.length, 0, `불일치 ${f.count}건: ${JSON.stringify(f)}`);
});
test('변이 퍼징 중 호출당 할당 4 MiB 이하(큰 할당 0건)', () => {
  const f = finding.큰할당;
  assert.equal(f.length, 0, `큰 할당 ${f.count}건: ${JSON.stringify(f)}`);
});

const clientAlloc = [];
test('점 수 부풀림: 체크섬을 맞춘 거대 점 수가 큰 할당·긴 시간 없이 거부된다', () => {
  install();
  try {
    for (const big of [POINT_COUNT_MAX, POINT_COUNT_MAX - 1, 1 << 21, 1 << 16, 100_000]) {
      const f = bases[2].slice(); // n = 5
      setU32(f, OFFSETS.pointCount, big);
      setCrc(f);
      for (const fn of [decodeChunk, decodeChunkClient]) {
        const r = run(fn, f);
        assert.ok(r.err && allowed(r.err), `n=${big}: 거부되어야 한다`);
        assert.ok(r.ms <= MAX_CALL_MS, `n=${big}: ${r.ms} ms`);
        if (fn === decodeChunk) assert.ok(r.alloc <= MAX_ALLOC_BYTES, `서버 n=${big}: 할당 ${r.alloc} B`);
        else clientAlloc.push([big, r.alloc]);
      }
    }
  } finally { uninstall(); }
});

test('점 수 부풀림: 클라이언트 할당도 4 MiB 이하', () => {
  assert.ok(clientAlloc.length === 5, '클라이언트 할당 측정이 비었다');
  for (const [big, alloc] of clientAlloc) assert.ok(alloc <= MAX_ALLOC_BYTES, `클라이언트 n=${big}: 할당 ${alloc} B`);
});

test('헤더 의미 규칙 위반(체크섬 맞춤): 서버·클라이언트가 모두 거부한다', () => {
  const dvOf = (f) => new DataView(f.buffer, f.byteOffset, f.byteLength);
  const cases = {
    'quantExp 7': (f) => { f[OFFSETS.quantExp] = 7; },
    'quantExp 11': (f) => { f[OFFSETS.quantExp] = 11; },
    'tileSizeM 65': (f) => dvOf(f).setUint16(OFFSETS.tileSizeM, 65, true),
    'lod 8': (f) => { f[OFFSETS.lod] = 8; },
    'bbox 최솟값 NaN': (f) => dvOf(f).setFloat64(OFFSETS.bboxMin, NaN, true),
    'bbox min > max': (f) => dvOf(f).setFloat64(OFFSETS.bboxMin + 8, 1e6, true),
    '타일 밖(tileX 변경)': (f) => dvOf(f).setInt32(OFFSETS.tileX, 5, true),
    'anchor 무한': (f) => dvOf(f).setFloat64(OFFSETS.anchorLat, Infinity, true),
    'reserved 비0(minor 0)': (f) => { f[OFFSETS.reserved] = 1; },
  };
  for (const [name, mut] of Object.entries(cases)) {
    for (const base of bases) {
      const f = base.slice();
      mut(f);
      setCrc(f);
      assert.throws(() => decodeChunk(f), allowed, `서버가 받았다: ${name}`);
      assert.throws(() => decodeChunkClient(f), allowed, `클라이언트가 받았다: ${name}`);
    }
  }
});
