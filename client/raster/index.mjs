// T12.I 클라이언트 경량 래스터라이저 조립. contracts/client_raster/index.mjs 의 Renderer 인터페이스를 구현한다.
// 이미 병합된 모듈을 엮기만 한다: context(문맥·소실/복구), shader(점 프로그램·유니폼), buffers(조각 GL 버퍼 풀),
// camera(setView → 유니폼), memory(key 별 바이트 표). 프레임 루프(loop createFrameLoop)·지연 계측(latency)은 호출자가
// renderer.draw 를 감싸 쓴다. 복호 Worker 는 기본으로 쓰지 않는다: decode 옵션으로 주입한다(예: loop createDecodeWorkerClient 의 decode).
//
// 조각 흐름: uploadPiece(key, bytes) → key 검사(parsePieceKey) → decode(bytes)(기본 client/codec decodeChunkClient)
//   → 헤더의 (segmentId, level, tileX, tileY, lod, chunkIndex) 가 key 와 같은지 검사 → GPU 평면으로 바꿈 → 버퍼 풀에 올림.
//   GPU 평면(구현 몫, 계약 ①): position f32×3(조각 원점 o = bboxMin(f64) 기준 상대 ENU m = q·2^−quantExp), color u8×3,
//   normalOct i8×2(형식 1 만). 원점 o 는 meta 에 f64 로 두고 그릴 때 조각마다 u_tgl = R_gl·o + t_gl(f64)을 올린다
//   (RTE, F-243 ③: 앵커에서 수 km 먼 장면의 f32 정밀도. shader/index.mjs applyPieceOrigin).
//   형식 2 는 법선이 없어 셰이딩하지 않는다(u_shade = false, 법선 속성은 상수 (0,0)).
// 그리기 규칙(계약 ④): 올린 조각은 받는 것만으로 그리지 않는다. 호출자가 setArrived(arrived) 로 LEVEL_ARRIVED 완료 집합을
//   넘기면 상주 key 를 selectDrawable 로 나눠 draw 에 든 조각만 그린다. setArrived 를 한 번도 부르지 않으면 아무것도 그리지 않는다.
//   setArrived 는 계약 Renderer 에 올라 있는 도착 입력 메서드다(결정 0034). 결과의 discard 는
//   호출자가 releasePiece 로 해제한다(해제 근거). 렌더러는 discard 를 스스로 해제하지 않는다.
//   setArrived(list, {deferResult: true}) 는 반환값이 필요 없는 호출자용 지연 경로다(선택은 다음 draw 에서 1회).
//   재계산 주기(F-246 ⑦, 계약 '프레임마다 부르지 않는다'): selectDrawable 은 setArrived 때만 돈다. 업로드가 끝난 key 가 직전
//   선택에 없으면(도착 집합에 없는 새 key) 직전 선택에서 pending 으로 보고 다시 돌지 않는다. 도착 집합에 든 key 가 올라오면
//   다음 draw 에서 프레임당 최대 1회 다시 돈다. 해제·퇴출은 선택을 건드리지 않는다(draw 가 상주하지 않는 key 를 건너뛴다).
// 메모리(계약 ④·머리 주석 끝): maxResidentBytes 를 넘게 될 업로드는 그리지 않는 상주 조각(pending·discard)을 오래된 것부터
//   해제해 자리를 만든다(onEvict 로 알린다). 그려도 모자라면 그리는 조각은 건드리지 않고 ClientRasterError('memory').
// GPU 평면: 복호 결과에 Worker 가 만든 gpu({format,count,planes,origin})가 있으면 toGpuPlanes 를 다시 돌리지 않고 가벼운 검증만
//   하고 쓴다(F-244 ②). 없으면 toGpuPlanes. 잘못된 gpu 는 'piece'.
// 컨텍스트 소실: GPU 자원(버퍼·프로그램·VAO)을 모두 버린다(상주량 0). 원본 바이트는 보관하지 않는다(도착하지 않은 것을
//   만들지 않으려면 다시 받은 바이트만 쓴다). 복구되면 프로그램을 다시 만들고 onContextRestored 콜백에 소실 당시 상주(또는
//   올리는 중)였던 key 목록을 넘겨 호출자가 uploadPiece 로 다시 올리게 한다. 소실 중 uploadPiece 는 'context' 로 거부하고,
//   소실 전에 시작해 소실 뒤 끝난 업로드도 'context' 로 거부한다(그 key 는 복구 목록에 든다).
// 빈 칸은 메우지 않는다: 지우기 색 (0,0,0) 그대로 둔다.
import {
  ClientRasterError, FORMAT_POINT27, FORMAT_GAUSS56, parsePieceKey, selectDrawable,
} from '../../contracts/client_raster/index.mjs';
import { decodeChunkClient } from '../codec/index.mjs';
import { createContext } from './context/index.mjs';
import {
  createPointProgram, pointUniformValues, applyPointUniforms, applyPieceOrigin, ATTRIB, DEFAULT_AMBIENT,
} from './shader/index.mjs';
import { createBufferPool } from './buffers/index.mjs';
import { buildCameraUniforms } from './camera/index.mjs';
import { createMemoryMeter } from './memory/index.mjs';

