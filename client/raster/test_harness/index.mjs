// 헤드리스 화면 캡처 시험 틀(T12.9). 래스터러가 그린 RGBA 버퍼를 PNG 없이 비교하는 도구 모음이다.
// 구성: 8시점 합성 카메라(buildEightViews), SSIM·차이 통계(ssim, diffStats), 재현성 해시(hashRgba),
//   Chromium 캡처 도우미(captureWithChromium). 시험 전용이라 제품 번들에 넣지 않는다.
// 좌표·투영은 contracts/client_raster/index.mjs 머리 주석이 정본이다: X_c = R·X_w + t, OpenCV 규약, ENU 1 unit = 1 m.
// SSIM 은 Wang 2004 의 표준 정의(11×11 가우시안 창 σ=1.5, K1=0.01, K2=0.03, L=255)를 이 파일에서 독립 구현한다.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ERR = 'test_harness:';

export const VIEW_COUNT = 8;

/**
 * 고정 시점 8곳(fixtures/viewpoints/viewpoints.json)을 OpenCV 카메라로 바꿔 돌려준다.
 * 해상도를 바꾸면 시야각(fov_y)은 그대로 두고 fx=fy, cx=W/2, cy=H/2 로 다시 계산한다(가로세로비는 호출자 몫).
 * @param {{width?:number,height?:number,file?:string}} [opts]
 * @returns {{id:number,name:string,viewpoint:object,camera:import('../../../contracts/raster/index.mjs').Camera}[]}
 */
export function buildEightViews(opts = {}) {
  const file = opts.file ?? join(here, '../../../fixtures/viewpoints/viewpoints.json');
  const list = JSON.parse(readFileSync(file, 'utf8')).viewpoints;
  if (!Array.isArray(list) || list.length !== VIEW_COUNT) throw new Error(`${ERR} 시점이 ${VIEW_COUNT}개가 아님`);
  return list.map((vp) => {
    const viewpoint = { ...vp };
    if (opts.width !== undefined) viewpoint.width = opts.width;
    if (opts.height !== undefined) viewpoint.height = opts.height;
    return { id: vp.id, name: vp.name, viewpoint, camera: viewpointToCamera(viewpoint) };
  });
}

function checkRgba(buf, w, h, name) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new Error(`${ERR} 폭·높이는 양의 정수여야 함 (${w}x${h})`);
  if (buf == null || typeof buf.length !== 'number' || buf.length !== w * h * 4) {
    throw new Error(`${ERR} ${name} 길이는 ${w * h * 4} 여야 함 (${buf?.length})`);
  }
}

/** RGBA 해시. 크기를 앞에 섞어 같은 바이트의 다른 격자를 구분한다. */
export function hashRgba(buf, w, h) {
  checkRgba(buf, w, h, 'buf');
  const hh = createHash('sha256');
  hh.update(`${w}x${h}:`);
  hh.update(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
  return hh.digest('hex');
}

/** RGB(3채널) 버퍼를 알파 255 의 RGBA 로 넓힌다(CPU 참조 래스터러 결과를 비교할 때). */
export function rgbToRgba(rgb, w, h) {
  if (rgb.length !== w * h * 3) throw new Error(`${ERR} rgb 길이는 ${w * h * 3} 여야 함 (${rgb.length})`);
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[4 * i] = rgb[3 * i]; out[4 * i + 1] = rgb[3 * i + 1]; out[4 * i + 2] = rgb[3 * i + 2]; out[4 * i + 3] = 255;
  }
  return out;
}

/**
 * 차이 통계. 알파는 비교에서 뺀다(RGB 세 채널만).
 * @returns {{maxAbs:number,meanAbs:number,mse:number,psnr:number,diffPixels:number,diffRatio:number}}
 *   psnr 은 완전히 같으면 Infinity. diffPixels 는 RGB 중 하나라도 다른 픽셀 수.
 */
export function diffStats(a, b, w, h) {
  checkRgba(a, w, h, 'a');
  checkRgba(b, w, h, 'b');
  let maxAbs = 0; let sumAbs = 0; let sumSq = 0; let diffPixels = 0;
  for (let p = 0; p < w * h; p++) {
    let differs = false;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[4 * p + c] - b[4 * p + c]);
      if (d > 0) differs = true;
      if (d > maxAbs) maxAbs = d;
      sumAbs += d; sumSq += d * d;
    }
    if (differs) diffPixels++;
  }
  const n = w * h * 3;
  const mse = sumSq / n;
  return { maxAbs, meanAbs: sumAbs / n, mse, psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse), diffPixels, diffRatio: diffPixels / (w * h) };
}

const WIN = 11;
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;
const KERNEL = (() => {
  const k = new Float64Array(WIN);
  let s = 0;
  for (let i = 0; i < WIN; i++) { k[i] = Math.exp(-((i - 5) ** 2) / (2 * 1.5 * 1.5)); s += k[i]; }
  return k.map((v) => v / s);
})();

