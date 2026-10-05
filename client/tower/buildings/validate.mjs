// 관제탑 건물 묶음 검증(T15.3.1). 계약: contracts/controlview/buildings.mjs BUILDINGS_MODULES.validate.
// 강제 변환은 하지 않는다: 자료형이 다르면(일반 배열 대신 Float32Array 등) 그대로 거부한다.
// 예외 종류 규칙: 값의 종류가 틀리면(객체 아님·배열 아님·형식화 배열 종류 다름) TypeError,
// 길이·값의 범위가 틀리면(3 의 배수 아님·비유한·인덱스 범위 밖·uv 0..1 밖·wallMask 0|1 아님 등) RangeError.
// 메시지는 모두 'buildings:' 로 시작한다.

const U32_MAX = 0xffffffff;

function fail(Kind, msg) {
  throw new Kind(`buildings: ${msg}`);
}

function isObject(v) {
  return v !== null && typeof v === 'object';
}

function assertTyped(arr, Ctor, name) {
  if (!(arr instanceof Ctor)) fail(TypeError, `${name} 는 ${Ctor.name} 이어야 한다`);
}

function assertMultiple(arr, k, name) {
  if (arr.length % k !== 0) fail(RangeError, `${name} 길이 ${arr.length} 가 ${k} 의 배수가 아니다`);
}

function assertFinite(arr, name) {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) fail(RangeError, `${name}[${i}] 가 유한하지 않다: ${arr[i]}`);
  }
}

function validateIds(ids, g) {
  if (!Array.isArray(ids)) fail(TypeError, `groups[${g}].ids 는 배열이어야 한다`);
  if (ids.length === 0) fail(RangeError, `groups[${g}].ids 가 비어 있다`);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (typeof id !== 'number' || !Number.isInteger(id)) fail(TypeError, `groups[${g}].ids[${i}] 는 정수여야 한다: ${String(id)}`);
    if (id < 0 || id > U32_MAX || Object.is(id, -0)) fail(RangeError, `groups[${g}].ids[${i}] 가 u32 범위 밖이다: ${id}`);
  }
}

function validateGroup(group, g) {
  if (!isObject(group)) fail(TypeError, `groups[${g}] 는 객체여야 한다`);
  validateIds(group.ids, g);

  const p = `groups[${g}]`;
  if (!isObject(group.mesh)) fail(TypeError, `${p}.mesh 는 객체여야 한다`);
  const { positions, indices } = group.mesh;
  assertTyped(positions, Float32Array, `${p}.mesh.positions`);
  assertMultiple(positions, 3, `${p}.mesh.positions`);
  assertFinite(positions, `${p}.mesh.positions`);
  const vertexCount = positions.length / 3;

  assertTyped(indices, Uint32Array, `${p}.mesh.indices`);
  assertMultiple(indices, 3, `${p}.mesh.indices`);
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= vertexCount) fail(RangeError, `${p}.mesh.indices[${i}] = ${indices[i]} 가 정점 수 ${vertexCount} 이상이다`);
  }

  assertTyped(group.uv, Float32Array, `${p}.uv`);
  if (group.uv.length !== vertexCount * 2) fail(RangeError, `${p}.uv 길이 ${group.uv.length} ≠ 정점 수×2 = ${vertexCount * 2}`);
  for (let i = 0; i < group.uv.length; i++) {
    const u = group.uv[i];
    // NaN 은 두 비교 모두 거짓이라 아래 조건으로 함께 걸린다.
    if (!(u >= 0 && u <= 1)) fail(RangeError, `${p}.uv[${i}] 가 0..1 밖이다: ${u}`);
  }

  assertTyped(group.wallMask, Uint8Array, `${p}.wallMask`);
  if (group.wallMask.length !== vertexCount) fail(RangeError, `${p}.wallMask 길이 ${group.wallMask.length} ≠ 정점 수 ${vertexCount}`);
  for (let i = 0; i < group.wallMask.length; i++) {
    if (group.wallMask[i] > 1) fail(RangeError, `${p}.wallMask[${i}] 가 0|1 이 아니다: ${group.wallMask[i]}`);
  }

  assertTyped(group.edgeLines, Float32Array, `${p}.edgeLines`);
  assertMultiple(group.edgeLines, 6, `${p}.edgeLines`);
  assertFinite(group.edgeLines, `${p}.edgeLines`);

  assertTyped(group.points, Float32Array, `${p}.points`);
  assertMultiple(group.points, 3, `${p}.points`);
  assertFinite(group.points, `${p}.points`);
}

function validateImage(image) {
  if (image === null) return;
  if (!isObject(image)) fail(TypeError, 'image 는 null 또는 객체여야 한다');
  const { width, height, rgb } = image;
  if (typeof width !== 'number' || !Number.isInteger(width)) fail(TypeError, `image.width 는 정수여야 한다: ${String(width)}`);
  if (typeof height !== 'number' || !Number.isInteger(height)) fail(TypeError, `image.height 는 정수여야 한다: ${String(height)}`);
  if (width <= 0) fail(RangeError, `image.width 는 양수여야 한다: ${width}`);
  if (height <= 0) fail(RangeError, `image.height 는 양수여야 한다: ${height}`);
  assertTyped(rgb, Uint8Array, 'image.rgb');
  if (rgb.length !== width * height * 3) fail(RangeError, `image.rgb 길이 ${rgb.length} ≠ w·h·3 = ${width * height * 3}`);
}

/** 건물 묶음 검증. 통과하면 아무것도 돌려주지 않고, 위반이면 TypeError/RangeError 를 던진다. 입력은 바꾸지 않는다. */
export function validateBundle(bundle) {
  if (!isObject(bundle)) fail(TypeError, 'bundle 은 객체여야 한다');
  if (!Array.isArray(bundle.groups)) fail(TypeError, 'bundle.groups 는 배열이어야 한다');
  bundle.groups.forEach(validateGroup);
  validateImage(bundle.image);
}
