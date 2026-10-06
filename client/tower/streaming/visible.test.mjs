// tilesInView(T15.7.1) 시험. 합성 시점의 기대 타일 집합(숫자로 박음)과 무작위 시점 오라클(화소 광선 → 누락 0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tilesInView, vertexCallCount } from './visible.mjs';
import { poseToView } from '../overlay/view.mjs';
import { tileOf, TERRAIN_TILE_SIZE_M } from '../../../contracts/tower_assets/index.mjs';
import { TOWER_STREAMING_LIMITS } from '../../../contracts/controlview/streaming.mjs';

const S = TERRAIN_TILE_SIZE_M;

/** 쿼터니언 곱 a·b (x,y,z,w). */
function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/**
 * 시험용 자세. yaw = 북(+y)에서 반시계(서쪽으로) 회전, elev = 수평에서 위로(+)·아래로(−).
 * 카메라 축은 OpenCV(x 오른쪽, y 아래, z 앞). yaw=0, elev=0 이면 북쪽 수평을 본다.
 */
function pose(pos, yaw, elev, fovY) {
  const th = -Math.PI / 2 + elev;
  const quat = qmul([0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)], [Math.sin(th / 2), 0, 0, Math.cos(th / 2)]);
  return { pos, quat, fovY };
}

const pairs = (list) => list.map(({ tx, ty }) => [tx, ty]);
/** 집합 비교: 둘 다 (tx,ty) 사전순으로 정렬해 비교(중복도 잡는다). 순서 자체는 별도 시험이 본다. */
const lex = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);
function assertSet(list, expected) {
  assert.deepEqual(pairs(list).sort(lex), expected.slice().sort(lex));
}
const key = (tx, ty) => `${tx},${ty}`;
const SQ = { width: 100, height: 100 };
const FOV_HALF = 2 * Math.atan(0.5); // tan(fovY/2) = 0.5 → 깊이 100 에서 반폭 50

test('하향: 3×3 발자국, 거리순·사전순', () => {
  const v = poseToView(pose([32, 32, 100], 0, -Math.PI / 2, FOV_HALF), SQ);
  const r = tilesInView(v, { maxDistM: 500, zRangeM: [0, 10], nearM: 0.1 });
  assert.deepEqual(pairs(r), [[0, 0], [-1, 0], [0, -1], [0, 1], [1, 0], [-1, -1], [-1, 1], [1, -1], [1, 1]]);
});

test('타일 경계 직전·맞닿음·직후: 발자국 x 끝이 64−0.001 / 64 / 64+0.001', () => {
  const opts = { maxDistM: 500, zRangeM: [0, 0], nearM: 0.1 };
  // 발자국 x = [X−50, X+50], y = [−18, 82]
  const run = (X) => tilesInView(poseToView(pose([X, 32, 100], 0, -Math.PI / 2, FOV_HALF), SQ), opts);
  const two = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 0], [0, 1]];
  const three = [...two, [1, -1], [1, 0], [1, 1]];
  assertSet(run(13.999), two); // 오른쪽 끝 63.999: tx=1 제외
  assertSet(run(14), three); // 64 에 맞닿음: 닫힌 경계라 tx=1 포함
  assertSet(run(14.001), three);
  // 왼쪽 끝이 x=0 에 맞닿으면 tx=−1 도 포함, 0 을 조금 넘으면 제외
  assertSet(run(50), three);
  assertSet(run(50.001), [[0, -1], [0, 0], [0, 1], [1, -1], [1, 0], [1, 1]]);
  // y 쪽: 발자국 y = [Y−50, Y+50]
  const runY = (Y) => tilesInView(poseToView(pose([32, Y, 100], 0, -Math.PI / 2, FOV_HALF), SQ), opts);
  assertSet(runY(50), three); // 아래 끝 y=0 맞닿음 → ty=−1 포함
  assertSet(runY(50.001), [[-1, 0], [-1, 1], [0, 0], [0, 1], [1, 0], [1, 1]]);
  assertSet(runY(13.999), [[-1, -1], [-1, 0], [0, -1], [0, 0], [1, -1], [1, 0]]); // 위 끝 63.999
  assertSet(runY(14), three); // 위 끝 64 맞닿음 → ty=1 포함
});

test('수평(북쪽): 카메라 뒤(ty<0) 제외, 좌우 45° 쐐기, 거리 200 m 구', () => {
  const v = poseToView(pose([32, 32, 10], 0, 0, Math.PI / 2), SQ);
  const r = tilesInView(v, { maxDistM: 200, zRangeM: [0, 20], nearM: 0.1 });
  // 쐐기 변 x = 32 ± (y − 32) 는 (0,64)·(64,64)·(−64,128)·(128,128)·(−128,192)·(192,192) 모서리를 지난다 →
  // (±1,0)·(−2,1)·(2,1)·(−3,2)·(3,2) 는 모서리 맞닿음으로 포함(닫힌 경계).
  // 깊이 기준이면 들어갈 (−3,3)·(3,3) 은 카메라까지 최소 거리 √(160²+160²) ≈ 226 > 200 이라 빠진다.
  assert.deepEqual(pairs(r), [
    [0, 0], [-1, 0], [0, 1], [1, 0], [-1, 1], [1, 1], [0, 2], [-2, 1], [-1, 2], [1, 2], [2, 1],
    [-2, 2], [2, 2], [0, 3], [-1, 3], [1, 3], [-3, 2], [-2, 3], [2, 3], [3, 2],
  ]);
  assert.ok(r.every(({ ty }) => ty >= 0));
});

test('위향: 판 안에서는 머리 위 타일만, 판 위로 올라가면 없음', () => {
  const opts = { maxDistM: 200, zRangeM: [0, 20], nearM: 0.1 };
  assert.deepEqual(pairs(tilesInView(poseToView(pose([32, 32, 10], 0, Math.PI / 2, 1), SQ), opts)), [[0, 0]]);
  // 카메라가 z 판보다 위에서 위를 보면 판은 카메라 뒤에 있다
  assert.deepEqual(tilesInView(poseToView(pose([32, 32, 30], 0, Math.PI / 2, 1), SQ), opts), []);
  // 비스듬히 위(30°)
  const r = tilesInView(poseToView(pose([32, 32, 0], 0, Math.PI / 6, 0.6), SQ), opts);
  assert.deepEqual(pairs(r), [[0, 0], [0, 1]]);
});

