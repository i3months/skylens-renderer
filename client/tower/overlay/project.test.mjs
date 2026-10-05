// 관제탑 오버레이 투영·역투영(project.mjs) 시험. 기준 수치는 손으로 계산해 시험 안에 박아 두었다.
// 카메라는 client/tower/input/camera.mjs poseToCameraPose → client/status/camera syncCamera 로 View 를 만든다
// (view.mjs 를 기다리지 않는다). 가장자리·넘침 시험은 View 를 직접 적는다(R = I, t = 0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectPoints, unprojectPoint } from './project.mjs';
import { poseToCameraPose } from '../input/camera.mjs';
import { syncCamera } from '../../status/camera/index.mjs';
import { CONTROLVIEW_OVERLAY_MAX_ENU_ERR_M } from '../../../contracts/controlview/index.mjs';
import { TOWER_OVERLAY_TEST_NAMES, TOWER_OVERLAY_MODULES, TOWER_OVERLAY_LIMITS } from '../../../contracts/controlview/overlay.mjs';

const NAME_KNOWN = 'project: 알려진 카메라·점의 화면 좌표(숫자 박음)';
const NAME_BEHIND = 'project: 카메라 뒤 점은 visible=false, u=v=0';
const NAME_ROUND = 'project: ENU 왕복 오차 ≤ 1 cm';
const PX_EPS = 1e-6;

/** Pose {pos, yaw, pitch} + fovY + 크기 → View. */
function viewOf(pos, yaw, pitch, fovY, width, height) {
  const cam = poseToCameraPose({ pos, yaw, pitch }, fovY);
  return syncCamera(cam, { width, height, devicePixelRatio: 1 }, 0).view;
}

/** R = I, t = 0, fx = fy = 360, 1280×720 인 View(가장자리 시험용). */
function identityView() {
  return { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], K: { fx: 360, fy: 360, cx: 640, cy: 360 }, width: 1280, height: 720 };
}

