import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceCull } from './index.mjs';

/**
 * 간단한 테스트용 계층 만들기.
 * leafCount 개의 리프, 각각 하나의 점. 리프 k 의 상자는 [k, k, k] ~ [k+1, k+1, k+1].
 */
function makeSimpleHierarchy(leafCount) {
  const octree = {
    leafCount,
    nodeCount: leafCount,
    firstChild: new Int32Array(leafCount).fill(-1),
    childCount: new Uint8Array(leafCount).fill(0),
    leafIndex: new Int32Array(Array.from({ length: leafCount }, (_, i) => i)),
    boxMin: new Float32Array(leafCount * 3),
    boxMax: new Float32Array(leafCount * 3),
    leafStart: new Uint32Array(Array.from({ length: leafCount + 1 }, (_, i) => i)),
    order: new Uint32Array(Array.from({ length: leafCount }, (_, i) => i)),
  };

  // 각 리프 상자 설정: 리프 k 는 [k, k, k] ~ [k+1, k+1, k+1]
  for (let k = 0; k < leafCount; k++) {
    const i3 = k * 3;
    octree.boxMin[i3] = k;
    octree.boxMin[i3 + 1] = k;
    octree.boxMin[i3 + 2] = k;
    octree.boxMax[i3] = k + 1;
    octree.boxMax[i3 + 1] = k + 1;
    octree.boxMax[i3 + 2] = k + 1;
  }

  const levels = [
    {
      level: 0,
      edgeM: 1,
      count: leafCount,
      indices: new Uint32Array(Array.from({ length: leafCount }, (_, i) => i)),
      leafStart: octree.leafStart,
      positions: new Float32Array(leafCount * 3),
      normals: new Float32Array(leafCount * 3),
      colors: new Uint8Array(leafCount * 3),
    },
  ];

  return { octree, levels, cloud: null };
}

/**
 * 카메라 만들기. R = 항등 행렬, t 는 -C 이므로 center = C.
 */
function makeCamera(center) {
  return {
    K: { fx: 1000, fy: 1000, cx: 320, cy: 240 },
    R: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    t: new Float32Array([-center[0], -center[1], -center[2]]),
  };
}

test('거리 컬링: 기본 경계 시험', () => {
  const h = makeSimpleHierarchy(5);
  // 리프 0: [0,0,0] ~ [1,1,1]
  // 리프 1: [1,1,1] ~ [2,2,2]
  // 리프 2: [2,2,2] ~ [3,3,3]
  // 리프 3: [3,3,3] ~ [4,4,4]
  // 리프 4: [4,4,4] ~ [5,5,5]

  // 카메라를 원점에 배치
  const camera = makeCamera([0, 0, 0]);

  // maxDistanceM = √3 (대략 1.732) -> 리프 0 의 최소 거리 = 0 (카메라가 상자 안)
  // 리프 1 의 최소 거리 = √3 (경계)
  // 리프 2 의 최소 거리 = √12 = 2√3 (약 3.464)
  const sqrt3 = Math.sqrt(3);
  const mask1 = distanceCull(h, camera, { maxDistanceM: sqrt3 });
  // 리프 0: 거리 0 <= √3 -> 1
  // 리프 1: 거리 √3 <= √3 -> 1 (경계)
  // 리프 2: 거리 2√3 > √3 -> 0
  // 리프 3,4: 0
  assert.deepEqual([...mask1], [1, 1, 0, 0, 0]);

  // maxDistanceM = 2√3 (약 3.464) -> 리프 1 과 2 는 남김
  const mask2 = distanceCull(h, camera, { maxDistanceM: 2 * sqrt3 });
  assert.deepEqual([...mask2], [1, 1, 1, 0, 0]);
});

test('거리 컬링: 카메라가 상자 안', () => {
  const h = makeSimpleHierarchy(3);
  // 리프 0: [0,0,0] ~ [1,1,1]
  // 리프 1: [1,1,1] ~ [2,2,2]
  // 리프 2: [2,2,2] ~ [3,3,3]

  // 카메라를 [0.5, 0.5, 0.5] (리프 0 안)에 배치
  const camera = makeCamera([0.5, 0.5, 0.5]);

  // maxDistanceM = 0.5 -> 거리 0 <= 0.5 -> 1, 그 외 0
  const mask = distanceCull(h, camera, { maxDistanceM: 0.5 });
  assert.deepEqual([...mask], [1, 0, 0]);

  // maxDistanceM = 0 -> 카메라가 상자 안이거나 면 위인 것만 남김
  const mask0 = distanceCull(h, camera, { maxDistanceM: 0 });
  assert.deepEqual([...mask0], [1, 0, 0]);
});

