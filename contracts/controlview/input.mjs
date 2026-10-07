// 관제탑 입력 층(T15.4) 계약. 구현은 client/tower/input/. 서명·자료형·기준 수치만 둔다.
// 방향키 조향·Q/E 고도는 서버 왕복 없이 로컬에서 처리한다(결정 0001: 경로 B). 이 층은 네트워크·타이머를 쓰지 않는다.
// 좌표: GeoAnchor 기준 ENU(x=동, y=북, z=위), 1 unit = 1 m. 방위 yaw: 0 = 북(+y), 시계 방향(동쪽 쪽)이 +, rad.
// 원본 대조 완료(0122bd4, T15.0L): 키 입력은 drones/manualControl.ts:13-28·pathFollower.ts:130-144 에 있다
// (원본 manualSpeed 8.0·manualAltitudeSpeed 5.0·manualYawRate 0.95, src/shared/viewer/config.ts:71·73·75). 원본 값은 world units/s(장면 축척 s 의존)이고 숫자만 맞춤(SPEC 2026-10-07 ②, T15.I). 값을 8.0·0.95·5 로 정했다. 값은 모두 opts 로 바꿀 수 있다.
// 원칙: 입력은 같은 프레임 안에 카메라에 반영된다(keyDown → step(dt) → camera() 가 한 프레임 안의 동기 호출이고 await·타이머가 없다).

/** 키(KeyboardEvent.code 기준)와 동작. 같은 축의 반대 키가 함께 눌리면 서로 상쇄(0). */
export const TOWER_INPUT_KEYS = Object.freeze({
  ArrowLeft: 'yawLeft', ArrowRight: 'yawRight', ArrowUp: 'forward', ArrowDown: 'back', KeyE: 'altUp', KeyQ: 'altDown',
});

/** 기본 값. 속도 단위는 초당. */
export const TOWER_INPUT_DEFAULTS = Object.freeze({
  yawRateRad: 0.95, speedMps: 8.0, altRateMps: 5, minAltM: 1, maxAltM: 500, pitchRad: -0.3, fovYRad: 0.9, maxDtSec: 0.25,
});

/** 입력 층 서명. */
export const TOWER_INPUT_API = Object.freeze({
  create: 'createTowerInput(opts?) -> TowerInput   opts: { pos?:[x,y,z] ENU m, yaw?:rad, ...TOWER_INPUT_DEFAULTS 의 키 }. 위반은 TypeError/RangeError',
  key: 'input.keyDown(code:string) / input.keyUp(code:string) -> boolean   TOWER_INPUT_KEYS 의 키면 true. 반복(이미 눌림)은 무시, 모르는 키는 false 이고 상태를 바꾸지 않는다',
  blur: 'input.releaseAll() -> void   창이 포커스를 잃으면 모든 키를 뗀 것으로 한다(눌린 채 남는 키 방지)',
  step: 'input.step(dtSec:number) -> Pose   dt 는 유한 ≥ 0, maxDtSec 로 상한(긴 정지 뒤 순간이동 방지). 눌린 키로 위치·방위·고도를 적분하고 Pose 를 돌려준다. dt = 0 이면 변화 없음',
  pose: 'input.pose() -> { pos:[x,y,z], yaw:number, pitch:number }   복사본(바꿔도 상태 불변)',
  camera: 'input.camera() -> CameraPose(contracts/statusview: {pos, quat 카메라→ENU 단위(x,y,z,w), fovY})   현재 Pose 에서 계산. step 직후 같은 프레임에서 읽으면 갱신된 값',
});

/** 모듈 파일(client/tower/input/). */
export const TOWER_INPUT_MODULES = Object.freeze({
  state: { file: 'state.mjs', fn: 'createPoseState(opts) -> { step(dt, held), pose() }   held = {yawLeft,yawRight,forward,back,altUp,altDown} 불리언. 순서: 스텝 중간 방위 yawMid = yaw + (right − left)·yawRate·dt/2 로 이동한 뒤 yaw 를 (right − left)·yawRate·dt 만큼 갱신한다. forward = (sin yawMid, cos yawMid, 0)·speed·dt, z 는 [minAltM, maxAltM] 로 자른다' },
  keys: { file: 'keys.mjs', fn: 'createKeyTracker() -> { down(code), up(code), releaseAll(), held() -> held 객체 }   keys 는 상쇄하지 않고 held 에 둘 다 true 로 둔다. 상쇄는 state 가 한다' },
  camera: { file: 'camera.mjs', fn: 'poseToCameraPose(pose, fovYRad) -> CameraPose   카메라 축 OpenCV(x 오른쪽, y 아래, z 앞). yaw=0,pitch=0 이면 앞(z)=북(+y), 오른쪽(x)=동(+x), 아래(y)=−z(ENU 아래). pitch 는 위가 +' },
  index: { file: 'index.mjs', fn: 'createTowerInput(opts?) 조립' },
});

/** 시험 이름(구현 모듈별 .test.mjs 가 이 이름을 쓴다). 빈 본문이 아니라 이름 약속이다. */
export const TOWER_INPUT_TEST_NAMES = Object.freeze([
  'state: 방위 0 에서 앞으로 1 s 이동하면 y 가 speed 만큼 늘고 x 는 0',
  'state: 방위 +90° 에서 앞은 동(+x)',
  'state: 고도는 [minAltM, maxAltM] 로 잘린다',
  'keys: 반복 keyDown 은 무시되고 keyUp 한 번으로 뗀다',
  'keys: 모르는 키는 false 이고 상태 불변',
  'camera: yaw=0 pitch=0 이면 카메라 앞(z)이 북이고 오른쪽(x)이 동',
  'camera: quat 는 단위이고 카메라→ENU 회전이 contracts/raster 의 R 과 맞는다',
  'index: keyDown → step → camera 가 한 프레임 안 동기 호출에서 갱신된다',
  'index: 네트워크·타이머를 쓰지 않는다',
  'index: dt 상한과 반대 키 상쇄',
]);
