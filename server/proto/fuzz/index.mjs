// 프로토콜 퍼저(T11.10). 고정 시드 PRNG 로 (a) 완전 무작위 바이트 (b) 유효 프레임의 변형(비트 뒤집기·잘라내기·늘리기·
// 머리 필드 변조·PIECE_REQUEST count/ERROR msgLen 변조)을 복호기에 먹이고 아래를 단언한다.
//   1. 예외는 ProtoError 뿐이다(그 밖의 예외 = 패닉).
//   2. 복호가 성공하면 encode → decode 가 같은 메시지를 돌려준다.
//   3. 한 입력당 복호 시간이 TIME_LIMIT_MS 이하다.
//      근거: 입력 상한은 본문 4 MiB 이고 정상 복호는 수 ms 이내다. 200 ms 는 CI 의 GC·스케줄링 흔들림을 넉넉히 덮으면서
//      본문 길이·count 를 믿고 도는 이차·지수 시간 복호를 잡는다.
//   4. 할당이 입력 크기에 비례하는 선을 넘지 않는다. (a) 결과 구조 한계: items ≤ 입력/16, chunk ≤ 입력 길이, text ≤ 입력 길이.
//      (b) 복호 중 힙 증가 ≤ HEAP_BASE_BYTES + HEAP_PER_INPUT_BYTE × 입력 길이. count 가 거대해도 본문 길이로 먼저 거부해야 한다.
//      (c) 복호 중 ArrayBuffer 증가(process.memoryUsage().arrayBuffers) ≤ AB_BASE_BYTES + AB_PER_INPUT_BYTE × 입력 길이.
//          typed array·Buffer 는 힙(used_heap_size) 밖에 잡히므로 (b) 만으로는 count 를 믿고 선할당하는 복호기를 못 본다.
//   6. 기준 코덱(codec.reference.decode)이 주어지면 (성공/실패, code, 값)이 제품 복호와 같아야 한다(차등 비교).
//   5. 복호가 입력 바이트를 바꾸지 않는다.
// 이 모듈은 코덱을 import 하지 않는다. 복호·부호화 함수를 주입받는다.

export const TIME_LIMIT_MS = 200;
export const HEAP_BASE_BYTES = 8 * 1024 * 1024;
export const HEAP_PER_INPUT_BYTE = 64;
export const AB_BASE_BYTES = 1024 * 1024;
export const AB_PER_INPUT_BYTE = 16;
import { getHeapStatistics } from 'node:v8';
import { ProtoError, MSG, MAX_PAYLOAD_BYTES } from '../../../contracts/proto/index.mjs';

/** mulberry32. 고정 시드 → 결정적 수열. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), byte: () => Math.floor(next() * 256) };
}

function randBytes(rng, n) { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = rng.byte(); return b; }
const pick = (rng, arr) => arr[rng.int(arr.length)];

/** 시드용 유효 메시지. 두 방향 종류를 모두 만든다. */
export function randomMessage(rng, type) {
  const u32 = () => (rng.next() < 0.2 ? pick(rng, [0, 1, 0xffffffff, 0x7fffffff]) : Math.floor(rng.next() * 4294967296));
  const key = () => ({ segmentId: rng.int(1 << 20), level: rng.int(4), lod: rng.int(8), chunkIndex: rng.int(65536), tileX: rng.int(2000) - 1000, tileY: rng.int(2000) - 1000 });
  switch (type) {
    case 'HELLO': return { type, sessionId: u32(), lastPieceSeq: u32() };
    case 'VIEW_UPDATE': {
      const q = [rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5, rng.next() + 0.1];
      const n = Math.hypot(...q);
      return { type, viewSeq: u32(), pos: [0, 1, 2].map(() => Math.fround((rng.next() - 0.5) * 2000)), quat: q.map((v) => Math.fround(v / n)), fovY: Math.fround(0.2 + rng.next() * 2.5), width: 1 + rng.int(4096), height: 1 + rng.int(4096) };
    }
    case 'PIECE_REQUEST': return { type, reqId: u32(), items: Array.from({ length: rng.int(rng.next() < 0.1 ? 257 : 12) % 257 }, key) };
    case 'ACK': return { type, upToPieceSeq: u32() };
    case 'WELCOME': return { type, sessionId: u32(), resumed: rng.int(2) === 1, nextPieceSeq: Math.max(1, u32()) };
    case 'PIECE': return { type, pieceSeq: Math.max(1, u32()), key: key(), chunk: randBytes(rng, 1 + rng.int(rng.next() < 0.1 ? 3000 : 200)) };
    case 'LEVEL_ARRIVED': return { type, segmentId: rng.int(1 << 20), level: rng.int(4), pieceCount: 1 + rng.int(0xffffffff) };
    case 'MISSING': return { type, segmentId: rng.int(1 << 20) };
    case 'ERROR': return { type, code: 1 + rng.int(5), text: 'e'.repeat(rng.int(40)) + (rng.int(2) ? '오류' : '') };
  }
  throw new Error(`unknown type ${type}`);
}

