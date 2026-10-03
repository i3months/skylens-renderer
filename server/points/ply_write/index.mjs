// 이진 PLY 쓰기(T04.2). 헤더는 계약 속성 표 그대로, 본문은 little-endian 레코드.
import {
  FORMAT_POINT27, PROPERTIES, stride, PointsError,
} from '../../../contracts/points/index.mjs';

function need(cloud, key, Type, len) {
  const a = cloud[key];
  if (!(a instanceof Type)) throw new PointsError('format', `${key} 는 ${Type.name} 이어야 한다`);
  if (a.length !== len) throw new PointsError('size', `${key} 길이 ${a.length} != ${len}`);
  return a;
}

/** 열 배열 점군 -> 이진 PLY 바이트. */
export function writePly(cloud) {
  if (cloud === null || typeof cloud !== 'object') throw new PointsError('format', 'cloud 가 객체가 아니다');
  const { format, count: n } = cloud;
  const props = PROPERTIES[format];
  if (!props) throw new PointsError('format', `알 수 없는 format ${format}`);
  if (!Number.isInteger(n) || n < 0) throw new PointsError('size', `count 가 올바르지 않다: ${n}`);

  const f = (k, m = 1) => need(cloud, k, Float32Array, n * m);
  const is27 = format === FORMAT_POINT27;
  const cols = is27
    ? { p: f('positions', 3), nr: f('normals', 3), c: need(cloud, 'colors', Uint8Array, n * 3) }
    : { p: f('positions', 3), d: f('fdc', 3), o: f('opacity'), s: f('scales', 3), r: f('rotations', 4) };

  const head = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n`
    + props.map((p) => `property ${p.type} ${p.name}\n`).join('') + 'end_header\n';
  const hb = Buffer.from(head, 'latin1');
  const st = stride(props);
  const out = new Uint8Array(hb.length + st * n);
  out.set(hb, 0);
  const dv = new DataView(out.buffer);
  // 비트 그대로 복사(NaN 페이로드 보존)해 바이트 왕복을 보장한다
  const bits = (a) => new Uint32Array(a.buffer, a.byteOffset, a.length);
  const put = (a, m, i, off, w) => { for (let k = 0; k < w; k++) dv.setUint32(off + k * 4, a[i * m + k], true); };

  if (is27) {
    const p = bits(cols.p); const nr = bits(cols.nr);
    for (let i = 0; i < n; i++) {
      const o = hb.length + i * st;
      put(p, 3, i, o, 3); put(nr, 3, i, o + 12, 3);
      out[o + 24] = cols.c[i * 3];
      out[o + 25] = cols.c[i * 3 + 1];
      out[o + 26] = cols.c[i * 3 + 2];
    }
  } else {
    const p = bits(cols.p); const d = bits(cols.d); const op = bits(cols.o); const s = bits(cols.s); const r = bits(cols.r);
    for (let i = 0; i < n; i++) {
      const o = hb.length + i * st;
      put(p, 3, i, o, 3); put(d, 3, i, o + 12, 3); put(op, 1, i, o + 24, 1);
      put(s, 3, i, o + 28, 3); put(r, 4, i, o + 40, 4);
    }
  }
  return out;
}
