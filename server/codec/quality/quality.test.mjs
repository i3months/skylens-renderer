// T09.10 양자화 후 화질 시험. 문턱 0.98 은 낮추지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { codecQualityEight, codecRoundTrip, reorderCloud, SCENES, QUALITY_MIN_SSIM } from './index.mjs';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';

test('문턱은 0.98 이다', () => assert.equal(QUALITY_MIN_SSIM, 0.98));

test('왕복은 점 수를 보존하고 위치 오차가 2^-9 m(+f32 여유) 이하다', () => {
  const { cloud } = generate({ seed: 1, count: 20000 });
  const rt = codecRoundTrip(cloud);
  assert.equal(rt.cloud.count, 20000);
  assert.ok(rt.chunks > 1, '여러 타일로 나뉘어야 함');
  // 순서가 모턴 순으로 바뀌므로 점 집합을 축별 정렬해 비교하는 대신, 바운딩 상자와 색 합계(무손실)를 본다.
  const sum = (c) => c.colors.reduce((s, v) => s + v, 0);
  assert.equal(sum(rt.cloud), sum(cloud));
  for (let a = 0; a < 3; a++) {
    let mn = Infinity, mx = -Infinity, mn2 = Infinity, mx2 = -Infinity;
    for (let i = 0; i < 20000; i++) {
      mn = Math.min(mn, cloud.positions[3 * i + a]); mx = Math.max(mx, cloud.positions[3 * i + a]);
      mn2 = Math.min(mn2, rt.cloud.positions[3 * i + a]); mx2 = Math.max(mx2, rt.cloud.positions[3 * i + a]);
    }
    assert.ok(Math.abs(mn - mn2) < 0.002 && Math.abs(mx - mx2) < 0.002, `축 ${a} 범위 변동`);
  }
  assert.ok(rt.codecBytes < rt.rawBytes, '압축되어야 함');
});

for (const sceneId of ['flat_boxes', 'terrain', 'holes']) {
  for (const lossyColor of [false, true]) {
    test(`${sceneId} lossyColor=${lossyColor}: 8 시점 SSIM ≥ ${QUALITY_MIN_SSIM}`, (t) => {
      const r = codecQualityEight(sceneId, { lossyColor });
      assert.equal(r.rows.length, 8);
      assert.equal(SCENES[sceneId].vps.length, 8);
      for (const row of r.rows) t.diagnostic(`${sceneId} lossy=${lossyColor} ${row.vp} SSIM ${row.ssim.toFixed(5)}`);
      t.diagnostic(`${sceneId} lossy=${lossyColor} 최소 ${r.min.toFixed(5)} 조각 ${r.chunks} 원 ${r.rawBytes} B → ${r.codecBytes} B`);
      if (sceneId === 'holes') t.diagnostic(`holes lossy=${lossyColor} 8시점 최솟값 ${r.min.toFixed(5)}`);
      for (const row of r.rows) assert.ok(row.ssim >= 0.98, `${sceneId} ${row.vp}: SSIM ${row.ssim}`);
    });
  }
}

test('변이: 왕복 결과 위치를 0.3 m 밀면 같은 문턱이 잡아낸다(단언이 항상 참이 아님)', () => {
  const shift = (c) => { const p = Float32Array.from(c.positions); for (let i = 0; i < p.length; i += 3) p[i] += 0.3; return { ...c, positions: p }; };
  const r = codecQualityEight('flat_boxes', { mutate: shift });
  assert.ok(r.min < 0.98, `변이 SSIM ${r.min}`);
});

test('왕복 순열은 실제다: 재배열한 원본이 왕복 위치와 양자화 오차(2^-8 m 격자 반칸 + f32 여유) 안에서 점마다 일치하고 순열이 전단사', () => {
  const { cloud } = generate({ seed: 1, count: 20000 });
  const rt = codecRoundTrip(cloud);
  assert.equal(rt.perm.length, 20000);
  assert.equal(new Set(rt.perm).size, 20000, '순열은 전단사여야 함');
  assert.ok(rt.perm.some((v, k) => v !== k), '항등이 아니어야 함');
  const ref = reorderCloud(cloud, rt.perm);
  for (let i = 0; i < 3 * 20000; i++) {
    assert.ok(Math.abs(ref.positions[i] - rt.cloud.positions[i]) <= 2 ** -9 + 1e-3, `위치 ${i}: ${ref.positions[i]} vs ${rt.cloud.positions[i]}`);
  }
  // 색은 무손실이므로 점마다 정확히 일치해야 한다
  assert.deepEqual(ref.colors, rt.cloud.colors);
});

test('변이: 순열 재배열을 빼면(원본 순서 기준) holes 단언이 실패한다', () => {
  const r = codecQualityEight('holes', { alignReference: false });
  assert.ok(r.min < 0.98, `재배열 없는 holes 최솟값 ${r.min}`);
});

test('진단: holes top_down_150 의 원본 순서 기준 값(단언 근거 아님)', (t) => {
  const a = codecQualityEight('holes', { alignReference: false });
  const b = codecQualityEight('holes', {});
  t.diagnostic(`holes top_down_150 순서 미정렬 ${a.rows[0].ssim.toFixed(4)} / 정렬 ${b.rows[0].ssim.toFixed(4)}`);
});
