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
// 덮인 화소 일치율 하한 0.99. 선·선 불일치 검출(아래 참조)과 색 허용(±3, :69) 을 적용할 때 측정 최저 일치율은 0.9973(시드 1~6 × 카메라 3).
// aerial·points 는 선이 없어 경계 화소 몇 개뿐이어야 한다.
// black 은 선 폭 규칙이 층(주축 한 화소)과 참조(중심에서 0.5 px)에서 달라 선 가장자리 화소가 갈린다. 그래서 선 화소는 대칭 허용을 둔다:
// 층만 선이면 참조 선이, 참조만 선이면 층 선이 1 px 안에 있을 때 일치로 센다. 둘 다 선이면 index 같고 깊이 차가 상대 1 % 안이어야 한다.
// 선·선 불일치 개수와 참조 면 위 층 선 화소 수는 아래 상한 단언으로 따로 막는다(일치율에만 섞이지 않게).
const MIN_COVERED_AGREE = { aerial: 0.99, points: 0.99, black: 0.99 };
const MIN_LINE_OVERLAP = 0.9; // 층 선 화소 중 참조 선(1 px 안)과 겹치는 비율 하한
const MAX_LINE_DEPTH_REL = 0.01; // 둘 다 선인 화소의 깊이 차 상대 허용(선 표본 위치가 화소 안에서 달라 생기는 차). 선 깊이 편향 검출은 MAX_LINE_ON_REF_SURFACE(:22-24) 상한이 맡는다.
// 선·선 불일치(index 다름 또는 깊이 차 1 % 초과) 화소 수 상한. 원본 측정 최대 5(시드 1~6 × 카메라 3, top 카메라 시드 3), 여유 3 포함 8.
const MAX_LINE_MISMATCH = 8;
// 층 선이 참조 '면' 화소(참조는 선 아님) 위에 찍힌 화소 수 상한. 원본 측정 최대 24(eye17 시드 2), 여유 8 포함 32.
// 선 깊이 편향이 커지면 면 뒤의 선이 앞으로 나와 이 수가 늘어난다.
const MAX_LINE_ON_REF_SURFACE = 32;
const MAX_DEPTH_ERR = 1e-3; // 같은 화소를 둘 다 덮을 때 깊이 오차(m)
const LINE = BUILDINGS_DEFAULTS.lineRgb;
const isLine = (r, p) => r.color[3 * p] === LINE[0] && r.color[3 * p + 1] === LINE[1] && r.color[3 * p + 2] === LINE[2];
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function lineNear(cam, r, p) {
  const W = cam.width; const H = cam.height;
  const x = p % W; const y = (p - x) / W;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = x + dx; const yy = y + dy;
    if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
    if (isLine(r, yy * W + xx)) return true;
  }
  return false;
}

function compare(cam, got, ref, mode) {
  const n = cam.width * cam.height;
  let covered = 0; let agree = 0; let worst = 0; let lineGot = 0; let lineOverlap = 0; let worstLine = 0; let lineMismatch = 0; let lineOnSurface = 0;
  for (let p = 0; p < n; p++) {
    const g = got.depth[p] > 0; const r = ref.depth[p] > 0;
    if (!g && !r) continue;
    if (mode === 'black' && g && r && isLine(got, p) && isLine(ref, p)) {
      // 둘 다 선인 화소: 묶음 번호가 같고 깊이 차가 허용 안이어야 일치.
      lineGot++; lineOverlap++; covered++;
      const dd = Math.abs(got.depth[p] - ref.depth[p]);
      if (got.index[p] === ref.index[p] && dd <= MAX_LINE_DEPTH_REL * ref.depth[p]) { agree++; worstLine = Math.max(worstLine, dd); } else lineMismatch++;
      continue;
    }
    if (mode === 'black' && g && isLine(got, p)) {
      // 층만 선인 화소: 참조 선이 1 px 안에 있으면 겹침(선 폭 규칙 차이 허용)이라 일치로 센다.
      lineGot++; covered++;
      if (r) lineOnSurface++; // 참조는 선이 아닌 면 화소(위 분기에서 선·선은 이미 처리됨)
      if (lineNear(cam, ref, p)) { lineOverlap++; agree++; }
      continue;
    }
    if (mode === 'black' && r && isLine(ref, p)) {
      // 참조만 선인 화소(참조 0.5 px 선 폭): 대칭으로 층 선이 1 px 안에 있으면 일치로 센다.
      covered++;
      if (lineNear(cam, got, p)) agree++;
      continue;
    }
    covered++;
    if (g && r && got.index[p] === ref.index[p]
      && near(got.color[3 * p], ref.color[3 * p], 3) && near(got.color[3 * p + 1], ref.color[3 * p + 1], 3) && near(got.color[3 * p + 2], ref.color[3 * p + 2], 3)) {
      agree++;
      worst = Math.max(worst, Math.abs(got.depth[p] - ref.depth[p]));
    }
  }
  return { covered, agree, worst, lineGot, lineOverlap, worstLine, lineMismatch, lineOnSurface };
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
          assert.ok(s.lineMismatch <= MAX_LINE_MISMATCH, `${tag}: 선·선 불일치 ${s.lineMismatch} > ${MAX_LINE_MISMATCH}`);
          assert.ok(s.lineOnSurface <= MAX_LINE_ON_REF_SURFACE, `${tag}: 참조 면 위 층 선 ${s.lineOnSurface} > ${MAX_LINE_ON_REF_SURFACE}`);
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