function near(actual, expected, eps, msg) {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg}: ${actual} vs ${expected}`);
}

function checkPoint(r, exp, msg) {
  assert.equal(r.id, exp.id, msg);
  near(r.u, exp.u, PX_EPS, `${msg} u`);
  near(r.v, exp.v, PX_EPS, `${msg} v`);
  near(r.depth, exp.depth, 1e-9, `${msg} depth`);
  assert.equal(r.visible, exp.visible, `${msg} visible`);
}

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

test('project: 계약의 시험 이름·모듈 파일·허용 오차', () => {
  for (const n of [NAME_KNOWN, NAME_BEHIND, NAME_ROUND]) assert.ok(TOWER_OVERLAY_TEST_NAMES.includes(n), n);
  assert.equal(TOWER_OVERLAY_MODULES.project.file, 'project.mjs');
  assert.equal(CONTROLVIEW_OVERLAY_MAX_ENU_ERR_M, 0.01);
  assert.equal(TOWER_OVERLAY_LIMITS.nearM, 0.1);
});

test(NAME_KNOWN, async (t) => {
  await t.test('fovY 0.9 rad, 1280×720, 카메라 [0,0,50] 에서 바로 아래를 본다(화면 위 = 북)', () => {
    // fy = 360/tan(0.45) = 745.25665006843654…; 앞 = −z, 오른쪽 = +x(동), 아래 = −y(남).
    const view = viewOf([0, 0, 50], 0, -Math.PI / 2, 0.9, 1280, 720);
    near(view.K.fy, 745.2566500684365, 1e-9, 'fy');
    const r = projectPoints(view, [
      { id: 'o', enu: [0, 0, 0] },
      { id: 'e', enu: [10, 0, 0] },
      { id: 'n', enu: [0, 10, 0] },
      { id: 'w', enu: [-20, -5, 10] },
    ]);
    checkPoint(r[0], { id: 'o', u: 640, v: 360, depth: 50, visible: true }, '원점');
    checkPoint(r[1], { id: 'e', u: 789.0513300136873, v: 360, depth: 50, visible: true }, '동 10 m');
    checkPoint(r[2], { id: 'n', u: 640, v: 210.9486699863127, depth: 50, visible: true }, '북 10 m');
    // d = 40, x = −20, y = +5: u = 640 − fy/2, v = 360 + fy/8
    checkPoint(r[3], { id: 'w', u: 267.37167496578173, v: 453.15708125855457, depth: 40, visible: true }, '서남 위');
  });

  await t.test('fovY π/2(fy = 360), 1280×720, 원점에서 북을 본다', () => {
    const view = viewOf([0, 0, 0], 0, 0, Math.PI / 2, 1280, 720);
    near(view.K.fy, 360, 1e-9, 'fy');
    const r = projectPoints(view, [{ id: 'a', enu: [100, 200, -50] }, { id: 'b', enu: [-300, 100, 0] }]);
    // a: d = 200, x = 100, y = 50 → u = 640 + 180, v = 360 + 90
    checkPoint(r[0], { id: 'a', u: 820, v: 450, depth: 200, visible: true }, 'a');
    // b: d = 100, x = −300 → u = 640 − 1080 = −440(화면 밖), v = 360
    checkPoint(r[1], { id: 'b', u: -440, v: 360, depth: 100, visible: false }, 'b');
  });

  await t.test('fovY π/2, 1280×720, 카메라 [10,20,30] 에서 동을 본다(yaw = π/2)', () => {
    // 앞 = +x, 오른쪽 = −y(남), 아래 = −z.
    const view = viewOf([10, 20, 30], Math.PI / 2, 0, Math.PI / 2, 1280, 720);
    const r = projectPoints(view, [{ id: 'p', enu: [100, -50, 25] }]);
    // 상대 [90, −70, −5]: d = 90, x = 70, y = 5 → u = 640 + 280, v = 360 + 20
    checkPoint(r[0], { id: 'p', u: 920, v: 380, depth: 90, visible: true }, 'p');
  });

  await t.test('fovY 2·atan(0.5)(fy = 720), 640×720, 북쪽 45° 위를 본다', () => {
    // pitch = π/4: 앞 = (0, √½, √½), 아래 = (0, √½, −√½). 점 [0, 100, 100] 은 d = 100√2, 화면 중앙.
    // 점 [3, 100, 100]: x = 3, d = 141.42135623730951 → u = 320 + 21.6/√2 = 335.2735064736294
    const view = viewOf([0, 0, 0], 0, Math.PI / 4, 2 * Math.atan(0.5), 640, 720);
    near(view.K.fy, 720, 1e-9, 'fy');
    const r = projectPoints(view, [{ id: 'c', enu: [0, 100, 100] }, { id: 'x', enu: [3, 100, 100] }]);
    checkPoint(r[0], { id: 'c', u: 320, v: 360, depth: 141.42135623730951, visible: true }, 'c');
    checkPoint(r[1], { id: 'x', u: 335.2735064736294, v: 360, depth: 141.42135623730951, visible: true }, 'x');
  });

  await t.test('역투영도 같은 숫자로 돌아간다', () => {
    const view = viewOf([10, 20, 30], Math.PI / 2, 0, Math.PI / 2, 1280, 720);
    const p = unprojectPoint(view, 920, 380, 90);
    [100, -50, 25].forEach((x, i) => near(p[i], x, 1e-9, `enu[${i}]`));
  });
});

test(NAME_BEHIND, () => {
  const view = viewOf([0, 0, 0], 0, 0, Math.PI / 2, 1280, 720); // 북을 본다
  const r = projectPoints(view, [
    { id: 'back', enu: [0, -100, 0] },
    { id: 'backSide', enu: [500, -1, 3] },
    { id: 'front', enu: [0, 100, 0] },
  ]);
  assert.deepEqual([r[0].u, r[0].v, r[0].visible], [0, 0, false]);
  near(r[0].depth, -100, 1e-9, 'back depth');
  assert.deepEqual([r[1].u, r[1].v, r[1].visible], [0, 0, false]);
  assert.ok(r[1].depth < 0);
  assert.equal(r[2].visible, true);
  near(r[2].u, 640, PX_EPS, 'front u');
});

test('project: 깊이 0 과 음수는 visible=false, u=v=0', () => {
  const r = projectPoints(identityView(), [
    { id: 'z', enu: [5, 5, 0] },
    { id: 'neg', enu: [1, 2, -3] },
    { id: 'tiny', enu: [0, 0, 1e-300] },
  ]);
  assert.deepEqual(r.slice(0, 2), [
    { id: 'z', u: 0, v: 0, depth: 0, visible: false },
    { id: 'neg', u: 0, v: 0, depth: -3, visible: false },
  ]);
  // 깊이가 아주 작은 양수면 중앙 점은 그대로 중앙이다.
  assert.deepEqual(r[2], { id: 'tiny', u: 640, v: 360, depth: 1e-300, visible: true });
});

test('project: 화면 가장자리 u=0·v=0 은 보이고 u=width·v=height 는 안 보인다', () => {
  // fx = fy = 360, cx = 640, cy = 360: x/d = 16/9 → u = 1280, x/d = −16/9 → u = 0, y/d = ±1 → v = 720·0.
  const r = projectPoints(identityView(), [
    { id: 'uW', enu: [16, 0, 9] },
    { id: 'u0', enu: [-16, 0, 9] },
    { id: 'vH', enu: [0, 9, 9] },
    { id: 'v0', enu: [0, -9, 9] },
    { id: 'corner', enu: [-16, -9, 9] },
  ]);
  assert.deepEqual(r, [
    { id: 'uW', u: 1280, v: 360, depth: 9, visible: false },
    { id: 'u0', u: 0, v: 360, depth: 9, visible: true },
    { id: 'vH', u: 640, v: 720, depth: 9, visible: false },
    { id: 'v0', u: 640, v: 0, depth: 9, visible: true },
    { id: 'corner', u: 0, v: 0, depth: 9, visible: true },
  ]);
});

test('project: 아주 큰 좌표(1e308)는 던지지 않고 visible=false, u=v=0', () => {
  const view = viewOf([0, 0, 0], 0.3, -0.4, 0.9, 1280, 720);
  const r = projectPoints(view, [
    { id: 'big', enu: [1e308, 1e308, 1e308] },
    { id: 'bigNeg', enu: [-1e308, 1e308, -1e308] },
    { id: 'ok', enu: [0, 100, -50] },
  ]);
  for (const x of r.slice(0, 2)) {
    assert.equal(x.visible, false, x.id);
    assert.equal(x.u, 0, x.id);
    assert.equal(x.v, 0, x.id);
  }
  assert.ok(Number.isFinite(r[2].u) && Number.isFinite(r[2].v));
  // R = I: d = 1 이지만 u = 360·1e308 + 640 = Infinity → 넘침
  const r2 = projectPoints(identityView(), [{ id: 'u', enu: [1e308, 0, 1] }, { id: 'v', enu: [0, -1e308, 1] }]);
  assert.deepEqual(r2, [
    { id: 'u', u: 0, v: 0, depth: 1, visible: false },
    { id: 'v', u: 0, v: 0, depth: 1, visible: false },
  ]);
});

test('project: 입력 순서·개수·id 를 지키고 입력을 바꾸지 않는다', () => {
  const view = viewOf([1, 2, 3], 1.1, 0.2, 0.9, 1280, 720);
  const items = [
    { id: 'z', enu: [5, 50, 3], yaw: 1 },
    { id: 'a', enu: [-5, -50, 3] },
    { id: 'z', enu: [0, 0, 0] },
    { id: 'm', enu: [100, 40, 10], kind: 'alert' },
  ];
  const before = JSON.parse(JSON.stringify(items));
  Object.freeze(items);
  items.forEach((it) => { Object.freeze(it); Object.freeze(it.enu); });
  const r = projectPoints(view, items);
  assert.deepEqual(r.map((x) => x.id), ['z', 'a', 'z', 'm']);
  assert.deepEqual(JSON.parse(JSON.stringify(items)), before);
  for (const x of r) assert.deepEqual(Object.keys(x).sort(), ['depth', 'id', 'u', 'v', 'visible']);
  assert.notEqual(r[0], items[0]);
  assert.deepEqual(projectPoints(view, []), []);
});

test('project: 형식 위반은 TypeError, 값 범위 위반은 RangeError', () => {
  const v = identityView();
  assert.throws(() => projectPoints(v, null), TypeError);
  assert.throws(() => projectPoints(v, [{ id: 1, enu: [0, 0, 1] }]), TypeError);
  assert.throws(() => projectPoints(v, [{ id: 'a', enu: [0, 0] }]), TypeError);
  assert.throws(() => projectPoints(v, [{ id: 'a', enu: [0, NaN, 1] }]), TypeError);
  assert.throws(() => projectPoints(null, []), TypeError);
  assert.throws(() => projectPoints({ ...v, t: [0, 0] }, []), TypeError);
  assert.throws(() => projectPoints({ ...v, K: { ...v.K, fx: -1 } }, []), RangeError);
  assert.throws(() => projectPoints({ ...v, width: 0 }, []), RangeError);
  assert.throws(() => projectPoints({ ...v, R: [2, 0, 0, 0, 1, 0, 0, 0, 1] }, []), RangeError);
  assert.throws(() => projectPoints({ ...v, R: [1, 0, 0, 0, 1, 0, 0, 0, -1] }, []), RangeError);
});

test('unproject: depth 0·음수·넘침은 RangeError, 비유한 입력은 TypeError', () => {
  const v = identityView();
  assert.throws(() => unprojectPoint(v, 640, 360, 0), RangeError);
  assert.throws(() => unprojectPoint(v, 640, 360, -1), RangeError);
  assert.throws(() => unprojectPoint(v, 1e308, 0, 1e308), RangeError);
  assert.throws(() => unprojectPoint(v, 0, -1e308, 1e308), RangeError);
  assert.throws(() => unprojectPoint(v, NaN, 0, 1), TypeError);
  assert.throws(() => unprojectPoint(v, 0, 0, Infinity), TypeError);
  assert.deepEqual(unprojectPoint(v, 640, 360, 7), [0, 0, 7]);
  assert.deepEqual(unprojectPoint(v, 0, 0, 9), [-16, -9, 9]);
});

test(NAME_ROUND, () => {
  const TOL = 0.01; // m. 계약 CONTROLVIEW_OVERLAY_MAX_ENU_ERR_M 와 같다(위 시험이 확인한다).
  assert.equal(CONTROLVIEW_OVERLAY_MAX_ENU_ERR_M, TOL);
  const rnd = mulberry32(0x5eed1506);
  const NEAR = TOWER_OVERLAY_LIMITS.nearM;
  let maxErr = 0;
  let checked = 0;
  for (let k = 0; k < 200; k += 1) {
    const pos = [0, 1, 2].map(() => (rnd() * 2 - 1) * 5000);
    const yaw = (rnd() * 2 - 1) * Math.PI;
    const pitch = (rnd() * 2 - 1) * (Math.PI / 2);
    const fovY = 0.2 + rnd() * 2.6;
    const width = 1 + Math.floor(rnd() * 3840);
    const height = 1 + Math.floor(rnd() * 2160);
    const view = viewOf(pos, yaw, pitch, fovY, width, height);
    const items = [];
    for (let i = 0; i < 60; i += 1) {
      // |p| ≤ 1e4: 공 안에서 고른다. 몇 개는 카메라 바로 앞(깊이 0.1 근처)에 둔다.
      let p;
      do p = [0, 1, 2].map(() => (rnd() * 2 - 1) * 1e4); while (Math.hypot(...p) > 1e4);
      items.push({ id: `p${i}`, enu: p });
    }
    const fwd = [view.R[6], view.R[7], view.R[8]];
    for (const d of [0.1, 0.1000001, 0.5, 3]) {
      const p = pos.map((c, j) => c + fwd[j] * d + (rnd() - 0.5) * 0.01 * d);
      if (Math.hypot(...p) <= 1e4) items.push({ id: `near${d}`, enu: p });
    }
    const out = projectPoints(view, items);
    out.forEach((r, i) => {
      if (!(r.depth >= NEAR)) return;
      assert.ok(Number.isFinite(r.u) && Number.isFinite(r.v), r.id);
      const q = unprojectPoint(view, r.u, r.v, r.depth);
      for (let j = 0; j < 3; j += 1) {
        const e = Math.abs(q[j] - items[i].enu[j]);
        if (e > maxErr) maxErr = e;
        assert.ok(e <= TOL, `자세 ${k} 점 ${r.id} 성분 ${j}: 오차 ${e} m`);
      }
      checked += 1;
    });
  }
  assert.ok(checked >= 5000, `확인한 점 ${checked}개`);
  assert.ok(maxErr <= CONTROLVIEW_OVERLAY_MAX_ENU_ERR_M);
  console.log(`# ENU 왕복: 자세 200개, 점 ${checked}개, 최대 성분 오차 ${maxErr.toExponential(3)} m`);
});

