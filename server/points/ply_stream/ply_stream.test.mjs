import test from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readPlyStream } from './index.mjs';
import { countCopiesAsync, countBytesAsync } from '../test_util/copies.mjs';
import { PointsError, PROPERTIES, FORMAT_POINT27, FORMAT_GAUSS56, stride } from '../../../contracts/points/index.mjs';

const header = (format, n) => Buffer.from(
  `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${PROPERTIES[format].map((p) => `property ${p.type} ${p.name}`).join('\n')}\nend_header\n`);

// 합성 점군: 값은 인덱스에서 결정하고 기대 열 배열도 함께 만든다
function synth(format, n) {
  const st = stride(PROPERTIES[format]);
  const body = Buffer.alloc(st * n);
  const exp = format === FORMAT_POINT27
    ? { positions: new Float32Array(3 * n), normals: new Float32Array(3 * n), colors: new Uint8Array(3 * n) }
    : { positions: new Float32Array(3 * n), fdc: new Float32Array(3 * n), opacity: new Float32Array(n), scales: new Float32Array(3 * n), rotations: new Float32Array(4 * n) };
  for (let i = 0; i < n; i++) {
    const o = i * st;
    const fl = (k, v) => body.writeFloatLE(v, o + 4 * k);
    for (let k = 0; k < 3; k++) { exp.positions[3 * i + k] = i * 1.5 + k * 0.25 - 100; fl(k, exp.positions[3 * i + k]); }
    if (format === FORMAT_POINT27) {
      for (let k = 0; k < 3; k++) {
        exp.normals[3 * i + k] = (i + k) / 7; fl(3 + k, exp.normals[3 * i + k]);
        exp.colors[3 * i + k] = (i * 3 + k) & 255; body[o + 24 + k] = exp.colors[3 * i + k];
      }
    } else {
      for (let k = 0; k < 3; k++) {
        exp.fdc[3 * i + k] = i * 0.01 + k; fl(3 + k, exp.fdc[3 * i + k]);
        exp.scales[3 * i + k] = -i * 0.02 - k; fl(7 + k, exp.scales[3 * i + k]);
      }
      exp.opacity[i] = i * 0.5 - 3; fl(6, exp.opacity[i]);
      for (let k = 0; k < 4; k++) { exp.rotations[4 * i + k] = i + k * 0.125; fl(10 + k, exp.rotations[4 * i + k]); }
    }
  }
  return { bytes: Buffer.concat([header(format, n), body]), exp };
}

function* slices(buf, size) { for (let o = 0; o < buf.length; o += size) yield buf.subarray(o, o + size); }

async function collect(source, opts) {
  const parts = [];
  for await (const c of readPlyStream(source, opts)) parts.push(c);
  return parts;
}
function concatCols(parts) {
  const out = {};
  for (const key of Object.keys(parts[0]).filter((k) => ArrayBuffer.isView(parts[0][k]))) {
    out[key] = new parts[0][key].constructor(parts.reduce((s, p) => s + p[key].length, 0));
    let o = 0;
    for (const p of parts) { out[key].set(p[key], o); o += p[key].length; }
  }
  return out;
}

for (const format of [FORMAT_POINT27, FORMAT_GAUSS56]) {
  for (const size of [1, 7, 4096]) {
    test(`형식 ${format} 을 ${size} 바이트씩 잘라도 값이 같다`, async () => {
      const { bytes, exp } = synth(format, 1000);
      const parts = await collect(slices(bytes, size), { chunkPoints: 300 });
      assert.deepEqual(parts.map((p) => p.count), [300, 300, 300, 100]);
      const got = concatCols(parts);
      for (const k of Object.keys(exp)) assert.deepEqual(got[k], exp[k], k);
    });
  }
}

test('비동기 소스와 기본 chunkPoints', async () => {
  const { bytes, exp } = synth(FORMAT_GAUSS56, 70000);
  async function* src() { for (const c of slices(bytes, 10007)) yield c; }
  const parts = await collect(src());
  assert.deepEqual(parts.map((p) => p.count), [65536, 4464]);
  assert.deepEqual(concatCols(parts).positions, exp.positions);
});

test('점 0개는 조각 없이 끝난다', async () => {
  assert.deepEqual(await collect([header(FORMAT_POINT27, 0)]), []);
});

test('음성: 본문이 모자라면 truncated', async () => {
  const { bytes } = synth(FORMAT_POINT27, 10);
  for (const cut of [1, 13, 27, 100]) {
    await assert.rejects(collect(slices(bytes.subarray(0, bytes.length - cut), 5)), { code: 'truncated' });
  }
});

