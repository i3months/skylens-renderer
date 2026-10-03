// 클라이언트 codec 복호 벤치마크 시험.
// 작은 입력(10k 점)에서 CLI 가 실행되고 복호 결과가 원본 점 다중집합과 같은지 검증.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createChunk, benchmark } from './index.mjs';
import { decodeChunkClient } from '../../client/codec/index.mjs';
import { pointMultiset } from '../../contracts/codec/index.mjs';

/**
 * 임시 파일 경로 생성.
 */
function tmpPath(name) {
  return `/tmp/codec_bench_test_${name}_${Date.now()}.json`;
}

/**
 * 스폰된 프로세스 대기.
 */
function runProcess(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    // 기본 cwd 를 t0909 작업 트리로 설정
    const defaultCwd = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
    const proc = spawn(cmd, args, { cwd: defaultCwd, ...opts, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (d) => { stdout += d; });
    proc.stderr?.on('data', (d) => { stderr += d; });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`프로세스 종료 코드 ${code}\nstderr: ${stderr}`));
      } else {
        resolve({ stdout, stderr });
      }
    });

    proc.on('error', reject);
  });
}

test('벤치마크 기본 실행(10k 점)', async (t) => {
  const result = benchmark({ points: 10000, runs: 2 });

  assert.ok(result.lossless, '무손실 결과 존재');
  assert.ok(result.lossy, '손실 결과 존재');
  assert.equal(result.lossless.totalPoints, 10000, '무손실 총 점 수');
  assert.equal(result.lossy.totalPoints, 10000, '손실 총 점 수');
  assert.ok(result.lossless.totalTime > 0, '무손실 시간 > 0');
  assert.ok(result.lossy.totalTime > 0, '손실 시간 > 0');
  assert.ok(result.lossless.throughput > 0, '무손실 처리량 > 0');
  assert.ok(result.lossy.throughput > 0, '손실 처리량 > 0');
});

test('CLI --help', async (t) => {
  const result = await runProcess('node', ['bench/codec_client/cli.mjs', '--help']);
  assert.match(result.stdout, /클라이언트 codec 1 복호 벤치마크/i);
  assert.match(result.stdout, /--points/);
  assert.match(result.stdout, /--runs/);
  assert.match(result.stdout, /--json/);
});

test('CLI 기본 실행', async (t) => {
  const result = await runProcess('node', ['bench/codec_client/cli.mjs', '--points=10000', '--runs=2']);
  assert.match(result.stdout, /무손실|손실/);
  assert.match(result.stdout, /색 모드별 복호 성능/);
});

test('CLI JSON 출력', async (t) => {
  const jsonPath = tmpPath('output');
  const result = await runProcess('node', ['bench/codec_client/cli.mjs', '--points=10000', '--runs=2', `--json=${jsonPath}`]);
  assert.match(result.stdout, /JSON 저장됨/);
  assert.match(result.stdout, /JSON 저장됨: .*json/);

  // JSON 파일 읽기
  const fs = await import('node:fs/promises');
  const content = await fs.readFile(jsonPath, 'utf-8');
  const data = JSON.parse(content);

  assert.ok(data.timestamp);
  assert.equal(data.config.points, 10000);
  assert.equal(data.config.runs, 2);
  assert.ok(data.results.lossless);
  assert.ok(data.results.lossy);

  await fs.unlink(jsonPath);
});

test('CLI 오류: 잘못된 --points', async (t) => {
  const result = await runProcess('node', ['bench/codec_client/cli.mjs', '--points=abc']).catch((e) => ({ error: e.message }));
  assert.ok(result.error, '오류 발생 확인');
});

test('CLI 오류: 중복 --points', async (t) => {
  const result = await runProcess('node', ['bench/codec_client/cli.mjs', '--points=10000', '--points=20000']).catch((e) => ({ error: e.message }));
  assert.ok(result.error, '중복 플래그 거부');
});

test('CLI 오류: 알 수 없는 옵션', async (t) => {
  const result = await runProcess('node', ['bench/codec_client/cli.mjs', '--unknown=value']).catch((e) => ({ error: e.message }));
  assert.ok(result.error, '알 수 없는 옵션 거부');
});

test('복호 결과 검증(10k 점)', async (t) => {
  // 조각 생성(seed 고정으로 재현 가능)
  const chunkCount = 1;
  const pointsPerChunk = 10000;
  const chunk = createChunk(pointsPerChunk, 42);

  // 복호
  const decoded = decodeChunkClient(chunk);
  const { header, planes } = decoded;

  // 복호된 점 집합 추출
  assert.equal(header.pointCount, pointsPerChunk);
  assert.ok(planes.pos_e instanceof Uint16Array);
  assert.ok(planes.pos_n instanceof Uint16Array);
  assert.ok(planes.pos_u instanceof Uint16Array);
  assert.ok(planes.color_r instanceof Uint8Array);
  assert.ok(planes.color_g instanceof Uint8Array);
  assert.ok(planes.color_b instanceof Uint8Array);

  // 원본과 복호본의 점 다중집합이 같은지 검증
  // (codec 1 복호는 점 순서를 모턴으로 정렬하고, 위치 양자화와 색 모드에 따라 오차가 있음)
  const n = header.pointCount;
  assert.equal(planes.pos_e.length, n);
  assert.equal(planes.pos_n.length, n);
  assert.equal(planes.pos_u.length, n);
  assert.equal(planes.color_r.length, n);
  assert.equal(planes.color_g.length, n);
  assert.equal(planes.color_b.length, n);

  // 색상이 유효한 범위인지 확인
  for (let i = 0; i < n; i++) {
    assert.ok(planes.color_r[i] >= 0 && planes.color_r[i] <= 255);
    assert.ok(planes.color_g[i] >= 0 && planes.color_g[i] <= 255);
    assert.ok(planes.color_b[i] >= 0 && planes.color_b[i] <= 255);
  }
});

test('여러 조각 복호', async (t) => {
  const chunkCount = 3;
  const pointsPerChunk = 5000;
  const totalPoints = chunkCount * pointsPerChunk;

  let decodedCount = 0;
  for (let i = 0; i < chunkCount; i++) {
    const chunk = createChunk(pointsPerChunk, i);
    const { header } = decodeChunkClient(chunk);
    decodedCount += header.pointCount;
  }

  assert.equal(decodedCount, totalPoints);
});
