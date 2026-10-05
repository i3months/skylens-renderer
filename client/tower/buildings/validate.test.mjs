// 건물 묶음 검증(validateBundle) 시험: 정상·경계값 통과, 위반 유형마다 음성, 강제 변환 없음, 서버 참조 구현 출력 통과.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBundle } from './validate.mjs';
import { extrudeBuilding } from '../../../server/buildings/extrude/index.mjs';
import { buildBlackBuilding } from '../../../server/buildings/black/index.mjs';
import { buildAerialUv } from '../../../server/buildings/aerial_uv/index.mjs';
import { sampleBuildingPoints } from '../../../server/buildings/points/index.mjs';

// 삼각형 하나(정점 3개): 위치 9, 인덱스 3, uv 6(=3×2), wallMask 3, 선분 1개(6), 표본점 1개(3).
function group(over = {}) {
  return {
    ids: [7],
    mesh: { positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]), indices: new Uint32Array([0, 1, 2]) },
    edgeLines: new Float32Array([0, 0, 0, 10, 0, 0]),
    uv: new Float32Array([0, 0, 1, 0, 0, 1]),
    wallMask: new Uint8Array([0, 1, 0]),
    points: new Float32Array([1, 1, 0]),
    ...over,
  };
}
// 2×1 영상: rgb 길이 2·1·3 = 6.
const image = () => ({ width: 2, height: 1, rgb: new Uint8Array([1, 2, 3, 4, 5, 6]) });
const bundle = (groups = [group()], img = image()) => ({ groups, image: img });

const isBuildingsError = (Kind) => (e) => e instanceof Kind && e.message.startsWith('buildings:');

test('정상 묶음은 통과하고 입력을 바꾸지 않는다', () => {
  const b = bundle();
  assert.equal(validateBundle(b), undefined);
  assert.deepEqual([...b.groups[0].uv], [0, 0, 1, 0, 0, 1]);
  assert.deepEqual([...b.groups[0].wallMask], [0, 1, 0]);
  assert.equal(b.image.rgb.length, 6);
});

test('빈 groups·image null·빈 메시·빈 선·빈 점은 유효하다', () => {
  validateBundle({ groups: [], image: null });
  validateBundle(bundle([group()], null));
  const empty = group({
    mesh: { positions: new Float32Array(0), indices: new Uint32Array(0) },
    uv: new Float32Array(0),
    wallMask: new Uint8Array(0),
    edgeLines: new Float32Array(0),
    points: new Float32Array(0),
  });
  validateBundle(bundle([empty]));
});

test('경계값은 통과한다: id 0·2^32−1, 인덱스 = 정점 수−1, uv 0 과 1, wallMask 1, 1×1 영상', () => {
  validateBundle(bundle([group({ ids: [0, 4294967295] })]));
  validateBundle(bundle([group({ mesh: { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([2, 2, 2]) } })]));
  validateBundle(bundle([group({ uv: new Float32Array([0, 1, 1, 1, 0, 0]), wallMask: new Uint8Array([1, 1, 1]) })]));
  validateBundle(bundle([group()], { width: 1, height: 1, rgb: new Uint8Array(3) }));
});

test('묶음 여러 개: 두 번째 묶음의 위반도 잡는다', () => {
  validateBundle(bundle([group(), group({ ids: [8, 9] })]));
  assert.throws(() => validateBundle(bundle([group(), group({ ids: [] })])), isBuildingsError(RangeError));
});

test('묶음 겉모양 위반은 TypeError', () => {
  const cases = {
    'bundle null': null,
    'bundle 문자열': 'b',
    'groups 없음': { image: null },
    'groups 가 객체': { groups: {}, image: null },
    'group 이 null': { groups: [null], image: null },
    'image undefined': { groups: [] },
    'image 숫자': { groups: [], image: 3 },
  };
  for (const [name, b] of Object.entries(cases)) assert.throws(() => validateBundle(b), isBuildingsError(TypeError), name);
});