test('음성: 본문이 남으면 size', async () => {
  const { bytes } = synth(FORMAT_GAUSS56, 10);
  await assert.rejects(collect(slices(Buffer.concat([bytes, Buffer.from([0])]), 9)), { code: 'size' });
  await assert.rejects(collect(slices(Buffer.concat([bytes, Buffer.alloc(56)]), 1000)), { code: 'size' });
});

test('음성: 머리 오류와 모르는 형식', async () => {
  const { bytes } = synth(FORMAT_POINT27, 3);
  await assert.rejects(collect(slices(bytes.subarray(0, 20), 3)), { code: 'header' });
  await assert.rejects(collect([Buffer.from('nope\nend_header\n')]), { code: 'header' });
  const odd = 'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n' + 'x'.repeat(12);
  await assert.rejects(collect(slices(Buffer.from(odd), 5)), { code: 'format' });
});

test('음성: chunkPoints 와 헤더 vertexCount 상한은 range', async () => {
  const big = 2 ** 31 - 1;
  for (const chunkPoints of [big, (1 << 20) + 1, 0, -1, 1.5, NaN]) {
    await assert.rejects(collect([header(FORMAT_POINT27, 1)], { chunkPoints }), (e) => e instanceof PointsError && e.code === 'range', String(chunkPoints));
  }
  for (const n of [big, 2 ** 30 + 1, 2 ** 53]) {
    await assert.rejects(collect([header(FORMAT_POINT27, n)]), (e) => e instanceof PointsError && e.code === 'range', String(n));
  }
  await assert.rejects(collect([header(FORMAT_GAUSS56, big)], { chunkPoints: big }), (e) => e instanceof PointsError && e.code === 'range');
  // 상한 값 자체는 통과해 본문 부족(truncated)으로 끝난다
  await assert.rejects(collect([header(FORMAT_POINT27, 5)], { chunkPoints: 1 << 20 }), { code: 'truncated' });
});

test('음성: null 소스와 문자열 청크는 header', async () => {
  const isHeader = (e) => e instanceof PointsError && e.code === 'header';
  await assert.rejects(collect(null), isHeader);
  await assert.rejects(collect(undefined), isHeader);
  await assert.rejects(collect(42), isHeader);
  await assert.rejects(collect('ply\nend_header\n'), isHeader);
  await assert.rejects(collect(['ply\n', 'end_header\n']), isHeader);
  await assert.rejects(collect([null]), isHeader);
  const { bytes } = synth(FORMAT_POINT27, 2);
  await assert.rejects(collect([bytes.subarray(0, header(FORMAT_POINT27, 2).length), 'text']), isHeader);
});

const LIMIT = 1 << 20; // 구현의 MAX_HEADER 와 같은 값(머리 상한)
// 길이가 정확히 total 바이트인 유효 머리(주석 줄로 채운다)
function paddedHeader(total) {
  const pre = header(FORMAT_POINT27, 1).toString('latin1').replace('end_header\n', '');
  const post = 'end_header\n';
  const padLen = total - pre.length - post.length - 'comment \n'.length; // 주석 한 줄
  assert.ok(padLen >= 0);
  const h = Buffer.from(pre + 'comment ' + 'a'.repeat(padLen) + '\n' + post, 'latin1');
  assert.equal(h.length, total);
  return h;
}
const withinLimit = (e) => e instanceof PointsError && e.code === 'header' && /within limit/.test(e.message);

test('음성: end_header 가 상한(1 MiB)을 넘으면 읽기를 멈추고 within limit', async () => {
  // 상한 + 1 바이트 쓰레기 뒤에 무한 제너레이터: 한도 초과 순간 이후로는 더 당겨 읽지 않는다
  for (const size of [LIMIT + 1, 4096, 1000]) {
    const junk = Buffer.alloc(LIMIT + 1, 0x61);
    let pulled = 0;
    const fed = Math.ceil(junk.length / size);
    function* src() {
      for (let o = 0; o < junk.length; o += size) { pulled++; yield junk.subarray(o, o + size); }
      for (;;) { pulled++; if (pulled > fed + 3) return; yield Buffer.alloc(1, 0x61); } // 무한(안전망으로 3 번 뒤 종료)
    }
    await assert.rejects(collect(src()), withinLimit, `size ${size}`);
    assert.ok(pulled <= fed, `size ${size}: 한도 초과 뒤에도 ${pulled - fed} 청크를 더 당김`);
  }
  // 비동기 무한 소스도 마찬가지
  let pulledA = 0;
  async function* inf() { for (;;) { pulledA++; if (pulledA > 5000) return; yield Buffer.alloc(4096, 0x61); } }
  await assert.rejects(collect(inf()), withinLimit);
  assert.ok(pulledA <= LIMIT / 4096 + 1, `pulled ${pulledA}`);
  // 한 청크 안에 상한 초과 쓰레기 + end_header 가 함께 있어도 거부
  const one = Buffer.concat([Buffer.alloc(LIMIT + 10, 0x61), Buffer.from('end_header\n')]);
  await assert.rejects(collect([one]), withinLimit);
  // 앞에 작은 청크가 쌓인 뒤 큰 청크 하나에 쓰레기 + end_header
  await assert.rejects(collect([Buffer.alloc(100, 0x61), one]), withinLimit);
});

