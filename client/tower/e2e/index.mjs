// 관제탑 화면 조립(T15.9). 계약: contracts/controlview/e2e.mjs(TOWER_E2E_API).
// 입력·추적·오버레이·스트리밍·폴백 모듈을 각자의 공개 index.mjs 로만 묶는다. 네트워크·타이머·난수를 쓰지 않는다.
// 한 프레임(step): 입력 적분 → 추적 목표 갱신 → 카메라 → 스트리밍 update. 던지면 상태 불변(검사 뒤 실패하면 이전 상태로 되돌린다).
// 원칙: 도착한 것만 그린다. fallback 모드에서는 3D 층 결과(camera·overlay·streaming)를 내지 않는다(null).
import { createTowerInput } from '../input/index.mjs';
import { createChaseCamera } from '../chase/index.mjs';
import { createTowerOverlay } from '../overlay/index.mjs';
import { createTowerStreaming } from '../streaming/index.mjs';
import { createTowerFallback } from '../fallback/index.mjs';

const OPT_KEYS = ['input', 'chase', 'overlay', 'streaming', 'fallback'];

function checkViewOpts(opts) {
  if (opts === undefined) return {};
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) throw new TypeError('opts 는 객체여야 한다');
  for (const k of Object.keys(opts)) {
    if (!OPT_KEYS.includes(k)) throw new RangeError(`알 수 없는 opts 키: ${k}`);
  }
  return opts;
}

// 모듈 opts 는 되살리기(재생성)에 다시 쓰므로 얕은 복사로 붙잡아 둔다(호출자가 나중에 고쳐도 영향 없음).
// 비객체(숫자·null·배열 등)는 펼치지 않고 그대로 두어 각 모듈 생성자가 TypeError 로 거부하게 한다.
const copyOpts = (o) => (o === null || typeof o !== 'object' || Array.isArray(o) ? o : { ...o });

const copyVec = (v) => [v[0], v[1], v[2]];

const MAX_COPY_DEPTH = 6;

// 입력을 한 번만 읽어 평범한 사본으로 만든다(배열·평범한 객체만 재귀, 접근자는 한 번씩만 읽힌다).
// strictName 이 있으면 희소 배열 구멍을 TypeError 로 막고, 없으면 구멍은 undefined 로 두어 각 검사가 던지게 한다.
export function copyInput(v, strictName, depth = MAX_COPY_DEPTH) {
  if (v === null || typeof v !== 'object') return v;
  if (depth <= 0) throw new RangeError(`${strictName ?? '입력'} 의 중첩이 너무 깊다`);
  if (Array.isArray(v)) {
    const n = v.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      if (strictName !== undefined && !Object.prototype.hasOwnProperty.call(v, i)) {
        throw new TypeError(`${strictName}[${i}] 는 비어 있으면 안 된다(희소 배열 구멍)`);
      }
      out[i] = copyInput(v[i], strictName === undefined ? undefined : `${strictName}[${i}]`, depth - 1);
    }
    return out;
  }
  const keys = Object.keys(v);
  const entries = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    entries[i] = [keys[i], copyInput(v[keys[i]], strictName === undefined ? undefined : `${strictName}.${keys[i]}`, depth - 1)];
  }
  return Object.fromEntries(entries); // 자체 속성으로만 만든다(__proto__ 키도 평범한 속성)
}

// size 사본: 비객체는 그대로 둬 크기 검사가 TypeError 로 던진다. 접근자 재읽기로 값이 바뀌어도 사본만 쓴다.
export function copySize(size) {
  if (size === null || typeof size !== 'object' || Array.isArray(size)) return size;
  const keys = Object.keys(size);
  const out = {};
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const x = size[k];
    if (k === '__proto__') Object.defineProperty(out, k, { value: x, enumerable: true, writable: true, configurable: true });
    else out[k] = x;
  }
  return out;
}