test('ids 위반: 비어 있음·배열 아님·정수 아님·u32 범위 밖', () => {
  const cases = [
    [RangeError, [], '빈 ids'],
    [TypeError, new Uint32Array([1]), '형식화 배열(강제 변환 없음)'],
    [TypeError, 7, '숫자'],
    [TypeError, [1.5], '소수'],
    [TypeError, ['1'], '문자열'],
    [TypeError, [NaN], 'NaN'],
    [RangeError, [-1], '음수'],
    [RangeError, [-0], '-0'],
    [RangeError, [4294967296], '2^32'],
  ];
  for (const [Kind, ids, name] of cases) assert.throws(() => validateBundle(bundle([group({ ids })])), isBuildingsError(Kind), name);
});

test('mesh 위반: 종류·길이·유한·인덱스 범위', () => {
  const pos = (arr) => ({ positions: arr, indices: new Uint32Array([0, 1, 2]) });
  const idx = (arr) => ({ positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]), indices: arr });
  const cases = [
    [TypeError, null, 'mesh null'],
    [TypeError, pos([0, 0, 0, 10, 0, 0, 0, 10, 0]), 'positions 일반 배열'],
    [TypeError, pos(new Float64Array(9)), 'positions Float64Array'],
    [RangeError, pos(new Float32Array(10)), 'positions 길이 10'],
    [RangeError, pos(new Float32Array(8)), 'positions 길이 8'],
    [RangeError, pos(new Float32Array([0, 0, 0, 10, NaN, 0, 0, 10, 0])), 'positions NaN'],
    [RangeError, pos(new Float32Array([0, 0, 0, 10, 0, 0, 0, Infinity, 0])), 'positions Infinity'],
    [TypeError, idx([0, 1, 2]), 'indices 일반 배열'],
    [TypeError, idx(new Uint16Array([0, 1, 2])), 'indices Uint16Array'],
    [RangeError, idx(new Uint32Array([0, 1])), 'indices 길이 2'],
    [RangeError, idx(new Uint32Array([0, 1, 3])), 'indices 3 = 정점 수'],
  ];
  for (const [Kind, mesh, name] of cases) {
    assert.throws(() => validateBundle(bundle([group({ mesh })])), isBuildingsError(Kind), name);
  }
});

test('positions 길이 위반은 uv 길이 검사보다 먼저 positions 오류로 잡힌다', () => {
  // 길이 10 이면 정점 수 10/3 이 정수가 아니므로 uv 길이 검사로 넘어가기 전에 positions 이름으로 던져야 한다.
  const mesh = { positions: new Float32Array(10), indices: new Uint32Array(0) };
  assert.throws(
    () => validateBundle(bundle([group({ mesh })])),
    (e) => e instanceof RangeError && /mesh\.positions 길이 10 가 3 의 배수가 아니다/.test(e.message),
  );
});

test('uv 위반: 종류·길이(정점×2 = 6)·0..1 밖·NaN', () => {
  const cases = [
    [TypeError, [0, 0, 1, 0, 0, 1], '일반 배열'],
    [RangeError, new Float32Array(4), '길이 4'],
    [RangeError, new Float32Array(8), '길이 8'],
    [RangeError, new Float32Array([0, 0, 1.0001, 0, 0, 1]), '1 초과'],
    [RangeError, new Float32Array([0, 0, 1, 0, 0, -0.0001]), '0 미만'],
    [RangeError, new Float32Array([0, NaN, 1, 0, 0, 1]), 'NaN'],
  ];
  for (const [Kind, uv, name] of cases) assert.throws(() => validateBundle(bundle([group({ uv })])), isBuildingsError(Kind), name);
});

test('wallMask 위반: 종류·길이(정점 수 = 3)·값 2', () => {
  const cases = [
    [TypeError, [0, 1, 0], '일반 배열'],
    [TypeError, new Uint8ClampedArray(3), 'Uint8ClampedArray'],
    [RangeError, new Uint8Array(2), '길이 2'],
    [RangeError, new Uint8Array(4), '길이 4'],
    [RangeError, new Uint8Array([0, 2, 0]), '값 2'],
  ];
  for (const [Kind, wallMask, name] of cases) assert.throws(() => validateBundle(bundle([group({ wallMask })])), isBuildingsError(Kind), name);
});

