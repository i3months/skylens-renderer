// 관제탑 오버레이 조립(index.mjs) 정답 장면 시험(T15.6.8). 구현과 독립으로 만든 기준 수치를 시험 안에 박아 두었다.
//
// 정답 숫자를 만든 방법(구현 식·camera.mjs·view.mjs 를 쓰지 않았다):
//   별도 계산 스크립트(Node, 이 저장소 밖)가 단위 벡터 기하로 카메라를 직접 세웠다.
//     앞 f = (sin yaw·cos pitch, cos yaw·cos pitch, sin pitch), 오른쪽 r = f × (0,0,1) 을 단위화, 아래 d = f × r.
//     점 P 의 카메라 성분은 내적으로: x = (P−C)·r, y = (P−C)·d, z = (P−C)·f (쿼터니언·행렬 곱을 쓰지 않는다).
//   핀홀은 손으로 푼 식: fy = (H/2)/tan(fovY/2) = 360/tan(30°) = 623.5382907…, fx = fy, u = fx·x/z + 640, v = fy·y/z + 360.
//   경로 근평면 자르기는 매개변수 s = (nearM − dA)/(dB − dA) 로 교점을 직접 풀어 같은 내적으로 투영했다.
//   출력은 소수 9째 자리로 반올림해 아래 GOLD 에 박았다. 화면 경계와 가장 가까운 점도 0.1 px 이상 떨어져 있어 visible 판정이 모호하지 않다.
// 장면: 화면 1280×720, fovY = 60°, nearM = 0.1, 카메라 [−40,−60,35], 시점 8개(yaw = k·π/4, pitch = −0.3 + 0.5·k/7).
//   드론 3대, 탐지 마커 5개(카메라 뒤·화면 밖·카메라와 1.5 m 거리 포함), 경로 둘(8점 나선, 카메라 중심을 지나 근평면을 가로지르는 직선).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTowerOverlay } from './index.mjs';
import { poseToCameraPose } from '../input/camera.mjs';

const SIZE = { width: 1280, height: 720 };
const FOVY = Math.PI / 3;
const NEAR = 0.1;
const CAM = [-40, -60, 35];
const PX = 0.01; // 픽셀 허용 오차
const DEPTH_EPS = 1e-6; // 깊이 허용 오차(m)
const ENU_EPS = 0.01; // 왕복 허용 오차(1 cm)

const DRONES = [
  { id: 'd1', enu: [0, 0, 30], yaw: 0.5 },
  { id: 'd2', enu: [20, 15, 45] },
  { id: 'd3', enu: [-10, 40, 25], yaw: 3 },
];
const DETS = [
  { id: 'a', enu: [-30, -30, 40], kind: 'alert', confidence: 0.9 },
  { id: 'b', enu: [-60, -90, 20] },
  { id: 'c', enu: [-40, -60, 36.5], confidence: 0.25 },
  { id: 'e', enu: [100, 50, 60], kind: 'detection' },
  { id: 'f', enu: [-30, -100, 35] },
];
// 나선: 중심 (0,10), 반지름 15, 점마다 45°, 고도 20 m 에서 4 m 씩 상승.
const SPIRAL = [];
for (let k = 0; k < 8; k += 1) {
  const a = (k * Math.PI) / 4;
  SPIRAL.push([15 * Math.cos(a), 15 * Math.sin(a) + 10, 20 + 4 * k]);
}
// 직선: 중점이 카메라 위치(-40,-60,35)다. 한쪽 끝은 항상 카메라 뒤, 다른 쪽은 앞이라 근평면을 가로지른다.
const LINE = [[-45, -75, 30], [-35, -45, 40]];

