import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTROLVIEW_METHOD_MAP, controlviewModulePath, isDrapeAligned, CONTROLVIEW_LIMITS } from './index.mjs';

test('대응표 자기 일관성: 모듈 9개, 모듈·fn 중복 없음', () => {
  const mods = CONTROLVIEW_METHOD_MAP.map((r) => r.module).sort();
  assert.deepEqual(mods, ['buildings', 'chase', 'drape', 'e2e', 'fallback', 'input', 'overlay', 'streaming', 'terrain']);
  for (const r of CONTROLVIEW_METHOD_MAP) {
    assert.equal(typeof r.fn, 'string');
    assert.equal(typeof r.origin, 'string');
  }
  assert.equal(new Set(CONTROLVIEW_METHOD_MAP.map((r) => r.fn)).size, 9);
  for (const bad of ['nope', undefined, '../x', Object.create(null)]) assert.throws(() => controlviewModulePath(bad), RangeError);
  assert.equal(controlviewModulePath('drape'), 'client/tower/drape/index.mjs');
  // 모든 모듈의 경로를 구현 템플릿과 무관한 독립 표로 대조한다.
  const EXPECTED_PATHS = {
    buildings: 'client/tower/buildings/index.mjs', chase: 'client/tower/chase/index.mjs', drape: 'client/tower/drape/index.mjs',
    e2e: 'client/tower/e2e/index.mjs', fallback: 'client/tower/fallback/index.mjs', input: 'client/tower/input/index.mjs',
    overlay: 'client/tower/overlay/index.mjs', streaming: 'client/tower/streaming/index.mjs', terrain: 'client/tower/terrain/index.mjs',
  };
  assert.deepEqual(Object.keys(EXPECTED_PATHS).sort(), mods);
  for (const [m, path] of Object.entries(EXPECTED_PATHS)) assert.equal(controlviewModulePath(m), path);
  // CONTROLVIEW_LIMITS 는 동결됨
  assert.equal(Object.isFrozen(CONTROLVIEW_LIMITS), true);
  assert.deepEqual({ ...CONTROLVIEW_LIMITS }, { bundleBytes: 300_000, initialBytes: 15_000_000, segmentBytes: 3_000_000 });
});

test('원본 대조 T15.0L: skylens towerViewer.ts 공개 메서드 목록 (commit 0122bd4)', () => {
  // skylens 원본 공개 메서드 목록 (TowerViewer class, 라인 145-811)
  // 커밋: 0122bd4 (C:\Users\wayso\work_local\skylens)
  const ORIGINAL_METHODS = [
    { name: 'constructor', lines: '204-267' },
    { name: 'setDisplay', lines: '293-297' },
    { name: 'display', lines: '299-301', kind: 'getter' },
    { name: 'aerialAvailable', lines: '304-306', kind: 'getter' },
    { name: 'addStreamedTerrain', lines: '420-441' },
    { name: 'addSurroundBuildings', lines: '448-498' },
    { name: 'setRoute', lines: '586-638' },
    { name: 'debugTopDown', lines: '653-664' },
    { name: 'debugScene', lines: '668-670' },
    { name: 'debugRoute', lines: '674-686' },
    { name: 'update', lines: '734-752' },
    { name: 'resize', lines: '789-795' },
    { name: 'dispose', lines: '797-810' },
  ];

  // e2e 모듈이 모든 공개 메서드를 커버하는지 확인
  const e2eRow = CONTROLVIEW_METHOD_MAP.find((r) => r.module === 'e2e');
  assert.ok(e2eRow, 'e2e 행이 존재해야 함');
  assert.equal(e2eRow.origin, 'checked', 'e2e 행은 checked 상태여야 함');

  // 모든 메서드 이름이 source 필드에 포함되는지 확인
  for (const method of ORIGINAL_METHODS) {
    assert.ok(
      e2eRow.source.includes(method.name),
      `e2e source에 '${method.name}' 포함되어야 함: ${e2eRow.source}`
    );
  }

  console.log('✓ 원본 메서드 13개 모두 e2e 대응표 행에 포함됨');
});

test('원본 대조 T15.0L: 대응표 행의 origin 상태 (checked vs estimated)', () => {
  const estimatedRows = CONTROLVIEW_METHOD_MAP.filter((r) => r.origin === 'estimated');

  // estimated 행이 있으면 그것이 왜인지 기록
  if (estimatedRows.length > 0) {
    console.log('추정(estimated) 행 목록:');
    for (const row of estimatedRows) {
      console.log(`  - ${row.module} (${row.role}): ${row.source}`);
      if (row.module === 'input') {
        console.log('    → 대조 결과: towerViewer.ts에서 키 입력 처리 코드를 찾을 수 없음');
        console.log('      input 모듈은 로컬 클라이언트 입력 처리로, 뷰어 클래스가 아닌 별도 모듈에서 구현됨');
      }
      if (row.module === 'fallback') {
        console.log('    → 신규 기능(새로 추가됨)');
      }
    }
  }

  // checked 행만 있고 estimated는 input과 fallback만 있어야 함
  const checkedCount = CONTROLVIEW_METHOD_MAP.filter((r) => r.origin === 'checked').length;
  assert.equal(checkedCount, 7, '7개 행이 checked 상태여야 함 (terrain, drape, buildings, chase, overlay, streaming, e2e)');

  for (const row of estimatedRows) {
    assert.ok(
      ['input', 'fallback'].includes(row.module),
      `estimated는 input 또는 fallback만 가능: ${row.module}`
    );
  }

  console.log(`✓ 7개 행 checked, 2개 행 estimated (input·fallback)`);
});