test('옆(서쪽) 보기: 동쪽(tx>0) 제외', () => {
  const v = poseToView(pose([32, 32, 10], Math.PI / 2, 0, 1), SQ);
  const r = tilesInView(v, { maxDistM: 200, zRangeM: [0, 20], nearM: 0.1 });
  // (−3,±2) 는 사각뿔 다면체와도, 구와도 각각 만나지만 그 교집합과는 아슬하게(≈200.4 m) 만나지 않는다.
  // 행마다 구의 x 범위(camX ± √(D²−dy²−dz²))와 다면체 띠 범위를 교집합하므로(F-439 ①) 이제 걸러진다. 포함해도 허용된 과포함이다.
  assert.deepEqual(pairs(r), [[0, 0], [-1, 0], [-1, -1], [-1, 1], [-2, 0], [-2, -1], [-2, 1], [-3, 0], [-3, -1], [-3, 1]]);
});

test('카메라가 타일 모서리 위: 네 타일', () => {
  const v = poseToView(pose([64, 64, 50], 0, -Math.PI / 2, FOV_HALF), SQ);
  // 발자국 반폭 25(z=0) → [39,89]² : tx,ty ∈ {0,1}
  const r = tilesInView(v, { maxDistM: 500, zRangeM: [0, 0], nearM: 0.1 });
  assertSet(r, [[0, 0], [0, 1], [1, 0], [1, 1]]);
});

test('근평면이 타일 경계에 걸침: nearM 에 따라 카메라 타일 포함 여부가 바뀐다', () => {
  // 동쪽(yaw=−90°) 수평, 카메라 x = 63.95. 근평면 x = 63.95 + nearM.
  const v = poseToView(pose([63.95, 32, 5], -Math.PI / 2, 0, 0.2), SQ);
  const base = { maxDistM: 100, zRangeM: [0, 10] };
  assert.deepEqual(pairs(tilesInView(v, { ...base, nearM: 0.01 })), [[0, 0], [1, 0], [2, 0]]);
  assert.deepEqual(pairs(tilesInView(v, { ...base, nearM: 0.05 })), [[0, 0], [1, 0], [2, 0]]); // 근평면이 x=64 에 맞닿음
  assert.deepEqual(pairs(tilesInView(v, { ...base, nearM: 0.1 })), [[1, 0], [2, 0]]);
});

test('광각 fovY 2.5 rad 하향 비스듬: 기대 집합과 개수', () => {
  const v = poseToView(pose([0, 0, 30], 0, -0.6, 2.5), { width: 160, height: 90 });
  const r = tilesInView(v, { maxDistM: 120, zRangeM: [0, 5], nearM: 0.1 });
  // 아래 끝 광선은 수직을 지나 약간 뒤(남쪽)를 본다 → ty=−1 포함. 카메라 x=0 이 경계라 좌우 대칭(−2..1).
  // 깊이 120 원평면이었다면 옆으로 −11..10 까지 60개였으나, 거리 120 m 구로 12개로 준다.
  assert.equal(r.length, 12);
  assertSet(r, EXPECT_WIDE);
  assert.ok(r.every(({ tx, ty }) => tx >= -2 && tx <= 1 && ty >= -1 && ty <= 1));
});

test('거리 구 경계: 타일 모서리까지 거리가 정확히 maxDistM(3-4-5) 이면 포함, 조금 모자라면 제외', () => {
  // 카메라 (34,24,5), 북쪽 수평. 타일 (1,1) 의 가장 가까운 모서리 (64,64) 까지 √(30²+40²) = 50.
  // 원평면(깊이 50, y=74)은 (1,1) 을 넓게 지나므로 포함 여부는 구가 정한다.
  const v = poseToView(pose([34, 24, 5], 0, 0, 1.5), SQ);
  const run = (D) => tilesInView(v, { maxDistM: D, zRangeM: [0, 10], nearM: 0.1 });
  assertSet(run(49.999), [[-1, 0], [0, 0], [0, 1], [1, 0]]);
  assertSet(run(50), [[-1, 0], [0, 0], [0, 1], [1, 0], [1, 1]]);
  assertSet(run(50.001), [[-1, 0], [0, 0], [0, 1], [1, 0], [1, 1]]);
});

test('거리 구 경계 z: 수평 40 m, dz 30 m 의 3-4-5 → 50 m 에서 갈리는 타일 (dz 를 무시하면 49.999 에서도 포함)', () => {
  // 카메라 (40,32,40), 북쪽 수평, zRangeM [0,10] → 카메라가 판 위 30 m. 타일 (1,1) 의 가까운 모서리 (64,64,10): 수평 √(24²+32²)=40, dz=30 → 50.
  // 타일 (−1,0) 의 가까운 모서리 (0,32,10): 수평 40, dz 30 → 50. 수평 거리만 보면 40 < 49.999 라 둘 다 들어와 버린다.
  const v = poseToView(pose([40, 32, 40], 0, 0, 2.0), SQ);
  const run = (D) => tilesInView(v, { maxDistM: D, zRangeM: [0, 10], nearM: 0.1 });
  const base = [[0, 0], [1, 0], [0, 1]];
  assertSet(run(49.999), base);
  assertSet(run(50), [...base, [-1, 0], [1, 1]]);
  assertSet(run(50.001), [...base, [-1, 0], [1, 1]]);
  // 거리 판정을 정수로 반올림하면(50.32 → 50) D=50 에서 50.32 m 떨어진 타일이 들어온다: 모서리까지 수평 40.4, dz 30 → √2532.16 = 50.32
  const v2 = poseToView(pose([64 - 24.24, 64 - 32.32, 40], 0, 0, 2.0), SQ);
  const has = (D) => tilesInView(v2, { maxDistM: D, zRangeM: [0, 10], nearM: 0.1 }).some(({ tx, ty }) => tx === 1 && ty === 1);
  assert.equal(has(50), false); // 50.32 > 50
  assert.equal(has(50.3), false);
  assert.equal(has(50.33), true);
});