// [u, v, depth, visible] (드론·마커), polylines [[ [u,v,depth], ... ], ...] (경로)
const GOLD = [
  {
    yaw: 0, pitch: -0.3,
    drones: [[1064.191648486, 222.619914586, 58.797790381, true], [1184.614289106, 72.104357102, 68.695034618, true], [829.931637295, 233.387418833, 98.488850979, true]],
    dets: [[869.389657539, 47.060007956, 27.18249364, true], [0, 0, -24.227291574, false], [0, 0, -0.44328031, false], [1533.513270186, 0.101566773, 97.699008637, false], [0, 0, -38.213459565, false]],
    spiral: [[[1120.947383513, 304.416761099, 71.306357339], [1033.175609551, 256.574288582, 80.257150159], [939.517951286, 221.983160319, 83.272243022], [875.296008988, 192.254941629, 77.892988505], [874.138143229, 157.313624603, 66.578034032], [971.64835311, 108.064041931, 55.263079559], [1139.992364419, 49.359246811, 49.883825042], [1236.51794751, 6.717386926, 52.898917906]]],
    line: [[[882.575722939, -86.799522821, 0.1], [882.575722939, -86.799522821, 12.852446304]]],
  },
  {
    yaw: 0.7853981633974483, pitch: -0.22857142857142856,
    drones: [[514.034342642, 260.666776996, 70.004501695, true], [567.091090521, 144.367186332, 90.710756104, true], [303.791512942, 284.680124632, 91.798904392, true]],
    dets: [[306.177148121, 93.766084428, 26.415696302, true], [0, 0, -31.036989908, false], [0, 0, -0.339879509, false], [719.436104114, 118.825712867, 166.514266511, true], [0, 0, -20.661470999, false]],
    spiral: [[[566.095082375, 322.250247921, 89.488257589], [497.558733071, 290.776516329, 92.861042984], [413.70129873, 266.054494828, 87.675566873], [344.594895206, 240.067589348, 76.438486016], [335.698783359, 205.123301511, 65.201405159], [419.604434676, 161.607021916, 60.015929048], [535.665618659, 124.047206473, 63.388714444], [586.792953381, 100.643064618, 72.813104586]]],
    line: [[[291.218400692, -38.269654973, 0.1], [291.218400692, -38.269654973, 12.641382303]]],
  },
  {
    yaw: 1.5707963267948966, pitch: -0.15714285714285714,
    drones: [[-288.583966321, 339.548182808, 40.289622479, false], [-170.551586713, 151.779033406, 57.69573778, false], [-1358.819822059, 463.57638778, 31.195322552, false]],
    dets: [[-1416.909148707, -85.894115177, 9.094299927, false], [0, 0, -17.406115301, false], [0, 0, -0.234745366, false], [129.521396471, 143.735606359, 134.362559969, true], [3165.268388316, 261.200824576, 9.876784481, false]],
    spiral: [[[-130.211025259, 428.305027376, 56.669768309], [-332.087288928, 395.511879446, 51.704515869], [-665.353190019, 370.041586137, 40.602616301], [-1063.731577467, 325.401003452, 29.500716733], [-1138.962885324, 235.470025699, 24.535464293], [-670.998513506, 149.458307079, 28.248741447], [-260.152415689, 112.06557889, 38.098665728], [-132.370116362, 90.035785931, 47.94859001]]],
    line: [[[-1610.54911368, -498.340946644, 0.1], [-1610.54911368, -498.340946644, 4.155907687]]],
  },
  {
    yaw: 2.356194490192345, pitch: -0.08571428571428572,
    drones: [[0, 0, -13.66216988, false], [0, 0, -11.42375622, false], [0, 0, -48.459664841, false]],
    dets: [[0, 0, -14.51826356, false], [3286.746183551, 1433.479566285, 8.32924888, false], [0, 0, -0.128414052, false], [-5162.922403428, -517.258485086, 18.99509088, false], [1015.501523467, 306.422586492, 35.225541801, true]],
    spiral: [],
    line: [[[1819.978581728, 725.145238229, 7.4731552], [1819.978581728, 725.145238229, 0.1]]],
  },
  {
    yaw: 3.141592653589793, pitch: -0.01428571428571429,
    drones: [[0, 0, -59.922451513, false], [0, 0, -75.135199353, false], [0, 0, -99.846943808, false]],
    dets: [[0, 0, -30.068364969, false], [1052.785943378, 660.712755099, 30.211217253, true], [0, 0, -0.021427843, false], [0, 0, -110.345906411, false], [484.099519377, 351.091704118, 39.995918437, true]],
    spiral: [],
    line: [[[846.882087676, 557.994904006, 15.069895556], [846.882087676, 557.994904006, 0.1]]],
  },
  {
    yaw: 3.9269908169872414, pitch: 0.05714285714285716,
    drones: [[0, 0, -70.880822344, false], [0, 0, -94.732488117, false], [0, 0, -92.344960222, false]],
    dets: [[0, 0, -27.952546589, false], [511.981439003, 667.681950746, 34.440955301, true], [640, -10540.040581604, 0.085667646, false], [0, 0, -175.060364708, false], [-400.929498882, 395.66959197, 21.178579057, false]],
    spiral: [],
    line: [[[321.274913349, 621.41071874, 13.833493884], [321.274913349, 621.41071874, 0.1]]],
  },
  {
    yaw: 4.71238898038469, pitch: 0.12857142857142856,
    drones: [[0, 0, -40.310930409, false], [0, 0, -58.222589471, false], [0, 0, -31.034557143, false]],
    dets: [[0, 0, -9.276373266, false], [-404.356006147, 967.137790726, 17.911659062, false], [640, -4462.989695236, 0.192326241, false], [0, 0, -135.639012942, false], [0, 0, -9.917460735, false]],
    spiral: [],
    line: [[[-1526.245468008, 1168.705334012, 4.317642898], [-1526.245468008, 1168.705334012, 0.1]]],
  },
  {
    yaw: 5.497787143782138, pitch: 0.2,
    drones: [[4066.688412978, 733.629102967, 12.86688781, false], [5447.238713277, -27.434757177, 12.381869156, false], [1872.0072033, 623.148092017, 46.524127316, false]],
    dets: [[1827.345058934, 272.233512808, 14.853581118, false], [0, 0, -9.910157194, false], [640, -2716.010959004, 0.298003996, false], [0, 0, -15.823618426, false], [0, 0, -34.65058616, false]],
    spiral: [[[8072.570361317, 1773.400868119, 7.415135886], [3749.540730683, 862.555912957, 18.604989057], [2489.767110347, 635.871070597, 29.794842229], [2029.867346504, 541.094196132, 34.895342371], [1974.629487839, 466.125472231, 31.384196875], [2437.069621374, 340.366173287, 21.78369835], [4078.035590191, 16.407389588, 12.183199825], [6232.665251822, -467.340145781, 8.672054329]]],
    line: [[[1752.917683586, 84.91880487, 0.1], [1752.917683586, 84.91880487, 7.923463886]]],
  },
];

