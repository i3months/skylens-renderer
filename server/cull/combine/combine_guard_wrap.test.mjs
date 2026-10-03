// F-152 4: 계층 필드는 검사 시점에 한 번만 읽는다. cullAndSelect 는 검사 뒤 leafCount 를 다시 읽지 않으므로 따로 감싸지 않는다.
// (selectLevels 는 자체 검증·선택 과정에서 leafCount 를 읽는다. 그 읽기는 select 모듈의 몫이라 여기서 횟수를 고정하지 않는다.)
// 검사 시점의 읽기 예외는 'cull:' 오류가 되고, 정상 입력의 결과는 그대로다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, sep } from 'node:path';
import { buildHierarchy, assertHierarchyInput } from '../../lod/select/index.mjs';
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
const SELECT_DIR = fileURLToPath(new URL('../../lod/select/', import.meta.url));
// 'at 함수 (파일:줄:열)' 또는 'at 파일:줄:열' 형태의 프레임을 풀어 {fn, file, loc} 로 만든다.
const FRAME_RE = /^at (?:(.*?) \()?((?:file:\/\/)?[^\s()]+?):(\d+):(\d+)\)?$/;
function parseFrames() {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = Infinity;
  const lines = String(new Error().stack).split('\n').slice(1);
  Error.stackTraceLimit = limit;
  const out = [];
  for (const raw of lines) {
    const m = FRAME_RE.exec(raw.trim());
    if (!m) continue;
    let file = m[2];
    if (file.startsWith('file://')) { try { file = fileURLToPath(file); } catch { continue; } }
    out.push({ fn: m[1] ?? '', file, loc: `${file}:${m[3]}:${m[4]}` });
  }
  return out;
}
// 읽은 곳 분류(호출 스택 전체 기준).
//  - 스택에 select 의 selectLevels 프레임이 있으면 'select' (select 모듈 몫이라 제외).
//    assertHierarchyInput 같은 select 의 검사 함수는 combine 이 직접 부를 수 있으므로 제외 대상이 아니다.
//  - 그 밖에 스택에 combine 디렉터리 프레임이 있으면 'combine' (직접 읽기, 헬퍼·assertHierarchyInput 재호출 경유 포함).
//    site 는 스택에서 가장 안쪽 combine 프레임의 위치(호출 지점)다.
//  - 둘 다 아니면 'other'.
function classifyRead() {
  const frames = parseFrames().filter((f) => f.file !== SELF && !f.file.startsWith('node:'));
  if (frames.some((f) => f.file.startsWith(SELECT_DIR) && f.fn.replace(/^.*\./, '') === 'selectLevels')) return { kind: 'select' };
  const inner = frames.find((f) => f.file.startsWith(COMBINE_DIR));
  return inner ? { kind: 'combine', site: inner.loc, direct: frames[0] === inner } : { kind: 'other' };
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
  // 허용되는 combine 의 읽기는 검사 블록 하나뿐이다: assertHierarchyInput 한 번(그 안에서 여러 번 읽힘) 뒤에
  // hierarchy.octree.leafCount 를 직접 읽는 것으로 블록이 끝난다.
  // 호출 지점이나 줄 수가 아니라 읽기 횟수 자체를 센다(같은 줄의 반복 호출도 잡기 위함).
  //  - 끝 표지: 스택 가장 안쪽 비-테스트 프레임이 combine 인 첫 읽기(검사 블록의 직접 읽기). 그 뒤의 combine 읽기는 전부 위반이다.
  //  - 검사 블록 안의 읽기 수는 assertHierarchyInput 한 번이 내는 읽기 수(기준값)에 직접 읽기 1회를 더한 값과 정확히 같아야 한다.
  //  - 규칙: 스택에 selectLevels 프레임이 있으면 제외, 스택에 combine 프레임이 있으면 combine 의 읽기로 센다.
  //  - 단계 구현(stageImpls) 호출 이후의 combine 읽기도 위반이다(값은 real+1 로 내서 재사용 여부를 드러낸다).
  let mode = 'baseline';
  let baselineReads = 0;
  let combineReads = 0;
  let afterEnd = 0;
  let afterStages = 0;
  let ended = false;
  let stagesStarted = false;
  const count = () => {
    const c = classifyRead();
    if (mode === 'baseline') { baselineReads++; return real; }
    if (c.kind !== 'combine') return real;
    combineReads++;
    if (ended) afterEnd++;
    else if (c.direct) ended = true;
    if (stagesStarted) { afterStages++; return real + 1; }
    return ended && afterEnd > 0 ? real + 1 : real;
  };
  // 검사 함수는 결과를 캐시할 수 있으므로 기준값과 실제 실행은 서로 다른 계층 객체(같은 접근자)로 잰다.
  const probe = withLeafCount(h, count);
  const baseProbe = withLeafCount(h, count);
  // 기준값: 테스트가 직접 assertHierarchyInput 을 한 번 부를 때의 leafCount 읽기 수.
  assertHierarchyInput(baseProbe);
  assert.ok(baselineReads >= 1, 'assertHierarchyInput 이 leafCount 를 읽어야 기준값이 의미가 있음');
  mode = 'run';
  const opts = { ...OPTS, stageImpls: { distance: (hh, cam, o) => { stagesStarted = true; return OPTS.stageImpls.distance(hh, cam, o); } } };
  const r = cullAndSelect(probe, CAM, opts);
  assert.ok(stagesStarted, '단계 구현이 불려야 함');
  assert.ok(ended, '검사 블록 끝의 직접 leafCount 읽기가 combine 에서 일어나야 함');
  assert.equal(r.cull.mask.length, real);
  assert.equal(r.cull.stats.leafCount, real);
  assert.equal(afterEnd, 0, `검사 블록 끝 뒤에 combine 이 계층을 ${afterEnd}번 다시 읽음`);
  assert.equal(afterStages, 0, '검사 블록 밖(단계 이후)에서 combine 이 leafCount 를 다시 읽음');
  assert.equal(combineReads, baselineReads + 1, `combine 의 leafCount 읽기 ${combineReads}회, 기대 ${baselineReads + 1}회(assertHierarchyInput 1회 + 직접 읽기 1회)`);
});

test('정상 입력 결과는 그대로', () => {
  const h = scene();
  const r = cullAndSelect(h, CAM, OPTS);
  assert.equal(r.cull.mask.length, h.octree.leafCount);
  assert.equal(r.cull.stats.kept, r.cull.chunks.length);
});
