import test from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readPlyStream } from './index.mjs';
import { PROPERTIES, FORMAT_POINT27, FORMAT_GAUSS56, stride } from '../../../contracts/points/index.mjs';

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

test('250만 점 27 B 가상 스트림: 추가 메모리 증가 ≤ 32 MB', async () => {
  const N = 2_500_000, ST = 27, LIMIT = 32 * 1024 * 1024;
  async function* gen() {
    yield header(FORMAT_POINT27, N);
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
  console.log(`memory peak increase: ${(peak / 1048576).toFixed(2)} MB (limit 32 MB)`);
  assert.ok(peak <= LIMIT, `peak ${peak}`);
});
