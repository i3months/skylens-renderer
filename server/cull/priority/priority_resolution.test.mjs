// F-120 극단 해상도 시험: 합법 극단 해상도는 정상 출력(거친 버퍼 칸 수 상한 이내), 불법 해상도는 던지지 않고 빈 결과(추가 버퍼 할당 없음).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate as terrain } from '../../../fixtures/scenes/terrain/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { leafPriority, orderChunks, MAX_COARSE_CELLS as IMPL_MAX_COARSE_CELLS } from './index.mjs';

const { cloud } = terrain({ seed: 1, count: 20000 });
const h = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 4, maxLeafPoints: 512 });
const n = h.octree.leafCount;
const MAX_COARSE_CELLS = 4_000_000; // priority/index.mjs 의 거친 버퍼 칸 수 상한과 같은 값
assert.equal(IMPL_MAX_COARSE_CELLS, MAX_COARSE_CELLS, '구현 상수가 시험 예상값과 같아야 함');

// 장면 중심을 내려다보는 카메라(R = 아래를 향함). 해상도·초점거리만 바꾼다.
function cam(width, height, f = 500) {
  let c = [0, 0, 0];
  for (let i = 0; i < 3; i++) { let s = 0; for (let k = 0; k < cloud.count; k++) s += cloud.positions[3 * k + i]; c[i] = s / cloud.count; }
  const R = [1, 0, 0, 0, -1, 0, 0, 0, -1]; // 카메라 z = 월드 -z (아래를 봄), det = +1
  const t = [-c[0], c[1], c[2] + 60];
  return { width, height, K: { fx: f, fy: f, cx: width / 2, cy: height / 2 }, R, t };
}
// 벽시계 대신 작업량(타입 배열 할당 원소 수)을 센다: 전역 생성자를 Proxy 로 감싸 숫자 길이로 만든 배열의 최대·합계 길이를 기록한다. 결정적이다.
function trackAlloc(fn) {
  const names = ['Float32Array', 'Float64Array', 'Int32Array', 'Uint32Array', 'Uint8Array'];
  const orig = {};
  const st = { max: 0, total: 0 };
  for (const nm of names) {
    orig[nm] = globalThis[nm];
    globalThis[nm] = new Proxy(orig[nm], {
      construct(t, args, nt) {
        if (typeof args[0] === 'number') { st.max = Math.max(st.max, args[0]); st.total += args[0]; }
        return Reflect.construct(t, args, nt === globalThis[nm] ? t : nt);
      },
    });
  }
  try { st.result = fn(); } finally { for (const nm of names) globalThis[nm] = orig[nm]; }
  return st;
}

// 하한 증인 점: 마지막 비어 있지 않은 리프(번호 ≥ 1, 아래 mask[0]=0 에 걸리지 않는다)의 첫 단계 0 대표점. 카메라 광축이 정확히 이 점을 지나도록 둔다.
let wk = n - 1;
while (wk > 0 && h.levels[0].leafStart[wk + 1] === h.levels[0].leafStart[wk]) wk--;
assert.ok(wk >= 1, '증인 리프 없음');
const wp = [0, 1, 2].map((i) => h.levels[0].positions[3 * h.levels[0].leafStart[wk] + i]);
const wnode = (() => { for (let i = 0; i < h.octree.nodeCount; i++) if (h.octree.leafIndex[i] === wk) return i; return -1; })();
function camThrough(width, height, f = 500) {
  const R = [1, 0, 0, 0, -1, 0, 0, 0, -1]; // 카메라 z = 월드 -z. 점 wp 의 카메라 좌표 = (0, 0, 60)
  return { width, height, K: { fx: f, fy: f, cx: width / 2, cy: height / 2 }, R, t: [-wp[0], wp[1], wp[2] + 60] };
}