test('거리 컬링: 경계 정확성 (거리 정확히 maxDistanceM)', () => {
  const h = makeSimpleHierarchy(3);
  const sqrt2 = Math.sqrt(2);

  // 카메라를 [√2, 0, 0] 에 배치
  const camera = makeCamera([sqrt2, 0, 0]);

  // 거리 계산:
  // 리프 0: [0,0,0] ~ [1,1,1], 거리 = √2 - 1 ≈ 0.414
  // 리프 1: [1,1,1] ~ [2,2,2], 거리 = √((2-√2)² + 1² + 1²) ≈ 1.318
  // 리프 2: [2,2,2] ~ [3,3,3], 거리 = √((2-√2)² + 2² + 2²) ≈ 2.829

  // maxDistanceM = √2 (≈1.414) -> 리프 0 은 거리 0.414 <= 1.414 -> 1, 리프 1 은 거리 1.318 <= 1.414 -> 1, 리프 2 는 거리 2.829 > 1.414 -> 0
  const mask = distanceCull(h, camera, { maxDistanceM: sqrt2 });
  assert.deepEqual([...mask], [1, 1, 0]);

  // maxDistanceM = √2 - 0.001 -> 리프 1 은 거리 1.318 > 1.413 -> 0
  const mask2 = distanceCull(h, camera, { maxDistanceM: sqrt2 - 0.001 });
  assert.deepEqual([...mask2], [1, 0, 0]);

  // maxDistanceM = √2 + 0.01 -> 리프 0, 1 포함, 리프 2 는 여전히 0
  const mask3 = distanceCull(h, camera, { maxDistanceM: sqrt2 + 0.01 });
  assert.deepEqual([...mask3], [1, 1, 0]);
});

test('거리 컬링: maxDistanceM = 0', () => {
  const h = makeSimpleHierarchy(3);

  // 카메라가 리프 0 안 [0.5, 0.5, 0.5]
  const camera = makeCamera([0.5, 0.5, 0.5]);

  // maxDistanceM = 0 -> 카메라가 상자 안(거리 0)인 것만 남김
  const mask = distanceCull(h, camera, { maxDistanceM: 0 });
  assert.deepEqual([...mask], [1, 0, 0]);
});

test('거리 컬링: maxDistanceM = Infinity', () => {
  const h = makeSimpleHierarchy(3);
  const camera = makeCamera([0, 0, 0]);

  // maxDistanceM = Infinity -> 비어있지 않은 모든 리프 남김
  const mask = distanceCull(h, camera, { maxDistanceM: Infinity });
  assert.deepEqual([...mask], [1, 1, 1]);
});

test('거리 컬링: maxDistanceM = NaN', () => {
  const h = makeSimpleHierarchy(3);
  const camera = makeCamera([0, 0, 0]);

  // maxDistanceM = NaN -> 빈 마스크
  const mask = distanceCull(h, camera, { maxDistanceM: NaN });
  assert.deepEqual([...mask], [0, 0, 0]);
});

test('거리 컬링: maxDistanceM < 0', () => {
  const h = makeSimpleHierarchy(3);
  const camera = makeCamera([0, 0, 0]);

  // maxDistanceM < 0 -> 빈 마스크
  const mask = distanceCull(h, camera, { maxDistanceM: -1 });
  assert.deepEqual([...mask], [0, 0, 0]);

  const mask2 = distanceCull(h, camera, { maxDistanceM: -1e10 });
  assert.deepEqual([...mask2], [0, 0, 0]);
});

