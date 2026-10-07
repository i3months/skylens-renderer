// 시드 1..6 재측정: flat_boxes 시드별 8시점 최소 SSIM 표(진단, 단언 없음).
// s6_quality.test.mjs 의 '예산 맞춤 flat_boxes'(evaluateFlatBoxesBudget, 최고 수준 = 수준 3) 와 같은 방식이다.
// 시험의 측정 장면은 시드 1 고정이고 문턱 0.75 는 시드 1 에만 걸린다. 사용: node bench/status_quality/seed_table.mjs [시드...]
import { evaluateFlatBoxesBudget } from './tune.mjs';

const THRESHOLD = 0.75;
const seeds = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [1, 2, 3, 4, 5, 6];
console.log('시드 | 구간 B | 최소 SSIM | 평균 SSIM | 0.75 이상');
for (const s of seeds) {
  const r = await evaluateFlatBoxesBudget({ count: 2500000, sceneSeed: s, levels: [3] });
  const top = r.levels.find((l) => l.level === 3);
  console.log(`${s} | ${r.bytes} | ${top.ssimMin.toFixed(4)} | ${top.ssimMean.toFixed(4)} | ${top.ssimMin >= THRESHOLD ? '예' : '아니오'}`);
}
