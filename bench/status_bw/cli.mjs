// result.json 을 만든다: node bench/status_bw/cli.mjs
//   small·large = T13 기준 구성(무압축), s6 = S6 송출 구성(T13.HQ, codec 1 로 원본 점 전부, 솎기·바이트 예산 없음).
//   구간당 바이트는 출력만 한다(대역폭 상한 없음).
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
