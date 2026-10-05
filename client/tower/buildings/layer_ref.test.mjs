// 건물 층 대 독립 참조(광선 추적) 비교. 시드 1~6 × 카메라 3종 × 옵션 3종.
// 일치율 분모는 층 또는 참조가 덮은 화소(배경 제외). 기준값은 이 파일 안 숫자다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuildingsLayer } from './index.mjs';
import { makeBundle, makeCameras } from './test_support/fixtures.mjs';
import { refRenderBuildings } from './ref_trace.mjs';
import { BUILDINGS_DEFAULTS } from '../../../contracts/controlview/buildings.mjs';
import { DISPLAY_MODES } from '../../../contracts/tower_assets/index.mjs';

const SEEDS = [1, 2, 3, 4, 5, 6];
// 덮인 화소 일치율 하한. aerial·points 는 선이 없어 경계 화소 몇 개뿐이어야 한다(0.99). black 은 선 폭 규칙이 층(주축 한 화소)과
// 참조(중심에서 0.5 px)에서 달라 선 가장자리 화소가 갈린다(선 길이에 비례하는 몫이라 0.95, 선 겹침은 따로 단언).
const MIN_COVERED_AGREE = { aerial: 0.99, points: 0.99, black: 0.95 };
const MIN_LINE_OVERLAP = 0.9; // 층 선 화소 중 참조 선(1 px 안)과 겹치는 비율 하한
const MAX_DEPTH_ERR = 1e-3; // 같은 화소를 둘 다 덮을 때 깊이 오차(m)
const LINE = BUILDINGS_DEFAULTS.lineRgb;
const isLine = (r, p) => r.color[3 * p] === LINE[0] && r.color[3 * p + 1] === LINE[1] && r.color[3 * p + 2] === LINE[2];
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function compare(cam, got, ref, mode) {
  const n = cam.width * cam.height;
  let covered = 0; let agree = 0; let worst = 0; let lineGot = 0; let lineOverlap = 0;
  for (let p = 0; p < n; p++) {
    const g = got.depth[p] > 0; const r = ref.depth[p] > 0;
    if (!g && !r) continue;
    if (mode === 'black' && g && isLine(got, p)) {
      // 선 화소: 참조(lines:true) 선 화소가 1 px 안에 있으면 겹침. 겹치면 일치로 센다.
      lineGot++;
      const x = p % cam.width; const y = (p - x) / cam.width;
      let hit = false;
      for (let dy = -1; dy <= 1 && !hit; dy++) for (let dx = -1; dx <= 1 && !hit; dx++) {
        const xx = x + dx; const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= cam.width || yy >= cam.height) continue;
        if (isLine(ref, yy * cam.width + xx)) hit = true;
      }
      if (hit) lineOverlap++;
      covered++; if (hit) agree++;
      continue;
    }
    covered++;
    if (g && r && got.index[p] === ref.index[p]
      && near(got.color[3 * p], ref.color[3 * p], 3) && near(got.color[3 * p + 1], ref.color[3 * p + 1], 3) && near(got.color[3 * p + 2], ref.color[3 * p + 2], 3)) {
      agree++;
      worst = Math.max(worst, Math.abs(got.depth[p] - ref.depth[p]));
    }
  }
  return { covered, agree, worst, lineGot, lineOverlap };
}

test('층 render 는 광선 추적 참조와 일치한다(덮인 화소 기준, 시드 6 × 카메라 3 × 옵션 3)', () => {
  const cams = makeCameras({ width: 160, height: 90 });
  let total = 0;
  for (const seed of SEEDS) {
    const bundle = makeBundle(seed, { count: 6 });
    const layer = createBuildingsLayer();
    layer.accept(3, bundle);
    for (const cam of cams) {
      for (const mode of DISPLAY_MODES) {
        layer.setMode(mode);
        const got = layer.render(cam);
        // black 은 선 포함 참조(lines:true)와 비교한다. 선 화소는 위 compare 가 따로 본다.
        const ref = refRenderBuildings(cam, bundle, mode, { lines: mode === 'black' });
        const s = compare(cam, got, ref, mode);
        const tag = `seed ${seed} ${cam.name} ${mode}`;
        assert.ok(s.covered > 0, `${tag}: 덮인 화소 0`);
        assert.ok(s.agree / s.covered >= MIN_COVERED_AGREE[mode], `${tag}: 덮인 화소 일치율 ${(s.agree / s.covered).toFixed(4)} < ${MIN_COVERED_AGREE[mode]}`);
        assert.ok(s.worst <= MAX_DEPTH_ERR, `${tag}: 깊이 오차 ${s.worst}`);
        if (mode === 'black') {
          assert.ok(s.lineGot > 0, `${tag}: 층 선 화소 0`);
          assert.ok(s.lineOverlap / s.lineGot >= MIN_LINE_OVERLAP, `${tag}: 선 겹침 ${(s.lineOverlap / s.lineGot).toFixed(3)} < ${MIN_LINE_OVERLAP}`);
        }
        total++;
      }
    }
  }
  assert.equal(total, 54);
});

test('points: 묶음마다 index 가 참조와 같다(묶음 누락 검출)', () => {
  const cam = makeCameras({ width: 160, height: 90 })[0];
  const bundle = makeBundle(2, { count: 6 });
  const layer = createBuildingsLayer({ mode: 'points' });
  layer.accept(3, bundle);
  const got = layer.render(cam);
  const ref = refRenderBuildings(cam, bundle, 'points');
  const gotGroups = new Set(); const refGroups = new Set();
  for (let p = 0; p < got.index.length; p++) { if (got.depth[p] > 0) gotGroups.add(got.index[p]); if (ref.depth[p] > 0) refGroups.add(ref.index[p]); }
  assert.ok(refGroups.size > 1, '참조에 점이 있는 묶음이 둘 이상이어야 한다');
  assert.deepEqual([...gotGroups].sort((a, b) => a - b), [...refGroups].sort((a, b) => a - b));
  let diff = 0;
  for (let p = 0; p < got.index.length; p++) if ((got.depth[p] > 0) !== (ref.depth[p] > 0) || (got.depth[p] > 0 && got.index[p] !== ref.index[p])) diff++;
  assert.equal(diff, 0, '점 화소·묶음 번호가 참조와 완전히 같아야 한다');
});
