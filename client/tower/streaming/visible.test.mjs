// tilesInView(T15.7.1) 시험. 합성 시점의 기대 타일 집합(숫자로 박음)과 무작위 시점 오라클(화소 광선 → 누락 0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tilesInView } from './visible.mjs';
import { poseToView } from '../overlay/view.mjs';
import { tileOf, TERRAIN_TILE_SIZE_M } from '../../../contracts/tower_assets/index.mjs';

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
  // (−3,±2) 는 사각뿔 다면체와도, 구와도 각각 만나지만 그 교집합과는 아슬하게(≈200.4 m) 만나지 않는다 — 허용된 과포함.
  assert.deepEqual(pairs(r), [[0, 0], [-1, 0], [-1, -1], [-1, 1], [-2, 0], [-2, -1], [-2, 1], [-3, 0], [-3, -1], [-3, 1], [-3, -2], [-3, 2]]);
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

test('최대 개수: 걸러낸 결과가 4096 을 넘으면 RangeError, 기본 한도 광각은 반경 정사각 이하', () => {
  // 기본 한도(1500 m)에서는 결과가 반경 정사각 격자(49×49 = 2401) 이하라 광각에서도 한도에 닿지 않는다
  const opts = { maxDistM: 1500, zRangeM: [-100, 600], nearM: 0.1 };
  const at = (z, e) => poseToView(pose([0, 0, z], 0, e, 2.5), { width: 1600, height: 900 });
  assert.equal(tilesInView(at(300, -0.3), opts).length, 894);
  assert.equal(tilesInView(at(300, -0.8), opts).length, 1068);
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

test('광각 fovY 2.4 rad, 고도 60~140 m, pitch −0.5~−0.1, 1500 m: 결과 수 ≤ 900', () => {
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
  assert.ok(max > 0 && max <= 900, `최댓값 ${max}`);
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
      if (e instanceof RangeError && e.message === 'maxTilesPerUpdate') continue;
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
});

const EXPECT_WIDE = [
  [-2, -1], [-2, 0], [-2, 1], [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 0], [0, 1], [1, -1], [1, 0], [1, 1],
];