/** 셰이딩 기본값(구현 몫, 계약이 고정하지 않음). createRenderer 의 shading 옵션으로 덮어쓴다. */
export const DEFAULT_SHADING = Object.freeze({
  lightDirWorld: Object.freeze([0, 0, 1]), // 세계 좌표 빛 방향(표면 → 광원). ENU 위쪽
  pointSizeM: 0.05, // 점 지름(m)
  ambient: DEFAULT_AMBIENT,
  near: 0.1,
  far: 10000,
});

// 유니폼 검사용 더미 카메라(셰이딩 옵션만 미리 검사한다)
const PROBE_CAMERA = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], K: { fx: 1, fy: 1, cx: 0, cy: 0 }, bw: 1, bh: 1 };

const KEY_FIELDS = ['segmentId', 'level', 'tileX', 'tileY', 'lod', 'chunkIndex'];

/**
 * 복호 결과({header, planes})를 GPU 평면으로 바꾼다. 평면 길이가 pointCount 와 다르면 ClientRasterError('piece').
 * position 은 origin 기준 상대 좌표 (bboxMin − origin) + q·2^−quantExp 를 f64 로 계산한 뒤 f32 로 담는다.
 * 렌더러는 origin = bboxMin 을 넘긴다(상대 좌표 = q·2^−quantExp, f32 로 정확). 생략하면 [0,0,0](절대 ENU, 예전 방식).
 * @param {any} decoded
 * @param {number[]} [origin] 조각 원점 [e, n, u] m(f64)
 * @returns {{format: number, count: number, planes: Record<string, ArrayBufferView>, origin: number[]}}
 */
export function toGpuPlanes(decoded, origin = [0, 0, 0]) {
  const h = decoded && decoded.header;
  const p = decoded && decoded.planes;
  if (!h || !p || typeof p !== 'object') throw new ClientRasterError('piece', '복호 결과에 header·planes 가 없음');
  const format = h.format;
  if (format !== FORMAT_POINT27 && format !== FORMAT_GAUSS56) throw new ClientRasterError('piece', `모르는 format ${String(format)}`);
  const n = h.pointCount;
  if (!Number.isSafeInteger(n) || n < 1) throw new ClientRasterError('piece', `pointCount 가 틀림: ${String(n)}`);
  const need = ['pos_e', 'pos_n', 'pos_u', 'color_r', 'color_g', 'color_b'];
  if (format === FORMAT_POINT27) need.push('normal_oct_x', 'normal_oct_y');
  for (const name of need) {
    if (!ArrayBuffer.isView(p[name]) || p[name].length !== n) throw new ClientRasterError('piece', `평면 ${name} 이 없거나 길이가 ${n} 이 아님`);
  }
  if (!Array.isArray(h.bboxMin) || h.bboxMin.length !== 3 || !Number.isInteger(h.quantExp)) {
    throw new ClientRasterError('piece', '헤더 bboxMin·quantExp 가 틀림');
  }
  if (!Array.isArray(origin) || origin.length !== 3 || !origin.every(Number.isFinite)) {
    throw new ClientRasterError('piece', '조각 원점이 유한 3-벡터가 아님');
  }
  const step = 2 ** -h.quantExp;
  const position = new Float32Array(3 * n);
  const axes = [p.pos_e, p.pos_n, p.pos_u];
  for (let a = 0; a < 3; a += 1) {
    const min = h.bboxMin[a] - origin[a];
    const q = axes[a];
    for (let i = 0; i < n; i += 1) position[3 * i + a] = min + q[i] * step;
  }
  for (let i = 0; i < position.length; i += 1) {
    if (!Number.isFinite(position[i])) throw new ClientRasterError('piece', '복원 위치가 유한하지 않음');
  }
  const color = new Uint8Array(3 * n);
  for (let i = 0; i < n; i += 1) {
    color[3 * i] = p.color_r[i];
    color[3 * i + 1] = p.color_g[i];
    color[3 * i + 2] = p.color_b[i];
  }
  const planes = { position, color };
  if (format === FORMAT_POINT27) {
    const normalOct = new Int8Array(2 * n);
    for (let i = 0; i < n; i += 1) {
      const x = p.normal_oct_x[i];
      const y = p.normal_oct_y[i];
      // ASSET_FORMAT §4.2: normal_oct 범위 -127..127 (−128 거부)
      if (x < -127 || x > 127 || y < -127 || y > 127) {
        throw new ClientRasterError('piece', `normal_oct 값이 범위 [-127, 127] 밖: [${x}, ${y}]`);
      }
      normalOct[2 * i] = x;
      normalOct[2 * i + 1] = y;
    }
    planes.normalOct = normalOct;
  }
  return { format, count: n, planes, origin: [origin[0], origin[1], origin[2]] };
}