test('경계: end_header 로 끝나는 머리가 정확히 1 MiB 면 성공, 1 바이트 늘면 실패', async () => {
  for (const size of [Infinity, 4096, 4097, 1 << 16]) {
    const mk = (total) => { const h = paddedHeader(total); const body = Buffer.alloc(27); return Buffer.concat([h, body]); };
    const sl = (buf) => (size === Infinity ? [buf] : slices(buf, size));
    const ok = await collect(sl(mk(LIMIT)));
    assert.equal(ok.length, 1, `size ${size}`);
    await assert.rejects(collect(sl(mk(LIMIT + 1))), withinLimit, `size ${size}`);
    await assert.rejects(collect(sl(mk(LIMIT + 4096))), withinLimit, `size ${size}`);
    assert.equal((await collect(sl(mk(LIMIT - 1)))).length, 1);
  }
});

test('opts 가 null/undefined 여도 기본값으로 동작한다', async () => {
  const { bytes, exp } = synth(FORMAT_POINT27, 5);
  for (const opts of [null, undefined]) {
    const parts = await collect(slices(bytes, 7), opts);
    assert.deepEqual(concatCols(parts).positions, exp.positions);
  }
});

test('머리 누적 복사량은 입력 길이에 선형이고 큰 청크의 본문은 복사하지 않는다', async () => {
  // 벽시계 대신 Buffer 로 새로 만든 바이트 수를 센다(결정적). 1바이트 청크 100만 개: 선형이면 ~2 MiB 이하, 2차 누적이면 수 TB
  const junk = Buffer.alloc(LIMIT, 0x61);
  const chunks = [...slices(junk, 1)];
  const copiedJunk = await countCopiesAsync(() => assert.rejects(collect(chunks), { code: 'header' }));
  console.log(`1-byte header chunks x ${junk.length}: copied ${copiedJunk} B`);
  assert.ok(copiedJunk <= 2 * junk.length + 65536, `copied ${copiedJunk}`);
  // 상한을 넘는 큰 청크(표시 없음): 상한 확인 전에 복사하지 않는다
  const big = Buffer.alloc(8 << 20, 0x61);
  const copiedBigJunk = await countCopiesAsync(() => assert.rejects(collect([big]), withinLimit));
  assert.ok(copiedBigJunk <= 8192, `copied ${copiedBigJunk}`);
  // 머리 + 큰 본문이 한 청크: 머리 바이트(+4 KiB 블록) 만 복사하고 본문(≈8 MB)은 뷰로 읽는다
  const { bytes } = synth(FORMAT_POINT27, 300000);
  const h = header(FORMAT_POINT27, 300000);
  let n = 0;
  const copiedBody = await countCopiesAsync(async () => { for await (const c of readPlyStream([bytes], { chunkPoints: 65536 })) n += c.count; });
  assert.equal(n, 300000);
  assert.ok(copiedBody <= h.length + 8192, `copied ${copiedBody} (header ${h.length})`);
  // `new Uint8Array(len)` + set 로 본문을 옮기는 변형은 copied 에 안 잡히므로 Uint8Array(길이) 할당량 상한으로 막는다.
  // 정당한 할당: 출력 colors 3 B × 300000 점 = 900000 B + 레코드 경계 이월 stride(27) 정도. 본문 복사는 ≈8.1 MB.
  const allocBody = await countBytesAsync(async () => { for await (const c of readPlyStream([bytes], { chunkPoints: 65536 })) void c; });
  assert.ok(allocBody.allocated <= 3 * 300000 + 65536, `Uint8Array(len) 할당 ${allocBody.allocated} B`);
  // 머리 청크 + 본문이 여러 청크(레코드 경계와 안 맞는 크기): 본문 청크는 복사하지 않는다(머리 뒤 본문 복사 변형 검출)
  const bodyOnly = bytes.subarray(h.length);
  const multi = [bytes.subarray(0, h.length), ...slices(bodyOnly, 100003)];
  let nMulti = 0;
  const copiedMulti = await countCopiesAsync(async () => { for await (const c of readPlyStream(multi, { chunkPoints: 65536 })) nMulti += c.count; });
  assert.equal(nMulti, 300000);
  const allocMulti = await countBytesAsync(async () => { for await (const c of readPlyStream(multi, { chunkPoints: 65536 })) void c; });
  assert.ok(allocMulti.allocated <= 3 * 300000 + 65536, `Uint8Array(len) 할당(다중 청크) ${allocMulti.allocated} B`);
  assert.ok(copiedMulti <= h.length + 8192 + 27 * 4, `copied ${copiedMulti} (header ${h.length})`);
  // 정상 머리 + 본문도 1바이트 청크로 값이 같다(경계에 걸친 end_header 포함)
  const s20 = synth(FORMAT_POINT27, 20);
  assert.deepEqual(concatCols(await collect(slices(s20.bytes, 1))).positions, s20.exp.positions);
});