test('큰 좌표에서 이론상 정확히 maxDistM 인 타일은 포함(거리 여유 EDGE_EPS_M): D=50 결과 = D=50.001 결과', () => {
  // 타일 모서리까지 수평 40(24,32)·dz 30 → 정확히 50 인 타일(위 시험과 같은 배치)을 좌표 6.4e3~6.4e7 m 로 옮기고 자세를 바꿔도
  // 부동소수 오차(R·t 왕복)로 계산 거리가 50 을 아주 조금 넘는다. 여유가 있으면 D=50 결과가 50.001 결과와 같다(사이에 다른 타일 없음).
  let cases = 0;
  for (const N of [100, 1000, 10000, 100000, 1000000]) {
    for (const yaw of [0, 0.3, 1, 2.5, -1.3]) {
      for (const el of [0, 0.2, -0.4]) {
        const Y = Math.round((64 * N * 0.7) / S) * S;
        const v = poseToView(pose([S * N + 40, Y + 32, 40], yaw, el, 2.0), SQ);
        const at = (D) => tilesInView(v, { maxDistM: D, zRangeM: [0, 10], nearM: 0.1 });
        assertSet(at(50), pairs(at(50.001)));
        cases += 1;
      }
    }
  }
  assert.equal(cases, 75);
});

test('최대 개수: 걸러낸 결과가 4096 을 넘으면 RangeError, 기본 한도 광각은 반경 정사각 이하', () => {
  // 기본 한도(1500 m)의 결과는 반경 정사각 격자(49×49 = 2401) 이하라 광각에서도 한도에 닿지 않는다.
  // 개수 골든은 두지 않고 아래 '골든 대신 포함 관계' 시험이 오라클 ⊆ 결과 ⊆ 반경 정사각으로 본다.
  // 높이 1000 m 하향 정사각 시야, 발자국 반폭 h, 구 3100 m(발자국 모서리 ≈ 3057 m 를 덮는다):
  // h=2047.9 → tx,ty ∈ −32..31 = 64×64 = 정확히 4096(허용), h=2048.1 → −33..32 = 66×66(초과)
  const down = (h) => poseToView(pose([0, 0, 1000], 0, -Math.PI / 2, 2 * Math.atan(h / 1000)), SQ);
  const flat = { maxDistM: 3100, zRangeM: [0, 0], nearM: 0.1 };
  assert.equal(tilesInView(down(2047.9), flat).length, 4096);
  assert.throws(() => tilesInView(down(2048.1), flat), (e) => e instanceof RangeError && e.message === 'maxTilesPerUpdate');
  // 같은 h=2048.1 이라도 구가 작으면 걸러낸 뒤 수가 한도 아래라 던지지 않는다(한도는 거른 뒤에 적용)
  const small = tilesInView(down(2048.1), { ...flat, maxDistM: 2500 });
  assert.ok(small.length > 0 && small.length <= 4096);
  // 어긋난 카메라 (5,13,1000), 발자국 반폭 2100(후보 4422개). 구 반경이 2610.75 면 걸러낸 결과가 정확히 4096(허용),
  // 2611 이면 4097(초과). 한도 비교가 한 칸 어긋나거나 거르기 전에 세면 이 둘이 갈린다.
  const off = poseToView(pose([5, 13, 1000], 0, -Math.PI / 2, 2 * Math.atan(2.1)), SQ);
  assert.equal(tilesInView(off, { ...flat, maxDistM: 2610.75 }).length, 4096);
  assert.throws(() => tilesInView(off, { ...flat, maxDistM: 2611 }), (e) => e instanceof RangeError && e.message === 'maxTilesPerUpdate');
});

test('광각 fovY 2.4 rad, 고도 60~140 m, pitch −0.5~−0.1, 1500 m: 결과 수 ≤ 이론 상한(원판)', () => {
  const opts = { maxDistM: 1500, zRangeM: [-100, 600], nearM: 0.1 };
  let max = 0;
  for (let h = 60; h <= 140; h += 20) {
    for (let p = -0.5; p <= -0.1 + 1e-9; p += 0.1) {
      for (let yaw = 0; yaw < 2 * Math.PI; yaw += Math.PI / 6) {
        const n = tilesInView(poseToView(pose([0, 0, h], yaw, p, 2.4), { width: 1600, height: 900 }), opts).length;
        if (n > max) max = n;
      }
    }
  }
  // 상한 근거(측정값은 근거가 아니다): 카메라 z(60~140)가 zRangeM[-100,600] 안이라 dz=0 이므로 결과 타일은 모두 xy 로 반경 D 원판과 만난다.
  // 그런 타일의 중심은 카메라로부터 D + S/√2 이내에 있고 타일 중심은 면적 S² 에 하나씩이므로 개수 ≤ π(D + S/√2)²/S² 이고, 여유를 두어 π(D + √2·S)²/S² 를 상한으로 쓴다.
  const bound = Math.ceil(Math.PI * (1500 + Math.SQRT2 * S) ** 2 / (S * S));
  assert.ok(max > 0 && max <= bound, `최댓값 ${max}, 이론 상한 ${bound}`);
});

test('입력 검사·불변', () => {
  const v = poseToView(pose([32, 32, 100], 0, -Math.PI / 2, FOV_HALF), SQ);
  const opts = { maxDistM: 500, zRangeM: [0, 10], nearM: 0.1 };
  const snap = JSON.stringify([v, opts]);
  tilesInView(v, opts);
  assert.equal(JSON.stringify([v, opts]), snap);
  assert.throws(() => tilesInView(null, opts), TypeError);
  assert.throws(() => tilesInView(v, { ...opts, zRangeM: [10, 0] }), RangeError);
  assert.throws(() => tilesInView(v, { ...opts, nearM: 0 }), RangeError);
  assert.throws(() => tilesInView(v, { ...opts, maxDistM: NaN }), RangeError);
});

