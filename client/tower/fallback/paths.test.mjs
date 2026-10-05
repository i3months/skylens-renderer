// 관제탑 폴백 경로 그리기 목록(paths.mjs) 시험. 기준 수치는 손으로 계산해 시험 안에 박아 두었다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaths } from './paths.mjs';

// 장면: 800×600, 중심 (e=100, n=200), 1 px = 2 m.  x = 400 + (e−100)/2,  y = 300 − (n−200)/2.
const VIEW = { centerE: 100, centerN: 200, metersPerPx: 2 };
const SIZE = { width: 800, height: 600 };

test('paths: 점 전부 순서 유지', () => {
  const paths = [
    { id: 'a', points: [[100, 200, 5], [110, 210, 6], [-100, 0, 7], [10100, 200, 8]] },
    { id: 'b', points: [[100, 200, 0]] },
    { id: 'c', points: [] },
  ];
  const snapshot = JSON.stringify(paths);
  const out = buildPaths(VIEW, SIZE, paths);

  // 입력 순서·id 유지, 점 수 보존(화면 밖 점도 남는다)
  assert.deepEqual(out.map((p) => p.id), ['a', 'b', 'c']);
  assert.deepEqual(out.map((p) => p.polyline.length), [4, 1, 0]);

  // 손계산: (100,200)->(400,300), (110,210)->(405,295), (-100,0)->(300,400), (10100,200)->(5400,300)
  assert.deepEqual(out[0].polyline, [{ x: 400, y: 300 }, { x: 405, y: 295 }, { x: 300, y: 400 }, { x: 5400, y: 300 }]);
  assert.deepEqual(out[1].polyline, [{ x: 400, y: 300 }]);

  // 입력 불변, 결과는 새 객체
  assert.equal(JSON.stringify(paths), snapshot);
  assert.notEqual(out, paths);
  assert.notEqual(out[0], paths[0]);
  assert.notEqual(out[0].polyline, paths[0].points);

  // 경로가 없으면 빈 배열
  assert.deepEqual(buildPaths(VIEW, SIZE, []), []);

  // 한 경로 10만 점 한 번 변환이 1 초 안에 끝난다(느슨한 합계 기준)
  const N = 100000;
  const big = { id: 'big', points: Array.from({ length: N }, (_, i) => [i, -i, 0]) };
  const t0 = performance.now();
  const r = buildPaths(VIEW, SIZE, [big]);
  const ms = performance.now() - t0;
  assert.equal(r[0].polyline.length, N);
  assert.deepEqual(r[0].polyline[N - 1], { x: 400 + (N - 1 - 100) / 2, y: 300 - (-(N - 1) - 200) / 2 });
  assert.ok(ms < 1000, `10만 점 변환 ${ms.toFixed(1)} ms`);
});
