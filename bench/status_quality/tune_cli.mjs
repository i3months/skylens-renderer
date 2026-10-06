// 사용: node bench/status_quality/tune_cli.mjs [점수=2500000] — 현재 채택 방식(S6_SEND_CONFIG: 낮은 수준 2% 보장 + 블루노이즈 솎기)을 잰다. 이전 채택안(모턴 등간격·수준 원본 비례)은 evaluateThinner({createThinner: createSpatialThinner, allocate: levelPointTargets}). 후보는 이 파일을 복사해 createThinner/allocate 를 바꾼다.
import { evaluateThinner } from './tune.mjs';
const t0 = Date.now();
const r = await evaluateThinner({ count: +process.argv[2] || 2500000 });
console.log(JSON.stringify({ ...r, ssims: r.ssims.map((x) => +x.toFixed(4)), ssimMin: +r.ssimMin.toFixed(4), ssimMean: +r.ssimMean.toFixed(4), seconds: (Date.now() - t0) / 1000 }));
