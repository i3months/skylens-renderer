// 사용: node bench/status_quality/cand/2_voxel.mjs [점수=2500000] [base] — 후보 2(복셀 격자 솎기)를 잰다. 'base' 를 주면 기준(모턴 등간격)도 함께 잰다.
import { evaluateThinner } from '../tune.mjs';
import { createVoxelThinner, allocateVoxel } from '../../../server/scheduler/segment_budget/cand_2_voxel.mjs';

const count = +process.argv[2] || 2500000;
const fmt = (name, r, sec) => console.log(JSON.stringify({ name, bytes: r.bytes, ratio: +r.ratio.toFixed(5), levelPoints: r.levelPoints, levelSource: r.levelSource, ssimMin: +r.ssimMin.toFixed(4), ssimMean: +r.ssimMean.toFixed(4), ssims: r.ssims.map((x) => +x.toFixed(4)), sentMean: Math.round(r.sentMean), seconds: sec }));
const run = async (name, opts) => { const t0 = Date.now(); const r = await evaluateThinner({ count, ...opts }); fmt(name, r, (Date.now() - t0) / 1000); };

if (process.argv[3] === 'base') await run('base_morton_stride', {});
await run('cand2_voxel', { createThinner: (p) => createVoxelThinner(p), allocate: allocateVoxel });
