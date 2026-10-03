// F-152 4: 계층 필드는 검사 시점에 한 번만 읽는다. cullAndSelect 는 검사 뒤 leafCount 를 다시 읽지 않으므로 따로 감싸지 않는다.
// (selectLevels 는 자체 검증·선택 과정에서 leafCount 를 읽는다. 그 읽기는 select 모듈의 몫이라 여기서 횟수를 고정하지 않는다.)
// 검사 시점의 읽기 예외는 'cull:' 오류가 되고, 정상 입력의 결과는 그대로다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHierarchy } from '../../lod/select/index.mjs';
import { cullAndSelect } from './index.mjs';

const CAM = { width: 64, height: 48, K: { fx: 60, fy: 60, cx: 32, cy: 24 }, R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
function scene() {
  const pos = [], nor = [];
  for (let i = 0; i < 100; i++) { pos.push((i % 10) * 0.1 - 0.5, Math.floor(i / 10) * 0.1 - 1, 5); nor.push(0, 0, -1); }
  const n = pos.length / 3;
  return buildHierarchy({ format: 1, count: n, positions: Float32Array.from(pos), normals: Float32Array.from(nor), colors: new Uint8Array(3 * n).fill(200) },
    { edge0M: 0.5, levelCount: 2, maxLeafPoints: 16 });
}
// leafCount 접근자를 건드리지 않도록 레벨 0 의 leafStart 길이(리프 수 + 1)에서 길이를 얻는다.
const ones = (h) => new Uint8Array(h.levels[0].leafStart.length - 1).fill(1);
const OPTS = { thresholdPx: 0.5, stages: ['distance'], stageImpls: { distance: ones } };
const RX = /^Error: cull:/;

function withLeafCount(h, get) {
  const oc = Object.create(h.octree);
  Object.defineProperty(oc, 'leafCount', { get, enumerable: true });
  return { ...h, octree: oc };
}

test('검사 시점에 leafCount 읽기가 던지면 cull: 오류', () => {
  const bad = withLeafCount(scene(), () => { throw new TypeError('boom'); });
  assert.throws(() => cullAndSelect(bad, CAM, OPTS), (e) => RX.test(String(e)));
});

test('검사 시점에 첫 읽기부터 던지는 Proxy octree 도 cull: 오류', () => {
  const h = scene();
  const bad = { ...h, octree: new Proxy(h.octree, { get() { throw new TypeError('boom'); } }) };
  assert.throws(() => cullAndSelect(bad, CAM, OPTS), (e) => RX.test(String(e)));
});

test('leafCount 는 검사 블록에서 읽은 값을 그대로 쓴다(검사 뒤 cullAndSelect 의 재독 금지)', () => {
  const h = scene();
  const real = h.octree.leafCount;
  // 검사 완료 시점 = 카메라 접근자 첫 읽기(검사 블록 다음에 assertCameraShape 가 읽는다).
  // 그 뒤 cullAndSelect(combine/index.mjs) 가 직접 읽으면 다른 값을 내고 읽은 횟수를 센다.
  // selectLevels(select/index.mjs) 안의 읽기는 호출 스택으로 구분해 real 을 돌려주고 판정에서 뺀다.
  // 읽기 횟수 상수는 쓰지 않으므로 select 쪽의 동작 같은 리팩터에도 깨지지 않는다.
  let armed = false;
  let lateCombineReads = 0;
  const probe = withLeafCount(h, () => {
    if (!armed) return real;
    const caller = String(new Error().stack).split('\n')[2] ?? '';
    if (caller.includes('combine')) {
      lateCombineReads++;
      return real + 1;
    }
    return real;
  });
  const cam = new Proxy(CAM, { get(t, k, r) { armed = true; return Reflect.get(t, k, r); } });
  const r = cullAndSelect(probe, cam, OPTS);
  assert.ok(armed, '카메라 읽기가 일어나 검사 완료 시점이 표시되어야 함');
  assert.equal(r.cull.mask.length, real);
  assert.equal(r.cull.stats.leafCount, real);
  assert.equal(lateCombineReads, 0, '검사 뒤 cullAndSelect 가 leafCount 를 다시 읽음');
});

test('정상 입력 결과는 그대로', () => {
  const h = scene();
  const r = cullAndSelect(h, CAM, OPTS);
  assert.equal(r.cull.mask.length, h.octree.leafCount);
  assert.equal(r.cull.stats.kept, r.cull.chunks.length);
});