function setup() {
  const ov = createTowerOverlay({ nearM: NEAR });
  ov.setDrones(DRONES);
  ov.setDetections(DETS);
  ov.setPath({ id: 'spiral', points: SPIRAL });
  ov.setPath({ id: 'line', points: LINE });
  return ov;
}
const poseOf = (g) => poseToCameraPose({ pos: CAM, yaw: g.yaw, pitch: g.pitch }, FOVY);

function checkPoint(r, exp, msg) {
  assert.ok(Math.abs(r.depth - exp[2]) <= DEPTH_EPS, `${msg} depth ${r.depth} vs ${exp[2]}`);
  assert.equal(r.visible, exp[3], `${msg} visible`);
  if (exp[2] <= 0) {
    assert.equal(r.u, 0, `${msg} u`);
    assert.equal(r.v, 0, `${msg} v`);
    return;
  }
  assert.ok(Math.abs(r.u - exp[0]) <= PX, `${msg} u ${r.u} vs ${exp[0]}`);
  assert.ok(Math.abs(r.v - exp[1]) <= PX, `${msg} v ${r.v} vs ${exp[1]}`);
}

test('장면: 드론 3대의 화면 좌표·깊이가 정답과 같다(시점 8개)', () => {
  const ov = setup();
  GOLD.forEach((g, k) => {
    const out = ov.project(poseOf(g), SIZE);
    assert.equal(out.drones.length, 3);
    out.drones.forEach((r, i) => {
      assert.equal(r.id, DRONES[i].id);
      checkPoint(r, g.drones[i], `시점${k} 드론${i}`);
    });
  });
});