test('isDrapeAligned: 이동량 모르는 local 블록이 있으면 통과가 아니다', () => {
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: 0 }, 1), true);
  assert.equal(isDrapeAligned({ maxMisalignPx: 1, unmeasuredLocalBlocks: 0 }, 1), true);
  assert.equal(isDrapeAligned({ maxMisalignPx: 1.01, unmeasuredLocalBlocks: 0 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.2, unmeasuredLocalBlocks: 1 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: NaN, unmeasuredLocalBlocks: NaN }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: NaN, unmeasuredLocalBlocks: 0 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.2 }, 1), false);
  assert.equal(isDrapeAligned(undefined, 1), false);
});

test('isDrapeAligned: 강제 변환·음수 입력은 통과가 아니다', () => {
  const j = JSON.parse(JSON.stringify({ maxMisalignPx: NaN, unmeasuredLocalBlocks: 0 }));
  assert.equal(isDrapeAligned(j, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: null, unmeasuredLocalBlocks: 0 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: '0.5', unmeasuredLocalBlocks: 0 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: -1, unmeasuredLocalBlocks: 0 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: 0 }, null), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.2, unmeasuredLocalBlocks: -1 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: -1 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: 0 }, 1), true);
  assert.equal(isDrapeAligned({ maxMisalignPx: 1, unmeasuredLocalBlocks: 0 }, 1), true);
});

test('isDrapeAligned: 비유한 입력(maxMisalignPx·tolPx Infinity)·문자열·소수·NaN·undefined 인 tolPx·unmeasuredLocalBlocks 는 통과가 아니다', () => {
  // maxMisalignPx Infinity → false (tolPx 도 Infinity 여도 false)
  assert.equal(isDrapeAligned({ maxMisalignPx: Infinity, unmeasuredLocalBlocks: 0 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: Infinity, unmeasuredLocalBlocks: 0 }, Infinity), false);
  // tolPx Infinity·문자열 → false
  assert.equal(isDrapeAligned({ maxMisalignPx: 5, unmeasuredLocalBlocks: 0 }, Infinity), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: 0 }, '1'), false);
  // tolPx null 은 위 시험에서 다룸
  // unmeasuredLocalBlocks 문자열·소수·NaN·undefined → false
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: '0' }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: 0.5 }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: NaN }, 1), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: undefined }, 1), false);
  // 원본 유효 입력은 true 유지
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.5, unmeasuredLocalBlocks: 0 }, 1), true);
  assert.equal(isDrapeAligned({ maxMisalignPx: 1, unmeasuredLocalBlocks: 0 }, 1), true);
});

test('isDrapeAligned: 경계 0 — maxMisalignPx 0·tolPx 0 은 유효 입력이다 (F-397 ⑧)', () => {
  // maxMisalignPx 0(이동 없음)은 거부하면 안 된다: `maxMisalignPx <= 0` 거부 변이를 죽인다.
  assert.equal(isDrapeAligned({ maxMisalignPx: 0, unmeasuredLocalBlocks: 0 }, 1), true);
  // tolPx 0(허용 오차 없음)도 유효하다: `tolPx <= 0` 거부 변이를 죽인다. 이때 통과는 이동량이 정확히 0 일 때뿐이다.
  assert.equal(isDrapeAligned({ maxMisalignPx: 0, unmeasuredLocalBlocks: 0 }, 0), true);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0.001, unmeasuredLocalBlocks: 0 }, 0), false);
  // 0 이어도 미측정 local 이 있으면 통과가 아니다.
  assert.equal(isDrapeAligned({ maxMisalignPx: 0, unmeasuredLocalBlocks: 1 }, 1), false);
  // 음수 경계: -0 은 0 과 같게 유효, 음수는 거부.
  assert.equal(isDrapeAligned({ maxMisalignPx: -0, unmeasuredLocalBlocks: 0 }, 0), true);
  assert.equal(isDrapeAligned({ maxMisalignPx: 0, unmeasuredLocalBlocks: 0 }, -0.001), false);
  assert.equal(isDrapeAligned({ maxMisalignPx: -0.001, unmeasuredLocalBlocks: 0 }, 1), false);
});

test('건물 층 계약: 모듈 파일 이름이 겹치지 않고 기본값은 동결', async () => {
  const m = await import('./index.mjs');
  const files = Object.values(m.BUILDINGS_MODULES).map((r) => r.file);
  assert.equal(new Set(files).size, files.length);
  assert.equal(files.length, 9);
  assert.equal(Object.isFrozen(m.BUILDINGS_DEFAULTS), true);
  assert.deepEqual(Object.keys(m.BUILDINGS_LAYER_API), ['create', 'accept', 'setMode', 'mode', 'render', 'state']);
  assert.deepEqual([...m.BUILDINGS_DEFAULTS.faceRgb], [0, 0, 0]);
});

test('추적 카메라 계약: clearTarget·float32 조건·조준 오프셋·dt 조건이 명시돼 있다', async () => {
  const m = await import('./chase.mjs');
  assert.deepEqual(Object.keys(m.TOWER_CHASE_API), ['create', 'target', 'step', 'clear', 'snap', 'camera']);
  assert.match(m.TOWER_CHASE_API.clear, /clearTarget\(\)/);
  assert.match(m.TOWER_CHASE_API.clear, /snap\(\)/);
  assert.match(m.TOWER_CHASE_API.target, /float32/);
  assert.match(m.TOWER_CHASE_API.create, /float32/);
  assert.match(m.TOWER_CHASE_API.create, /조준 오프셋/);
  assert.match(m.TOWER_CHASE_API.step, /TypeError/);
  const src = (await import('node:fs')).readFileSync(new URL('./chase.mjs', import.meta.url), 'utf8');
  assert.match(src, /dt ≤ maxDtSec 일 때 프레임 길이 무관/);
});