// ── 오라클 ──

/** 결정적 의사난수(mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 선분 (p0→p1, xy) 이 지나는 타일 전부(격자선 교차 매개변수 사이의 중점 + 양 끝점). */
function segmentTiles(p0, p1, out) {
  const ts = [0, 1];
  for (const d of [0, 1]) {
    const a = p0[d]; const b = p1[d];
    if (a === b) continue;
    const lo = Math.min(a, b); const hi = Math.max(a, b);
    for (let k = Math.ceil(lo / S); k * S <= hi; k += 1) ts.push((k * S - a) / (b - a));
  }
  ts.sort((x, y) => x - y);
  const at = (s) => [p0[0] + (p1[0] - p0[0]) * s, p0[1] + (p1[1] - p0[1]) * s];
  const add = ([x, y]) => { const { tx, ty } = tileOf(x, y); out.add(key(tx, ty)); };
  add(at(0));
  add(at(1));
  for (let i = 0; i + 1 < ts.length; i += 1) add(at((ts[i] + ts[i + 1]) / 2));
}

/** 화소 격자 광선이 깊이 ≥ near, 카메라 거리 ≤ maxDist, z 판 안에서 지나는 타일 집합. */
function oracle(view, opts, nu = 32, nv = 18) {
  const { R, t, K, width, height } = view;
  const C = [0, 1, 2].map((j) => -(R[j] * t[0] + R[3 + j] * t[1] + R[6 + j] * t[2]));
  const out = new Set();
  for (let i = 0; i < nu; i += 1) {
    for (let j = 0; j < nv; j += 1) {
      const u = (i / (nu - 1)) * width;
      const vv = (j / (nv - 1)) * height;
      const dc = [(u - K.cx) / K.fx, (vv - K.cy) / K.fy, 1]; // 깊이 1 당 카메라 좌표
      const dw = [0, 1, 2].map((k) => R[k] * dc[0] + R[3 + k] * dc[1] + R[6 + k] * dc[2]);
      // 깊이 d 인 점의 카메라 거리는 d·|dw| → 거리 ≤ maxDist ⇔ d ≤ maxDist/|dw|
      let d0 = opts.nearM; let d1 = opts.maxDistM / Math.hypot(dw[0], dw[1], dw[2]);
      const [zmin, zmax] = opts.zRangeM;
      if (Math.abs(dw[2]) < 1e-15) {
        if (C[2] < zmin || C[2] > zmax) continue;
      } else {
        const a = (zmin - C[2]) / dw[2]; const b = (zmax - C[2]) / dw[2];
        d0 = Math.max(d0, Math.min(a, b));
        d1 = Math.min(d1, Math.max(a, b));
      }
      if (d0 > d1) continue;
      segmentTiles([C[0] + dw[0] * d0, C[1] + dw[1] * d0], [C[0] + dw[0] * d1, C[1] + dw[1] * d1], out);
    }
  }
  return out;
}

test('오라클: 무작위 시점 200개에서 화소 광선이 지나는 타일 누락 0', () => {
  const rand = rng(20261005);
  const sizes = [{ width: 1600, height: 900 }, { width: 800, height: 600 }, { width: 640, height: 640 }, { width: 400, height: 900 }];
  let done = 0;
  let checked = 0;
  let tries = 0;
  let skipped = 0; // maxTilesPerUpdate 로 건너뛴 시점 수
  while (done < 200) {
    tries += 1;
    assert.ok(tries < 2000, '시점 생성 실패');
    // 일부는 좌표를 타일 경계(64 배수)에 붙여 경계 근처를 일부러 찌른다
    const snap = rand() < 0.3;
    const px = snap ? Math.round((rand() - 0.5) * 20) * S : (rand() - 0.5) * 2000;
    const py = snap ? Math.round((rand() - 0.5) * 20) * S : (rand() - 0.5) * 2000;
    const p = pose([px, py, rand() * 300 - 20], (rand() - 0.5) * 2 * Math.PI, (rand() - 0.5) * Math.PI, 0.2 + rand() * 2.3);
    const size = sizes[Math.floor(rand() * sizes.length)];
    const zmin = -50 + rand() * 60;
    const opts = { maxDistM: 100 + rand() * 1400, zRangeM: [zmin, zmin + rand() * 120], nearM: 0.05 + rand() * 2 };
    const view = poseToView(p, size);
    let r;
    try {
      r = tilesInView(view, opts);
    } catch (e) {
      if (e instanceof RangeError && e.message === 'maxTilesPerUpdate') { skipped += 1; continue; }
      throw e;
    }
    const got = new Set(r.map(({ tx, ty }) => key(tx, ty)));
    assert.equal(got.size, r.length, '중복 타일');
    for (const k of oracle(view, opts)) {
      assert.ok(got.has(k), `누락 ${k} (시점 ${done}: ${JSON.stringify({ p, size, opts })})`);
      checked += 1;
    }
    // 순서: 거리 오름차순, 같으면 사전순
    const C = [0, 1].map((j) => -(view.R[j] * view.t[0] + view.R[3 + j] * view.t[1] + view.R[6 + j] * view.t[2]));
    const dist = ({ tx, ty }) => ((tx + 0.5) * S - C[0]) ** 2 + ((ty + 0.5) * S - C[1]) ** 2;
    for (let i = 0; i + 1 < r.length; i += 1) {
      const a = r[i]; const b = r[i + 1];
      assert.ok(dist(a) < dist(b) || (dist(a) === dist(b) && (a.tx < b.tx || (a.tx === b.tx && a.ty < b.ty))), '순서');
    }
    done += 1;
  }
  assert.ok(checked > 1000, `오라클 타일 수가 너무 적다: ${checked}`);
  // 건너뜀 상한: maxDistM ≤ 1500 이면 결과가 반경 정사각 ≤ 49×49 = 2401 < 4096 이라 RangeError 는 이론상 나올 수 없다 → 0.
  assert.equal(skipped, 0, `RangeError 로 건너뛴 시점 ${skipped} 개`);
});

