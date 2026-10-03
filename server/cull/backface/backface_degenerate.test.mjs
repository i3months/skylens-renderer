// T08.2 뒷면 제거 모듈의 퇴화 시점 처리(F-120). isDegenerateView 를 쓰고, 어떤 카메라에서도 던지지 않고 빈 마스크를 돌린다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { leafNormalCones, backfaceCull } from './index.mjs';

// 단순한 테스트 클라우드: 한 점 또는 여러 점
function makeCloud(positions, normals) {
  return {
    format: 1,
    count: positions.length / 3,
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    colors: new Uint8Array(positions.length),
  };
}

// 계층 구성: 점 몇 개와 기본 LOD 매개변수
function makeHierarchy(positions, normals) {
  const cloud = makeCloud(positions, normals);
  return buildHierarchy(cloud, { edge0M: 1, levelCount: 1, maxLeafPoints: 1000 });
}

// 정규 카메라(기본값): 정상 작동해야 함
const normalCamera = {
  width: 64,
  height: 64,
  K: { fx: 60, fy: 60, cx: 32, cy: 32 },
  R: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  t: [0, 0, -5],
};

// 정규 카메라로 정규 결과 확인
test('정규 카메라에서는 이전 결과가 유지된다(이전 테스트 회귀 확인)', () => {
  const h = makeHierarchy(
    [0, 0, 0, 1, 0, 0, 2, 0, 0],  // 3개 점, 일렬
    [0, 1, 0, 0, 1, 0, 0, 1, 0],  // 모두 위쪽 법선
  );
  const cones = leafNormalCones(h);
  const mask = backfaceCull(h, normalCamera, cones);
  assert.equal(mask.length, h.octree.leafCount);
  // 정규 카메라에서 위쪽 법선 점들은 앞면이므로 제거되지 않음
  assert.ok(mask.every((x) => x === 1), '정규 카메라, 앞면 법선 → 제거 0');
});

// 퇴화 시점: 각각 하나씩 테스트
test('퇴화 시점: fx = 1e7(극단적 초점거리), 너비 1 → 빈 마스크', () => {
  const h = makeHierarchy([0, 0, 0], [0, 1, 0]);
  const cones = leafNormalCones(h);
  const cam = { ...normalCamera, width: 1, K: { ...normalCamera.K, fx: 1e7 } };
  const mask = backfaceCull(h, cam, cones);
  assert.equal(mask.length, h.octree.leafCount);
  assert.ok(mask.every((x) => x === 0), `시야각 너무 좁음 → 빈 마스크 (길이 ${mask.length})`);
});

test('퇴화 시점: 8193×8193 해상도 → 빈 마스크', () => {
  const h = makeHierarchy([0, 0, 0], [0, 1, 0]);
  const cones = leafNormalCones(h);
  const cam = { ...normalCamera, width: 8193, height: 8193, K: { fx: 6000, fy: 6000, cx: 4096.5, cy: 4096.5 } };
  const mask = backfaceCull(h, cam, cones);
  assert.equal(mask.length, h.octree.leafCount);
  assert.ok(mask.every((x) => x === 0), '해상도 한 변 상한 초과 → 빈 마스크');
});

test('퇴화 시점: 픽셀 수 = 2e9 → 빈 마스크', () => {
  const h = makeHierarchy([0, 0, 0], [0, 1, 0]);
  const cones = leafNormalCones(h);
  const cam = { ...normalCamera, width: 100000, height: 20000, K: { ...normalCamera.K } };
  const mask = backfaceCull(h, cam, cones);
  assert.equal(mask.length, h.octree.leafCount);
  assert.ok(mask.every((x) => x === 0), '픽셀 수 상한 초과 → 빈 마스크');
});

test('퇴화 시점: R = 2I(비회전) → 빈 마스크', () => {
  const h = makeHierarchy([0, 0, 0], [0, 1, 0]);
  const cones = leafNormalCones(h);
  const cam = { ...normalCamera, R: [2, 0, 0, 0, 2, 0, 0, 0, 2] };
  const mask = backfaceCull(h, cam, cones);
  assert.equal(mask.length, h.octree.leafCount);
  assert.ok(mask.every((x) => x === 0), 'R 비회전 → 빈 마스크');
});

