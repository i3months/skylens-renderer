// 축소(T07.6) 시 칸 대표 법선. 새 방향을 만들지 않고 칸 안 원본 법선들의 평균 방향만 쓴다.
import { assertCloud } from '../../../contracts/lod/index.mjs';

const ERR = 'lod:';

function checkVoxel(voxel, n) {
  if (!voxel || typeof voxel !== 'object') throw new Error(`${ERR} voxel 이 객체가 아님`);
  const { count, cellOfPoint } = voxel;
  if (!Number.isInteger(count) || count < 0) throw new Error(`${ERR} voxel.count 가 음이 아닌 정수가 아님`);
  if (!(cellOfPoint instanceof Uint32Array) || cellOfPoint.length !== n) throw new Error(`${ERR} voxel.cellOfPoint 길이가 점 수(${n})와 다름`);
  for (let i = 0; i < n; i++) if (cellOfPoint[i] >= count) throw new Error(`${ERR} cellOfPoint[${i}] 가 칸 수(${count}) 이상`);
}

/**
 * 칸마다 대표 법선 1개를 구한다. 길이 3·count 의 Float32Array.
 *
 * 규칙과 근거:
 *  - 원본 법선을 각각 먼저 정규화한 뒤 더한다. 정규화 전에 더하면 길이가 큰(비정규) 입력이 방향을 좌우해
 *    "칸 안 방향의 평균" 이라는 의미가 깨진다. 모든 점이 같은 한 표를 갖게 한다.
 *  - 길이 0 법선은 방향 정보가 없는 "법선 없음" 이므로 합에서 제외한다. 0 벡터를 더해도 합은 변하지 않지만
 *    정규화 단계(0 나눗셈)를 피하려고 명시적으로 건너뛴다. 비유한 값도 방향이 없으므로 같이 제외한다.
 *  - 합이 0(반대 방향끼리 상쇄)이거나 쓸 법선이 하나도 없으면 (0,0,0). 임의의 방향을 만들어 채우지 않는다
 *    (도착하지 않은 정보를 지어내지 않는 skylens 원칙). (0,0,0) 은 "법선 없음" 으로 하류가 그대로 다룬다.
 *  - 합 계산은 float64 로 하고 마지막에 float32 로 저장한다.
 */
export function representativeNormals(cloud, voxel) {
  const n = assertCloud(cloud);
  checkVoxel(voxel, n);
  const sums = new Float64Array(3 * voxel.count);
  const src = cloud.normals;
  for (let i = 0; i < n; i++) {
    const x = src[3 * i], y = src[3 * i + 1], z = src[3 * i + 2];
    const len = Math.hypot(x, y, z);
    if (!(len > 0) || !Number.isFinite(len)) continue; // 길이 0·비유한 제외
    const c = voxel.cellOfPoint[i];
    sums[3 * c] += x / len;
    sums[3 * c + 1] += y / len;
    sums[3 * c + 2] += z / len;
  }
  const out = new Float32Array(3 * voxel.count);
  for (let c = 0; c < voxel.count; c++) {
    const x = sums[3 * c], y = sums[3 * c + 1], z = sums[3 * c + 2];
    const len = Math.hypot(x, y, z);
    if (!(len > 1e-12)) continue; // 상쇄(부동소수 잔여 포함) → (0,0,0)
    out[3 * c] = x / len;
    out[3 * c + 1] = y / len;
    out[3 * c + 2] = z / len;
  }
  return out;
}

/**
 * 각 원본 점의 법선과 그 칸 대표 법선 사이 각(도)의 최대·평균.
 * 원본 법선 길이가 0 인 점은 비교 대상이 아니라 제외한다. 원본은 있는데 대표가 (0,0,0) 이면 정보를 잃은 최악으로 보아 180° 로 센다.
 * 비교 대상 점이 없으면 {max:0, mean:0}.
 */
export function maxAngleErrorDeg(cloud, voxel, normals) {
  const n = assertCloud(cloud);
  checkVoxel(voxel, n);
  if (!(normals instanceof Float32Array) || normals.length !== 3 * voxel.count) throw new Error(`${ERR} normals 길이가 3·count 가 아님`);
  let max = 0, sum = 0, used = 0;
  const src = cloud.normals;
  for (let i = 0; i < n; i++) {
    const x = src[3 * i], y = src[3 * i + 1], z = src[3 * i + 2];
    const len = Math.hypot(x, y, z);
    if (!(len > 0) || !Number.isFinite(len)) continue;
    const c = voxel.cellOfPoint[i];
    const rx = normals[3 * c], ry = normals[3 * c + 1], rz = normals[3 * c + 2];
    const rlen = Math.hypot(rx, ry, rz);
    let deg;
    if (!(rlen > 0)) deg = 180;
    else {
      const cos = (x * rx + y * ry + z * rz) / (len * rlen);
      deg = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    }
    if (deg > max) max = deg;
    sum += deg;
    used++;
  }
  return { max, mean: used ? sum / used : 0 };
}
