import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { measureBundle } from '../tower/bundle.mjs';
import { CONTROLVIEW_LIMITS } from '../../contracts/controlview/index.mjs';
import { modules } from './index.mjs';

// Limit comes from the contract; measurement is the shared esbuild-based one
// (no npx fallback: esbuild is a devDependency installed by "npm ci").
const GZIP_LIMIT_BYTES = CONTROLVIEW_LIMITS.bundleBytes;

const EXPECTED_MODULES = [
  'client/proto', 'client/codec', 'client/asset',
  'client/levels', 'client/cull', 'client/geo',
];
// 각 entry 의 번들 import 그래프에 든 소스 파일 수 (실측: proto 4, codec 5,
// asset 3, levels 4, cull 1, geo 2; 합 19). 하한은 실측값 그대로라서 import 를
// 하나라도 못 따라가면 해당 entry 가 실패한다. 전체 합 하한은 항목별 하한의
// 합과 같아 따로 두지 않는다(이전의 합계 9 는 항목별 단언에 가려져 죽은 단언이었다).
// 단 client/cull 의 하한 1 은 entry 자체가 1개이므로 항상 참이다. 즉 cull 은
// import 추적을 검증하지 못하고 "entry 파일이 번들에 들었다"만 확인한다.
const MIN_INPUTS = {
  'client/proto': 4, 'client/codec': 5, 'client/asset': 3,
  'client/levels': 4, 'client/cull': 1, 'client/geo': 2,
};
// 실측(bundle:true, splitting:true): 총 12,411 B gzip
// (entry 10,268 B + 공유 chunk 2개 2,143 B). bundle:false 는 10,812 B.
// 이 하한(10,000 B)은 큰 코드가 통째로 탈락하는 경우만 잡는다.
// bundle:false 같은 측정 방식 고장은 이 값이 아니라 entry 별 inputs 하한(:45),
// chunk 수 하한(:47), chunk gzip 하한(:51)이 잡는다.
const MIN_TOTAL_GZIP = 10_000;
// 실측 공유 chunk 2개. 가장 큰 chunk 하나만 남는 변이를 잡기 위한 개수 하한.
// 실측 chunk 수에서 정한 사후 문턱이며 근거는 독립적이지 않다. 낮추지 않는다.
const MIN_CHUNKS = 2;
const MIN_CHUNK_GZIP = 1_000;

test('client bundle gzip size', { timeout: 60_000 }, async () => {
  assert.deepEqual(modules, EXPECTED_MODULES, 'module list must not shrink');
  const r = await measureBundle(modules);
  assert.ok(r.totalGzip > 0, 'measured size must be positive');

  // negative assertions: the measurement actually measured everything
  assert.equal(r.entries.length, modules.length, 'one measured entry per module');
  assert.deepEqual(r.entries.map((e) => e.module), modules);
  for (const e of r.entries) {
    assert.ok(e.minified > 0 && e.gzip > 0, `${e.module} must have nonzero size`);
    assert.ok(e.inputs >= MIN_INPUTS[e.module], `${e.module} bundles ${e.inputs} source file(s), expected >= ${MIN_INPUTS[e.module]}; imports were not followed`);
  }
  assert.ok(r.chunks.length >= MIN_CHUNKS, `shared chunks ${r.chunks.length} below floor ${MIN_CHUNKS}; chunks were lost or not counted`);
  assert.ok(Number.isInteger(r.outputs), `outputs must be an integer, got ${r.outputs}`);
  assert.equal(r.entries.length + r.chunks.length, r.outputs, 'emit count = entries + chunks (no emitted file left unmeasured)');
  const chunkGzip = r.chunks.reduce((s, x) => s + x.gzip, 0);
  assert.ok(chunkGzip >= MIN_CHUNK_GZIP, `shared chunks gzip ${chunkGzip} below floor ${MIN_CHUNK_GZIP}`);
  const sum = [...r.entries, ...r.chunks].reduce((s, x) => s + x.gzip, 0);
  assert.equal(r.totalGzip, sum, 'total equals sum of emitted files');
  assert.ok(r.totalGzip >= MIN_TOTAL_GZIP, `total gzip ${r.totalGzip} below floor ${MIN_TOTAL_GZIP}`);

  assert.ok(
    r.totalGzip <= GZIP_LIMIT_BYTES,
    `Total gzip size ${r.totalGzip} bytes exceeds limit of ${GZIP_LIMIT_BYTES} bytes`
  );
});