const INTERESTING32 = [0, 1, 2, 7, 8, 9, 15, 16, 17, 255, 256, 257, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xfffffff0, 0xffffffff, MAX_PAYLOAD_BYTES - 1, MAX_PAYLOAD_BYTES, MAX_PAYLOAD_BYTES + 1];

/** 유효 프레임 하나를 변형한다. */
export function mutate(rng, frame) {
  let b = frame.slice();
  const dv = () => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const kind = rng.int(7);
  if (kind === 0) { // 비트 뒤집기 1~8 개
    const k = 1 + rng.int(8);
    for (let i = 0; i < k && b.length; i++) b[rng.int(b.length)] ^= 1 << rng.int(8);
  } else if (kind === 1) { // 잘라내기
    b = b.slice(0, rng.int(b.length + 1));
  } else if (kind === 2) { // 늘리기(무작위·0)
    const extra = 1 + rng.int(64), add = rng.int(2) ? randBytes(rng, extra) : new Uint8Array(extra);
    const c = new Uint8Array(b.length + extra); c.set(b); c.set(add, b.length); b = c;
  } else if (kind === 3 && b.length >= 8) { // 머리 필드 변조
    const f = rng.int(4);
    if (f === 0) b[0] = rng.int(2) ? pick(rng, [0, 10, 255, 6, 3]) : rng.byte();
    else if (f === 1) b[1] = pick(rng, [0, 2, 255, rng.byte()]);
    else if (f === 2) dv().setUint16(2, pick(rng, [1, 0xffff, 0x100, rng.int(65536)]), true);
    else dv().setUint32(4, rng.int(2) ? pick(rng, INTERESTING32) : Math.max(0, (b.length - 8) + rng.int(5) - 2), true);
  } else if (kind === 4 && b.length >= 14) { // PIECE_REQUEST count / ERROR msgLen 변조(어느 종류든 해당 오프셋을 건드린다)
    dv().setUint16(rng.int(2) ? 12 : 10, pick(rng, [0, 1, 255, 256, 257, 0xffff, 0x8000, rng.int(65536)]), true);
  } else if (kind === 5) { // 유효 머리 + 무작위 본문(본문 값 범위 검사 쪽을 친다)
    const body = randBytes(rng, rng.int(2) ? Math.max(0, b.length - 8) : rng.int(60));
    const c = new Uint8Array(8 + body.length); c.set(b.subarray(0, Math.min(8, b.length))); c.set(body, 8);
    if (c.length >= 8) new DataView(c.buffer).setUint32(4, body.length, true);
    b = c;
  } else { // 바이트 덮어쓰기·삽입
    if (b.length) b[rng.int(b.length)] = rng.byte();
  }
  return b;
}

const TYPES = Object.keys(MSG);

function sameMessage(a, b) {
  try { return JSON.stringify(norm(a)) === JSON.stringify(norm(b)); } catch { return false; }
}
function norm(v) {
  if (v instanceof Uint8Array) return { $u8: Array.from(v) };
  if (typeof v === 'number') return Object.is(v, -0) ? { $nz: 1 } : Number.isNaN(v) ? { $nan: 1 } : v;
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
  return v;
}

/**
 * 입력 하나를 검사한다. 위반이면 {kind, detail} 를, 아니면 null 을 돌려준다.
 * @param {{decode:Function, encode:Function, reference?:{decode:Function}}} codec
 */
