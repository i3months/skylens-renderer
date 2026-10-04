// T13.10 현황판 화질: 8시점 SSIM ≥ 0.95(SPEC 수치, 낮추지 않는다).
// 측정 경로(CPU): 컬링+LOD 선택 → 타일 조각 → codec 1 → 클라이언트 복호 → CPU 참조 래스터러. 코덱·LOD·컬링 손실만 잰다.
// client/raster(WebGL) 래스터 자체의 차이는 이 시험 밖이다(브라우저 캡처는 [local]).
import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_QUALITY_MIN_SSIM } from '../../contracts/statusview/index.mjs';
import { measureStatusQuality, VIEWPOINTS } from './index.mjs';

test('문턱은 SPEC 수치 0.95 이다', () => assert.equal(STATUS_QUALITY_MIN_SSIM, 0.95));

test('고정 시점은 8곳이다', () => assert.equal(VIEWPOINTS.length, 8));

test('현황판 경로 8시점 SSIM ≥ 0.95', async (t) => {
  const r = await measureStatusQuality();
  assert.equal(r.rows.length, 8);
  for (const row of r.rows) t.diagnostic(`${row.vp} SSIM ${row.ssim.toFixed(5)} 점 ${row.points}/${r.total} 조각 ${row.chunks} 바이트 ${row.bytes}`);
  t.diagnostic(`최소 SSIM ${r.min.toFixed(5)}`);
  for (const row of r.rows) assert.ok(row.ssim >= 0.95, `${row.vp}: SSIM ${row.ssim}`);
});

test('변이: 복호 결과 위치를 0.3 m 밀면 같은 문턱이 잡아낸다', async () => {
  const shift = (c) => { const p = Float32Array.from(c.positions); for (let i = 0; i < p.length; i += 3) p[i] += 0.3; return { ...c, positions: p }; };
  const r = await measureStatusQuality({ mutate: shift });
  assert.ok(r.min < 0.95, `변이 SSIM ${r.min}`);
});
