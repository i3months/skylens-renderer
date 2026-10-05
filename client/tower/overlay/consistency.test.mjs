// clip.mjs 의 카메라 공간 투영이 projectPoints 와 벌어지지 않게 지킨다(0052 대가)
// 같은 점을 projectPoints 와 clipPolyline 으로 투영했을 때 u·v·depth 가 같은지 확인해 두 구현이 벌어지지 않게 지킨다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPoints, unprojectPoint } from './project.mjs';
import { clipPolyline } from './clip.mjs';
import { poseToView } from './view.mjs';
import { poseToCameraPose } from '../input/camera.mjs';
import { TOWER_OVERLAY_LIMITS } from '../../../contracts/controlview/overlay.mjs';

// 허용 상대 오차. 실측 최대(아래 출력)의 10 배 이내로 둔다.
const REL_TOL = 1e-9;

/** 시드 고정 의사난수(mulberry32). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rel = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));

test('consistency: projectPoints 와 clipPolyline 의 u·v·depth 가 같다(무작위 시점 200개)', () => {
  const rnd = mulberry32(0xc0551);
  const nearM = TOWER_OVERLAY_LIMITS.nearM;
  let maxRel = 0;
  let checked = 0;
  for (let k = 0; k < 200; k += 1) {
    const pos = [0, 1, 2].map(() => (rnd() * 2 - 1) * 5000);
    const fovY = 0.2 + rnd() * 2.6;
    const cam = poseToCameraPose({ pos, yaw: (rnd() * 2 - 1) * Math.PI, pitch: (rnd() * 2 - 1) * (Math.PI / 2) }, fovY);
    const size = { width: 1 + Math.floor(rnd() * 3840), height: 1 + Math.floor(rnd() * 2160) };
    const view = poseToView(cam, size);
    // 가시 범위: 화면 안의 (u, v) 와 깊이 nearM·2 ~ 2000 m 를 역투영해 ENU 점을 만든다.
    const pts = [];
    for (let i = 0; i < 20; i += 1) {
      pts.push(unprojectPoint(view, rnd() * size.width, rnd() * size.height, nearM * 2 + rnd() * 2000));
    }
    const proj = projectPoints(view, pts.map((enu, i) => ({ id: `p${i}`, enu })));
    // 인접한 두 점마다 2점 polyline 으로 자른다(둘 다 앞이므로 그대로 두 점이 나온다).
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const r = clipPolyline(view, [pts[i], pts[i + 1]], nearM);
      assert.equal(r.length, 1, `자세 ${k} 쌍 ${i}`);
      assert.equal(r[0].length, 2);
      for (let j = 0; j < 2; j += 1) {
        const a = proj[i + j];
        const b = r[0][j];
        assert.equal(a.depth >= nearM, true);
        for (const key of ['u', 'v', 'depth']) {
          const e = rel(a[key], b[key]);
          if (e > maxRel) maxRel = e;
          assert.ok(e <= REL_TOL, `자세 ${k} 점 ${i + j} ${key}: ${a[key]} vs ${b[key]} (상대 ${e})`);
        }
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 1500, `확인한 점 ${checked}개`);
  console.log(`# 투영 일관성: 점 ${checked}개, 최대 상대 오차 ${maxRel.toExponential(3)} (허용 ${REL_TOL})`);
});