test('장면: 탐지 마커 5개의 화면 좌표·깊이·visible 이 정답과 같다(시점 8개)', () => {
  const ov = setup();
  GOLD.forEach((g, k) => {
    const out = ov.project(poseOf(g), SIZE);
    assert.equal(out.detections.length, 5);
    out.detections.forEach((r, i) => {
      assert.equal(r.id, DETS[i].id);
      checkPoint(r, g.dets[i], `시점${k} 마커${i}`);
    });
  });
});

test('장면: 마커 종류·신뢰도·드론 yaw 는 받은 값 그대로다', () => {
  const out = setup().project(poseOf(GOLD[0]), SIZE);
  assert.deepEqual(out.detections.map((r) => r.kind), ['alert', 'detection', 'detection', 'detection', 'detection']);
  assert.deepEqual(out.detections.map((r) => r.confidence), [0.9, undefined, 0.25, undefined, undefined]);
  assert.ok(!('confidence' in out.detections[1]));
  assert.equal(out.drones[0].yaw, 0.5);
  assert.ok(!('yaw' in out.drones[1]));
  assert.equal(out.drones[2].yaw, 3);
});

test('장면: 카메라 뒤 마커는 visible=false, u=v=0 이다', () => {
  const ov = setup();
  let behind = 0;
  let offscreen = 0;
  GOLD.forEach((g, k) => {
    const out = ov.project(poseOf(g), SIZE);
    for (const [list, exps] of [[out.drones, g.drones], [out.detections, g.dets]]) {
      list.forEach((r, i) => {
        if (exps[i][2] <= 0) {
          behind += 1;
          assert.equal(r.visible, false, `시점${k} ${r.id}`);
          assert.equal(r.u, 0);
          assert.equal(r.v, 0);
        } else if (!exps[i][3]) {
          offscreen += 1;
          assert.equal(r.visible, false);
        }
      });
    }
  });
  // 장면이 뒤·화면 밖 경우를 실제로 담고 있는지(정답 표에서 센 값).
  assert.ok(behind >= 20, `뒤 ${behind}`);
  assert.ok(offscreen >= 3, `화면 밖 ${offscreen}`);
});

test('장면: visible 판정이 정답과 일치한다(시점별 개수)', () => {
  const ov = setup();
  GOLD.forEach((g, k) => {
    const out = ov.project(poseOf(g), SIZE);
    const got = [...out.drones, ...out.detections].map((r) => r.visible);
    const exp = [...g.drones, ...g.dets].map((r) => r[3]);
    assert.deepEqual(got, exp, `시점${k}`);
  });
  // 시점0(북쪽, pitch −0.3): 드론 3대 모두 보인다.
  assert.deepEqual(ov.project(poseOf(GOLD[0]), SIZE).drones.map((r) => r.visible), [true, true, true]);
});

test('장면: 경로는 깊이 ≥ nearM 인 점만 담고 정답 폴리라인과 같다', () => {
  const ov = setup();
  GOLD.forEach((g, k) => {
    const out = ov.project(poseOf(g), SIZE);
    assert.deepEqual(out.paths.map((p) => p.id), ['spiral', 'line']);
    [g.spiral, g.line].forEach((exp, pi) => {
      const polys = out.paths[pi].polylines;
      assert.equal(polys.length, exp.length, `시점${k} 경로${pi} 조각 수`);
      polys.forEach((poly, a) => {
        assert.equal(poly.length, exp[a].length, `시점${k} 경로${pi}/${a} 점 수`);
        poly.forEach((pt, b) => {
          assert.ok(pt.depth >= NEAR - 1e-9, `깊이 ${pt.depth}`);
          const e = exp[a][b];
          assert.ok(Math.abs(pt.u - e[0]) <= PX && Math.abs(pt.v - e[1]) <= PX, `시점${k} 경로${pi}/${a}/${b} (${pt.u},${pt.v}) vs (${e[0]},${e[1]})`);
          assert.ok(Math.abs(pt.depth - e[2]) <= DEPTH_EPS, `깊이 ${pt.depth} vs ${e[2]}`);
        });
      });
    });
  });
});