// 한 변 상한 1e6 때문에 1x2^26 같은 가는 해상도는 불법. 합법 극단: 정사각 상한, 2^26 경계, 한 변 1e6.
const LEGAL = [[8192, 8192], [1000, 67108], [67108, 1000], [1e6, 67], [67, 1e6], [1e6, 1], [1, 1e6], [1, 1]];
for (const [w, hh] of LEGAL) {
  test(`합법 ${w}x${hh}`, () => {
    const c = cam(w, hh);
    const a1 = trackAlloc(() => leafPriority(h, c));
    const p = a1.result;
    assert.equal(p.length, n);
    assert.ok(p.every((v) => Number.isFinite(v) && v >= 0));
    const mask = new Uint8Array(n).fill(1);
    mask[0] = 0;
    const a2 = trackAlloc(() => orderChunks(h, c, mask));
    const o = a2.result;
    assert.deepEqual([...o].sort((a, b) => a - b), Array.from({ length: n - 1 }, (_, i) => i + 1));
    // 작업량: 어떤 해상도에서도 가장 큰 단일 버퍼는 거친 깊이/소유 버퍼(칸 수 상한 이하), orderChunks 는 leafPriority 를 한 번만 부른다(할당 합계가 같다).
    assert.ok(a1.max <= MAX_COARSE_CELLS, `거친 버퍼 ${a1.max} 칸 > 상한`);
    assert.ok(a2.max <= MAX_COARSE_CELLS, `거친 버퍼 ${a2.max} 칸 > 상한`);
    assert.ok(a2.total <= a1.total + 2 * n, `orderChunks 할당 ${a2.total} > leafPriority ${a1.total} + 2n`);
  });
  // 0 점수 퇴행(예: 큰 해상도에서 전부 0 반환) 방지: 구조 논증으로 정한 하한. 임의 수치가 아니다.
  // 카메라는 대표점 wp 를 광축(화면 중앙 (W/2,H/2)) 위 깊이 60 m 에 둔다. 그러면
  //  (1) wp 는 카메라 앞(z=60>0)이고 중앙에 투영되며 원판 반지름 ≥ 0.5 칸이라 중앙 칸을 반드시 덮는다(칸은 [0,w)x[0,h) 안, 중앙은 안쪽 또는 1칸 버퍼의 칸 0).
  //      깊이 버퍼 소유권은 '덮인 칸은 어떤 리프든 한 리프가 가진다' 이므로 그 칸 1개는 어느 리프의 이긴 칸이 된다. 이긴 칸 수 ≥ 1 이고 px 환산 계수는 1/(sx*sy) ≥ 1
  //      (거친 폭·높이 w=max(1,round(W*scale)) ≤ W 이므로 sx,sy ≤ 1). 따라서 점수 최댓값 ≥ 1 px.
  //  (2) wp 의 리프 상자는 wp 를 품으므로 투영 경계상자가 중앙을 가로질러 화면과 양의 면적으로 겹친다(A>0). 보조 항 0.5*A/(1+A) > 0 이므로 그 리프 점수 > 0.
  //  (3) 마스크에서 0번만 빼므로 wk ≥ 1 인 그 리프가 남아 orderChunks 의 첫 항목 점수는 > 0 이어야 한다(점수 내림차순이므로 첫 항목이 최대).
  test(`합법 ${w}x${hh} 0 이 아닌 점수`, () => {
    const c = camThrough(w, hh);
    const bmin = [0, 1, 2].map((i) => h.octree.boxMin[3 * wnode + i]), bmax = [0, 1, 2].map((i) => h.octree.boxMax[3 * wnode + i]);
    assert.ok([0, 1, 2].every((i) => bmin[i] <= wp[i] && wp[i] <= bmax[i]), '증인 점이 자기 리프 상자 안에 있어야 한다');
    assert.ok(bmax[0] > bmin[0] && bmax[1] > bmin[1], '증인 리프는 x·y 폭이 > 0 이어야 한다');
    const p = leafPriority(h, c);
    assert.ok(p[wk] > 0, `증인 리프 점수 ${p[wk]} 는 > 0 이어야 함`);
    assert.ok(Math.max(...p) >= 1, `점수 최댓값 ${Math.max(...p)} 는 ≥ 1 px 이어야 함`);
    const mask = new Uint8Array(n).fill(1);
    mask[0] = 0;
    const o = orderChunks(h, c, mask);
    assert.ok(p[o[0]] > 0, `첫 순위 리프 점수 ${p[o[0]]} 는 > 0 이어야 함`);
  });
}

for (const [w, hh] of [[2e9, 1080], [1080, 2e9], [1, 67108864], [67108864, 1], [1000, 67109], [8193, 8193], [1e6 + 1, 1], [1, 1e6 + 1], [60000, 60000], [1.5, 100]]) {
  test(`불법 ${w}x${hh}`, () => {
    const c = cam(w, hh);
    const a = trackAlloc(() => leafPriority(h, c));
    const p = a.result;
    assert.equal(p.length, n);
    assert.ok(p.every((v) => v === 0));
    assert.equal(orderChunks(h, c, new Uint8Array(n).fill(1)).length, 0);
    assert.equal(a.total, n); // 결과 Float64Array(n) 하나뿐: leafIndex 검사표는 결과 버퍼를 빌려 쓰고 거친 버퍼·노드 표는 만들지 않는다
    const mask = new Uint8Array(n).fill(1);
    assert.equal(trackAlloc(() => orderChunks(h, c, mask)).total, n); // 점수 버퍼(검사표 겸용) n 하나뿐, 빈 Uint32Array(0) 은 길이 0
  });
}
