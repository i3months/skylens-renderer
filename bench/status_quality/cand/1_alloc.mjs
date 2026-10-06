// 후보 1 측정: node bench/status_quality/cand/1_alloc.mjs <설정...>  설정: base | floor:0.02 | w:0.5
import { evaluateThinner } from '../tune.mjs';
import { makeFloorAllocate, makeWeightedAllocate } from '../../../server/scheduler/segment_budget/cand_1_alloc.mjs';
import { levelPointTargets } from '../../../server/scheduler/segment_budget/index.mjs';

for (const spec of process.argv.slice(2)) {
  const [kind, v] = spec.split(':');
  const allocate = kind === 'floor' ? makeFloorAllocate(+v) : kind === 'w' ? makeWeightedAllocate(+v) : levelPointTargets;
  const t0 = Date.now();
  const r = await evaluateThinner({ allocate });
  const total = r.levelPoints.reduce((a, b) => a + b, 0);
  console.log(JSON.stringify({ spec, bytes: r.bytes, ratio: +r.ratio.toFixed(5), levelPoints: r.levelPoints, levelSource: r.levelSource, total,
    ssimMin: +r.ssimMin.toFixed(4), ssimMean: +r.ssimMean.toFixed(4), ssims: r.ssims.map((x) => +x.toFixed(4)), sec: (Date.now() - t0) / 1000 }));
}
