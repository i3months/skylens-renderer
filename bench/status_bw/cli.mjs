// result.json 을 만든다: node bench/status_bw/cli.mjs
import { writeFileSync } from 'node:fs';
import { measureStatusBandwidth, STATUS_BW_LIMITS } from './index.mjs';

const small = measureStatusBandwidth({ segments: 4, pointsPerSegment: 100000 });
const large = measureStatusBandwidth({ segments: 3, pointsPerSegment: 2500000 });
const out = { limits: { ...STATUS_BW_LIMITS }, small, large };
writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
for (const [n, r] of Object.entries({ small, large })) {
  console.log(n, 'initial', r.initialBytes, 'segments', r.rows.map((x) => x.frameBytes).join(','));
}