test('골든 대신 포함 관계: 오라클 ⊆ 결과 ⊆ 반경 정사각 ∩ 구와 만나는 타일 (1500 m 광각)', () => {
  const opts = { maxDistM: 1500, zRangeM: [-100, 600], nearM: 0.1 };
  const D = opts.maxDistM;
  const size = { width: 1600, height: 900 };
  for (const e of [-0.3, -0.8]) {
    const view = poseToView(pose([0, 0, 300], 0, e, 2.5), size);
    const r = tilesInView(view, opts);
    const got = new Set(r.map(({ tx, ty }) => key(tx, ty)));
    assert.equal(got.size, r.length);
    const want = oracle(view, opts, 64, 36);
    assert.ok(want.size > 100);
    for (const k of want) assert.ok(got.has(k), `누락 ${k}`);
    const lo = Math.floor(-D / S); const hi = Math.floor(D / S); // 반경 정사각 |dx|,|dy| ≤ D (카메라 (0,0))
    for (const { tx, ty } of r) {
      assert.ok(tx >= lo && tx <= hi && ty >= lo && ty <= hi, `정사각 밖 ${tx},${ty}`);
      // 구: 카메라 z=300 이 판 안이라 dz=0, 타일 사각형까지 xy 최소 거리 ≤ D
      const dx = Math.max(tx * S, 0, -(tx + 1) * S); const dy = Math.max(ty * S, 0, -(ty + 1) * S);
      assert.ok(Math.hypot(dx, dy) <= D + 1e-6, `구 밖 ${tx},${ty}`);
    }
    assert.ok(r.length >= want.size && r.length <= (hi - lo + 1) ** 2);
  }
});

const EXPECT_WIDE = [
  [-2, -1], [-2, 0], [-2, 1], [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 0], [0, 1], [1, -1], [1, 0], [1, 1],
];

test('카메라 회전 R: 직교하지 않으면 RangeError', () => {
  const base = poseToView({ pos: [0, 0, 100], quat: [0, 0, 0, 1], fovY: 1 }, SQ);
  const opts = { maxDistM: 500, zRangeM: [0, 10], nearM: 0.1 };
  // 비직교: R 행을 스케일링하면 R·Rᵀ ≠ I
  const badR = base.R.slice();
  badR[0] *= 2; // 첫 행 스케일
  const badView = { ...base, R: badR };
  assert.throws(() => tilesInView(badView, opts), RangeError);
});

test('카메라 회전 R: 직교하면 정상', () => {
  // 하향 자세: pose() 함수가 만든 쿼터니언은 직교 회전 행렬을 만든다
  const v = poseToView(pose([32, 32, 100], 0, -Math.PI / 2, FOV_HALF), SQ);
  const opts = { maxDistM: 500, zRangeM: [0, 10], nearM: 0.1 };
  const r = tilesInView(v, opts);
  assert.ok(Array.isArray(r));
  assert.ok(r.length > 0);
});

const LIM = TOWER_STREAMING_LIMITS;
/** 결과 또는 RangeError 문구(둘 다 비교 대상). */
function outcome(fn, view, opts, stats) {
  try { return fn(view, opts, stats); } catch (e) { if (e instanceof RangeError) return `RangeError: ${e.message}`; throw e; }
}

test('좌표 상한 근처(|x|,|y| ≈ 6.4e7 m) 타일 경계 직전·맞닿음·직후', () => {
  // 위 '타일 경계 직전·맞닿음·직후' 를 타일 (±999990) 근처로 옮긴다. 경계 여유 EDGE_EPS_M 은 좌표에 비례하지 않으므로
  // 이 크기의 좌표에서도 맞닿음(64 배수)을 포함하고 0.001 m 넘침은 빼야 한다.
  const K0 = 999990;
  const X0 = K0 * S;
  const Y0 = -K0 * S;
  const opts = { maxDistM: 500, zRangeM: [0, 0], nearM: 0.1 };
  const shift = (list) => list.map(([tx, ty]) => [tx + K0, ty - K0]);
  const run = (X, Y) => tilesInView(poseToView(pose([X0 + X, Y0 + Y, 100], 0, -Math.PI / 2, FOV_HALF), SQ), opts);
  const two = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 0], [0, 1]];
  const three = [...two, [1, -1], [1, 0], [1, 1]];
  assertSet(run(13.999, 32), shift(two));
  assertSet(run(14, 32), shift(three));
  assertSet(run(50, 32), shift(three));
  assertSet(run(50.001, 32), shift([[0, -1], [0, 0], [0, 1], [1, -1], [1, 0], [1, 1]]));
  assertSet(run(32, 50), shift(three));
  assertSet(run(32, 50.001), shift([[-1, 0], [-1, 1], [0, 0], [0, 1], [1, 0], [1, 1]]));
  assertSet(run(32, 13.999), shift([[-1, -1], [-1, 0], [0, -1], [0, 0], [1, -1], [1, 0]]));
  assertSet(run(32, 14), shift(three));
});

