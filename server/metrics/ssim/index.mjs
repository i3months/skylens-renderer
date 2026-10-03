// 표준 SSIM(Wang 2004) 구현. 11x11 가우시안 창(σ=1.5), K1=0.01, K2=0.03, L=255.
// 유효 영역(창이 영상 안에 완전히 들어가는 위치)만 평균내며(MSSIM), 다채널은 채널별 값의 평균이다.
const WIN = 11;
const SIGMA = 1.5;
const K1 = 0.01;
const K2 = 0.03;
const L = 255;
const C1 = (K1 * L) ** 2;
const C2 = (K2 * L) ** 2;

// 합이 1 인 1차원 가우시안 커널(2차원 창은 두 커널의 외적과 같다)
const KERNEL = (() => {
  const k = new Float64Array(WIN);
  let s = 0;
  const c = (WIN - 1) / 2;
  for (let i = 0; i < WIN; i++) {
    k[i] = Math.exp(-((i - c) ** 2) / (2 * SIGMA * SIGMA));
    s += k[i];
  }
  for (let i = 0; i < WIN; i++) k[i] /= s;
  return k;
})();

// 유효 영역 분리 가우시안 필터: src(w x h) -> (w-10) x (h-10)
function filterValid(src, w, h) {
  const ow = w - WIN + 1;
  const oh = h - WIN + 1;
  const tmp = new Float64Array(ow * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < ow; x++) {
      let s = 0;
      for (let i = 0; i < WIN; i++) s += KERNEL[i] * src[row + x + i];
      tmp[y * ow + x] = s;
    }
  }
  const out = new Float64Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let s = 0;
      for (let i = 0; i < WIN; i++) s += KERNEL[i] * tmp[(y + i) * ow + x];
      out[y * ow + x] = s;
    }
  }
  return out;
}

export function ssim(a, b, width, height, channels) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`ssim: 폭·높이는 양의 정수여야 함 (${width}x${height})`);
  }
  if (channels !== 1 && channels !== 3) throw new Error(`ssim: channels 는 1 또는 3 이어야 함 (${channels})`);
  if (width < WIN || height < WIN) {
    throw new Error(`ssim: 영상이 ${WIN}x${WIN} 창보다 작음 (${width}x${height})`);
  }
  const n = width * height * channels;
  for (const [name, v] of [['a', a], ['b', b]]) {
    if (v == null || typeof v.length !== 'number') throw new Error(`ssim: ${name} 는 배열형이어야 함`);
    if (v.length !== n) throw new Error(`ssim: ${name} 길이 ${v.length} != ${n}`);
    for (let i = 0; i < n; i++) {
      if (typeof v[i] !== 'number' || !Number.isFinite(v[i])) throw new Error(`ssim: ${name}[${i}] 가 유한한 수가 아님`);
    }
  }
  const pix = width * height;
  const pa = new Float64Array(pix);
  const pb = new Float64Array(pix);
  const paa = new Float64Array(pix);
  const pbb = new Float64Array(pix);
  const pab = new Float64Array(pix);
  let total = 0;
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < pix; i++) {
      const x = a[i * channels + c];
      const y = b[i * channels + c];
      pa[i] = x; pb[i] = y; paa[i] = x * x; pbb[i] = y * y; pab[i] = x * y;
    }
    const ma = filterValid(pa, width, height);
    const mb = filterValid(pb, width, height);
    const eaa = filterValid(paa, width, height);
    const ebb = filterValid(pbb, width, height);
    const eab = filterValid(pab, width, height);
    let sum = 0;
    for (let i = 0; i < ma.length; i++) {
      const sa = eaa[i] - ma[i] * ma[i];
      const sb = ebb[i] - mb[i] * mb[i];
      const sab = eab[i] - ma[i] * mb[i];
      sum += ((2 * ma[i] * mb[i] + C1) * (2 * sab + C2)) / ((ma[i] * ma[i] + mb[i] * mb[i] + C1) * (sa + sb + C2));
    }
    total += sum / ma.length;
  }
  return total / channels;
}
