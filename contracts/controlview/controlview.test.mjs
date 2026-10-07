import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTROLVIEW_METHOD_MAP, controlviewModulePath, isDrapeAligned, CONTROLVIEW_LIMITS } from './index.mjs';

test('대응표 자기 일관성: 모듈 9개, 모듈·fn 중복 없음', () => {
  const mods = CONTROLVIEW_METHOD_MAP.map((r) => r.module).sort();
  assert.deepEqual(mods, ['buildings', 'chase', 'drape', 'e2e', 'fallback', 'input', 'overlay', 'streaming', 'terrain']);
  for (const r of CONTROLVIEW_METHOD_MAP) {
    assert.equal(typeof r.fn, 'string');
    assert.ok(['checked', 'estimated'].includes(r.origin), `${r.module}: ${r.origin}`);
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

// T15.0L: skylens 원본(NET-Challenge-S13/skylens 0122bd4) src/skylens_core/controlview/towerViewer.ts
// TowerViewer 클래스(:146-811)의 공개 멤버. private 멤버는 뺐다.
// 주의: 줄 번호(주석)는 사람이 원본을 열어 대조한 결과이고 이 시험이 자동 검증하지 않는다. 시험이 고정하는 것은 멤버 이름 목록과 행 인용의 파일·줄 범위 문자열뿐이다.
const ORIGINAL_PUBLIC = [
  'constructor', // :204-267
  'setDisplay', // :293-297
  'display', // :299-301 getter
  'aerialAvailable', // :304-306 getter
  'addStreamedTerrain', // :420-441
  'addSurroundBuildings', // :448-498
  'setRoute', // :586-638
  'debugTopDown', // :653-664
  'debugScene', // :668-670
  'debugRoute', // :674-686
  'update', // :734-752
  'resize', // :789-795
  'dispose', // :797-810
];

test('원본 대조 T15.0L: 조립 행 source 가 원본 공개 멤버를 정확히 그 목록대로 나열한다', () => {
  const e2e = CONTROLVIEW_METHOD_MAP.find((r) => r.module === 'e2e');
  assert.ok(e2e);
  assert.equal(e2e.origin, 'checked');
  const listed = /\(([^)]*)\)\s*$/.exec(e2e.source)[1].split('·');
  assert.deepEqual(listed, ORIGINAL_PUBLIC);
});

test('원본 대조 T15.0L: checked 행은 원본 줄을 대고, estimated 는 input·streaming·fallback 만 남는다', () => {
  for (const r of CONTROLVIEW_METHOD_MAP) {
    if (r.origin === 'checked') assert.match(r.source, /^towerViewer\.ts:\d/, r.module);
  }
  const estimated = CONTROLVIEW_METHOD_MAP.filter((r) => r.origin === 'estimated').map((r) => r.module);
  // input: 원본 키 입력은 towerViewer.ts 가 아니라 drones/manualControl.ts:13-28·pathFollower.ts:130-144 에 있고,
  // 속도 상수가 다르다(원본 manualSpeed 8.0·manualAltitudeSpeed 5.0·manualYawRate 0.95, shared/viewer/config.ts:71·73·75). 결정 전까지 estimated.
  // streaming: 원본 요청 로직은 shared/viewer/sources/streamSource.ts:23-36,85,99 에 있고 상수가 다르다
  //   (원본 LOAD_RADIUS 34·EVICT_RADIUS 74.8·MAX_CONCURRENT 2·TICK_MS 900, 우리 maxDistM 1500·maxInflight 16·타이머 없음).
  // fallback: 원본에 없는 신규.
  assert.deepEqual(estimated, ['input', 'streaming', 'fallback']);
  const streaming = CONTROLVIEW_METHOD_MAP.find((r) => r.module === 'streaming');
  assert.match(streaming.source, /streamSource\.ts:23-36,85,99/);
  const input = CONTROLVIEW_METHOD_MAP.find((r) => r.module === 'input');
  assert.match(input.source, /pathFollower\.ts:130-144/);
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
