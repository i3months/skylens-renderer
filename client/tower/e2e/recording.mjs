// 관제탑 화면 녹화 재생(T15.9). 계약: contracts/controlview/e2e.mjs(TOWER_E2E_RECORDING, TOWER_E2E_MODULES.recording).
// 프레임마다 keys → step → 데이터 → 가용성 → 도착/실패 → snapshot 순서로 적용한다. 벽시계·난수·네트워크를 쓰지 않아 결정적이다.
import { TOWER_E2E_RECORDING } from '../../../contracts/controlview/e2e.mjs';
import { copyInput, copySize, checkSizeLight } from './index.mjs';

const FRAME_KEYS = ['dtSec', 'keys', 'drones', 'detections', 'paths', 'available', 'arrivedTiles', 'failedTiles'];

// 녹화는 프레임 배열이거나 {version?, frames} 객체다.
// 각 필드는 한 번만 읽는다.
function framesOf(recording) {
  if (Array.isArray(recording)) return recording;
  if (recording === null || typeof recording !== 'object') throw new TypeError('recording 은 프레임 배열 또는 {version, frames} 객체여야 한다');
  const version = recording.version;
  const frames = recording.frames;
  if (version !== undefined && version !== TOWER_E2E_RECORDING.version) {
    throw new RangeError(`지원하지 않는 녹화 version: ${String(version)}`);
  }
  if (!Array.isArray(frames)) throw new TypeError('recording.frames 는 배열이어야 한다');
  return frames;
}

// 프레임을 한 번 읽어 평범한 사본으로 만든다(희소 배열 구멍은 TypeError). 이후 재생은 사본만 쓴다.
function readFrames(frames) {
  const n = frames.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    if (!Object.prototype.hasOwnProperty.call(frames, i)) throw new TypeError(`frames[${i}] 는 비어 있으면 안 된다(희소 배열 구멍)`);
    const f = frames[i];
    if (f === null || typeof f !== 'object' || Array.isArray(f)) throw new TypeError(`frames[${i}] 는 객체여야 한다`);
    out[i] = copyInput(f, `frames[${i}]`);
  }
  return out;
}

function checkFrame(f, i) {
  if (f === null || typeof f !== 'object' || Array.isArray(f)) throw new TypeError(`frames[${i}] 는 객체여야 한다`);
  for (const k of Object.keys(f)) {
    if (!FRAME_KEYS.includes(k)) throw new RangeError(`frames[${i}] 의 알 수 없는 키: ${k}`);
  }
  if (typeof f.dtSec !== 'number') throw new TypeError(`frames[${i}].dtSec 는 number 여야 한다`);
  if (!Number.isFinite(f.dtSec) || f.dtSec < 0) throw new RangeError(`frames[${i}].dtSec 는 유한 ≥ 0 이어야 한다`);
  for (const k of ['paths', 'arrivedTiles', 'failedTiles']) {
    if (f[k] !== undefined && !Array.isArray(f[k])) throw new TypeError(`frames[${i}].${k} 는 배열이어야 한다`);
  }
  if (f.keys !== undefined) {
    if (f.keys === null || typeof f.keys !== 'object') throw new TypeError(`frames[${i}].keys 는 객체여야 한다`);
    for (const k of Object.keys(f.keys)) {
      if (k !== 'down' && k !== 'up') throw new RangeError(`frames[${i}].keys 의 알 수 없는 키: ${k}`);
      if (!Array.isArray(f.keys[k])) throw new TypeError(`frames[${i}].keys.${k} 는 배열이어야 한다`);
    }
  }
  const tiles = [...(f.arrivedTiles ?? []), ...(f.failedTiles ?? [])];
  for (const t of tiles) {
    if (!Array.isArray(t) || t.length !== 2) throw new TypeError(`frames[${i}] 의 타일은 [tx, ty] 여야 한다`);
  }
}

/**
 * replayRecording(view, recording, size) -> Snapshot[]
 * view 는 createControlView 결과. 프레임마다 한 개의 snapshot(size) 를 돌려준다.
 */
export function replayRecording(view, recording, size) {
  const sz = copySize(size);
  checkSizeLight(sz);
  const frames = readFrames(framesOf(recording));
  frames.forEach(checkFrame);
  const out = [];
  try {
    for (const f of frames) out.push(replayFrame(view, f, sz));
  } catch (err) {
    view.releaseAll(); // 중간에 던져도 눌린 키가 남지 않게
    throw err;
  }
  return out;
}

function replayFrame(view, f, size) {
  // 키: 뗌을 먼저 적용하고 누름을 적용한다(같은 프레임에서 뗐다 다시 누르는 경우를 누름으로 끝낸다).
  for (const code of f.keys?.up ?? []) view.keyUp(code);
  for (const code of f.keys?.down ?? []) view.keyDown(code);
  view.step(f.dtSec, size);
  if (f.drones !== undefined) view.setDrones(f.drones);
  if (f.detections !== undefined) view.setDetections(f.detections);
  for (const p of f.paths ?? []) view.setPath(p);
  if (f.available !== undefined) view.setAvailable(f.available);
  // 도착·실패: inflight 가 아닌 타일은 streaming 이 받지 않는다(상태 불변).
  for (const [tx, ty] of f.arrivedTiles ?? []) view.arrived(tx, ty);
  for (const [tx, ty] of f.failedTiles ?? []) view.failed(tx, ty);
  return view.snapshot(size);
}