test('무작위 자세: 현재 결과 = f0b6609 고정 사본 결과(기본 범위·큰 D·좌표 상한 근처)', () => {
  const rand = rng(8201005);
  const size = { width: 1600, height: 900 };
  const cases = [];
  // 기본 범위: D 300~1500, 카메라 z 는 판 안팎
  for (let i = 0; i < 300; i += 1) {
    const D = 300 + rand() * 1200;
    const z = rand() < 0.5 ? rand() * 300 : (rand() - 0.5) * 3 * D;
    const p = pose([(rand() - 0.5) * 4000, (rand() - 0.5) * 4000, z], (rand() - 0.5) * 2 * Math.PI, (rand() - 0.5) * Math.PI, 0.6 + rand() * 2.2);
    cases.push([p, { maxDistM: D, zRangeM: [0, 100 + rand() * 200], nearM: 0.1 + rand() }]);
  }
  // 큰 D: 10^3.5 ~ 10^6 m, 고도 0~1.2D (옛 구현이 행을 많이 도는 영역이라 수를 줄인다)
  for (let i = 0; i < 60; i += 1) {
    const D = 10 ** (3.5 + rand() * 2.5);
    const p = pose([(rand() - 0.5) * 1e6, (rand() - 0.5) * 1e6, 600 + rand() * 1.2 * D], (rand() - 0.5) * 2 * Math.PI, -rand() * Math.PI / 2, 0.3 + rand() * 2.5);
    cases.push([p, { maxDistM: D, zRangeM: [-100, 600], nearM: 0.1 + rand() }]);
  }
  // 좌표 상한 근처: |x|,|y| + D ≈ maxCoordM(타일 경계에 붙이거나 조금 안쪽)
  for (let i = 0; i < 60; i += 1) {
    const D = 300 + rand() * 1200;
    const edge = LIM.maxCoordM - D;
    const sx = rand() < 0.5 ? 1 : -1;
    const sy = rand() < 0.5 ? 1 : -1;
    const snap = rand() < 0.5;
    const x = sx * (snap ? Math.floor(edge / S) * S : edge - rand() * 2 * S);
    const y = sy * (snap ? Math.floor(edge / S) * S : edge - rand() * 2 * S);
    const p = pose([x, y, rand() * 1500], (rand() - 0.5) * 2 * Math.PI, (rand() - 0.5) * Math.PI, 0.6 + rand() * 2.2);
    cases.push([p, { maxDistM: D, zRangeM: [-100, 600], nearM: 0.1 + rand() }]);
  }
  let nonEmpty = 0;
  cases.forEach(([p, opts], i) => {
    const view = poseToView(p, size);
    const a = outcome(tilesInView, view, opts);
    const b = outcome(tilesInViewF0, view, opts);
    assert.deepEqual(a, b, `옛 결과와 다르다 (시점 ${i}: ${JSON.stringify({ p, opts })})`);
    if (Array.isArray(a) && a.length > 0) nonEmpty += 1;
  });
  assert.ok(nonEmpty >= 200, `비지 않은 결과가 너무 적다: ${nonEmpty}`);
});

/** 작업량: 꼭짓점 연립 조합 + 원판 교차에서 본 변 + 행 + 칸. 옛 사본은 조합이 C(12,3) = 220 으로 고정이고 변 단계가 없다. */
const workNew = (st) => st.combos + st.edges + st.rows + st.cells;
const workF0 = (st) => 220 + st.rows + st.cells;

test('기본값(maxDistM 1500) 작업량: 호출마다 f0b6609 사본의 1.2 배 이내, 꼭짓점 연립은 220 조합 한 번', () => {
  // 벽시계 대신 결정적 작업량 계수기로 본다. 반공간을 더해 꼭짓점을 다시 구하면(16각형 28면: C(28,3) = 3276 조합) 여기서 걸린다.
  const opts = { maxDistM: LIM.maxDistM, zRangeM: [LIM.zMinM, LIM.zMaxM], nearM: LIM.nearM };
  const size = { width: 1600, height: 900 };
  let sumNew = 0;
  let sumOld = 0;
  let calls = 0;
  for (let i = 0; i < 200; i += 1) {
    const p = pose([(i * 37) % 500, (i * 91) % 500, 60 + (i % 5) * 20], i * 0.3, -0.1 - (i % 5) * 0.1, 0.6 + (i % 4) * 0.6);
    const view = poseToView(p, size);
    const sn = { rows: 0, cells: 0, combos: 0, edges: 0, vertexCalls: 0 };
    const so = { rows: 0, cells: 0 };
    const c0 = vertexCallCount();
    assert.deepEqual(tilesInView(view, opts, sn), tilesInViewF0(view, opts, so));
    assert.equal(vertexCallCount() - c0, 1, `모듈 수준 vertices() 호출 ${vertexCallCount() - c0} 회 (시점 ${i})`);
    assert.equal(sn.combos, 220);
    assert.equal(sn.vertexCalls, 1, `vertices() 호출 ${sn.vertexCalls} 회 (시점 ${i})`);
    assert.ok(sn.rows <= so.rows && sn.cells <= so.cells, `행·칸이 늘었다 (시점 ${i})`);
    assert.ok(workNew(sn) <= 1.2 * workF0(so), `작업량 ${workNew(sn)} > 1.2 × ${workF0(so)} (시점 ${i})`);
    sumNew += workNew(sn);
    sumOld += workF0(so);
    calls += 1;
  }
  assert.equal(calls, 200);
  assert.ok(sumNew <= 1.2 * sumOld, `합계 작업량 ${sumNew} > 1.2 × ${sumOld}`);
});

test('고고도·큰 maxDistM(fovY 0.6~2.8 × f 0.3~0.99 × yaw 5 × pitch 10, z=600+f·6e7): 행 ≤ 2000, 칸·조합 상한, 일부는 옛 사본과 같다', () => {
  const size = { width: 1600, height: 900 };
  const D = 6e7;
  const opts = { maxDistM: D, zRangeM: [0, 600], nearM: 1 };
  const yaws = [1, -Math.PI / 2, 0, Math.PI / 2, 2.5];
  const pitches = [-Math.PI / 2, -1, -0.4, -0.2, -0.1, -0.05, 0, 0.1, 0.4, 1];
  let n = 0;
  let maxRows = 0;
  let compared = 0;
  for (const fovY of [0.6, 1.0, 1.2, 2.0, 2.8]) {
    for (const f of [0.3, 0.5, 0.6, 0.9, 0.99]) {
      for (const yaw of yaws) {
        for (const pitch of pitches) {
          const view = poseToView(pose([0, 0, 600 + f * D], yaw, pitch, fovY), size);
          const stats = { rows: 0, cells: 0, combos: 0, edges: 0, vertexCalls: 0 };
          const c0 = vertexCallCount();
          const t0 = performance.now();
          const r = outcome(tilesInView, view, opts, stats);
          const ms = performance.now() - t0;
          const where = `fovY ${fovY} f ${f} yaw ${yaw} pitch ${pitch}`;
          // 행 수는 결정적 작업량 상한이다(옛 16각형 반공간 좁히기는 이 격자에서 최대 5 만 행, 좁히기 없는 f0b6609 는 150 만 행)
          assert.ok(stats.rows <= 2000, `행 ${stats.rows} ${where}`);
          assert.ok(stats.cells <= LIM.maxTilesPerUpdate + 1 + 2 * stats.rows, `칸 ${stats.cells} ${where}`);
          assert.equal(stats.combos, 220, where);
          assert.equal(stats.vertexCalls, 1, `vertices() 호출 ${stats.vertexCalls} 회 ${where}`);
          assert.equal(vertexCallCount() - c0, 1, `모듈 수준 vertices() 호출 ${vertexCallCount() - c0} 회 ${where}`);
          assert.ok(ms < 1000, `${ms} ms ${where}`); // 느슨한 안전 단언(판정은 위 계수기)
          if (stats.rows > maxRows) maxRows = stats.rows;
          // 옛 사본은 호출당 수백 ms 까지 걸리므로 일부만 비교한다: 25 번째마다 + 보고된 최악 배치(fovY 1, f 0.5, yaw −π/2, pitch −0.1)
          if (n % 25 === 0 || (fovY === 1.0 && f === 0.5 && yaw === -Math.PI / 2 && pitch === -0.1)) {
            assert.deepEqual(r, outcome(tilesInViewF0, view, opts), `옛 결과와 다르다 ${where}`);
            compared += 1;
          }
          n += 1;
        }
      }
    }
  }
  assert.equal(n, 1250);
  assert.ok(compared >= 50, `비교 ${compared}`);
  assert.ok(maxRows > 0);
});