export function checkOne(codec, input, opts = {}) {
  const timeLimit = opts.timeLimitMs ?? TIME_LIMIT_MS;
  const before = input.slice();
  const heap0 = getHeapStatistics().used_heap_size;
  const ab0 = process.memoryUsage().arrayBuffers;
  const t0 = performance.now();
  let msg, err;
  try { msg = codec.decode(input); } catch (e) { err = e; }
  const dt = performance.now() - t0;
  const heapGrow = getHeapStatistics().used_heap_size - heap0;
  const abGrow = process.memoryUsage().arrayBuffers - ab0;
  if (err !== undefined && !(err instanceof ProtoError)) return { kind: 'panic', detail: `${err?.name}: ${err?.message}` };
  if (dt > timeLimit) return { kind: 'time', detail: `${dt.toFixed(1)} ms > ${timeLimit}` };
  if (heapGrow > HEAP_BASE_BYTES + HEAP_PER_INPUT_BYTE * input.length) return { kind: 'alloc', detail: `heap +${heapGrow} B for input ${input.length} B` };
  if (abGrow > AB_BASE_BYTES + AB_PER_INPUT_BYTE * input.length) return { kind: 'alloc', detail: `arrayBuffers +${abGrow} B for input ${input.length} B` };
  if (input.length !== before.length || input.some((v, i) => v !== before[i])) return { kind: 'mutated-input', detail: 'decode changed input bytes' };
  if (codec.reference) { // 차등 비교: 기준 코덱과 (성공/실패, code, 값)이 같아야 한다.
    let rmsg, rerr;
    try { rmsg = codec.reference.decode(input.slice()); } catch (e) { rerr = e; }
    const sig = (m, e) => (e === undefined ? 'ok' : e instanceof ProtoError ? e.code : `panic:${e?.name}`);
    if (sig(msg, err) !== sig(rmsg, rerr)) return { kind: 'diff', detail: `product ${sig(msg, err)} vs reference ${sig(rmsg, rerr)}` };
    if (err === undefined && !sameMessage(msg, rmsg)) return { kind: 'diff', detail: `${msg.type} value differs from reference` };
  }
  if (err !== undefined) return null;
  // 결과 구조의 크기 한계(입력에 비례).
  if (msg.type === 'PIECE_REQUEST' && (msg.items.length > input.length / 16 || msg.items.length > 256)) return { kind: 'alloc', detail: `items ${msg.items.length} for input ${input.length}` };
  if (msg.type === 'PIECE' && msg.chunk.length > input.length) return { kind: 'alloc', detail: `chunk ${msg.chunk.length}` };
  if (msg.type === 'ERROR' && msg.text.length > input.length) return { kind: 'alloc', detail: `text ${msg.text.length}` };
  let again;
  try { again = codec.decode(codec.encode(msg)); } catch (e) { return { kind: 'roundtrip', detail: `re-encode/decode threw ${e?.name}: ${e?.message}` }; }
  if (!sameMessage(msg, again)) return { kind: 'roundtrip', detail: `${msg.type} differs after encode/decode` };
  return null;
}

/**
 * @param {{decode:Function, encode:Function, seedEncode:Function}} codec seedEncode: 시드 프레임 부호화(독립 구현 권장)
 * @param {{iterations:number, seed:number, stopAfter?:number}} opts
 * @returns {{runs:number, random:number, mutated:number, accepted:number, rejected:number, violations:Array}}
 */
export function runFuzz(codec, { iterations, seed, stopAfter = Infinity }) {
  const savedLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0; // 거부마다 스택을 캡처하는 비용이 10만 회 합에서 지배적이라 끈다(오류 이름·메시지는 그대로).
  try { return fuzzLoop(codec, { iterations, seed, stopAfter }); } finally { Error.stackTraceLimit = savedLimit; }
}

function fuzzLoop(codec, { iterations, seed, stopAfter }) {
  const rng = makeRng(seed);
  const res = { runs: 0, random: 0, mutated: 0, accepted: 0, rejected: 0, violations: [] };
  for (let i = 0; i < iterations && res.violations.length < stopAfter; i++) {
    let input;
    if (rng.next() < 0.3) { // (a) 완전 무작위 바이트
      const n = rng.next() < 0.7 ? rng.int(64) : rng.int(600);
      input = randBytes(rng, n); res.random++;
    } else { // (b) 유효 프레임 변형
      let f = codec.seedEncode(randomMessage(rng, pick(rng, TYPES)));
      const rounds = 1 + rng.int(3);
      for (let r = 0; r < rounds; r++) f = mutate(rng, f);
      input = f; res.mutated++;
      if (rng.int(10) === 0) input = codec.seedEncode(randomMessage(rng, pick(rng, TYPES))); // 무변형 유효 프레임도 섞는다(성공 경로 확보)
    }
    res.runs++;
    const v = checkOne(codec, input, opts_time);
    let ok = false;
    if (v) res.violations.push({ index: i, ...v, inputHex: Buffer.from(input.subarray(0, 64)).toString('hex') });
    else { try { codec.decode(input); ok = true; } catch { /* 거부 */ } }
    if (ok) res.accepted++; else if (!v) res.rejected++;
  }
  return res;
}
const opts_time = {};