test('퇴화 시점: R 반사행렬 → 빈 마스크', () => {
  const h = makeHierarchy([0, 0, 0], [0, 1, 0]);
  const cones = leafNormalCones(h);
  // 반사: det = -1
  const cam = { ...normalCamera, R: [-1, 0, 0, 0, 1, 0, 0, 0, 1] };
  const mask = backfaceCull(h, cam, cones);
  assert.equal(mask.length, h.octree.leafCount);
  assert.ok(mask.every((x) => x === 0), 'R 반사(det=-1) → 빈 마스크');
});

test('퇴화 시점: t 에 NaN → 빈 마스크', () => {
  const h = makeHierarchy([0, 0, 0], [0, 1, 0]);
  const cones = leafNormalCones(h);
  const cam = { ...normalCamera, t: [NaN, 0, 0] };
  const mask = backfaceCull(h, cam, cones);
  assert.equal(mask.length, h.octree.leafCount);
  assert.ok(mask.every((x) => x === 0), 't 에 NaN → 빈 마스크');
});

test('퇴화 시점: 여러 퇴화 조건 동시(e.g. NaN 카메라 + 잘못된 R) → 빈 마스크', () => {
  const h = makeHierarchy([0, 0, 0], [0, 1, 0]);
  const cones = leafNormalCones(h);
  const cam = {
    width: 64,
    height: 64,
    K: { fx: NaN, fy: 60, cx: 32, cy: 32 },
    R: [2, 0, 0, 0, 1, 0, 0, 0, 1],  // 비회전
    t: [Infinity, 0, 0],  // Infinity
  };
  const mask = backfaceCull(h, cam, cones);
  assert.equal(mask.length, h.octree.leafCount);
  assert.ok(mask.every((x) => x === 0), '여러 퇴화 조건 → 빈 마스크');
});

test('퇴화 시점: 어떤 opts 조합에서도 던지지 않고 빈 마스크', () => {
  const h = makeHierarchy([0, 0, 0, 1, 0, 0], [0, 1, 0, 0, 1, 0]);
  const cones = leafNormalCones(h);
  const degenerateCam = { ...normalCamera, width: 0 };  // 너비 0
  const optsVariants = [
    undefined,
    {},
    { requireCover: true },
    { requireCover: false },
    { pointSizeM: 0.5 },
    { pointSizeM: 0.5, requireCover: true },
    { pointSizeM: 0.5, requireCover: false },
    { marginDeg: 45 },
    { marginDeg: 0 },
  ];
  for (const opts of optsVariants) {
    let mask;
    assert.doesNotThrow(
      () => { mask = backfaceCull(h, degenerateCam, cones, opts); },
      `opts=${JSON.stringify(opts)} 에서 예외 발생`,
    );
    assert.equal(mask.length, h.octree.leafCount, `opts=${JSON.stringify(opts)}`);
    assert.ok(mask.every((x) => x === 0), `opts=${JSON.stringify(opts)}`);
  }
});

test('빈 마스크는 올바른 길이를 가진다(leafCount)', () => {
  // 다양한 크기의 계층
  const makeHierarchyWithCount = (count) => {
    const positions = [];
    const normals = [];
    for (let i = 0; i < count; i++) {
      positions.push(i, 0, 0);
      normals.push(0, 1, 0);
    }
    return makeHierarchy(positions, normals);
  };
  const degenerateCam = { ...normalCamera, height: 0 };
  for (const count of [1, 10, 100, 1000]) {
    const h = makeHierarchyWithCount(count);
    const cones = leafNormalCones(h);
    const mask = backfaceCull(h, degenerateCam, cones);
    assert.equal(mask.length, h.octree.leafCount, `점 ${count}개, 리프 ${h.octree.leafCount}개`);
  }
});