// 분리 가우시안 필터(유효 영역만): src(w×h) → (w-10)×(h-10)
function filterValid(src, w, h) {
  const ow = w - WIN + 1; const oh = h - WIN + 1;
  const tmp = new Float64Array(ow * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < ow; x++) {
      let s = 0;
      for (let i = 0; i < WIN; i++) s += KERNEL[i] * src[y * w + x + i];
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

/**
 * RGBA 두 장의 SSIM. R·G·B 채널별 MSSIM 의 평균이다(알파 제외, 채널마다 표준 SSIM).
 * 영상이 11×11 보다 작으면 던진다.
 */
export function ssim(a, b, w, h) {
  checkRgba(a, w, h, 'a');
  checkRgba(b, w, h, 'b');
  if (w < WIN || h < WIN) throw new Error(`${ERR} ssim 영상이 ${WIN}x${WIN} 창보다 작음 (${w}x${h})`);
  const pix = w * h;
  let total = 0;
  for (let c = 0; c < 3; c++) {
    const pa = new Float64Array(pix); const pb = new Float64Array(pix);
    const paa = new Float64Array(pix); const pbb = new Float64Array(pix); const pab = new Float64Array(pix);
    for (let i = 0; i < pix; i++) {
      const x = a[4 * i + c]; const y = b[4 * i + c];
      pa[i] = x; pb[i] = y; paa[i] = x * x; pbb[i] = y * y; pab[i] = x * y;
    }
    const ma = filterValid(pa, w, h); const mb = filterValid(pb, w, h);
    const eaa = filterValid(paa, w, h); const ebb = filterValid(pbb, w, h); const eab = filterValid(pab, w, h);
    let sum = 0;
    for (let i = 0; i < ma.length; i++) {
      const sa = eaa[i] - ma[i] * ma[i];
      const sb = ebb[i] - mb[i] * mb[i];
      const sab = eab[i] - ma[i] * mb[i];
      sum += ((2 * ma[i] * mb[i] + C1) * (2 * sab + C2)) / ((ma[i] * ma[i] + mb[i] * mb[i] + C1) * (sa + sb + C2));
    }
    total += sum / ma.length;
  }
  return total / 3;
}

// 화면 캡처 PNG → RGBA. 비교는 PNG 없이 하지만 브라우저 스크린샷이 PNG 로만 나오므로 여기서만 푼다(8비트, 비인터레이스).
export function decodePngRgba(png) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (png[i] !== sig[i]) throw new Error(`${ERR} PNG 서명이 아님`);
  let off = 8; let w = 0; let h = 0; let type = 0; const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const kind = png.toString('latin1', off + 4, off + 8);
    const body = png.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4); type = body[9];
      if (body[8] !== 8 || body[12] !== 0 || (type !== 2 && type !== 6)) throw new Error(`${ERR} 지원하지 않는 PNG 형식`);
    } else if (kind === 'IDAT') idat.push(body);
    off += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const cur = new Uint8Array(stride); const prev = new Uint8Array(stride);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const l = x >= bpp ? cur[x - bpp] : 0; const u = prev[x]; const ul = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += l; else if (f === 2) v += u; else if (f === 3) v += (l + u) >> 1;
      else if (f === 4) {
        const p = l + u - ul; const pl = Math.abs(p - l); const pu = Math.abs(p - u); const pul = Math.abs(p - ul);
        v += pl <= pu && pl <= pul ? l : pu <= pul ? u : ul;
      }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      out[(y * w + x) * 4] = cur[x * bpp]; out[(y * w + x) * 4 + 1] = cur[x * bpp + 1]; out[(y * w + x) * 4 + 2] = cur[x * bpp + 2];
      out[(y * w + x) * 4 + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev.set(cur);
  }
  return { width: w, height: h, rgba: out };
}

async function loadPlaywright() {
  const roots = [process.env.PLAYWRIGHT_MODULE, '/opt/node-tools/node_modules/playwright/index.mjs'].filter(Boolean);
  try { return await import('playwright'); } catch { /* 아래 후보로 */ }
  for (const r of roots) {
    if (existsSync(r)) { try { return await import(pathToFileURL(r).href); } catch { /* 다음 후보 */ } }
  }
  return null;
}

/**
 * Playwright Chromium 으로 html 을 열어 size(CSS 픽셀, deviceScaleFactor 1) 만큼 캡처해 RGBA 로 돌려준다.
 * 모듈이나 브라우저가 없으면 던지지 않고 {skipped:true, reason} 을 돌려준다(시험은 이를 skip 으로 처리한다).
 * @param {{html:string,size:{width:number,height:number},args?:string[]}} p
 * @returns {Promise<{skipped:false,width:number,height:number,rgba:Uint8Array}|{skipped:true,reason:string}>}
 */
export async function captureWithChromium({ html, size, args = [] }) {
  if (typeof html !== 'string') throw new Error(`${ERR} html 은 문자열이어야 함`);
  if (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1) {
    throw new Error(`${ERR} size 는 양의 정수 width·height 여야 함`);
  }
  const pw = await loadPlaywright();
  if (!pw?.chromium) return { skipped: true, reason: 'playwright 모듈을 찾지 못함' };
  let browser;
  try {
    browser = await pw.chromium.launch({ headless: true, args });
  } catch (e) {
    const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '';
    const have = base && existsSync(base) ? readdirSync(base).join(',') : '없음';
    return { skipped: true, reason: `Chromium 실행 실패(브라우저 경로 항목: ${have}): ${String(e.message).split('\n')[0]}` };
  }
  try {
    const page = await browser.newPage({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: size.width, height: size.height } });
    const img = decodePngRgba(Buffer.from(png));
    return { skipped: false, ...img };
  } finally {
    await browser.close();
  }
}