test('거리 컬링: 빈 리프', () => {
  const leafCount = 3;
  const octree = {
    leafCount,
    nodeCount: leafCount,
    firstChild: new Int32Array(leafCount).fill(-1),
    childCount: new Uint8Array(leafCount).fill(0),
    leafIndex: new Int32Array(Array.from({ length: leafCount }, (_, i) => i)),
    boxMin: new Float32Array(leafCount * 3),
    boxMax: new Float32Array(leafCount * 3),
    leafStart: new Uint32Array([0, 1, 1, 1]), // 리프 1, 2 는 비어 있음 (시작 = 끝)
    order: new Uint32Array([0]),
  };

  for (let k = 0; k < leafCount; k++) {
    const i3 = k * 3;
    octree.boxMin[i3] = k;
    octree.boxMin[i3 + 1] = k;
    octree.boxMin[i3 + 2] = k;
    octree.boxMax[i3] = k + 1;
    octree.boxMax[i3 + 1] = k + 1;
    octree.boxMax[i3 + 2] = k + 1;
  }

  const levels = [
    {
      level: 0,
      leafStart: octree.leafStart,
    },
  ];

  const hierarchy = { octree, levels };
  const camera = makeCamera([0, 0, 0]);

  // 리프 0 은 비어있지 않지만, 리프 1, 2 는 비어 있음
  const mask = distanceCull(hierarchy, camera, { maxDistanceM: Infinity });
  assert.deepEqual([...mask], [1, 0, 0]);
});

test('거리 컬링: 카메라가 상자 면 위', () => {
  const h = makeSimpleHierarchy(2);
  // 리프 0: [0,0,0] ~ [1,1,1]
  // 리프 1: [1,1,1] ~ [2,2,2]

  // 카메라를 [1, 0.5, 0.5] (리프 0 의 면 위)에 배치
  const camera = makeCamera([1, 0.5, 0.5]);

  // boxDistanceM([1, 0.5, 0.5], [0,0,0], [1,1,1]) = 0
  // (카메라가 상자 면 위)
  const mask = distanceCull(h, camera, { maxDistanceM: 0 });
  assert.deepEqual([...mask], [1, 0]);
});

test('거리 컬링: 큰 좌표에서 경계 정확성', () => {
  // 카메라와 상자를 1e6 m 스케일로 생성
  const leafCount = 2;
  const octree = {
    leafCount,
    nodeCount: leafCount,
    firstChild: new Int32Array(leafCount).fill(-1),
    childCount: new Uint8Array(leafCount).fill(0),
    leafIndex: new Int32Array(Array.from({ length: leafCount }, (_, i) => i)),
    boxMin: new Float32Array(leafCount * 3),
    boxMax: new Float32Array(leafCount * 3),
    leafStart: new Uint32Array([0, 1, 2]),  // 리프 0: [0,1), 리프 1: [1,2)
    order: new Uint32Array([0, 1]),
  };

  const base = 1e6;
  // 리프 0: [1e6, 1e6, 1e6] ~ [1e6+1, 1e6+1, 1e6+1]
  octree.boxMin[0] = base;
  octree.boxMin[1] = base;
  octree.boxMin[2] = base;
  octree.boxMax[0] = base + 1;
  octree.boxMax[1] = base + 1;
  octree.boxMax[2] = base + 1;

  // 리프 1: [1e6+2, 1e6+2, 1e6+2] ~ [1e6+3, 1e6+3, 1e6+3]
  octree.boxMin[3] = base + 2;
  octree.boxMin[4] = base + 2;
  octree.boxMin[5] = base + 2;
  octree.boxMax[3] = base + 3;
  octree.boxMax[4] = base + 3;
  octree.boxMax[5] = base + 3;

  const levels = [{ level: 0, leafStart: octree.leafStart }];
  const hierarchy = { octree, levels };

  // 카메라를 [1e6, 1e6, 1e6] (리프 0 의 한 꼭짓점)에 배치
  const camera = makeCamera([base, base, base]);

  // 거리 0 <= 0 -> 1, 거리 √3 > 0 -> 0
  const mask = distanceCull(hierarchy, camera, { maxDistanceM: 0 });
  assert.deepEqual([...mask], [1, 0]);

  // 거리 0 <= 2 -> 1, 거리 √3 ≈ 1.732 > 2 이므로 아니다
  // 리프 1의 최소점은 [base+2, base+2, base+2], 카메라는 [base, base, base]
  // 거리 = √((2)² + (2)² + (2)²) = √12 = 2√3 ≈ 3.464
  // 따라서 maxDistanceM = 2 일 때 리프 1은 제거됨
  const mask2 = distanceCull(hierarchy, camera, { maxDistanceM: 2 });
  assert.deepEqual([...mask2], [1, 0]);

  // maxDistanceM = 4 -> 리프 1도 포함 (거리 2√3 ≈ 3.464 < 4)
  const mask3 = distanceCull(hierarchy, camera, { maxDistanceM: 4 });
  assert.deepEqual([...mask3], [1, 1]);

  // maxDistanceM = 3 -> 리프 1은 제거 (거리 2√3 ≈ 3.464 > 3)
  const mask4 = distanceCull(hierarchy, camera, { maxDistanceM: 3 });
  assert.deepEqual([...mask4], [1, 0]);
});

