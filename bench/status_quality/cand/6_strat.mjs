// 사용: node bench/status_quality/cand/6_strat.mjs <jitter|hilbert|coarse> [coarseBits]
import { evaluateThinner } from '../tune.mjs';
import { createStratThinner } from '../../../server/scheduler/segment_budget/cand_6_strat.mjs';
const mode = process.argv[2] || 'jitter';
const coarseBits = +process.argv[3] || 8;
const t0 = Date.now();
const r = await evaluateThinner({ createThinner: (p) => createStratThinner(p, { mode, coarseBits }) });
console.log(JSON.stringify({ mode, coarseBits, bytes: r.bytes, ratio: +r.ratio.toFixed(5), levelPoints: r.levelPoints, ssims: r.ssims.map((x) => +x.toFixed(4)), ssimMin: +r.ssimMin.toFixed(4), ssimMean: +r.ssimMean.toFixed(4), seconds: (Date.now() - t0) / 1000 }));
