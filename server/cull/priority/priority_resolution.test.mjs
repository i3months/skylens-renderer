// F-120 극단 해상도 시험: 합법 극단 해상도는 정상 출력(거친 버퍼 칸 수 상한 이내), 불법 해상도는 던지지 않고 빈 결과(추가 버퍼 할당 없음).
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate as terrain } from '../../../fixtures/scenes/terrain/index.mjs';
import { buildHierarchy } from '../../lod/hierarchy/index.mjs';
import { leafPriority, orderChunks } from './index.mjs';

const { cloud } = terrain({ seed: 1, count: 20000 });
const h = buildHierarchy(cloud, { edge0M: 0.5, levelCount: 4, maxLeafPoints: 512 });
const n = h.octree.leafCount;
const MAX_COARSE_CELLS = 4_000_000; // priority/index.mjs 의 거친 버퍼 칸 수 상한과 같은 값

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
}

for (const [w, hh] of [[2e9, 1080], [1080, 2e9], [1, 67108864], [67108864, 1], [1000, 67109], [8193, 8193], [1e6 + 1, 1], [1, 1e6 + 1], [60000, 60000], [1.5, 100]]) {
  test(`불법 ${w}x${hh}`, () => {
    const c = cam(w, hh);
    const a = trackAlloc(() => leafPriority(h, c));
    const p = a.result;
    assert.equal(p.length, n);
    assert.ok(p.every((v) => v === 0));
    assert.equal(orderChunks(h, c, new Uint8Array(n).fill(1)).length, 0);
    assert.equal(a.total, n); // 결과 Float64Array(n) 하나뿐: 거친 버퍼·노드 표를 만들지 않는다
    assert.equal(trackAlloc(() => orderChunks(h, c, new Uint8Array(n).fill(1))).total, n); // 마스크 복제 없이 빈 Uint32Array(0)
  });
}
