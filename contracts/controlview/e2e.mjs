// 관제탑 화면 조립(T15.9) 계약: 입력·추적·오버레이·스트리밍·폴백 모듈을 한 객체로 묶는 createControlView 의 서명과 녹화 형식.
// 구현은 client/tower/e2e/index.mjs. 이 파일은 서명·자료형·완료 기준 상수만 가진다.
// 원칙: 도착한 것만 그린다, 수준은 교체이고 추월당한 수준은 건너뛴다, 메우지 않는다. 좌표는 GeoAnchor 기준 ENU, 1 unit = 1 m.

export const TOWER_E2E_API = Object.freeze({
  create: 'createControlView(opts?) -> ControlView   opts: {input?, chase?, overlay?, streaming?, fallback?} 각 모듈 opts 를 그대로 넘긴다. 알 수 없는 키 RangeError',
  frame: 'view.step(dtSec, size) -> Snapshot   한 프레임: 입력 적분 → 추적 목표 갱신 → 카메라 → 스트리밍 update. 던지면 상태 불변',
  data: 'view.setDrones(list)·setDetections(list)·setPath(path)·clear() — overlay 와 fallback 양쪽에 같은 데이터를 넣는다(live 에서도 폴백은 데이터를 받아 둔다)',
  arrival: 'view.arrived(tx,ty)·failed(tx,ty) — streaming 으로 전달',
  availability: 'view.setAvailable(boolean) — fallback 모드 전환. false 이면 snapshot.mode = "fallback", 3D 층 결과는 함께 내지 않는다',
  input: 'view.keyDown(code)·keyUp(code)·releaseAll() — 입력 층으로 전달(받아들인 키만 기억). view.removePath(id)·mode() — 오버레이·폴백 경로 제거·현재 모드',
  fallbackStreaming: '폴백(mode "fallback") 중 step 은 streaming.update 를 부르지 않는다(오지 않을 타일을 요청해 자리를 막지 않는다). arrived·failed 는 계속 전달하고 이미 나간 inflight 는 그대로 둔다. 복귀(live) 뒤 첫 step 이 다시 update 한다',
  tracking: '추적 대상은 드론 목록의 첫 드론. yaw 가 없으면 같은 드론의 이전 방위를 유지하고, 그것도 없으면(도착하지 않은 방위를 지어 쓰지 않는다) 그 프레임은 추적하지 않고 입력 카메라를 쓴다. 다른 드론으로 바뀌면 컷 전환(snap), 목록이 비면 해제',
  snapshot: 'view.snapshot(size) -> {mode, camera, overlay, streaming:{held,inflight}, fallback}   상태를 바꾸지 않는다. 같은 녹화를 두 번 재생하면 JSON 으로 같다',
});

/** 녹화 한 건: 시간순 프레임 목록. 재생은 결정적이어야 한다(벽시계·난수 없음). */
export const TOWER_E2E_RECORDING = Object.freeze({
  version: 1,
  frame: '{ dtSec:number, keys?:{down?:string[], up?:string[]}, drones?:Drone[], detections?:Detection[], paths?:Path[], available?:boolean, arrivedTiles?:[tx,ty][], failedTiles?:[tx,ty][] }',
  expected: '녹화마다 프레임별 기대 상태(모드·held·inflight 개수, camera.quat·fovY, 오버레이 드론 [id,x,y,visible]·탐지, fallback.paths)를 손계산으로 적은 표를 시험 안에 둔다. 구현 출력을 받아 적은 값은 손계산이라 쓰지 않는다',
});

export const TOWER_E2E_MODULES = Object.freeze({
  index: { file: 'index.mjs', fn: 'createControlView(opts?)' },
  recording: { file: 'recording.mjs', fn: 'replayRecording(view, recording, size) -> Snapshot[]' },
});

export const TOWER_E2E_MATCH = Object.freeze({ maxFrameStateMismatch: 0, maxNetworkCalls: 0 });