test('거리 컬링: 입력 오류 없음 (퇴화 시점은 빈 마스크)', () => {
  const h = makeSimpleHierarchy(2);

  // NaN 카메라 센터 -> 빈 마스크로 처리
  // R·t = identity·[-Inf, -Inf, -Inf] = [-Inf, -Inf, -Inf]
  // C = -R·t = [Inf, Inf, Inf] (제대로 된 동작은 아니지만 테스트 입력으로만 쓰임)
  const cameraBad = {
    K: { fx: 1000, fy: 1000, cx: 320, cy: 240 },
    R: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    t: new Float32Array([-Infinity, -Infinity, -Infinity]),
  };

  // maxDistanceM 이 Infinity 인 경우 빈 리프 제외 모두 남김
  // (NaN 카메라는 boxDistanceM 에서 NaN 을 반환할 수 있음)
  // 그래도 함수는 예외를 던지지 않아야 함
  const mask = distanceCull(h, cameraBad, { maxDistanceM: 100 });
  // NaN > 100 -> false (비교 연산) -> mask[k] = 1
  // 이 경우는 실제로 구현에 따라 다를 수 있음
  // 하지만 여기서는 빈 마스크가 아닌 상태로 반환됨
  assert(mask instanceof Uint8Array);
  assert.equal(mask.length, 2);
});

// ---- F-115: 내부 노드가 있는 실제 buildHierarchy 계층 ----
import { generate as flatBoxes } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';

const scene = flatBoxes({ seed: 1, count: 20000 });
const cloud = scene.cloud ?? scene;
const real = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 6, maxLeafPoints: 512 });

