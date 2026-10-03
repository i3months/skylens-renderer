// F-152 4: 계층 필드는 검사 시점에 한 번만 읽는다. cullAndSelect 는 검사 뒤 leafCount 를 다시 읽지 않으므로 따로 감싸지 않는다.
// (selectLevels 는 자체 검증·선택 과정에서 leafCount 를 읽는다. 그 읽기는 select 모듈의 몫이라 여기서 횟수를 고정하지 않는다.)
// 검사 시점의 읽기 예외는 'cull:' 오류가 되고, 정상 입력의 결과는 그대로다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, sep } from 'node:path';
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

const SELF = fileURLToPath(import.meta.url);
const COMBINE_DIR = dirname(SELF) + sep;
const FRAME_FILE = /\(?((?:file:\/\/)?[^\s()]+?):\d+:\d+\)?$/;
// 스택 전체를 훑어 첫 프로젝트 프레임이 combine 디렉터리인지 본다(테스트 파일·node 내부·익명 프레임은 건너뜀).
function directCaller() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = Infinity;
  const frames = String(new Error().stack).split('\n').slice(1);
  Error.stackTraceLimit = limit;
  for (const f of frames) {
    const m = FRAME_FILE.exec(f.trim());
    if (!m) continue;
    let file = m[1];
    if (file.startsWith('file://')) { try { file = fileURLToPath(file); } catch { continue; } }
    if (file === SELF || file.startsWith('node:')) continue;
    return file.startsWith(COMBINE_DIR) ? 'combine' : 'other';
  }
  return 'other';
}

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
  // 검사 블록(combine/index.mjs) 안의 leafCount 읽기는 마지막 계층 읽기라서 그 읽기가 검사 완료 시점이다.
  // 카메라 읽기는 그 뒤라서 쓰지 않는다(검사 블록과 카메라 검사 사이의 재독도 잡기 위해).
  // 읽은 곳은 호출 스택 전체에서 첫 프로젝트 프레임(이 테스트 파일과 node 내부 프레임 제외)으로 정한다.
  // 그 프레임이 combine 디렉터리 안이면 combine 이 직접 읽은 것이다(헬퍼·Reflect.get 재독 포함).
  // selectLevels(select/index.mjs) 안의 읽기는 첫 프로젝트 프레임이 select 라서 real 을 돌려주고 판정에서 뺀다.
  // 읽기 횟수 상수는 select 쪽에는 쓰지 않으므로 select 쪽의 동작 같은 리팩터에도 깨지지 않는다.
  let combineReads = 0;
  const probe = withLeafCount(h, () => {
    if (directCaller() !== 'combine') return real;
    combineReads++;
    // 첫 읽기는 검사 블록의 읽기(허용). 그 뒤 읽기는 다른 값을 내서 재사용 여부도 드러낸다.
    return combineReads === 1 ? real : real + 1;
  });
  const cam = CAM;
  const r = cullAndSelect(probe, cam, OPTS);
  assert.ok(combineReads >= 1, '검사 블록의 leafCount 읽기가 combine 에서 일어나야 함');
  assert.equal(r.cull.mask.length, real);
  assert.equal(r.cull.stats.leafCount, real);
  assert.equal(combineReads, 1, '검사 블록 밖에서 combine 이 leafCount 를 다시 읽음');
});

test('정상 입력 결과는 그대로', () => {
  const h = scene();
  const r = cullAndSelect(h, CAM, OPTS);
  assert.equal(r.cull.mask.length, h.octree.leafCount);
  assert.equal(r.cull.stats.kept, r.cull.chunks.length);
});
