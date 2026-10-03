import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { crc32 } from 'node:zlib';
import { validateAsset } from './index.mjs';

const root = new URL('../../fixtures/asset_golden/', import.meta.url);
const load = (name) => new Uint8Array(readFileSync(new URL(name, root)));
const CLI = new URL('./cli.mjs', import.meta.url).pathname;

// 헤더·평면 오프셋은 명세 §3.1·§4.2 와 골든 사이드카의 숫자를 그대로 박는다.
/** 골든을 복사해 고치고, fix 이면 체크섬 필드를 다시 계산해 넣는다. */
function corrupt(name, edit, fix = true) {
  const b = load(name).slice();
  const dv = new DataView(b.buffer);
  edit(b, dv);
  if (fix) {
    const z = b.slice(0, Math.min(128 + dv.getUint32(36, true), b.length));
    z.fill(0, 112, 116);
    dv.setUint32(112, crc32(z) >>> 0, true);
  }
  return b;
}
const codes = (b) => validateAsset(b).map((v) => v.code);

test('골든 두 개는 위반 0, 기준 길이 480·512', () => {
  assert.equal(load('point27.skla').length, 480);
  assert.equal(load('gauss56.skla').length, 512);
  assert.deepEqual(validateAsset(load('point27.skla')), []);
  assert.deepEqual(validateAsset(load('gauss56.skla')), []);
});

test('손상: 매직', () => {
  assert.deepEqual(codes(corrupt('point27.skla', (b) => { b[0] = 0x58; })), ['magic']);
});
test('손상: 주 버전 2', () => {
  assert.deepEqual(codes(corrupt('point27.skla', (b, dv) => dv.setUint16(4, 2, true))), ['version']);
});
test('손상: header_size 130(4의 배수 아님)', () => {
  assert.deepEqual(codes(corrupt('point27.skla', (b, dv) => dv.setUint16(8, 130, true))), ['header_size']);
});
test('손상: 형식 값 9', () => {
  assert.deepEqual(codes(corrupt('point27.skla', (b) => { b[10] = 9; })), ['format']);
});
test('손상: 길이 짧음(480 -> 470)', () => {
  assert.deepEqual(codes(load('point27.skla').slice(0, 470)), ['body']);
});
test('손상: 길이 김(480 -> 484)', () => {
  const b = new Uint8Array(484);
  b.set(load('point27.skla'));
  assert.deepEqual(codes(b), ['body']);
});
test('손상: 체크섬(color_r 평면 1바이트 변경)', () => {
  assert.deepEqual(codes(corrupt('point27.skla', (b) => { b[128 + 192] ^= 0xff; }, false)), ['checksum']);
});
test('손상: 평면 채움 비0(gauss56 pos_e 끝, 본문 오프셋 42)', () => {
  assert.deepEqual(codes(corrupt('gauss56.skla', (b) => { b[128 + 42] = 1; })), ['body']);
});
test('손상: snorm -128(normal_oct_x, 본문 오프셋 288)', () => {
  assert.deepEqual(codes(corrupt('point27.skla', (b) => { b[128 + 288] = 0x80; })), ['range']);
});
test('손상: rot 성분 1023 > 1022(rotation, 본문 오프셋 300)', () => {
  assert.deepEqual(codes(corrupt('gauss56.skla', (b, dv) => dv.setUint32(128 + 300, 1023 << 20, true))), ['range']);
});
test('손상: bbox min > max (u 축 min = 3.9375)', () => {
  assert.deepEqual(codes(corrupt('point27.skla', (b, dv) => dv.setFloat64(40 + 16, 3.9375, true))), ['bbox']);
});
test('손상: quantExp 11', () => {
  assert.deepEqual(codes(corrupt('point27.skla', (b) => { b[31] = 11; })), ['field']);
});
test('손상: bbox 폭이 65535 단계 초과(u 폭 101 m, quantExp 10)', () => {
  assert.deepEqual(codes(corrupt('point27.skla', (b, dv) => dv.setFloat64(64 + 16, 102, true))), ['range']);
});