test('장면: 근평면을 가로지르는 직선은 교점(깊이 nearM)에서 잘리고, 나선이 전부 뒤면 조각이 없다', () => {
  const ov = setup();
  GOLD.forEach((g, k) => {
    const out = ov.project(poseOf(g), SIZE);
    const line = out.paths[1].polylines;
    assert.equal(line.length, 1, `시점${k}`);
    assert.equal(line[0].length, 2);
    // 두 끝 중 하나는 정확히 nearM 깊이의 교점이다.
    const ds = line[0].map((p) => p.depth).sort((x, y) => x - y);
    assert.ok(Math.abs(ds[0] - NEAR) <= DEPTH_EPS, `교점 깊이 ${ds[0]}`);
    assert.ok(ds[1] > NEAR);
  });
  // 시점 3~6 에서 나선은 모두 카메라 뒤다.
  for (const k of [3, 4, 5, 6]) {
    assert.deepEqual(ov.project(poseOf(GOLD[k]), SIZE).paths[0].polylines, [], `시점${k}`);
  }
});

test('장면: project→unproject 왕복이 1 cm 이내다(깊이 ≥ nearM 인 모든 점)', () => {
  const ov = setup();
  let n = 0;
  GOLD.forEach((g) => {
    const pose = poseOf(g);
    const out = ov.project(pose, SIZE);
    const pairs = [
      ...out.drones.map((r, i) => [r, DRONES[i].enu]),
      ...out.detections.map((r, i) => [r, DETS[i].enu]),
    ];
    for (const [r, enu] of pairs) {
      if (r.depth < NEAR) continue;
      // 화면 밖이어도 깊이 > 0 이면 u,v 는 실제 값이다(계약 project 식).
      const back = ov.unproject(pose, SIZE, r.u, r.v, r.depth);
      for (let i = 0; i < 3; i += 1) assert.ok(Math.abs(back[i] - enu[i]) <= ENU_EPS, `${r.id}[${i}] ${back[i]} vs ${enu[i]}`);
      n += 1;
    }
  });
  assert.ok(n >= 20, `왕복 점 ${n}`);
});

test('장면: 같은 화면 점에서 깊이가 다르면 시선 위의 다른 점이 되고 왕복한다', () => {
  const ov = setup();
  const pose = poseOf(GOLD[0]);
  const a = ov.unproject(pose, SIZE, 640, 360, 10);
  const b = ov.unproject(pose, SIZE, 640, 360, 20);
  // 화면 중심 시선의 앞 단위 벡터는 (sin0·cos p, cos0·cos p, sin p), p = −0.3 이다.
  const fwd = [0, Math.cos(-0.3), Math.sin(-0.3)];
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(a[i] - (CAM[i] + 10 * fwd[i])) <= 1e-6);
    assert.ok(Math.abs(b[i] - (CAM[i] + 20 * fwd[i])) <= 1e-6);
  }
});

test('장면: project 는 상태를 바꾸지 않고 입력 순서·개수를 지킨다', () => {
  const ov = setup();
  const first = ov.project(poseOf(GOLD[2]), SIZE);
  ov.project(poseOf(GOLD[5]), SIZE);
  assert.deepEqual(ov.project(poseOf(GOLD[2]), SIZE), first);
  assert.deepEqual(ov.counts(), { drones: 3, detections: 5, paths: 2 });
  assert.deepEqual(first.drones.map((r) => r.id), ['d1', 'd2', 'd3']);
  assert.deepEqual(first.detections.map((r) => r.id), ['a', 'b', 'c', 'e', 'f']);
});