/**
 * Worker 가 만든 gpu 평면의 가벼운 검증(값 전수 검사는 하지 않는다): 형식·점 수·원점·평면 이름·타입·길이.
 * origin 은 헤더 bboxMin 과 같아야 한다(렌더러가 쓰는 원점 규약). 어기면 ClientRasterError('piece').
 * @param {any} decoded {header, planes, gpu}
 * @returns {{format: number, count: number, planes: Record<string, ArrayBufferView>, origin: number[]}}
 */
export function checkGpuPlanes(decoded) {
  const h = decoded && decoded.header;
  const g = decoded && decoded.gpu;
  const bad = (m) => new ClientRasterError('piece', `gpu 평면이 틀림: ${m}`);
  if (!h || typeof h !== 'object') throw bad('header 가 없음');
  if (g === null || typeof g !== 'object') throw bad('gpu 가 객체가 아님');
  const format = h.format;
  if (format !== FORMAT_POINT27 && format !== FORMAT_GAUSS56) throw new ClientRasterError('piece', `모르는 format ${String(format)}`);
  const n = h.pointCount;
  if (!Number.isSafeInteger(n) || n < 1) throw new ClientRasterError('piece', `pointCount 가 틀림: ${String(n)}`);
  if (g.format !== format) throw bad(`format ${String(g.format)} != 헤더 ${format}`);
  if (g.count !== n) throw bad(`count ${String(g.count)} != 헤더 pointCount ${n}`);
  if (!Array.isArray(h.bboxMin) || h.bboxMin.length !== 3) throw bad('헤더 bboxMin 이 틀림');
  if (!Array.isArray(g.origin) || g.origin.length !== 3 || !g.origin.every((v, a) => v === h.bboxMin[a])) throw bad('origin 이 헤더 bboxMin 과 다름');
  const p = g.planes;
  if (p === null || typeof p !== 'object') throw bad('planes 가 없음');
  const want = format === FORMAT_POINT27 ? ['position', 'color', 'normalOct'] : ['position', 'color'];
  const names = Object.keys(p);
  if (names.length !== want.length || !want.every((w) => names.includes(w))) throw bad(`평면 이름이 ${want.join(',')} 이 아님: ${names.join(',')}`);
  const spec = { position: [Float32Array, 3], color: [Uint8Array, 3], normalOct: [Int8Array, 2] };
  for (const name of want) {
    const [Type, k] = spec[name];
    if (!(p[name] instanceof Type) || p[name].length !== k * n) throw bad(`평면 ${name} 이 ${Type.name}[${k * n}] 이 아님`);
  }
  return { format, count: n, planes: p, origin: [g.origin[0], g.origin[1], g.origin[2]] };
}

