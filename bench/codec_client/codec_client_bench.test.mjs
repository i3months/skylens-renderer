// 클라이언트 codec 복호 벤치마크 시험.
// 작은 입력(10k 점)에서 CLI 가 실행되고 복호 결과가 원본 점 다중집합과 같은지 검증.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createChunk, benchmark, extractOriginalPlanes } from './index.mjs';
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

test('복호 결과 검증(10k 점, 무손실)', async (t) => {
  // 조각 생성(seed 고정으로 재현 가능, 무손실 모드)
  const pointsPerChunk = 10000;
  const chunk = createChunk(pointsPerChunk, 42, { lossy: false });

  // 복호
  const decoded = decodeChunkClient(chunk);
  const { header, planes: decodedPlanes, colorMode } = decoded;

  // 복호된 점 집합 추출
  assert.equal(header.pointCount, pointsPerChunk);
  assert.ok(decodedPlanes.pos_e instanceof Uint16Array);
  assert.ok(decodedPlanes.pos_n instanceof Uint16Array);
  assert.ok(decodedPlanes.pos_u instanceof Uint16Array);
  assert.ok(decodedPlanes.color_r instanceof Uint8Array);
  assert.ok(decodedPlanes.color_g instanceof Uint8Array);
  assert.ok(decodedPlanes.color_b instanceof Uint8Array);

  // 원본과 복호본의 점 다중집합이 같은지 검증(무손실)
  const originalPlanes = extractOriginalPlanes(pointsPerChunk, 42);
  const originalMultiset = pointMultiset(originalPlanes);
  const decodedMultiset = pointMultiset(decodedPlanes);
  assert.deepEqual(decodedMultiset, originalMultiset, '무손실 복호: 원본과 복호본 점 다중집합 일치');
});

test('손실 색 모드 검증(10k 점, 손실)', async (t) => {
  // 조각 생성(seed 고정으로 재현 가능, 손실 모드)
  const pointsPerChunk = 10000;
  const chunk = createChunk(pointsPerChunk, 43, { lossy: true });

  // 색 모드는 본문 offset 1 (body version 바로 다음)에 저장됨
  // 헤더 크기는 OFFSETS.headerSize(8) 에서 2바이트 little-endian
  const dv = new DataView(chunk.buffer, chunk.byteOffset);
  const headerSize = dv.getUint16(8, true);
  const colorMode = chunk[headerSize + 1];

  // 손실 모드에서 색 모드가 1 인지 확인
  assert.equal(colorMode, 1, '손실 모드 복호: 본문 색 스트림 첫 바이트(colorMode) === 1');

  // 복호 색을 원본 raw 파일 기준(복호 경로와 공유하지 않음)과 비교한다.
  // 복원 규칙: 복원 = ((v>>2)<<2)+2 이므로 v&3 = 0,1,2,3 에서 오차는 +2,+1,0,-1 이다.
  // 따라서 채널별 |Δ| ≤ 2 가 이론 상한이고, 10k 점 실측 최대 Δ 도 2 였다.
  const originalPlanes = extractOriginalPlanes(pointsPerChunk, 43);
  const { planes: decodedPlanes } = decodeChunkClient(chunk);
  // 복호 점 순서는 morton 순이라 위치(u16 3축)를 키로 원본 점과 짝짓는다(10k 점에서 키는 유일함).
  const key = (p, i) => `${p.pos_e[i]},${p.pos_n[i]},${p.pos_u[i]}`;
  const byPos = new Map();
  for (let i = 0; i < pointsPerChunk; i++) byPos.set(key(originalPlanes, i), i);
  assert.equal(byPos.size, pointsPerChunk, '원본 위치 키 유일');
  let maxDelta = 0;
  for (let i = 0; i < pointsPerChunk; i++) {
    const j = byPos.get(key(decodedPlanes, i));
    assert.notEqual(j, undefined, `복호 점 ${i} 에 대응하는 원본 점 존재`);
    for (const ch of ['color_r', 'color_g', 'color_b']) {
      maxDelta = Math.max(maxDelta, Math.abs(decodedPlanes[ch][i] - originalPlanes[ch][j]));
    }
  }
  assert.ok(maxDelta <= 2, `손실 색 채널별 최대 |Δ| ${maxDelta} ≤ 2`);
});

test('여러 조각 복호', async (t) => {
  const chunkCount = 3;
  const pointsPerChunk = 5000;
  const totalPoints = chunkCount * pointsPerChunk;

  let decodedCount = 0;
  for (let i = 0; i < chunkCount; i++) {
    const chunk = createChunk(pointsPerChunk, i, { lossy: false });
    const { header } = decodeChunkClient(chunk);
    decodedCount += header.pointCount;
  }

  assert.equal(decodedCount, totalPoints);
});
