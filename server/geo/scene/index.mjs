import { GeoError } from '../../../contracts/geo/index.mjs';

// 공통 변환: 입력 검증 후 새 Float32Array 로 축 치환 (입력 불변)
// 부호 반전은 0 - x 로 해 -0 이 생기지 않게 함
function convert(arr, name, map) {
  if (!(arr instanceof Float32Array || arr instanceof Float64Array)) {
    throw new GeoError('range', `${name}: Float32Array|Float64Array 필요`);
  }
  if (arr.length % 3 !== 0) throw new GeoError('range', `${name}: 길이 ${arr.length} 가 3의 배수 아님`);
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i += 3) {
    const a = arr[i], b = arr[i + 1], c = arr[i + 2];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) {
      throw new GeoError('range', `${name}: 비유한 값 (점 ${i / 3})`);
    }
    map(out, i, a, b, c);
  }
  return out;
}

/** ENU 배열 3n → 씬 (e,n,u)→(e,u,−n). */
export function enuArrayToScene(enu) {
  return convert(enu, 'enuArrayToScene', (o, i, e, n, u) => { o[i] = e; o[i + 1] = u; o[i + 2] = 0 - n; });
}

/** 씬 배열 3n → ENU (x,y,z)→(x,−z,y). */
export function sceneArrayToEnu(scene) {
  return convert(scene, 'sceneArrayToEnu', (o, i, x, y, z) => { o[i] = x; o[i + 1] = 0 - z; o[i + 2] = y; });
}