test('project: float32 쿼터니언·근사 회전 R 이어도 R 의 실제 역행렬로 1 cm 안에 돌아온다', () => {
  // (1) float32 로 줄인 쿼터니언으로 만든 View(syncCamera 가 정규화한다).
  const cam = poseToCameraPose({ pos: [1234.5, -987.25, 300], yaw: 0.7, pitch: -0.3 }, 0.9);
  const f32 = { ...cam, quat: cam.quat.map(Math.fround) };
  const v1 = syncCamera(f32, { width: 1280, height: 720, devicePixelRatio: 1 }, 0).view;
  // (2) 직교에서 4e-7 씩 벗어난 R(래스터라이저 허용 1e-6 안). Rᵀ 로 되돌리면 1e4 m 에서 수 mm 가 벌어진다.
  const v2 = identityView();
  v2.R = [1 + 4e-7, 4e-7, -4e-7, -4e-7, 1 - 4e-7, 4e-7, 4e-7, 4e-7, 1 + 4e-7];
  let maxErr = 0;
  for (const [view, pts] of [
    [v1, [[6000, 6000, 0], [-3000, 9000, 2000], [1234.5 + 50, -987.25 + 80, 290]]],
    [v2, [[5000, 3000, 8000], [-4000, -4000, 8000], [10, 0, 0.5]]],
  ]) {
    const items = pts.map((p, i) => ({ id: String(i), enu: p }));
    projectPoints(view, items).forEach((r, i) => {
      if (!(r.depth >= 0.1)) return;
      const q = unprojectPoint(view, r.u, r.v, r.depth);
      for (let j = 0; j < 3; j += 1) maxErr = Math.max(maxErr, Math.abs(q[j] - pts[i][j]));
    });
  }
  assert.ok(maxErr <= 0.01, `최대 오차 ${maxErr}`);
  assert.ok(maxErr <= 1e-6, `실제 역행렬이면 μm 아래여야 한다: ${maxErr}`);
});

test('project: 같은 입력을 두 번 넣으면 같은 결과이고 매번 새 객체다', () => {
  const view = viewOf([0, 0, 50], 0, -Math.PI / 2, 0.9, 1280, 720);
  const viewCopy = JSON.parse(JSON.stringify(view));
  const items = [{ id: 'o', enu: [0, 0, 0] }];
  const a = projectPoints(view, items);
  const b = projectPoints(view, items);
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(view)), viewCopy);
  const p = unprojectPoint(view, 640, 360, 50);
  const q = unprojectPoint(view, 640, 360, 50);
  assert.notEqual(p, q);
  [0, 0, 0].forEach((x, i) => near(p[i], x, 1e-9, `enu[${i}]`));
});
