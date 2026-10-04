// result.json 을 만든다: node bench/status_bw/cli.mjs
//   small·large = T13 기준 구성(무압축·솎기 없음), s6 = S6 송출 구성(결정 0043, codec 1 + 구간 바이트 예산 공간 균일 솎기).
import { writeFileSync } from 'node:fs';
import { measureStatusBandwidth, STATUS_BW_LIMITS, S6_SEND_CONFIG } from './index.mjs';

const small = measureStatusBandwidth({ segments: 4, pointsPerSegment: 100000 });
const large = measureStatusBandwidth({ segments: 3, pointsPerSegment: 2500000 });
const s6 = measureStatusBandwidth({ segments: 3, pointsPerSegment: 2500000, ...S6_SEND_CONFIG });
const out = { limits: { ...STATUS_BW_LIMITS }, s6Config: { ...S6_SEND_CONFIG }, small, large, s6 };
writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
for (const [n, r] of Object.entries({ small, large, s6 })) {
  console.log(n, 'initial', r.initialBytes, 'segments', r.rows.map((x) => x.frameBytes).join(','), 'points', r.rows.map((x) => x.points).join(','));
}
