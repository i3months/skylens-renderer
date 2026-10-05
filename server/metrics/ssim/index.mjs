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
// tmp 는 길이 ow·h 이상, out 은 길이 ow·oh 이상의 Float64Array 로 호출자가 한 번 할당해 재사용한다.
function filterValid(src, w, h, tmp, out) {
  const ow = w - WIN + 1;
  const oh = h - WIN + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < ow; x++) {
      let s = 0;
      for (let i = 0; i < WIN; i++) s += KERNEL[i] * src[row + x + i];
      tmp[y * ow + x] = s;
    }
  }
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let s = 0;
      for (let i = 0; i < WIN; i++) s += KERNEL[i] * tmp[(y + i) * ow + x];
      out[y * ow + x] = s;
    }
  }
  return out;
}

// 창 단위 채움 판정용: 창 11x11 안에 0 이 아닌 화소(어느 채널이든)가 하나라도 있으면 그 영상의 창은 '채워짐'.
// 값 0(전 채널)은 빈 화소(배경)로 본다. 반환: ow·oh 길이 Uint8Array(1=채워짐).
function filledWindows(v, width, height, channels) {
  const ow = width - WIN + 1;
  const oh = height - WIN + 1;
  const W1 = width + 1;
  const acc = new Int32Array(W1 * (height + 1)); // 적분 영상
  for (let y = 0; y < height; y++) {
    let run = 0;
    for (let x = 0; x < width; x++) {
      let nz = 0;
      for (let c = 0; c < channels; c++) if (v[(y * width + x) * channels + c] !== 0) nz = 1;
      run += nz;
      acc[(y + 1) * W1 + x + 1] = acc[y * W1 + x + 1] + run;
    }
  }
  const out = new Uint8Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const n = acc[(y + WIN) * W1 + x + WIN] - acc[y * W1 + x + WIN] - acc[(y + WIN) * W1 + x] + acc[y * W1 + x];
      out[y * ow + x] = n > 0 ? 1 : 0;
    }
  }
  return out;
}

// 기존 ssim 과 같은 값(result)에 더해, 두 영상이 모두 채워진 창만 평균한 값을 함께 돌려준다.
// 둘 다 빈 창은 SSIM=1 이라 전체 평균을 부풀리므로(F-396 ⑥) 별도 지표로 분리한다.
//  - ssim: ssim() 과 비트 단위로 동일한 전체 창 평균
//  - ssimFilled: '양쪽 모두 채워진' 창만의 평균(채널 평균). 해당 창이 없으면 null
//  - filledWindowRatio: 양쪽 모두 채워진 창 수 / 전체 창 수
//  - anyFilledWindowRatio: 한쪽이라도 채워진 창 비율(참고용)
//  - filledWindows, totalWindows: 위 비율의 분자·분모
export function ssimDetailed(a, b, width, height, channels) {
  return compute(a, b, width, height, channels, true);
}

export function ssim(a, b, width, height, channels) {
  return compute(a, b, width, height, channels, false).ssim;
}

function compute(a, b, width, height, channels, detailed) {
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
      // data_range L=255 를 전제로 한 상수 C1·C2 이므로 0..255 밖 값은 클램프하지 않고 거부한다.
      if (v[i] < 0 || v[i] > 255) throw new Error(`ssim: ${name}[${i}] = ${v[i]} 가 0..255 범위 밖`);
    }
  }
  const pix = width * height;
  const pa = new Float64Array(pix);
  const pb = new Float64Array(pix);
  const paa = new Float64Array(pix);
  const pbb = new Float64Array(pix);
  const pab = new Float64Array(pix);
  const ow = width - WIN + 1;
  const oh = height - WIN + 1;
  const tmp = new Float64Array(ow * height);
  const ma = new Float64Array(ow * oh);
  const mb = new Float64Array(ow * oh);
  const eaa = new Float64Array(ow * oh);
  const ebb = new Float64Array(ow * oh);
  const eab = new Float64Array(ow * oh);
  let total = 0;
  let maskBoth = null;
  let maskAny = null;
  let nBoth = 0;
  let nAny = 0;
  let totalFilled = 0;
  if (detailed) {
    const fa = filledWindows(a, width, height, channels);
    const fb = filledWindows(b, width, height, channels);
    maskBoth = new Uint8Array(fa.length);
    maskAny = new Uint8Array(fa.length);
    for (let i = 0; i < fa.length; i++) {
      maskBoth[i] = fa[i] & fb[i];
      maskAny[i] = fa[i] | fb[i];
      nBoth += maskBoth[i];
      nAny += maskAny[i];
    }
  }
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < pix; i++) {
      const x = a[i * channels + c];
      const y = b[i * channels + c];
      pa[i] = x; pb[i] = y; paa[i] = x * x; pbb[i] = y * y; pab[i] = x * y;
    }
    filterValid(pa, width, height, tmp, ma);
    filterValid(pb, width, height, tmp, mb);
    filterValid(paa, width, height, tmp, eaa);
    filterValid(pbb, width, height, tmp, ebb);
    filterValid(pab, width, height, tmp, eab);
    let sum = 0;
    let sumFilled = 0;
    for (let i = 0; i < ma.length; i++) {
      const sa = eaa[i] - ma[i] * ma[i];
      const sb = ebb[i] - mb[i] * mb[i];
      const sab = eab[i] - ma[i] * mb[i];
      const v = ((2 * ma[i] * mb[i] + C1) * (2 * sab + C2)) / ((ma[i] * ma[i] + mb[i] * mb[i] + C1) * (sa + sb + C2));
      sum += v;
      if (maskBoth !== null && maskBoth[i] === 1) sumFilled += v;
    }
    total += sum / ma.length;
    if (nBoth > 0) totalFilled += sumFilled / nBoth;
  }
  const result = total / channels;
  if (Number.isNaN(result)) throw new Error('ssim: 결과가 NaN');
  if (!detailed) return { ssim: result };
  const nWin = ow * oh;
  return {
    ssim: result,
    ssimFilled: nBoth > 0 ? totalFilled / channels : null,
    filledWindowRatio: nBoth / nWin,
    anyFilledWindowRatio: nAny / nWin,
    filledWindows: nBoth,
    totalWindows: nWin,
  };
}