// ── 고정 사본: f0b6609(T15.7 병합) 의 visible.mjs 구현 ──
// 행 범위 좁히기 전의 구현을 그대로 옮겨 둔다(입력 검사 checkArgs 만 뺌: 아래 시험은 늘 새 구현이 먼저 검사한다).
// 현재 구현이 바뀌어도 이 사본은 바뀌지 않으므로 '옛 결과와 같다' 비교의 기준이 된다. 고치지 말 것.
function oldRangeEps(v) {
  return 1e-6 + Math.abs(v) * 1e-12;
}

/**
 * 세계 좌표 반공간 목록 {a:[3], b} (a·X ≥ b, |a| = 1).
 * 카메라 좌표 반공간 n·X_c ≥ c 는 X_c = R·X + t 를 넣으면 (Rᵀn)·X ≥ c − n·t 이다.
 */
function oldHalfSpaces(view, opts, cam0) {
  const { R, t, K, width, height } = view;
  const cam = [
    [[K.fx, 0, K.cx], 0], // 왼쪽: u ≥ 0
    [[-K.fx, 0, width - K.cx], 0], // 오른쪽: u ≤ width
    [[0, K.fy, K.cy], 0], // 위: v ≥ 0
    [[0, -K.fy, height - K.cy], 0], // 아래: v ≤ height
    [[0, 0, 1], opts.nearM], // 근평면: 깊이 ≥ nearM
    [[0, 0, -1], -opts.maxDistM], // 원평면: 깊이 ≤ maxDistM (구를 감싼다)
  ];
  const out = [];
  for (const [n, c] of cam) {
    const a = [0, 1, 2].map((j) => R[j] * n[0] + R[3 + j] * n[1] + R[6 + j] * n[2]);
    const nt = n[0] * t[0] + n[1] * t[1] + n[2] * t[2];
    const len = Math.hypot(a[0], a[1], a[2]);
    out.push({ a: a.map((v) => v / len), b: (c - nt) / len });
  }
  out.push({ a: [0, 0, 1], b: opts.zRangeM[0] });
  out.push({ a: [0, 0, -1], b: -opts.zRangeM[1] });
  // 카메라 중심 xy 정사각 |dx|,|dy| ≤ maxDistM (구를 감싼다)
  const D = opts.maxDistM;
  out.push({ a: [1, 0, 0], b: cam0[0] - D });
  out.push({ a: [-1, 0, 0], b: -(cam0[0] + D) });
  out.push({ a: [0, 1, 0], b: cam0[1] - D });
  out.push({ a: [0, -1, 0], b: -(cam0[1] + D) });
  return out;
}

/** 반공간 교집합의 꼭짓점(세 면 연립). 허용 오차 안에서 모든 반공간을 만족하는 것만. */
function oldVertices(planes) {
  const pts = [];
  const m = planes.length;
  for (let i = 0; i < m; i += 1) {
    for (let j = i + 1; j < m; j += 1) {
      for (let k = j + 1; k < m; k += 1) {
        const p = planes[i].a; const q = planes[j].a; const r = planes[k].a;
        // q×r, r×p, p×q 로 크라메르 공식
        const qr = [q[1] * r[2] - q[2] * r[1], q[2] * r[0] - q[0] * r[2], q[0] * r[1] - q[1] * r[0]];
        const rp = [r[1] * p[2] - r[2] * p[1], r[2] * p[0] - r[0] * p[2], r[0] * p[1] - r[1] * p[0]];
        const pq = [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
        const det = p[0] * qr[0] + p[1] * qr[1] + p[2] * qr[2];
        if (Math.abs(det) < 1e-12) continue; // 평행·공선 조합은 꼭짓점을 만들지 않는다
        const bi = planes[i].b; const bj = planes[j].b; const bk = planes[k].b;
        const X = [0, 1, 2].map((d) => (bi * qr[d] + bj * rp[d] + bk * pq[d]) / det);
        if (!X.every(Number.isFinite)) continue;
        const tol = 1e-9 * (1 + Math.abs(X[0]) + Math.abs(X[1]) + Math.abs(X[2]));
        let ok = true;
        for (let h = 0; h < m && ok; h += 1) {
          const { a, b } = planes[h];
          if (a[0] * X[0] + a[1] * X[1] + a[2] * X[2] < b - tol) ok = false;
        }
        if (ok) pts.push([X[0], X[1]]);
      }
    }
  }
  return pts;
}

/** 2차원 볼록 껍질(단조 사슬). 반시계, 중복·공선 점 제거. 점이 1~2 개뿐이면 그대로. */
function oldHull(points) {
  const p = points.slice().sort((u, v) => (u[0] - v[0]) || (u[1] - v[1]));
  if (p.length <= 2) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i -= 1) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  const h = lower.concat(upper);
  return h.length > 0 ? h : [p[0]];
}

