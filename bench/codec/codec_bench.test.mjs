import test from 'node:test';
import assert from 'node:assert/strict';
import { generate as generateTerrain } from '../../fixtures/scenes/terrain/index.mjs';
import { generate as generateBuildings } from '../../fixtures/scenes/buildings/index.mjs';
import { measureCodecBytes } from './index.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 작은 장면(5k 점)에서 codec 1 본문 B/점 < 11 확인(codec 0 은 11 B/점).
 * 무손실·손실색 모두 확인.
 */
test('코덱 벤치: 작은 장면(5k 점) codec1 본문 B/점 < 11', () => {
  const scene = generateTerrain({ seed: 42, count: 5000, format: 1 });
  const result = measureCodecBytes(scene.cloud);

  const { pointCount, codec0, codec1Lossless, codec1Lossy } = result;

  // 기본 검사: 점 수가 맞아야 함
  assert.strictEqual(pointCount, 5000, '점 수 일치');

  // codec 0 본문은 11 B/점 (27 B 점 중 정확히 11 B만 위치가 취함)
  const codec0BodyBpp = codec0.bodyBytes / pointCount;
  assert.ok(codec0BodyBpp >= 10.9 && codec0BodyBpp <= 11.1, `codec0 본문 B/점 약 11 (실제: ${codec0BodyBpp.toFixed(4)})`);

  // codec 1 무손실: 본문 B/점 < 11
  const losslessBodyBpp = parseFloat(codec1Lossless.bodyBytesPerPoint);
  assert.ok(losslessBodyBpp < 11, `codec1-lossless 본문 B/점 < 11 (실제: ${losslessBodyBpp.toFixed(4)})`);

  // codec 1 손실: 본문 B/점 < 11 (더 작아야 함)
  const lossyBodyBpp = parseFloat(codec1Lossy.bodyBytesPerPoint);
  assert.ok(lossyBodyBpp < 11, `codec1-lossy 본문 B/점 < 11 (실제: ${lossyBodyBpp.toFixed(4)})`);

  console.log(`테스트 통과: codec1-lossless ${losslessBodyBpp.toFixed(4)} B/점, codec1-lossy ${lossyBodyBpp.toFixed(4)} B/점`);
});

/**
 * 다른 장면(buildings)에서 codec1 동작 확인(sparse 데이터이므로 B/점 제약 없음).
 */
test('코덱 벤치: buildings 장면(2k 점) codec1 동작', () => {
  const scene = generateBuildings({ seed: 7, count: 2000, format: 1 });
  const result = measureCodecBytes(scene.cloud);

  // sparse 데이터이므로 header 오버헤드가 크지만, 인코딩이 성공해야 함
  const codec1Lossless = result.codec1Lossless;
  assert.ok(codec1Lossless.bodyBytes > 0, 'codec1-lossless 본문 바이트 > 0');
  assert.ok(codec1Lossless.totalBytes > 0, 'codec1-lossless 합계 바이트 > 0');

  const codec1Lossy = result.codec1Lossy;
  assert.ok(codec1Lossy.bodyBytes > 0, 'codec1-lossy 본문 바이트 > 0');

  console.log(`테스트 통과: buildings 장면 codec1-lossless ${parseFloat(codec1Lossless.bodyBytesPerPoint).toFixed(4)} B/점`);
});

/**
 * CLI 인자 오류 시험: 점 수 없음 → exit 1
 */
test('코덱 벤치 CLI: 인자 오류(점 수 없음)', (t, done) => {
  const child = spawn('node', ['cli.mjs', 'terrain'], { cwd: __dirname });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });

  child.on('close', (code) => {
    assert.strictEqual(code, 1, 'exit code = 1');
    assert.ok(stderr.includes('오류') || stderr.includes('필요'), `stderr 에 오류 메시지 포함: ${stderr.substring(0, 100)}`);
    done();
  });
});

/**
 * CLI 인자 오류 시험: 알 수 없는 장면 → exit 1
 */
test('코덱 벤치 CLI: 인자 오류(알 수 없는 장면)', (t, done) => {
  const child = spawn('node', ['cli.mjs', 'unknown_scene', '1000'], { cwd: __dirname });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });

  child.on('close', (code) => {
    assert.strictEqual(code, 1, 'exit code = 1');
    assert.ok(stderr.includes('오류') || stderr.includes('알 수 없는'), `stderr 에 오류 메시지 포함: ${stderr.substring(0, 100)}`);
    done();
  });
});

/**
 * CLI 인자 오류 시험: 잘못된 점 수(음수) → exit 1
 */
test('코덱 벤치 CLI: 인자 오류(점 수 음수)', (t, done) => {
  const child = spawn('node', ['cli.mjs', 'terrain', '-100'], { cwd: __dirname });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });

  child.on('close', (code) => {
    assert.strictEqual(code, 1, 'exit code = 1');
    assert.ok(stderr.includes('오류') || stderr.includes('양의'), `stderr 에 오류 메시지 포함: ${stderr.substring(0, 100)}`);
    done();
  });
});

/**
 * CLI 정상 실행 시험: 작은 입력에서 성공 및 비율 수치 확인
 */
test('코덱 벤치 CLI: 정상 실행(terrain 2k 점)', (t, done) => {
  const child = spawn('node', ['cli.mjs', 'terrain', '2000'], { cwd: __dirname, timeout: 30000 });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });

  child.on('close', (code) => {
    assert.strictEqual(code, 0, `exit code = 0, stderr: ${stderr}`);
    assert.ok(stdout.includes('코덱 벤치마크'), '출력에 제목 포함');
    assert.ok(stdout.includes('codec1-lossless') || stdout.includes('무손실'), '출력에 codec1 결과 포함');

    // 수치 검증: codec1 본문 B/점 패턴 찾기
    const match = stdout.match(/codec1-lossless.*?(\d+\.\d+)\s+B\/점/);
    if (match) {
      const bpp = parseFloat(match[1]);
      assert.ok(bpp < 11, `codec1 본문 B/점 < 11 (실제: ${bpp})`);
    }

    done();
  });
});

/**
 * 왕복 검증: 다양한 크기에서 encodeChunk → decodeChunk 후 점 동일 확인
 */
test('코덱 벤치: 왕복 검증(다양한 크기)', () => {
  const sizes = [100, 1000, 5000];
  for (const n of sizes) {
    const scene = generateTerrain({ seed: 99, count: n, format: 1 });
    // 이 테스트는 measureCodecBytes 내부에서 단언됨
    const result = measureCodecBytes(scene.cloud);
    assert.strictEqual(result.pointCount, n, `크기 ${n}: 점 수 일치`);
  }
  console.log(`테스트 통과: 크기 ${sizes} 에서 왕복 검증 성공`);
});
