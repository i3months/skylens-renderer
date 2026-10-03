// T06.6 램버트 셰이딩. I = ambient + (1−ambient)·max(0, n̂·l̂), 결과 = round(rgb·I) 를 0..255 로 클램프.
// lightDirWorld 는 "표면에서 광원으로 향하는" 방향이다. 법선과 광원 방향은 세계 좌표계 기준이다.
import { assertCamera, assertRenderResult } from '../../../contracts/raster/index.mjs';

const ERR = 'shade:';
const DEFAULT_AMBIENT = 0.3;

const isFiniteNum = (x) => typeof x === 'number' && Number.isFinite(x);

// 길이 3 의 유한한 비영 벡터를 단위 벡터로 만든다. 아니면 'shade:' Error.
function unit(v, name) {
  if (!v || typeof v.length !== 'number' || v.length !== 3) throw new Error(`${ERR} ${name} 는 길이 3 벡터여야 함`);
  // 문자열 등은 Number() 로 바꾸지 않고 거부한다('1' 같은 값이 조용히 통과하지 않게).
  const x = v[0], y = v[1], z = v[2];
  if (!isFiniteNum(x) || !isFiniteNum(y) || !isFiniteNum(z)) throw new Error(`${ERR} ${name} 에 비유한 값이 있음`);
  // 큰 값의 제곱 넘침을 피하려고 최대 성분으로 먼저 나눈다.
  const m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  if (m === 0) throw new Error(`${ERR} ${name} 의 길이가 0`);
  const a = x / m, b = y / m, c = z / m;
  const len = Math.hypot(a, b, c);
  return [a / len, b / len, c / len];
}

function ambientOf(opts) {
  const a = opts && opts.ambient !== undefined ? opts.ambient : DEFAULT_AMBIENT;
  if (!isFiniteNum(a) || a < 0 || a > 1) throw new Error(`${ERR} ambient 는 0..1 의 유한 수여야 함: ${String(a)}`);
  return a;
}

function checkRgb(rgb) {
  if (!rgb || typeof rgb.length !== 'number' || rgb.length !== 3) throw new Error(`${ERR} rgb 는 길이 3 이어야 함`);
  for (let i = 0; i < 3; i += 1) {
    if (!isFiniteNum(rgb[i])) throw new Error(`${ERR} rgb 에 비유한 값이 있음`);
  }
}

const clamp255 = (x) => Math.min(255, Math.max(0, Math.round(x)));

// 정규화된 단위 벡터와 ambient 로 세기 I 를 구한다.
const intensity = (n, l, ambient) => ambient + (1 - ambient) * Math.max(0, n[0] * l[0] + n[1] * l[1] + n[2] * l[2]);

/**
 * 램버트 셰이딩. 정수 [r,g,b](0..255) 를 돌려준다.
 * opts.ambient 기본 0.3. 법선이 광원 반대쪽이면 ambient 만 남는다.
 */
export function lambert(normalWorld, lightDirWorld, rgb, opts) {
  const n = unit(normalWorld, '법선');
  const l = unit(lightDirWorld, '광원 방향');
  checkRgb(rgb);
  const ambient = ambientOf(opts);
  const I = intensity(n, l, ambient);
  return [clamp255(rgb[0] * I), clamp255(rgb[1] * I), clamp255(rgb[2] * I)];
}

/**
 * RenderResult 의 각 픽셀을 index[p] 번 점의 법선(cloud.normals, format 1 만)으로 셰이딩한 새 color 를 돌려준다.
 * - 빈 픽셀(index −1)은 (0,0,0) 그대로 둔다.
 * - 법선이 카메라를 등지고 있어도 그대로 계산한다(양면 처리 없음).
 * - format 2 는 법선이 없으므로 셰이딩하지 않고 입력 색을 그대로 복사해 돌려준다(광원·ambient 는 이때도 검사한다).
 * - 법선이 (0,0,0) 인 점(normalizeNormals 가 길이 0 을 그대로 남긴다)은 방향이 없으므로 셰이딩을 생략하고
 *   입력 색을 그대로 둔다. 비유한 법선·길이가 3 이 아닌 법선은 여전히 'shade:' 오류다.
 * 입력 result 는 바꾸지 않는다.
 */
export function shadeResult(result, camera, cloud, lightDirWorld, opts) {
  assertCamera(camera);
  assertRenderResult(result);
  if (result.width !== camera.width || result.height !== camera.height) throw new Error(`${ERR} 결과와 카메라의 해상도가 다름`);
  if (!cloud || typeof cloud !== 'object') throw new Error(`${ERR} cloud 가 객체가 아님`);
  const out = Uint8Array.from(result.color);
  if (cloud.format !== 1 && cloud.format !== 2) throw new Error(`${ERR} 알 수 없는 cloud.format: ${String(cloud.format)}`);
  const l = unit(lightDirWorld, '광원 방향');
  const ambient = ambientOf(opts);
  if (cloud.format === 2) return out;
  const normals = cloud.normals;
  if (!normals || typeof normals.length !== 'number') throw new Error(`${ERR} format 1 cloud 에 normals 가 없음`);
  const idx = result.index;
  for (let p = 0; p < idx.length; p += 1) {
    const k = idx[p];
    if (k < 0) continue;
    if (3 * k + 2 >= normals.length) throw new Error(`${ERR} 점 번호 ${k} 의 법선이 없음`);
    const nv = [normals[3 * k], normals[3 * k + 1], normals[3 * k + 2]];
    if (nv[0] === 0 && nv[1] === 0 && nv[2] === 0) continue; // 길이 0 법선: 셰이딩 생략, 입력 색 유지
    const n = unit(nv, `점 ${k} 의 법선`);
    const I = intensity(n, l, ambient);
    for (let c = 0; c < 3; c += 1) out[3 * p + c] = clamp255(result.color[3 * p + c] * I);
  }
  return out;
}
