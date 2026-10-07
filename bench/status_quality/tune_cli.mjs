// 사용: node bench/status_quality/tune_cli.mjs [점수=2500000] [시드=1] [variant=flat_boxes] — 원본 점 전부 송출(T13.HQ)의 바이트와 최고 수준 8시점 SSIM 을 JSON 한 줄로 낸다.
import { evaluateFullSend } from './tune.mjs';
import { parseCountAndSeed, parseVariant } from './cli_args.mjs';

try {
  const { count, seed } = parseCountAndSeed(process.argv[2], process.argv[3]);
  const variant = parseVariant(process.argv[4]);

  const t0 = Date.now();
  const r = await evaluateFullSend({ count, sceneSeed: seed, variant });
  const top = r.levels[0];
  console.log(JSON.stringify({
    bytes: r.bytes,
    levelPoints: r.levelPoints,
    levelBytes: r.levelBytes,
    ssims: top.ssims,
    ssimMin: top.ssimMin,
    ssimMean: top.ssimMean,
    ssimMinText: top.ssimMin.toFixed(4),
    ssimMeanText: top.ssimMean.toFixed(4),
    ssimsText: top.ssims.map((x) => +x.toFixed(4)),
    seconds: (Date.now() - t0) / 1000
  }));
} catch (e) {
  if (e instanceof RangeError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