// 크기만 검사하는 가벼운 검사(frame 을 만들지 않는다). 규칙·오류 종류는 overlay/fallback 의 checkSize 와 같다.
export function checkSizeLight(sz) {
  if (sz === null || typeof sz !== 'object' || Array.isArray(sz)) throw new TypeError('size 는 객체여야 한다');
  if (typeof sz.width !== 'number') throw new TypeError('size.width 는 숫자여야 한다');
  if (typeof sz.height !== 'number') throw new TypeError('size.height 는 숫자여야 한다');
  for (const k of Object.keys(sz)) {
    if (k !== 'width' && k !== 'height') throw new RangeError(`size 에 알 수 없는 키 '${k}'`);
  }
  if (!Number.isInteger(sz.width) || sz.width <= 0) throw new RangeError('size.width 는 양의 정수여야 한다');
  if (!Number.isInteger(sz.height) || sz.height <= 0) throw new RangeError('size.height 는 양의 정수여야 한다');
}

/**
 * createControlView(opts?) -> ControlView
 * opts: {input?, chase?, overlay?, streaming?, fallback?} 각 모듈 opts 를 그대로 넘긴다. 알 수 없는 키는 RangeError.
 */
export function createControlView(opts) {
  const o = checkViewOpts(opts);
  const inputOpts = copyOpts(o.input);
  const chaseOpts = copyOpts(o.chase);

  let input = createTowerInput(inputOpts);
  let chase = createChaseCamera(chaseOpts);
  const overlay = createTowerOverlay(o.overlay);
  const streaming = createTowerStreaming(o.streaming);
  const fallback = createTowerFallback(o.fallback);

  // 입력 되살리기용: 지금 눌린 키(입력 층이 받아들인 것만).
  const heldCodes = new Set();
  // 추적 상태 사본: 목표 유무, 마지막으로 넣은 목표, 마지막 감쇠 상태.
  let tracking = false;
  let chaseTarget = null; // {id, pos, yaw}
  let chaseCur = null; // {pos, yaw}
  // 추적에 쓸 드론 목록 사본(받은 그대로, 검사를 통과한 것만).
  let drones = [];

  // 입력 층을 자세·눌린 키로 다시 만든다(실패한 step 되돌리기).
  function rebuildInput(pose) {
    const next = createTowerInput({ ...(inputOpts ?? {}), pos: copyVec(pose.pos), yaw: pose.yaw });
    for (const code of heldCodes) next.keyDown(code);
    input = next;
  }

  // 추적 층을 감쇠 상태·목표로 다시 만든다. 첫 setTarget 은 그 자리에 놓이고 두 번째는 목표만 바꾼다.
  function rebuildChase(wasTracking, cur, target) {
    const next = createChaseCamera(chaseOpts);
    if (wasTracking && cur !== null && target !== null) {
      next.setTarget(copyVec(cur.pos), cur.yaw);
      next.setTarget(copyVec(target.pos), target.yaw);
    }
    chase = next;
  }

  function activeCamera() {
    return tracking ? chase.camera() : input.camera();
  }

  function snapshot(size) {
    return snapshotOf(copySize(size)); // 진입 때 size 를 한 번만 읽는다
  }

  function snapshotOf(size) {
    // 크기 검사는 폴백 frame 이 한다(overlay 와 같은 규칙). 상태를 바꾸지 않는다.
    const fb = fallback.frame(size);
    if (fb.mode === 'fallback') {
      return { mode: 'fallback', camera: null, overlay: null, streaming: null, fallback: fb };
    }
    const camera = activeCamera();
    const st = streaming.state();
    return {
      mode: 'live',
      camera: { pos: copyVec(camera.pos), quat: [...camera.quat], fovY: camera.fovY },
      overlay: overlay.project(camera, size),
      streaming: { held: st.held, inflight: st.inflight },
      fallback: fb,
    };
  }

  function step(dtSec, size) {
    if (typeof dtSec !== 'number') throw new TypeError('dtSec 는 number 여야 한다');
    if (!Number.isFinite(dtSec) || dtSec < 0) throw new RangeError('dtSec 는 유한 ≥ 0 이어야 한다');
    size = copySize(size); // 한 번만 읽은 사본만 쓴다
    checkSizeLight(size); // 크기 검사만(frame 을 만들지 않는다, 상태 불변)

    const savedPose = input.pose();
    const savedTracking = tracking;
    const savedTarget = chaseTarget;
    const savedCur = chaseCur;
    try {
      // 1) 입력 적분
      input.step(dtSec);
      // 2) 추적 목표 갱신: 드론이 있으면 첫 드론, 없으면 해제
      if (drones.length > 0) {
        const d = drones[0];
        // 방위가 없으면 같은 드론의 이전 목표 방위를 유지하고, 처음이면 0(북)으로 둔다.
        const yaw = d.yaw !== undefined ? d.yaw : (chaseTarget !== null && chaseTarget.id === d.id ? chaseTarget.yaw : undefined);
        if (yaw !== undefined) {
          chase.setTarget(copyVec(d.enu), yaw);
          // 목표가 새로 생기면(또는 다른 드론으로 바뀌면) 옛 자리에서 날아오지 않게 컷 전환한다.
          if (!tracking || chaseTarget === null || chaseTarget.id !== d.id) chase.snap();
          tracking = true;
          chaseTarget = { id: d.id, pos: copyVec(d.enu), yaw };
          const s = chase.step(dtSec);
          chaseCur = { pos: copyVec(s.pos), yaw: s.yaw };
        } else {
          // 이전 방위도 없으면 지어내지 않고 이 프레임은 추적하지 않는다(입력 카메라).
          chase.clearTarget();
          tracking = false;
          chaseTarget = null;
          chaseCur = null;
        }
      } else {
        chase.clearTarget();
        tracking = false;
        chaseTarget = null;
        chaseCur = null;
      }
      // 3) 카메라 → 4) 스트리밍 update
      // 폴백 중에는 오지 않을 타일을 요청해 자리를 막지 않도록 update 를 건너뛴다(복귀 뒤 첫 step 이 update).
      if (fallback.mode() !== 'fallback') streaming.update(activeCamera(), size);
      return snapshotOf(size);
    } catch (err) {
      rebuildInput(savedPose);
      rebuildChase(savedTracking, savedCur, savedTarget);
      tracking = savedTracking;
      chaseTarget = savedTarget;
      chaseCur = savedCur;
      throw err;
    }
  }

  return {
    keyDown(code) {
      const ok = input.keyDown(code);
      if (ok) heldCodes.add(code);
      return ok;
    },
    keyUp(code) {
      const ok = input.keyUp(code);
      if (ok) heldCodes.delete(code);
      return ok;
    },
    releaseAll() {
      input.releaseAll();
      heldCodes.clear();
    },
    step,
    // 데이터는 입력을 한 번만 읽은 사본으로 폴백·오버레이에 같이 넣는다. 두 층이 같은 사본을 보므로 폴백(검사가 더 엄격: |e|,|n| 상한)이
    // 받아들이면 오버레이도 받아들인다(거부는 폴백에서 먼저 던져 어느 층도 바뀌지 않는다). 그래서 되돌릴 코드가 없다.
    setDrones(input) {
      const list = copyInput(input); // 한 번만 읽은 사본(yaw 접근자 포함)을 넘기고 저장한다
      fallback.setDrones(list);
      overlay.setDrones(list);
      drones = list.map((d) => (d.yaw === undefined ? { id: d.id, enu: copyVec(d.enu) } : { id: d.id, enu: copyVec(d.enu), yaw: d.yaw }));
    },
    setDetections(input) {
      const list = copyInput(input);
      fallback.setDetections(list);
      overlay.setDetections(list);
    },
    setPath(input) {
      const path = copyInput(input);
      fallback.setPath(path);
      overlay.setPath(path);
    },
    removePath(id) {
      const a = overlay.removePath(id);
      fallback.removePath(id);
      return a;
    },
    clear() {
      overlay.clear();
      fallback.clear();
      drones = [];
    },
    setAvailable(available) {
      fallback.setAvailable(available);
    },
    mode: () => fallback.mode(),
    arrived: (tx, ty) => streaming.arrived(tx, ty),
    failed: (tx, ty) => streaming.failed(tx, ty),
    snapshot,
  };
}
