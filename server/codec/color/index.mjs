// 색 스트림 부호화(T09.3). 형식은 contracts/codec/index.mjs 의 COLOR_MODE 그대로. 첫 바이트가 모드.
import { COLOR_MODE, CodecError } from '../../../contracts/codec/index.mjs';

// 채널 평면 r→g→b 각각 이전 점과의 차분(mod 256, 첫 점은 0 기준)을 out 의 off 부터 쓴다.
function writeDelta(out, off, r, g, b, n) {
  let o = off;
  for (const ch of [r, g, b]) {
    let prev = 0;
    for (let i = 0; i < n; i++) {
      out[o++] = (ch[i] - prev) & 255;
      prev = ch[i];
    }
  }
}

// QUANT2 복원 값: ((v>>2)<<2)+2 를 255 로 상한.
const quant2 = (v) => Math.min(255, ((v >> 2) << 2) + 2);

export function encodeColorStream(r, g, b, opts = {}) {
  const n = r.length;
  if (g.length !== n || b.length !== n) throw new CodecError('stream', '색 채널 길이가 다르다');
  if (opts.lossy) {
    const out = new Uint8Array(1 + 3 * n);
    out[0] = COLOR_MODE.QUANT2;
    const q = [r, g, b].map((ch) => Uint8Array.from(ch, quant2));
    writeDelta(out, 1, q[0], q[1], q[2], n);
    return out;
  }
  // 서로 다른 색을 첫 등장 순서로 번호 매긴다(256 개 초과면 중단). 점이 없으면 DELTA.
  const map = new Map();
  const idx = new Uint8Array(n);
  let palette = n > 0;
  for (let i = 0; i < n && palette; i++) {
    const key = (r[i] << 16) | (g[i] << 8) | b[i];
    let id = map.get(key);
    if (id === undefined) {
      if (map.size === 256) { palette = false; break; }
      id = map.size;
      map.set(key, id);
    }
    idx[i] = id;
  }
  if (palette) {
    const k = map.size;
    const out = new Uint8Array(2 + 3 * k + n);
    out[0] = COLOR_MODE.PALETTE;
    out[1] = k - 1;
    for (const [key, id] of map) {
      out[2 + 3 * id] = key >> 16;
      out[3 + 3 * id] = (key >> 8) & 255;
      out[4 + 3 * id] = key & 255;
    }
    out.set(idx, 2 + 3 * k);
    return out;
  }
  const out = new Uint8Array(1 + 3 * n);
  out[0] = COLOR_MODE.DELTA;
  writeDelta(out, 1, r, g, b, n);
  return out;
}

export function decodeColorStream(bytes, n) {
  if (!(bytes instanceof Uint8Array) || !Number.isInteger(n) || n < 0) throw new CodecError('stream', '입력 형식 이상');
  if (bytes.length < 1) throw new CodecError('stream', '빈 색 스트림');
  const mode = bytes[0];
  const r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n);
  if (mode === COLOR_MODE.DELTA || mode === COLOR_MODE.QUANT2) {
    if (bytes.length !== 1 + 3 * n) throw new CodecError('stream', '색 스트림 길이 불일치');
    let o = 1;
    for (const ch of [r, g, b]) {
      let prev = 0;
      for (let i = 0; i < n; i++) {
        prev = (prev + bytes[o++]) & 255;
        ch[i] = prev;
      }
    }
    return { r, g, b, mode };
  }
  if (mode === COLOR_MODE.PALETTE) {
    if (bytes.length < 2) throw new CodecError('stream', '팔레트 헤더 부족');
    const k = bytes[1] + 1;
    if (bytes.length !== 2 + 3 * k + n) throw new CodecError('stream', '팔레트 스트림 길이 불일치');
    const base = 2 + 3 * k;
    for (let i = 0; i < n; i++) {
      const id = bytes[base + i];
      if (id >= k) throw new CodecError('range', '팔레트 인덱스 범위 밖');
      r[i] = bytes[2 + 3 * id]; g[i] = bytes[3 + 3 * id]; b[i] = bytes[4 + 3 * id];
    }
    return { r, g, b, mode };
  }
  throw new CodecError('mode', `알 수 없는 색 모드 ${mode}`);
}
