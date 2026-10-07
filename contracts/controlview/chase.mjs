// 관제탑 추적 카메라(T15.5) 계약. 구현은 client/tower/chase/. 서명·자료형·기준 수치만 둔다.
// 추적 카메라는 목표(드론)의 위치·방위를 따라가되 지수 감쇠로 부드럽게 움직인다. 이 층은 네트워크·타이머를 쓰지 않는다.
// 좌표: GeoAnchor 기준 ENU(x=동, y=북, z=위), 1 unit = 1 m. 방위 yaw: 0 = 북(+y), 시계 방향(동쪽 쪽)이 +, rad.
// 원본 '기존 감쇠 의미' 는 대조를 마쳤다(0122bd4, T15.0L, towerViewer.ts:734-752,769-787; origin 'checked'). 원본 CAMERA_LERP 0.06 은 프레임당 lerp 계수(towerViewer.ts:29, :782-783), 첫 표본은 감쇠 없이 즉시 부착(:777-780). 우리는 dt 기반 지수 감쇠 τ=0.35 로 구현해 원본과 동작이 다르지만 비슷한 느낌.
// 감쇠를 프레임 길이와 무관한 지수 감쇠로 둔 것은 이 층의 해석이다(연구 decisions/0051).
// 원칙: 도착한 것만 그린다 — 목표가 한 번도 주어지지 않았으면 camera() 는 null 이고 어떤 자세도 지어내지 않는다.

/** 기본 값. tauSec 는 감쇠 시간 상수(s): 목표와의 차이가 1/e 로 줄어드는 시간. 0 이면 감쇠 없음(즉시 따라감). */
export const TOWER_CHASE_DEFAULTS = Object.freeze({
  tauSec: 0.35, distM: 30, heightM: 10, lookAheadM: 0, fovYRad: 0.9, maxDtSec: 0.25,
});

/** 감쇠 계수. a = 1 − exp(−dt/tau), tau = 0 이면 a = 1. 같은 목표에서 dt 를 둘로 나눠 두 번 걸어도 한 번과 같다(dt ≤ maxDtSec 일 때 프레임 길이 무관. 더 긴 dt 는 maxDtSec 로 잘려 분할과 같지 않다). */
export const TOWER_CHASE_FORMULA = Object.freeze({
  factor: 'a = 1 − exp(−dt/tau)   (tau = 0 이면 1)',
  position: 'p ← p + (target − p)·a   (각 성분)',
  yaw: 'yaw ← yaw + wrapPi(targetYaw − yaw)·a   wrapPi 는 (−π, π] 로 접는 최단 호. 방위 ±π 경계를 가로질러도 먼 쪽으로 돌지 않는다',
  rig: '감쇠된 (p, yaw) 로부터 카메라 위치 = p − distM·(sin yaw, cos yaw, 0) + (0,0,heightM), 시선 = p + lookAheadM·(sin yaw, cos yaw, 0) 를 향함. 방위 yawCam·피치 pitchCam 은 시선 벡터 d 에서 yawCam = atan2(dx, dy), pitchCam = atan2(dz, hypot(dx, dy))',
});

/** 추적 카메라 서명. */
export const TOWER_CHASE_API = Object.freeze({
  create: 'createChaseCamera(opts?) -> ChaseCamera   opts: TOWER_CHASE_DEFAULTS 의 키. 형식 위반 TypeError, 알 수 없는 키·범위 위반(비유한, tauSec<0, distM<0, 0<fovY<π 위반, maxDtSec≤0, distM·heightM·lookAheadM 이 float32 유한이 아님 또는 |distM|+|heightM| 가 float32 최댓값 초과) RangeError. lookAheadM 은 목표 움직임의 예측이 아니라 시선 지점을 yaw 방향 앞으로 옮기는 조준 오프셋(m)이다',
  target: 'chase.setTarget(pos:[x,y,z] 유한, yaw:number 유한) -> void   pos 는 float32 유한(Math.fround 유한)이고 |pos 성분| + |distM| + |heightM| ≤ float32 최댓값이어야 하며(카메라 위치가 float32 안), 위반은 그 자리에서 RangeError(통과한 입력으로 camera()·step() 은 던지지 않는다). 첫 호출은 감쇠 없이 그 자리로 놓는다(원점에서 날아오지 않는다). 이후 호출은 목표만 바꾼다',
  step: 'chase.step(dtSec:number) -> {pos:[x,y,z], yaw:number}|null   dt 는 number(아니면 TypeError)이고 유한 ≥ 0(아니면 RangeError), maxDtSec 로 상한. 목표가 없으면 null. dt = 0 이면 변화 없음. 감쇠된 목표 상태를 돌려준다(복사본)',
  clear: 'chase.clearTarget() -> void   목표를 해제한다: 이후 camera()·step() 은 null(마지막 자세를 그리지 않는다). 목표 상실은 호출자가 알아 처리하고, 목표가 다시 나타나면 setTarget 뒤 snap() 으로 컷 전환한다(감쇠로 옛 자리에서 날아오지 않게)',
  snap: 'chase.snap() -> void   감쇠 없이 현재 목표로 즉시 놓는다(컷 전환). 목표가 없으면 아무것도 안 한다',
  camera: 'chase.camera() -> CameraPose|null   감쇠된 상태에서 rig 공식으로 계산(contracts/statusview {pos, quat, fovY}). 목표가 없으면 null',
});

/** 모듈 파일(client/tower/chase/). */
export const TOWER_CHASE_MODULES = Object.freeze({
  damp: { file: 'damp.mjs', fn: 'dampFactor(dt, tau) -> a ∈ [0,1];  wrapPi(rad) -> (−π, π];  dampScalar(cur, target, a);  dampAngle(cur, target, a)  순수 JS' },
  rig: { file: 'rig.mjs', fn: 'rigPose(state:{pos,yaw}, cfg:{distM,heightM,lookAheadM}) -> Pose{pos,yaw,pitch}   TOWER_CHASE_FORMULA.rig' },
  state: { file: 'state.mjs', fn: 'createChaseState(cfg) -> { setTarget(pos,yaw), step(dt), snap(), state() }   TOWER_CHASE_FORMULA.position·yaw' },
  index: { file: 'index.mjs', fn: 'createChaseCamera(opts?) 조립. rigPose → client/tower/input/camera.mjs 의 poseToCameraPose(pose, fovYRad)' },
});

/** 시험 이름(구현 모듈별 .test.mjs 가 이 이름을 쓴다). 빈 본문이 아니라 이름 약속이다. */
export const TOWER_CHASE_TEST_NAMES = Object.freeze([
  'damp: dampFactor 는 1 − exp(−dt/tau) 이고 tau=0 이면 1',
  'damp: wrapPi 는 (−π, π] 로 접는다',
  'rig: 방위 0 이면 카메라는 목표 남쪽 distM 뒤·heightM 위에 있고 시선은 목표를 향한다',
  'state: 첫 setTarget 은 감쇠 없이 놓는다',
  'state: 한 번 step(dt) 은 차이를 (1 − exp(−dt/tau)) 만큼 줄인다',
  'state: dt 를 둘로 나눠 두 번 걸어도 한 번과 같다',
  'state: 방위 ±π 경계를 가로질러도 최단 호로 돈다',
  'index: 목표가 없으면 camera() 는 null',
  'index: 네트워크·타이머를 쓰지 않는다',
  'index: dt 상한과 입력 검사',
]);
