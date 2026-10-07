// 사용: node bench/status_quality/tune_cli.mjs [점수=2500000] [시드=1] — 원본 점 전부 송출(T13.HQ)의 바이트와 최고 수준 8시점 SSIM 을 JSON 한 줄로 낸다.
import { evaluateFullSend } from './tune.mjs';
const t0 = Date.now();
const r = await evaluateFullSend({ count: +process.argv[2] || 2500000, sceneSeed: +process.argv[3] || 1 });
const top = r.levels[0];
console.log(JSON.stringify({ bytes: r.bytes, levelPoints: r.levelPoints, levelBytes: r.levelBytes, ssims: top.ssims.map((x) => +x.toFixed(4)), ssimMin: +top.ssimMin.toFixed(4), ssimMean: +top.ssimMean.toFixed(4), seconds: (Date.now() - t0) / 1000 }));
