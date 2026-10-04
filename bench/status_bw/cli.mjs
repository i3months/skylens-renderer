// result.json 을 만든다: node bench/status_bw/cli.mjs
import { writeFileSync } from 'node:fs';
import { measureStatusBandwidth } from './index.mjs';

const small = measureStatusBandwidth({ segments: 4, pointsPerSegment: 100000 });
const large = measureStatusBandwidth({ segments: 3, pointsPerSegment: 2500000 });
const out = { limits: { initialBytes: 15 * 1024 * 1024, perSegmentBytes: 3 * 1024 * 1024 }, small, large };
writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
for (const [n, r] of Object.entries({ small, large })) {
  console.log(n, 'initial', r.initialBytes, 'segments', r.rows.map((x) => x.frameBytes).join(','));
}
