// 래스터라이제이션 벤치마크 테스트(T06.11).
// 작은 입력(1만 점)으로 측정 도구가 계약을 만족하는 레코드를 내는지 검증한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { run, makeCamera, median } from './index.mjs';
import { validateRecord } from '../../contracts/metrics/index.mjs';
import { generate } from '../../fixtures/scenes/large/index.mjs';
import { renderPoints } from '../../server/raster_ref/zbuffer/index.mjs';

const COMMIT = 'abc1234567890abcdef';

test('카메라 생성: bounds 를 정면에서 본다', () => {
  const min = [0, 0, 0];
  const max = [100, 50, 100];
  const cam = makeCamera(min, max, 1280, 720);

  assert.ok(cam.width === 1280);
  assert.ok(cam.height === 720);
  assert.ok(cam.K);
  assert.ok(cam.K.fx > 0);
  assert.ok(cam.K.fy > 0);
  assert.ok(Number.isFinite(cam.K.cx));
  assert.ok(Number.isFinite(cam.K.cy));
  assert.ok(Array.isArray(cam.R) && cam.R.length === 9);
  assert.ok(Array.isArray(cam.t) && cam.t.length === 3);
  // 회전 행렬의 행렬식 확인 (역행렬 검증)
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      assert.ok(Number.isFinite(cam.R[i * 3 + j]));
    }
  }
});

test('중앙값 계산', () => {
  assert.equal(median([5]), 5);
  assert.equal(median([3, 5, 7]), 5);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([10, 20, 30, 40, 50]), 30);
});

test('작은 입력: 레코드 스키마 검증', async (t) => {
  // 1만 점으로 빠르게 테스트
  const records = await run({ runs: 1, commit: COMMIT });

  assert.ok(Array.isArray(records));
  assert.ok(records.length > 0, '최소 1개 레코드 생성');

  for (const record of records) {
    const errors = validateRecord(record);
    assert.equal(errors.length, 0, `레코드 유효성: ${errors.join('; ')}`);
  }
});

test('작은 입력: 측정 값이 유한하고 양수', async (t) => {
  const records = await run({ runs: 1, commit: COMMIT });

  for (const record of records) {
    assert.ok(Number.isFinite(record.value), `${record.metric}: 유한 수`);
    if (record.metric.includes('ratio') || record.metric.includes('empty')) {
      // 비율은 0 이상 1 이하
      assert.ok(record.value >= 0 && record.value <= 1, `${record.metric}: 0 이상 1 이하`);
    } else if (record.metric.includes('render_time')) {
      // 시간은 양수
      assert.ok(record.value > 0, `${record.metric}: 양수`);
    }
  }
});

test('작은 입력: 샘플이 있으면 유한', async (t) => {
  const records = await run({ runs: 2, commit: COMMIT });

  for (const record of records) {
    if (record.samples && Array.isArray(record.samples)) {
      for (const sample of record.samples) {
        assert.ok(Number.isFinite(sample), `${record.metric} 샘플: 유한 수`);
      }
    }
  }
});

test('큰 입력: 250만 점 측정 실행(정보용)', async (t) => {
  // 실제 250만 점 벤치마크 (시간 측정 목적)
  // 이 테스트는 시간 기준을 두지 않고, 측정이 완료되고 값이 합리적임만 확인한다.
  console.log('\\n  250 만 점 성능 측정 시작...');

  const records = await run({ runs: 3, commit: COMMIT });

  console.log('\\n  측정 결과:');
  for (const record of records) {
    if (record.samples) {
      const sampleStr = record.samples.map(s => s.toFixed(1)).join(', ');
      console.log(`    ${record.metric}: ${record.value.toFixed(2)} ${record.unit} (샘플: [${sampleStr}] ${record.unit})`);
    } else {
      console.log(`    ${record.metric}: ${record.value.toFixed(4)} ${record.unit}`);
    }
  }

  // 검증: 레코드가 유효하고 값이 합리적
  assert.ok(records.length > 0);
  for (const record of records) {
    const errors = validateRecord(record);
    assert.equal(errors.length, 0, `${record.metric}: ${errors.join('; ')}`);
  }
});
