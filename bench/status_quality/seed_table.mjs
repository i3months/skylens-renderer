// 시드별 표: flat_boxes 시드마다 원본 점 전부(250만 점, 무손실 codec 1) 송출의 구간 바이트와 8시점 최소·평균 SSIM.
// s6_quality.test.mjs 와 같은 측정(evaluateFullSend, 최고 수준 = 수준 3)이며, 기준은 SPEC 현황판 문턱 0.95 다.
// 사용: node bench/status_quality/seed_table.mjs [시드...]
import { evaluateFullSend } from './tune.mjs';

const THRESHOLD = 0.95;
const args = process.argv.slice(2);
// 시드 인자는 0 이상 정수만 받는다(NaN·abc·-1·1.5·빈 문자열 거부). 머리줄을 찍기 전에 사용법을 내고 종료 코드 2 로 끝낸다.
const bad = args.filter((a) => !/^\d+$/.test(a) || !Number.isSafeInteger(Number(a)));
if (bad.length > 0) {
  console.error(`잘못된 시드 인자: ${bad.map((a) => JSON.stringify(a)).join(', ')}`);
  console.error('사용: node bench/status_quality/seed_table.mjs [시드...]  (시드는 0 이상 정수, 생략하면 1..6)');
  process.exit(2);
}
const seeds = args.length > 0 ? args.map(Number) : [1, 2, 3, 4, 5, 6];
console.log('시드 | 구간 B | 최소 SSIM | 평균 SSIM | 0.95 이상');
for (const s of seeds) {
  const r = await evaluateFullSend({ count: 2500000, sceneSeed: s, levels: [3] });
  const top = r.levels[0];
  console.log(`${s} | ${r.bytes} | ${top.ssimMin.toFixed(4)} | ${top.ssimMean.toFixed(4)} | ${top.ssimMin >= THRESHOLD ? '예' : '아니오'}`);
}