test('edgeLines 위반: 종류·6 의 배수·유한', () => {
  const cases = [
    [TypeError, [0, 0, 0, 1, 0, 0], '일반 배열'],
    [RangeError, new Float32Array(3), '길이 3'],
    [RangeError, new Float32Array(9), '길이 9'],
    [RangeError, new Float32Array([0, 0, 0, 1, 0, NaN]), 'NaN'],
    [RangeError, new Float32Array([0, 0, -Infinity, 1, 0, 0]), '-Infinity'],
  ];
  for (const [Kind, edgeLines, name] of cases) assert.throws(() => validateBundle(bundle([group({ edgeLines })])), isBuildingsError(Kind), name);
});

test('points 위반: 종류·3 의 배수·유한', () => {
  const cases = [
    [TypeError, [1, 1, 0], '일반 배열'],
    [TypeError, undefined, '없음'],
    [RangeError, new Float32Array(4), '길이 4'],
    [RangeError, new Float32Array([1, Infinity, 0]), 'Infinity'],
  ];
  for (const [Kind, points, name] of cases) assert.throws(() => validateBundle(bundle([group({ points })])), isBuildingsError(Kind), name);
});

test('image 위반: 크기 정수·양수, rgb Uint8Array 길이 w·h·3', () => {
  const cases = [
    [TypeError, { width: 2.5, height: 1, rgb: new Uint8Array(6) }, 'width 소수'],
    [TypeError, { width: '2', height: 1, rgb: new Uint8Array(6) }, 'width 문자열'],
    [TypeError, { width: 2, height: NaN, rgb: new Uint8Array(6) }, 'height NaN'],
    [RangeError, { width: 0, height: 1, rgb: new Uint8Array(0) }, 'width 0'],
    [RangeError, { width: 2, height: -1, rgb: new Uint8Array(0) }, 'height 음수'],
    [RangeError, { width: 2, height: 0, rgb: new Uint8Array(0) }, 'height 0(rgb 길이 2·0·3 = 0 이 맞아도)'],
    [RangeError, { width: 0, height: 3, rgb: new Uint8Array(0) }, 'width 0(rgb 길이 0·3·3 = 0 이 맞아도)'],
    [TypeError, { width: 2, height: 1, rgb: [1, 2, 3, 4, 5, 6] }, 'rgb 일반 배열'],
    [TypeError, { width: 2, height: 1, rgb: new Uint8ClampedArray(6) }, 'rgb Uint8ClampedArray'],
    [RangeError, { width: 2, height: 1, rgb: new Uint8Array(5) }, 'rgb 길이 5'],
    [RangeError, { width: 2, height: 1, rgb: new Uint8Array(8) }, 'rgb 길이 8(w·h·4)'],
  ];
  for (const [Kind, img, name] of cases) assert.throws(() => validateBundle(bundle([group()], img)), isBuildingsError(Kind), name);
});

test('서버 참조 구현(extrude·black·aerial_uv·points)으로 만든 묶음은 통과한다', () => {
  const mesh = extrudeBuilding({ id: 1, ring: [[0, 0], [10, 0], [10, 10], [0, 10]], floors: 2 });
  // 정사각 바닥: 지붕 4 + 바닥 4 + 벽 4×4 = 정점 24.
  assert.equal(mesh.positions.length, 24 * 3);
  const { edgeLines } = buildBlackBuilding(mesh);
  const img = { width: 2, height: 2, rgb: new Uint8Array(12), bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } };
  const { uv, wallMask } = buildAerialUv(mesh, img);
  const points = sampleBuildingPoints(mesh, 1);
  validateBundle({ groups: [{ ids: [1], mesh, edgeLines, uv, wallMask, points }], image: { width: 2, height: 2, rgb: img.rgb } });
});