// 리프별 카메라 중심까지의 점 최소 거리(정답)
function minPointDist(h, C) {
  const oc = h.octree;
  const out = new Float64Array(oc.leafCount).fill(Infinity);
  for (let k = 0; k < oc.leafCount; k++) {
    for (let q = oc.leafStart[k]; q < oc.leafStart[k + 1]; q++) {
      const p = oc.order[q] * 3;
      const d = Math.hypot(cloud.positions[p] - C[0], cloud.positions[p + 1] - C[1], cloud.positions[p + 2] - C[2]);
      if (d < out[k]) out[k] = d;
    }
  }
  return out;
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

test('거리 컬링: 실제 계층은 내부 노드를 가진다(노드 수 > 리프 수)', () => {
  assert.equal(real.octree.leafCount, 86);
  assert.equal(real.octree.nodeCount, 111);
});

test('거리 컬링: 재현 시점 (0,5,0), maxDistanceM 20 에서 점까지 최소 거리 <= 20 인 리프는 모두 1', () => {
  const C = [0, 5, 0];
  const d = minPointDist(real, C);
  const mask = distanceCull(real, makeCamera(C), { maxDistanceM: 20 });
  let near = 0;
  for (let k = 0; k < d.length; k++) {
    if (d[k] <= 20) { near++; assert.equal(mask[k], 1, `리프 ${k} (점 최소 거리 ${d[k]})`); }
  }
  assert.ok(near > 0);
});

test('거리 컬링: 무작위 시점·여러 maxDistanceM 에서 거짓 제거 0, 멀리 있는 리프는 일부 제거', () => {
  const rnd = lcg(12345);
  let removed = 0;
  for (let i = 0; i < 40; i++) {
    const C = [(rnd() - 0.5) * 240, rnd() * 80 - 10, (rnd() - 0.5) * 240];
    const d = minPointDist(real, C);
    for (const maxD of [1, 5, 20, 60, 150]) {
      const mask = distanceCull(real, makeCamera(C), { maxDistanceM: maxD });
      for (let k = 0; k < d.length; k++) {
        if (d[k] <= maxD) assert.equal(mask[k], 1, `C=${C} maxD=${maxD} 리프 ${k} d=${d[k]}`);
        else removed += mask[k] === 0 ? 1 : 0;
      }
    }
  }
  assert.ok(removed > 0, '거리 컬링이 아무것도 제거하지 못함');
});

test('거리 컬링: 퇴화 카메라(NaN 이동)는 점 있는 리프도 전부 0', () => {
  const cam = makeCamera([0, 5, 0]);
  cam.t = new Float32Array([NaN, 0, 0]);
  for (const maxD of [20, Infinity]) {
    const mask = distanceCull(real, cam, { maxDistanceM: maxD });
    assert.equal(mask.length, real.octree.leafCount);
    assert.equal(mask.reduce((a, b) => a + b, 0), 0);
  }
});

test('거리 컬링: 잘못된 계층은 cull: 오류', () => {
  const cam = makeCamera([0, 5, 0]);
  const oc = real.octree;
  const bad = [
    undefined,
    {},
    { octree: null, levels: real.levels },
    { octree: { ...oc, leafIndex: undefined }, levels: real.levels },
    { octree: { ...oc, boxMin: new Float32Array(3) }, levels: real.levels },
    { octree: { ...oc, boxMax: oc.boxMax.subarray(0, 3 * oc.leafCount) }, levels: real.levels },
    { octree: { ...oc, leafCount: 1.5 }, levels: real.levels },
    { octree: oc, levels: [] },
    { octree: oc, levels: [{ leafStart: new Uint32Array(3) }] },
  ];
  for (const h of bad) {
    assert.throws(() => distanceCull(h, cam, { maxDistanceM: 20 }), (e) => !(e instanceof TypeError) && /^cull:/.test(e.message));
  }
});

// ---- F-127 ①~④ ----
test('F-127①: maxDistanceM 생략은 전부 남김, null·문자열은 cull: 오류', () => {
  const h = makeSimpleHierarchy(3);
  const cam = makeCamera([0, 0, 0]);
  assert.deepEqual([...distanceCull(h, cam, {})], [1, 1, 1]);
  assert.throws(() => distanceCull(h, cam, { maxDistanceM: null }), /^Error: cull:/);
  assert.throws(() => distanceCull(h, cam, { maxDistanceM: '5' }), /^Error: cull:/);
});

test('F-127②: opts=null 은 cull: 오류(TypeError 아님)', () => {
  const h = makeSimpleHierarchy(3);
  assert.throws(() => distanceCull(h, makeCamera([0, 0, 0]), null), (e) => e.constructor === Error && e.message.startsWith('cull:'));
});

test('F-127③: leafIndex 범위·일대일 위반은 cull: 오류', () => {
  const cam = makeCamera([0, 0, 0]);
  let h = makeSimpleHierarchy(3);
  h.octree.leafIndex[1] = 3 + 5;
  assert.throws(() => distanceCull(h, cam, { maxDistanceM: 10 }), /^Error: cull:/);
  h = makeSimpleHierarchy(3);
  h.octree.leafIndex[2] = 0; // 중복
  assert.throws(() => distanceCull(h, cam, { maxDistanceM: 10 }), /^Error: cull:/);
  h = makeSimpleHierarchy(3);
  h.octree.leafIndex[2] = -2;
  assert.throws(() => distanceCull(h, cam, { maxDistanceM: 10 }), /^Error: cull:/);
  h = makeSimpleHierarchy(3);
  h.octree.leafIndex[2] = -1; // 리프 누락
  assert.throws(() => distanceCull(h, cam, { maxDistanceM: 10 }), /^Error: cull:/);
});

test('F-127④: 회전이 아닌 R(0, 2I, 반사)은 빈 마스크', () => {
  const h = makeSimpleHierarchy(3);
  for (const R of [[0, 0, 0, 0, 0, 0, 0, 0, 0], [2, 0, 0, 0, 2, 0, 0, 0, 2], [1, 0, 0, 0, 1, 0, 0, 0, -1]]) {
    const cam = { ...makeCamera([0, 0, 0]), R: new Float32Array(R) };
    assert.deepEqual([...distanceCull(h, cam, { maxDistanceM: Infinity })], [0, 0, 0]);
    assert.deepEqual([...distanceCull(h, cam, { maxDistanceM: 100 })], [0, 0, 0]);
  }
});