/**
 * 렌더러를 만든다.
 * @param {Object} options
 * @param {any} options.canvas  getContext·addEventListener 를 가진 캔버스
 * @param {number} options.maxPieceBytes  한 조각 GPU 바이트 상한(복호 후 GPU 평면 합)
 * @param {number} options.maxResidentBytes  GPU 상주 바이트 상한
 * @param {(bytes: Uint8Array) => any | Promise<any>} [options.decode]  복호기 주입(기본 decodeChunkClient, 메인 스레드 동기)
 * @param {Partial<typeof DEFAULT_SHADING>} [options.shading]  셰이딩·점 크기·깊이 범위
 * @param {() => number} [options.now]  draw 의 drawMs 용 시계(기본 performance.now)
 * @param {(keys: string[]) => void} [options.onEvict]  메모리 한도 때문에 해제한 그리지 않는 조각 key 알림
 * @param {object} [options.contextAttributes]  getContext 속성(createContext 기본값 위에 덮어씀)
 * @param {{selectDrawable?: Function, toGpuPlanes?: Function}} [options.testHooks]  시험 전용: 호출 횟수 계측용 대체 함수(운영 코드는 쓰지 않는다)
 */
export function createRenderer(options) {
  if (options === null || typeof options !== 'object') throw new ClientRasterError('context', 'options 가 객체가 아님');
  const { canvas, maxPieceBytes, maxResidentBytes } = options;
  const decode = options.decode ?? decodeChunkClient;
  if (typeof decode !== 'function') throw new ClientRasterError('context', 'decode 는 함수여야 함');
  const now = options.now ?? (() => (globalThis.performance ? globalThis.performance.now() : Date.now()));
  const onEvict = options.onEvict;
  const select = options.testHooks?.selectDrawable ?? selectDrawable;
  const toPlanes = options.testHooks?.toGpuPlanes ?? toGpuPlanes;
  const shading = { ...DEFAULT_SHADING, ...(options.shading ?? {}) };
  // 셰이딩 옵션은 만들 때 한 번 검사한다(PointShaderError 를 'view' 로 바꾼다)
  try {
    pointUniformValues({ ...PROBE_CAMERA, ...shading, maxPointSize: 1 });
  } catch (e) {
    throw new ClientRasterError('view', `shading 옵션이 틀림: ${e.message}`);
  }

  const ctx = createContext({ canvas, attributes: options.contextAttributes });
  const { gl } = ctx;
  // 한도 검사는 버퍼 풀이 한다(양의 정수가 아니면 'memory')
  let pool;
  try {
    pool = createBufferPool({ gl, maxPieceBytes, maxResidentBytes });
  } catch (e) {
    ctx.dispose();
    throw e;
  }
  const meter = createMemoryMeter(); // key → GPU 바이트(풀과 같은 값). 해제 순서(오래된 것부터)도 이 표의 삽입 순서로 정한다
  /** @type {Map<string, {format: number, count: number, origin: number[]}>} */
  const meta = new Map();
  /** @type {Map<string, number>} 올리는 중인 key → 토큰(해제·소실 뒤 늦게 끝난 업로드를 버린다) */
  const inflight = new Map();
  let nextToken = 1;
  let generation = 0; // 문맥 세대. 소실마다 늘어난다
  let lost = false;
  let disposed = false;
  let failure = null; // 복구 중 프로그램 재생성 실패
  let gpu = null; // {program, uniforms, vao, maxPointSize}
  let view = null; // {cam, values}
  let arrived = null; // 마지막 setArrived 입력(없으면 아무것도 그리지 않음)
  let selection = null; // 마지막 selectDrawable 결과(setArrived 가 채운다)
  let arrivedKeys = new Set(); // 마지막 setArrived 의 도착 key 전체(새로 올라온 key 가 재계산을 요하는지 가린다)
  let selectionStale = false; // 도착 집합에 든 key 가 선택 뒤에 올라옴 → 다음 draw 에서 한 번 다시 돈다
  const fresh = new Set(); // 선택 뒤에 올라온 도착 집합 key(다시 돌기 전까지 퇴출에서 보호)
  let droppedFrames = 0;
  let lostKeys = new Set();
  const lostCbs = new Set();
  const restoredCbs = new Set();

  function buildGpu() {
    const { program, uniforms } = createPointProgram(gl);
    const vao = gl.createVertexArray();
    const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
    const maxPointSize = range && range[1] >= 1 ? range[1] : 1;
    return { program, uniforms, vao, maxPointSize };
  }
  try {
    gpu = buildGpu();
  } catch (e) {
    ctx.dispose();
    throw new ClientRasterError('context', `점 프로그램 생성 실패: ${e.message}`);
  }

  function currentSelection() {
    if (arrived === null) return { draw: [], pending: meta.size ? [...meta.keys()] : [], discard: [] };
    if (selectionStale) {
      selection = select([...meta.keys()], arrived);
      selectionStale = false;
      fresh.clear();
    }
    return selection;
  }

  function dropPiece(key) {
    pool.release(key);
    meter.remove(key);
    meta.delete(key);
  }

  function fire(set, ...args) {
    let first = null;
    for (const cb of [...set]) {
      try { cb(...args); } catch (e) { if (first === null) first = e; }
    }
    if (first !== null) throw first;
  }

  ctx.onLost(() => {
    lost = true;
    generation += 1;
    // 소실 당시 상주·업로드 중이던 key 를 복구 목록으로 남긴다(원본 바이트는 보관하지 않는다)
    lostKeys = new Set([...lostKeys, ...meta.keys(), ...inflight.keys()]); // 앞선 복구가 실패해 남은 목록도 잇는다
    inflight.clear();
    pool.clear(); // 소실된 문맥의 deleteBuffer 는 아무것도 하지 않는다. 참조만 버린다
    meter.reset();
    meta.clear();
    gpu = null;
    fresh.clear(); // 선택은 그대로 둔다: 복구 뒤 다시 올라온 key 가 같은 도착 집합으로 바로 그려진다
    fire(lostCbs);
  });
  ctx.onRestored(() => {
    lost = false;
    try {
      pool = createBufferPool({ gl, maxPieceBytes, maxResidentBytes });
      gpu = buildGpu();
      failure = null;
      if (view) view = makeView(view.input);
    } catch (e) {
      failure = new ClientRasterError('context', `복구 중 프로그램 재생성 실패: ${e && e.message ? e.message : String(e)}`);
    }
    // 실패하면 다시 올릴 수 없으므로 key 목록은 비우고(소실 목록은 다음 복구를 위해 남긴다) 둘째 인자로 오류를 알린다.
    // 계약의 콜백 인자는 key 배열 하나이고 둘째 인자 error 는 구현 확장이다. 실패 중 draw 는 건너뛰고 uploadPiece 는 'context' 로 거부한다.
    const keys = failure ? [] : [...lostKeys];
    if (!failure) lostKeys = new Set();
    fire(restoredCbs, keys, failure ?? undefined);
  });

  function assertAlive() {
    if (disposed) throw new ClientRasterError('context', 'dispose 된 렌더러');
  }

  function makeView(input) {
    const cam = buildCameraUniforms(input);
    const values = pointUniformValues({
      R: input.R, t: input.t, K: { fx: cam.fx, fy: cam.fy, cx: cam.cx, cy: cam.cy }, bw: cam.bw, bh: cam.bh,
      ...shading, maxPointSize: gpu ? gpu.maxPointSize : 1,
    });
    return { input, cam, values };
  }

  // 그리지 않는 상주 조각을 오래된 것부터 해제해 need 바이트를 만든다. 모자라면 'memory'.
  function makeRoom(key, bytes) {
    // 한도 여유가 있으면 크기 표·선택을 만들지 않고 돌아간다(F-246 ⑦). key 별 크기는 meta 에 둔다
    const resident = pool.residentBytes() - (meta.get(key)?.bytes ?? 0);
    if (resident + bytes <= maxResidentBytes) return;
    // 선택을 다시 돌지 않는다: 직전 선택의 draw 와, 그 뒤 올라온 도착 집합 key(fresh)를 그리는 조각으로 보호한다
    const drawing = new Set(arrived === null ? [] : selection.draw);
    for (const k of fresh) drawing.add(k);
    const victims = [];
    let free = 0;
    for (const [k, info] of meta) {
      if (resident + bytes - free <= maxResidentBytes) break;
      if (k === key || drawing.has(k)) continue;
      victims.push(k);
      free += info.bytes;
    }
    if (resident + bytes - free > maxResidentBytes) {
      throw new ClientRasterError('memory', `조각 ${bytes} B 를 올리면 상주가 maxResidentBytes ${maxResidentBytes} 를 넘음(그리는 조각은 해제하지 않음)`);
    }
    for (const k of victims) dropPiece(k);
    if (victims.length && typeof onEvict === 'function') {
      // 알림 콜백의 예외가 업로드를 막지 않게 한다(희생 조각은 이미 해제됨)
      try { onEvict(victims); } catch { /* 호출자 콜백 오류는 렌더러 상태와 무관 */ }
    }
  }

  async function uploadPiece(key, bytes) {
    assertAlive();
    const pk = parsePieceKey(key);
    if (!(bytes instanceof Uint8Array)) throw new ClientRasterError('piece', 'bytes 는 Uint8Array 여야 함');
    if (lost) throw new ClientRasterError('context', `문맥 소실 중: ${key} 는 복구 뒤 다시 올려야 함`);
    if (failure) throw new ClientRasterError('context', `복구 실패 상태(${failure.message}): ${key} 를 올릴 수 없음`);
    const token = nextToken++;
    const gen = generation;
    // 같은 key 의 앞선 업로드가 아직 진행 중이면 그 토큰들을 무효로 한다(늦게 끝나도 새 업로드를 덮지 않게)
    if (active.get(key)) superseded.set(key, token - 1);
    active.set(key, (active.get(key) ?? 0) + 1);
    inflight.set(key, token);
    let gpuPiece;
    let stale = false;
    try {
      let decoded;
      try {
        decoded = await decode(bytes);
      } catch (e) {
        if (e instanceof ClientRasterError) throw e;
        throw new ClientRasterError('piece', `복호 실패(${key}): ${e && e.message ? e.message : String(e)}`);
      }
      // Worker 가 origin = bboxMin 으로 만든 gpu 가 있으면 가벼운 검증만 하고 쓴다(toGpuPlanes 를 다시 돌리지 않는다)
      gpuPiece = decoded && typeof decoded === 'object' && decoded.gpu !== undefined
        ? checkGpuPlanes(decoded)
        : toPlanes(decoded, decoded && decoded.header ? decoded.header.bboxMin : undefined);
      for (const f of KEY_FIELDS) {
        if (decoded.header[f] !== pk[f]) throw new ClientRasterError('piece', `헤더 ${f}=${decoded.header[f]} 가 key ${key} 와 다름`);
      }
    } finally {
      if (gen === generation && inflight.get(key) === token) inflight.delete(key);
      // 무효 여부는 기록을 지우기 전에 확정한다
      stale = inflightSuperseded(key, token);
      const n = active.get(key) - 1;
      if (n > 0) active.set(key, n);
      else { active.delete(key); superseded.delete(key); } // 진행 중 업로드가 없으면 기록도 없다
    }
    if (disposed) throw new ClientRasterError('context', 'dispose 된 렌더러');
    if (gen !== generation) throw new ClientRasterError('context', `업로드 중 문맥 소실: ${key} 는 복구 뒤 다시 올려야 함`);
    // 해제됐거나 더 새 업로드가 시작된 key 는 올리지 않는다(늦게 끝난 업로드가 해제를 되살리지 않게)
    if (stale) return;
    let bytesTotal = 0;
    for (const v of Object.values(gpuPiece.planes)) bytesTotal += v.byteLength;
    if (bytesTotal > maxPieceBytes) throw new ClientRasterError('piece', `조각 ${bytesTotal} B 가 maxPieceBytes ${maxPieceBytes} 초과`);
    makeRoom(key, bytesTotal);
    pool.upload(key, gpuPiece); // 풀이 한도를 다시 검사한다
    meter.remove(key); // 삽입 순서를 최신으로
    meter.add(key, bytesTotal);
    meta.delete(key);
    meta.set(key, { format: gpuPiece.format, count: gpuPiece.count, origin: gpuPiece.origin, bytes: bytesTotal });
    // 도착 집합에 없는 새 key 는 직전 선택에서 pending 이라 다시 돌지 않는다. 도착 집합에 든 key 만 다음 draw 에서 1회 다시 돈다
    if (arrived !== null && arrivedKeys.has(key)) {
      selectionStale = true;
      fresh.add(key);
    }
  }

  // 업로드 시작 뒤 releasePiece 나 같은 key 의 새 uploadPiece 가 있었는가
  const superseded = new Map(); // key → 마지막으로 무효화된 토큰 상한(진행 중 업로드가 있는 key 만)
  const active = new Map(); // key → 진행 중 업로드 수
  function inflightSuperseded(key, token) {
    const s = superseded.get(key);
    if (s !== undefined && token <= s) return true;
    return false;
  }

  function releasePiece(key) {
    if (disposed) return;
    if (typeof key !== 'string') throw new ClientRasterError('piece', 'key 는 문자열이어야 함');
    // 진행 중인 업로드(지금까지 시작된 모든 토큰)를 무효로 표시한다
    if (active.get(key)) superseded.set(key, nextToken - 1); // 진행 중일 때만 기록(누수 방지)
    inflight.delete(key);
    lostKeys.delete(key);
    if (meta.has(key)) dropPiece(key); // 선택은 그대로 둔다: draw 가 상주하지 않는 key 를 건너뛴다
    fresh.delete(key);
  }

  function setArrived(list, opts) {
    assertAlive();
    if (opts !== undefined && opts !== null && opts.deferResult === true) {
      // 지연 경로: 반환값이 필요 없는 호출자용. 선택은 다음 draw 에서 프레임당 1회만 돈다(연속 호출은 마지막 입력으로 합쳐진다).
      // 항목 모양(segmentId·level·keys 배열)만 지금 검사하고 key 해석 오류는 draw 에서 ClientRasterError('piece') 로 난다.
      if (!Array.isArray(list)) throw new ClientRasterError('piece', 'arrived 는 배열이어야 함');
      if (list.length === 0) throw new ClientRasterError('piece', 'arrived 는 비지 않은 배열이어야 함');
      for (const a of list) {
        if (!a || !Number.isInteger(a.segmentId) || !Number.isInteger(a.level) || !Array.isArray(a.keys) || a.keys.length === 0) {
          throw new ClientRasterError('piece', `LEVEL_ARRIVED 항목이 틀림: ${JSON.stringify(a)}`);
        }
      }
      arrived = list.map((a) => ({ segmentId: a.segmentId, level: a.level, keys: [...a.keys] }));
      arrivedKeys = new Set();
      for (const a of arrived) for (const k of a.keys) arrivedKeys.add(k);
      if (selection === null) selection = { draw: [], pending: [], discard: [] };
      selectionStale = true;
      fresh.clear(); // 새 도착 집합에 든 상주 key 는 다시 고르기 전까지 그리는 조각으로 보호한다
      for (const k of arrivedKeys) if (meta.has(k)) fresh.add(k);
      return undefined;
    }
    const res = select([...meta.keys()], list); // 입력 검사 겸 결과(도착 이벤트마다 한 번)
    arrived = list.map((a) => ({ segmentId: a.segmentId, level: a.level, keys: [...a.keys] }));
    arrivedKeys = new Set();
    for (const a of arrived) for (const k of a.keys) arrivedKeys.add(k);
    selection = res;
    selectionStale = false;
    fresh.clear();
    return { draw: [...res.draw], pending: [...res.pending], discard: [...res.discard] };
  }

  function setView(v) {
    assertAlive();
    view = makeView(v);
  }

  // 조각별 VAO 캐시: 속성 배선(bindBuffer·vertexAttribPointer)은 만들 때 한 번만 하고 프레임에서는 bindVertexArray 만 부른다
  const pieceVaos = new Map(); // key → {bufs, format, vao}
  let vaoOwner = null; // 이 캐시가 만들어진 gpu(복구 때 gpu 가 바뀌면 옛 문맥의 VAO 는 버린다)

  function deletePieceVao(entry) {
    if (!lost) gl.deleteVertexArray(entry.vao);
  }

  function bindPiece(key, info) {
    const bufs = pool.get(key);
    let e = pieceVaos.get(key);
    if (e && e.bufs === bufs && e.format === info.format) {
      gl.bindVertexArray(e.vao);
      return;
    }
    if (e) deletePieceVao(e); // 같은 key 를 다시 올려 버퍼가 바뀐 경우
    e = { bufs, format: info.format, vao: gl.createVertexArray() };
    pieceVaos.set(key, e);
    gl.bindVertexArray(e.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufs.position);
    gl.enableVertexAttribArray(ATTRIB.position);
    gl.vertexAttribPointer(ATTRIB.position, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufs.color);
    gl.enableVertexAttribArray(ATTRIB.color);
    gl.vertexAttribPointer(ATTRIB.color, 3, gl.UNSIGNED_BYTE, false, 0, 0);
    if (info.format === FORMAT_POINT27) {
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs.normalOct);
      gl.enableVertexAttribArray(ATTRIB.normalOct);
      gl.vertexAttribPointer(ATTRIB.normalOct, 2, gl.BYTE, false, 0, 0);
    } else {
      gl.disableVertexAttribArray(ATTRIB.normalOct);
    }
  }

  function draw() {
    assertAlive();
    const t0 = now();
    if (lost || failure || !gpu || !view || ctx.isLost()) {
      droppedFrames += 1;
      return { drawnPoints: 0, drawnPieces: 0, droppedFrames, drawMs: 0 };
    }
    const { cam, values } = view;
    if (canvas.width !== cam.bw) canvas.width = cam.bw;
    if (canvas.height !== cam.bh) canvas.height = cam.bh;
    gl.viewport(0, 0, cam.bw, cam.bh);
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.useProgram(gpu.program);
    applyPointUniforms(gl, gpu.uniforms, values);
    if (vaoOwner !== gpu) { pieceVaos.clear(); vaoOwner = gpu; }
    if (pieceVaos.size > meta.size) { // 해제된 조각의 VAO 정리(드물게만 돈다)
      for (const [k, e] of pieceVaos) if (!meta.has(k)) { deletePieceVao(e); pieceVaos.delete(k); }
    }
    gl.vertexAttrib2f(ATTRIB.normalOct, 0, 0); // 법선 배열이 꺼진 조각(형식 2)의 상수 법선: 프레임에 한 번
    let drawnPoints = 0;
    let drawnPieces = 0;
    // u_shade 는 프레임 시작(applyPointUniforms)에서 올린 값에서 바뀔 때만 다시 올린다
    const hasShade = gpu.uniforms.u_shade !== null && gpu.uniforms.u_shade !== undefined;
    let shadeNow = values.u_shade ? 1 : 0;
    for (const key of currentSelection().draw) {
      const info = meta.get(key);
      if (!info) continue;
      bindPiece(key, info);
      applyPieceOrigin(gl, gpu.uniforms, values, info.origin); // 조각 원점 기준 u_tgl(f64 계산)
      const shade = info.format === FORMAT_POINT27 && values.u_shade ? 1 : 0;
      if (hasShade && shade !== shadeNow) { gl.uniform1i(gpu.uniforms.u_shade, shade); shadeNow = shade; }
      gl.drawArrays(gl.POINTS, 0, info.count);
      drawnPoints += info.count;
      drawnPieces += 1;
    }
    gl.bindVertexArray(null);
    return { drawnPoints, drawnPieces, droppedFrames, drawMs: Math.max(0, now() - t0) };
  }

  function memoryBytes() {
    return disposed ? 0 : pool.residentBytes();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    inflight.clear();
    if (!lost) {
      pool.clear();
      if (gpu) {
        for (const e of pieceVaos.values()) gl.deleteVertexArray(e.vao);
        gl.deleteVertexArray(gpu.vao);
        gl.deleteProgram(gpu.program);
      }
    }
    gpu = null;
    pieceVaos.clear();
    meta.clear();
    meter.reset();
    lostKeys = new Set();
    lostCbs.clear();
    restoredCbs.clear();
    ctx.dispose();
  }

  function subscribe(set, cb) {
    if (cb === undefined) return () => {};
    if (typeof cb !== 'function') throw new ClientRasterError('context', '콜백이 함수가 아님');
    if (disposed) return () => {};
    set.add(cb);
    return () => { set.delete(cb); };
  }

  return {
    uploadPiece,
    releasePiece,
    setView,
    draw,
    memoryBytes,
    dispose,
    /** 소실 알림. 콜백은 인자 없이 불린다. 구독 해제 함수를 돌려준다(계약 typedef 와 API 표 모두 구독 해제 함수 반환). */
    onContextLost: (cb) => subscribe(lostCbs, cb),
    /** 복구 알림. 콜백 인자는 다시 올려야 할 key 배열(소실 당시 상주·업로드 중이던 것 중 그 뒤 해제되지 않은 것).
     *  프로그램 재생성이 실패하면 key 배열은 비고 둘째 인자로 ClientRasterError('context')를 준다(구현 확장). */
    onContextRestored: (cb) => subscribe(restoredCbs, cb),
    // ---- 계약 Renderer 에 올라 있는 도착·관측 메서드(결정 0034) ----
    setArrived,
    residentKeys: () => [...meta.keys()],
    isContextLost: () => lost,
    // ---- 계약 밖 시험 전용 확장(운영 코드는 부르지 않는다. 이름은 api.test 의 허용 목록이 참조하므로 바꾸지 않는다) ----
    /** 시험 전용: 업로드 장부 크기(관측용). 진행 중 업로드가 있는 key 수와 무효 기록 수 */
    uploadBookkeeping: () => ({ active: active.size, superseded: superseded.size }),
  };
}