/**
 * 볼록 다각형(꼭짓점 목록) ∩ 띠 y∈[y0,y1] 의 x 범위. 비면 null.
 * 극값은 띠 안 꼭짓점이거나 변이 y=y0·y=y1 과 만나는 점이다.
 */
function oldStripRange(poly, y0, y1) {
  let lo = Infinity;
  let hi = -Infinity;
  const n = poly.length;
  const take = (x) => { if (x < lo) lo = x; if (x > hi) hi = x; };
  for (let i = 0; i < n; i += 1) {
    const [x, y] = poly[i];
    if (y >= y0 && y <= y1) take(x);
    if (n < 2) continue;
    const [xb, yb] = poly[(i + 1) % n];
    for (const c of [y0, y1]) {
      if ((y < c && yb > c) || (y > c && yb < c)) take(x + (xb - x) * ((c - y) / (yb - y)));
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * 시점에서 보이는 타일 번호.
 * @param {{R:number[], t:number[], K:{fx:number, fy:number, cx:number, cy:number}, width:number, height:number}} view  poseToView 결과
 * @param {{maxDistM:number, zRangeM:number[], nearM:number}} opts
 * @param {{rows:number, cells:number}} [stats] 시험용 작업량 계수기(행·칸 방문 수를 더해 준다). 결과에는 영향이 없다.
 * @returns {{tx:number, ty:number}[]} 카메라 (x,y) 에서 타일 중심까지 거리 오름차순, 같으면 (tx,ty) 사전순
 */
function tilesInViewF0(view, opts, stats) {
  const limit = TOWER_STREAMING_LIMITS.maxTilesPerUpdate;

  // 카메라 위치(세계) = −Rᵀ·t
  const { R, t } = view;
  const cam0 = [0, 1, 2].map((j) => -(R[j] * t[0] + R[3 + j] * t[1] + R[6 + j] * t[2]));
  const [camX, camY, camZ] = cam0;

  const poly = oldHull(oldVertices(oldHalfSpaces(view, opts, cam0)));
  if (poly.length === 0) return [];

  let ymin = Infinity;
  let ymax = -Infinity;
  for (const [, y] of poly) { if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
  const IMAX = TOWER_STREAMING_LIMITS.tileIndexMax;
  // 범위 방어: 한 칸 이내의 넘침(경계 여유)은 자르고, 그보다 크면 던진다. 루프 전에 검사한다.
  const clampIdx = (v, name) => {
    if (!(Math.abs(v) <= IMAX + 1)) throw new RangeError(`${name} 가 ±tileIndexMax(${IMAX}) 를 벗어난다: ${v}`);
    return Math.min(IMAX, Math.max(-IMAX, v));
  };
  let ty0 = clampIdx(Math.floor((ymin - oldRangeEps(ymin)) / S), 'ty');
  let ty1 = clampIdx(Math.floor((ymax + oldRangeEps(ymax)) / S), 'ty');

  // 직육면체-구 판정: 최소 거리² ≤ (maxDistM + 여유)²
  const D = opts.maxDistM + oldRangeEps(opts.maxDistM) + oldRangeEps(Math.hypot(camX, camY, camZ));
  const D2 = D * D;
  const [zMin, zMax] = opts.zRangeM;
  const gap = (c, lo, hi) => (c < lo ? lo - c : c > hi ? c - hi : 0);
  const dz = gap(camZ, zMin, zMax);
  // z 판이 구 밖이면 어떤 타일도 구와 만나지 않는다(빈 행을 수백만 번 도는 일을 막는다)
  if (dz > D) return [];
  // 구가 닿는 y 는 camY ± √(D²−dz²) 뿐이므로 행 범위를 먼저 좁힌다
  const hy = Math.sqrt(Math.max(0, D2 - dz * dz));
  ty0 = Math.max(ty0, clampIdx(Math.floor((camY - hy - oldRangeEps(camY - hy)) / S), 'ty'));
  ty1 = Math.min(ty1, clampIdx(Math.floor((camY + hy + oldRangeEps(camY + hy)) / S), 'ty'));

  const out = [];
  for (let ty = ty0; ty <= ty1; ty += 1) {
    if (stats) stats.rows += 1;
    const y0 = ty * S;
    const y1 = (ty + 1) * S;
    const r = oldStripRange(poly, y0 - oldRangeEps(y0), y1 + oldRangeEps(y1));
    if (r === null) continue;
    const dy = gap(camY, y0, y1);
    const rem = D2 - dy * dy - dz * dz;
    if (rem < 0) continue;
    // 이 행에서 구가 닿는 x 는 camX ± √(D²−dy²−dz²) 이므로 띠 범위와 교집합만 훑는다
    const hx = Math.sqrt(rem);
    const lo = Math.max(r[0], camX - hx);
    const hi = Math.min(r[1], camX + hx);
    if (lo - oldRangeEps(lo) > hi + oldRangeEps(hi)) continue;
    const tx0 = clampIdx(Math.floor((lo - oldRangeEps(lo)) / S), 'tx');
    const tx1 = clampIdx(Math.floor((hi + oldRangeEps(hi)) / S), 'tx');
    for (let tx = tx0; tx <= tx1; tx += 1) {
      if (stats) stats.cells += 1;
      const dx = gap(camX, tx * S, (tx + 1) * S);
      if (dx * dx + dy * dy + dz * dz > D2) continue; // 구와 만나지 않는다
      if (out.length >= limit) throw new RangeError('maxTilesPerUpdate');
      const cx = (tx + 0.5) * S - camX;
      const cy = (ty + 0.5) * S - camY;
      out.push({ tx, ty, d: cx * cx + cy * cy });
    }
  }
  out.sort((a, b) => (a.d - b.d) || (a.tx - b.tx) || (a.ty - b.ty));
  return out.map(({ tx, ty }) => ({ tx, ty }));
}
