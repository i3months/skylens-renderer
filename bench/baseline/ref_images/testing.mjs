// 테스트 전용 도우미: 합성 점군과 56 B 스플랫 PLY 작성기. run() 경로에서는 쓰지 않는다.
import { SH_C0 } from './index.mjs';

/** 시드 고정 합성 점군 (mulberry32). 지면 격자 + 기둥 + 무작위 구름. 결정적이다. 점은 {p:[x,y,z], rgb:[r,g,b]}. */
export function syntheticPoints(seed = 1) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pts = [];
  for (let x = -200; x <= 200; x += 2) {
    for (let z = -200; z <= 200; z += 2) pts.push({ p: [x, 0, z], rgb: [90 + ((x + 200) % 100), 120, 90 + ((z + 200) % 100)] });
  }
  for (let k = 0; k < 40; k++) {
    const bx = (rnd() - 0.5) * 300;
    const bz = (rnd() - 0.5) * 300;
    const h = 5 + rnd() * 40;
    for (let y = 0; y < h; y += 0.5) pts.push({ p: [bx, y, bz], rgb: [200, 100 + Math.floor(rnd() * 100), 60] });
  }
  for (let k = 0; k < 20000; k++) {
    pts.push({ p: [(rnd() - 0.5) * 800, rnd() * 300, (rnd() - 0.5) * 800], rgb: [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)] });
  }
  return pts;
}

/** 56 B 3DGS 스플랫 PLY 를 만든다. 색은 f_dc = (rgb/255 − 0.5)/SH_C0 로 넣는다. */
export function encodeSplatPly(points) {
  const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const head = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${points.length}\n${names.map((n) => `property float ${n}\n`).join('')}end_header\n`, 'latin1');
  const body = Buffer.alloc(points.length * 56);
  points.forEach((q, i) => {
    const o = i * 56;
    q.p.forEach((v, k) => body.writeFloatLE(v, o + k * 4));
    q.rgb.forEach((v, k) => body.writeFloatLE((v / 255 - 0.5) / SH_C0, o + 12 + k * 4));
    body.writeFloatLE(1, o + 24);
  });
  return Buffer.concat([head, body]);
}

/**
 * 원좌표(PLY 틀) 합성 장면. 앱 틀에서 약 44 m 크기의 지면 + 건물 4채 + 떠다니는 이상점을 만든 뒤
 * 원좌표로 되돌린다: raw = (0.1·x + 5, −0.1·y + 2, −0.1·z − 3). y 가 아래, 축척·원점이 다른 SfM 식 틀이다.
 * 점 간격 spacing(앱 틀 m). 결정적이다. 테스트 전용.
 */
export function syntheticScene({ spacing = 0.12, seed = 7 } = {}) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const toRaw = (x, y, z) => [0.1 * x + 5, -0.1 * y + 2, -0.1 * z - 3];
  const pts = [];
  const put = (x, y, z, rgb) => pts.push({ p: toRaw(x, y, z), rgb });
  const grid = (lo, hi) => {
    const out = [];
    for (let v = lo; v <= hi + 1e-9; v += spacing) out.push(v);
    return out;
  };
  for (const x of grid(-24, 24)) for (const z of grid(-24, 24)) put(x, 0, z, [90 + Math.floor((x + 24) * 2), 120, 90 + Math.floor((z + 24) * 2)]);
  const boxes = [[-12, -10, 8, 8, 30], [10, -8, 7, 9, 22], [-8, 12, 9, 7, 16], [12, 12, 6, 6, 38]];
  boxes.forEach(([cx, cz, w, d, h], bi) => {
    const col = [200 - bi * 20, 110 + bi * 25, 60 + bi * 30];
    for (const y of grid(0, h)) {
      for (const x of grid(cx - w / 2, cx + w / 2)) { put(x, y, cz - d / 2, col); put(x, y, cz + d / 2, col); }
      for (const z of grid(cz - d / 2, cz + d / 2)) { put(cx - w / 2, y, z, col); put(cx + w / 2, y, z, col); }
    }
    for (const x of grid(cx - w / 2, cx + w / 2)) for (const z of grid(cz - d / 2, cz + d / 2)) put(x, h, z, col);
  });
  const floaters = Math.max(20, Math.floor(pts.length * 0.01));
  for (let k = 0; k < floaters; k++) put((rnd() - 0.5) * 600, rnd() * 400, (rnd() - 0.5) * 600, [255, 0, 255]);
  return pts;
}
