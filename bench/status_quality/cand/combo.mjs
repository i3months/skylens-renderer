// T13.T 조합 측정: 수준 배분(floor 비율) × 솎기 방식(기본 모턴 / 힐베르트 / 복셀). 사용: node combo.mjs <floor> <base|hilbert|voxel>
import { evaluateThinner } from '../tune.mjs';
import { makeFloorAllocate } from '../../../server/scheduler/segment_budget/cand_1_alloc.mjs';
import { createStratThinner } from '../../../server/scheduler/segment_budget/cand_6_strat.mjs';
import { createVoxelThinner } from '../../../server/scheduler/segment_budget/cand_2_voxel.mjs';
const [floor, kind] = [+process.argv[2], process.argv[3] ?? 'base'];
const createThinner = kind === 'hilbert' ? (p, a) => createStratThinner(p, { mode: 'hilbert' }) : kind === 'voxel' ? (p, a) => createVoxelThinner(p) : undefined;
const r = await evaluateThinner({ allocate: floor > 0 ? makeFloorAllocate(floor) : undefined, createThinner });
console.log(JSON.stringify({ floor, kind, bytes: r.bytes, levelPoints: r.levelPoints, ratio: +r.ratio.toFixed(5), ssimMin: +r.ssimMin.toFixed(4), ssimMean: +r.ssimMean.toFixed(4), ssims: r.ssims.map((x) => +x.toFixed(4)) }));