test('호출자가 같은 Buffer 를 덮어쓰며 청크를 넘겨도 머리와 값이 같다(버퍼 재사용)', async () => {
  // 머리를 4 KiB 블록보다 길게(주석 줄) 만들어 작은 청크 경로와 큰 청크 경로를 모두 지난다
  const { bytes, exp } = synth(FORMAT_POINT27, 50);
  const h = header(FORMAT_POINT27, 50);
  const text = h.toString('latin1').replace('end_header\n', `comment ${'a'.repeat(10000)}\nend_header\n`);
  const full = Buffer.concat([Buffer.from(text, 'latin1'), bytes.subarray(h.length)]);
  for (const size of [1, 7, 100, 4095, 4096, 5000]) {
    const scratch = Buffer.alloc(size);
    async function* reuse() {
      for (let o = 0; o < full.length; o += size) {
        const n = Math.min(size, full.length - o);
        full.copy(scratch, 0, o, o + n);
        yield scratch.subarray(0, n);
        scratch.fill(0xee); // 소비된 뒤 덮어쓴다: 참조만 보관했다면 머리가 깨진다
      }
    }
    const parts = await collect(reuse());
    assert.deepEqual(concatCols(parts).positions, exp.positions, `size ${size}`);
    assert.deepEqual(concatCols(parts).colors, exp.colors, `size ${size}`);
  }
});

// 청크마다 GC 후 보유량(arrayBuffers + heapUsed 의 기준선 대비 증가)의 최댓값을 잰다. 한계는 SPEC 의 32 MB 그대로다.
for (const [format, ST] of [[FORMAT_POINT27, 27], [FORMAT_GAUSS56, 56]]) {
  test(`250만 점 ${ST} B 가상 스트림: 청크마다 GC 후 보유량 증가 ≤ 32 MB`, async () => {
    const N = 2_500_000, LIMIT = 32 * 1024 * 1024;
    async function* gen() {
      yield header(format, N);
      const total = N * ST;
      let made = 0;
      while (made < total) {
        const len = Math.min(28007 + (made % 13), total - made); // 레코드 경계와 안 맞는 크기
        const b = Buffer.allocUnsafe(len);
        for (let k = 0; k < len; k++) b[k] = (made + k) % ST;
        made += len;
        yield b;
      }
    }
    const mem = () => { const m = process.memoryUsage(); return m.arrayBuffers + m.heapUsed; };
    // 쓰레기가 아니라 붙들고 있는 양을 재려고 청크마다 GC 를 강제한다(--expose-gc 없이 v8 플래그로 gc 함수를 얻는다)
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    gc();
    const base = mem();
    let peak = 0, pts = 0;
    for await (const c of readPlyStream(gen(), { chunkPoints: 16384 })) {
      pts += c.count;
      gc();
      peak = Math.max(peak, mem() - base);
    }
    assert.equal(pts, N);
    console.log(`memory (per-chunk post-GC retained) format ${format} ${ST} B: peak increase ${(peak / 1048576).toFixed(2)} MB (limit 32 MB)`);
    assert.ok(peak <= LIMIT, `peak ${peak}`);
  });
}
