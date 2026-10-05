// 관제탑 지형 음영(T15.1-A3). 삼각형 면 법선과 램버트 셰이딩.
// 좌표: GeoAnchor 기준 ENU(x 동, y 북, z 위). 법선은 반시계 순서 기준 오른손 법선(위에서 본 지형이면 nz>0).
// 램버트: I = ambient + (1−ambient)·max(0, n·l̂), 결과 = clamp(round(base·I)). lightDir 은 표면→광원.

const isFiniteNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** 삼각형 tri 의 단위 법선. 면적 0(또는 비유한)이면 [0,0,1]. */
export function faceNormalEnu(positions, indices, tri) {
  const i0 = indices[3 * tri], i1 = indices[3 * tri + 1], i2 = indices[3 * tri + 2];
  const ax = positions[3 * i0], ay = positions[3 * i0 + 1], az = positions[3 * i0 + 2];
  const ux = positions[3 * i1] - ax, uy = positions[3 * i1 + 1] - ay, uz = positions[3 * i1 + 2] - az;
  const vx = positions[3 * i2] - ax, vy = positions[3 * i2 + 1] - ay, vz = positions[3 * i2 + 2] - az;
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  const m = Math.max(Math.abs(cx), Math.abs(cy), Math.abs(cz));
  if (!(m > 0) || !Number.isFinite(m)) return [0, 0, 1];
  const a = cx / m, b = cy / m, c = cz / m;
  const len = Math.hypot(a, b, c);
  return [a / len, b / len, c / len];
}

// 길이 3 의 유한한 비영 벡터를 단위 벡터로 만든다(큰 값의 제곱 넘침을 피해 최대 성분으로 먼저 나눈다).
function unit(v, name) {
  if (!v || typeof v.length !== 'number' || v.length !== 3) throw new TypeError(`shade: ${name} 는 길이 3 벡터여야 함`);
  const x = v[0], y = v[1], z = v[2];
  if (!isFiniteNum(x) || !isFiniteNum(y) || !isFiniteNum(z)) throw new TypeError(`shade: ${name} 에 비유한 값이 있음`);
  const m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  if (m === 0) throw new RangeError(`shade: ${name} 의 길이가 0`);
  const a = x / m, b = y / m, c = z / m;
  const len = Math.hypot(a, b, c);
  return [a / len, b / len, c / len];
}

/** 램버트 셰이딩. 정수 [r,g,b](0..255). */
export function shadeLambert(normal, lightDir, baseRgb, ambient) {
  const n = unit(normal, '법선');
  const l = unit(lightDir, '광원 방향');
  if (!baseRgb || typeof baseRgb.length !== 'number' || baseRgb.length !== 3) throw new TypeError('shade: baseRgb 는 길이 3 이어야 함');
  for (let i = 0; i < 3; i += 1) {
    if (!isFiniteNum(baseRgb[i])) throw new TypeError('shade: baseRgb 에 비유한 값이 있음');
  }
  if (!isFiniteNum(ambient) || ambient < 0 || ambient > 1) throw new RangeError(`shade: ambient 는 0..1 의 유한 수여야 함: ${String(ambient)}`);
  const I = ambient + (1 - ambient) * Math.max(0, n[0] * l[0] + n[1] * l[1] + n[2] * l[2]);
  const q = (x) => Math.min(255, Math.max(0, Math.round(x)));
  return [q(baseRgb[0] * I), q(baseRgb[1] * I), q(baseRgb[2] * I)];
}