// 헤더 필드 손상: 체크섬을 다시 계산해 해당 위반 하나만 남긴다. 위반 목록 전체를 비교한다.
test('손상: tileX 2(bbox 가 타일 밖)', () => {
  const v = validateAsset(corrupt('point27.skla', (b, dv) => dv.setInt32(20, 2, true)));
  assert.deepEqual(v.map((x) => x.code), ['tile']);
  assert.match(v[0].message, /axis 0/);
});

test('손상: tileY 손상(y축 범위가 타일 밖)', () => {
  const v = validateAsset(corrupt('point27.skla', (b, dv) => dv.setInt32(24, 0, true)));
  assert.deepEqual(v.map((x) => x.code), ['tile']);
  assert.match(v[0].message, /axis 1/);
});
test('손상: codec 1', () => {
  assert.deepEqual(codes(corrupt('point27.skla', (b) => { b[11] = 1; })), ['codec']);
});
test('손상: anchor 위도 NaN', () => {
  assert.deepEqual(codes(corrupt('point27.skla', (b, dv) => dv.setFloat64(88, NaN, true))), ['field']);
});

test('손상: anchor 경도 Infinity', () => {
  assert.deepEqual(codes(corrupt('point27.skla', (b, dv) => dv.setFloat64(96, Infinity, true))), ['field']);
});

test('손상: anchor 고도 -Infinity', () => {
  assert.deepEqual(codes(corrupt('point27.skla', (b, dv) => dv.setFloat64(104, -Infinity, true))), ['field']);
});
test('손상: point_count 0', () => {
  assert.deepEqual(codes(corrupt('point27.skla', (b, dv) => dv.setUint32(16, 0, true))), ['field']);
});
test('손상: tile_size 63', () => {
  assert.deepEqual(codes(corrupt('point27.skla', (b, dv) => dv.setUint16(28, 63, true))), ['field']);
});
test('손상: lod 8', () => {
  assert.deepEqual(codes(corrupt('point27.skla', (b) => { b[30] = 8; })), ['field']);
});

test('독립 위반은 모두 보고한다(snorm -128 + 체크섬 미갱신)', () => {
  const b = corrupt('point27.skla', (x) => { x[128 + 288] = 0x80; }, false);
  assert.deepEqual(codes(b).sort(), ['checksum', 'range']);
});

test('부 버전 1 은 reserved 를 보지 않고 받아들인다', () => {
  const b = corrupt('point27.skla', (x, dv) => { dv.setUint16(6, 1, true); x[116] = 7; });
  assert.deepEqual(validateAsset(b), []);
});

test('부 버전 0 의 reserved 비0 은 거부', () => {
  assert.deepEqual(codes(corrupt('point27.skla', (x) => { x[116] = 7; })), ['reserved']);
});

test('빈·1바이트·무작위 입력에서 던지지 않고 위반을 낸다', () => {
  assert.deepEqual(codes(new Uint8Array(0)), ['short']);
  assert.deepEqual(codes(new Uint8Array(1)), ['short']);
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24);
  for (let i = 0; i < 300; i++) {
    const len = i < 150 ? i : 128 + (i % 400);
    const b = Uint8Array.from({ length: len }, rnd);
    if (i % 3 === 0 && len >= 12) b.set([0x53, 0x4b, 0x4c, 0x41, 1, 0, 0, 0, 128, 0, 1 + (i % 2)]); // 매직·버전·형식만 맞춰 더 깊이 들어가게
    const v = validateAsset(b);
    assert.ok(Array.isArray(v) && v.length >= 1);
    for (const x of v) {
      assert.equal(typeof x.code, 'string');
      assert.ok(!x.message.includes('validator failure'), `내부 예외: ${x.message}`); // 내부 예외 금지
    }
  }
  assert.ok(validateAsset(null).length >= 1);
});

test('cli: 골든은 종료 0, 손상 파일은 종료 1 과 code 출력', () => {
  const ok = spawnSync(process.execPath, [CLI, new URL('point27.skla', root).pathname], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  const f = join(mkdtempSync(join(tmpdir(), 'skla-')), 'bad.skla');
  writeFileSync(f, corrupt('point27.skla', (x) => { x[128 + 288] = 0x80; }));
  const bad = spawnSync(process.execPath, [CLI, f], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /range/);
});
