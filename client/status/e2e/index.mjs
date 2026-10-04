// 현황판 화면 어댑터 본체(T13.8). 계약: contracts/statusview/index.mjs STATUSVIEW_API.createStatusView
// 선 메시지(client/proto decodeMessage 의 s2c 출력)를 받아 일곱 모듈(arrival·levels·reveal·camera·overlay·missing_ui·fallback)을
// 엮는다. 모듈은 options.modules 로 반드시 넘긴다(없으면 TypeError). 기본 조립은 loadDefaultModules() 가 동적 import 로
// ../<모듈>/index.mjs 를 읽어 돌려준다(파일 맨 위 정적 import 를 두지 않아 모듈이 없어도 이 파일은 읽힌다).
//
// 조각·창 규칙은 contracts/client_raster/arrival.mjs 와 같다:
//   ① 같은 pieceSeq·같은 key 는 한 조각(재전송), 같은 pieceSeq 다른 key 는 거부. 처음 보는 pieceSeq 는 그때까지의 가장 큰
//      pieceSeq 보다 커야 한다(순번은 늘기만 한다).
//   ② LEVEL_ARRIVED 의 창은 pieceSeq firstPieceSeq..firstPieceSeq+pieceCount−1. 창의 조각을 모두 받았고, 모두 그 (구간, 수준)
//      이고, key 가 서로 달라야 한다.
//   ⓪ WELCOME resumed=false 는 새 세션이라 pieceSeq 가 1 부터 다시 시작한다. 받은 조각 색인·수준 상태·요청 계획을 모두 새로
//      만든다(server/ws/session/contract.mjs 클라이언트 규약: 새 세션 도착분이 (구간, 수준) 키로 교체하고, 새 세션이 도착시키지
//      않은 칸은 비운다. 이전 세션 데이터로 채우거나 보간하지 않는다). 앞 세션에서 알던 구간은 도착 전(hidden·'없음')으로 남고,
//      앞 세션이 그리던 key 는 모두 다음 frame().releasedKeys 로 나가 호출자가 해제한다. resumed=true 는 같은 세션의 이어받기라
//      색인·수준 상태·요청 계획을 그대로 잇는다(앞 sessionId 와 다르면 거부).
//   ③ 해제: levels 의 해제 누적은 교체가 받아들여질 때마다 levels.released() 로 비워 frame() 의 releasedKeys 로 한 번씩 낸다.
//      해제된 key 의 pieceSeq 색인은 그때 지운다. releasedKeys 는 같은 frame 의 drawKeys 와 겹치지 않는다(새 세션이 같은 key 를
//      다시 도착시켰으면 해제하지 않는다).
//   ④ 요청: 조각 요청(requests())은 아직 받지 않은 PieceKey 만 낸다. 입력은 호출자가 넘기는 자산 색인 options.pieceIndex 이고,
//      MISSING(구간) 을 받았을 때 그 구간이 아직 도착 전이면 색인의 key 중 이 세션에서 받지 않은 것을 planner 에 넣는다.
//      pieceIndex 가 없으면 요청은 없다(이미 받은 조각을 다시 요청하지 않는다).
// 위반은 모두 TypeError/RangeError 이고 던질 때 상태는 바뀌지 않는다(검사를 모두 끝낸 뒤에 바꾼다).
// 원칙: 도착한 것만 그린다. 그림 목록은 levels.drawKeys 뿐이고, 도착 전 구간은 reveal.hidden·notices 로만 나타난다.
import { pieceKeyToString } from '../../../contracts/client_raster/arrival.mjs';
import { STATUS_INPUT_MESSAGES } from '../../../contracts/statusview/index.mjs';

const U32_MAX = 0xffffffff;
const LEVEL_MAX = 3;

/** 주입해야 하는 모듈과 각 모듈에서 쓰는 함수 이름. */
export const STATUS_MODULE_FUNCTIONS = Object.freeze({
  arrival: Object.freeze(['createArrivalPlanner']),
  levels: Object.freeze(['createStatusLevels']),
  reveal: Object.freeze(['computeReveal']),
  camera: Object.freeze(['syncCamera']),
  overlay: Object.freeze(['projectMarkers']),
  missing_ui: Object.freeze(['missingNotices']),
  fallback: Object.freeze(['createFallbackController']),
});

/** 기본 조립: ../<모듈>/index.mjs 를 동적 import 해 {arrival, levels, ...} 로 돌려준다. */
export async function loadDefaultModules() {
  const names = Object.keys(STATUS_MODULE_FUNCTIONS);
  const loaded = await Promise.all(names.map((n) => import(new URL(`../${n}/index.mjs`, import.meta.url).href)));
  return Object.fromEntries(names.map((n, i) => [n, loaded[i]]));
}

function isObject(v) {
  return v !== null && typeof v === 'object';
}

function checkModules(modules) {
  if (!isObject(modules)) throw new TypeError('options.modules 는 일곱 모듈 객체여야 한다(기본 조립은 loadDefaultModules())');
  for (const [name, fns] of Object.entries(STATUS_MODULE_FUNCTIONS)) {
    const m = modules[name];
    if (!isObject(m) && typeof m !== 'function') throw new TypeError(`modules.${name} 가 없다`);
    for (const fn of fns) {
      if (typeof m[fn] !== 'function') throw new TypeError(`modules.${name}.${fn} 가 함수가 아니다`);
    }
  }
}

function u32(v, name, min) {
  if (!Number.isInteger(v)) throw new TypeError(`${name} 는 정수여야 한다: ${String(v)}`);
  if (v < min || v > U32_MAX) throw new RangeError(`${name} 범위 밖: ${v}`);
  return v;
}

/** PieceKey 객체 → §11 정규 문자열. contracts/client_raster 의 ClientRasterError 는 TypeError 로 바꾼다. */
function keyString(key) {
  try {
    return pieceKeyToString(key);
  } catch (e) {
    if (e instanceof TypeError || e instanceof RangeError) throw e;
    throw new TypeError(`PIECE key 가 틀림: ${e.message}`);
  }
}

function copyKey(k) {
  return { segmentId: k.segmentId, level: k.level, lod: k.lod, chunkIndex: k.chunkIndex, tileX: k.tileX, tileY: k.tileY };
}

/**
 * @param {{modules: object, countOf?: (pieceBytes: Uint8Array) => number, pieceIndex?: (segmentId: number) => object[]}} options
 */
export function createStatusView(options) {
  if (!isObject(options)) throw new TypeError('options 는 객체여야 한다({modules, countOf})');
  const { modules, countOf, pieceIndex } = options;
  checkModules(modules);
  if (countOf !== undefined && typeof countOf !== 'function') throw new TypeError('countOf 는 함수여야 한다');
  if (pieceIndex !== undefined && typeof pieceIndex !== 'function') throw new TypeError('pieceIndex 는 함수여야 한다');

  let planner = modules.arrival.createArrivalPlanner();
  let levels = modules.levels.createStatusLevels();
  const fallback = modules.fallback.createFallbackController();

  // 받은 조각 색인(한 세션): pieceSeq -> {key, pieceKey, segmentId, level, count}
  let bySeq = new Map();
  let seqsByKey = new Map(); // key -> 그 key 를 가진 pieceSeq 목록(해제 때 bySeq 항목을 지우려고)
  let maxSeq = 0;
  let sessionId; // 앞서 본 WELCOME 의 sessionId
  let pendingReleased = []; // frame() 이 아직 내주지 않은 해제 key
  let view = null;
  let markers = [];
  let viewSeq = 0;

  function onWelcome(m) {
    u32(m.sessionId, 'WELCOME sessionId', 1);
    if (typeof m.resumed !== 'boolean') throw new TypeError(`WELCOME resumed 는 boolean 이어야 한다: ${String(m.resumed)}`);
    if (m.resumed) {
      if (sessionId === undefined) throw new TypeError('WELCOME resumed=true 인데 앞 세션이 없다');
      if (m.sessionId !== sessionId) throw new TypeError(`WELCOME resumed=true 의 sessionId ${m.sessionId} 가 앞 세션 ${sessionId} 와 다르다`);
    }
    if (!m.resumed) {
      // 새 세션: 앞 세션의 그림은 모두 해제하고, 알던 구간은 도착 전 칸으로 비운다.
      const known = levels.snapshots().map((s) => s.segmentId);
      const out = pendingReleased.concat(levels.released(), levels.drawKeys());
      const nextLevels = modules.levels.createStatusLevels();
      for (const id of known) nextLevels.expect(id);
      const nextPlanner = modules.arrival.createArrivalPlanner();
      levels = nextLevels;
      planner = nextPlanner;
      pendingReleased = out;
      bySeq = new Map();
      seqsByKey = new Map();
      maxSeq = 0;
    }
    fallback.handle({ kind: 'connected' });
    sessionId = m.sessionId;
  }

  function onPiece(m) {
    const seq = u32(m.pieceSeq, 'pieceSeq', 1);
    if (!isObject(m.key)) throw new TypeError('PIECE key 는 PieceKey 객체여야 한다');
    const key = keyString(m.key);
    if (!(m.chunk instanceof Uint8Array)) throw new TypeError('PIECE chunk 는 Uint8Array 여야 한다');
    const prev = bySeq.get(seq);
    if (prev !== undefined) {
      if (prev.key !== key) throw new TypeError(`pieceSeq ${seq} 가 두 key 에 쓰였다: ${prev.key}, ${key}`);
      return; // 재전송: 한 조각
    }
    if (seq <= maxSeq) throw new RangeError(`pieceSeq ${seq} 가 재전송이 아닌데 받은 가장 큰 pieceSeq ${maxSeq} 이하`);
    if (typeof countOf !== 'function') throw new TypeError('PIECE 의 점 수를 셀 countOf 가 주입되지 않았다');
    const count = countOf(m.chunk);
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError(`countOf 결과는 0 이상 안전 정수여야 한다: ${String(count)}`);
    bySeq.set(seq, { key, pieceKey: copyKey(m.key), segmentId: m.key.segmentId, level: m.key.level, count: count === 0 ? 0 : count });
    const seqs = seqsByKey.get(key);
    if (seqs === undefined) seqsByKey.set(key, [seq]);
    else seqs.push(seq);
    maxSeq = seq;
  }

  function windowPieces(m) {
    const { segmentId, level } = m;
    if (!Number.isInteger(segmentId) || Object.is(segmentId, -0) || segmentId < 0) throw new TypeError(`LEVEL_ARRIVED segmentId 가 틀림: ${String(segmentId)}`);
    if (!Number.isInteger(level) || level < 0 || level > LEVEL_MAX) throw new TypeError(`LEVEL_ARRIVED level 이 틀림: ${String(level)}`);
    const n = u32(m.pieceCount, 'pieceCount', 1);
    const first = u32(m.firstPieceSeq, 'firstPieceSeq', 1);
    if (first + n - 1 > U32_MAX) throw new RangeError(`창 끝이 u32 밖: ${first}+${n}-1`);
    const out = [];
    const seen = new Set();
    for (let s = first; s < first + n; s += 1) {
      const p = bySeq.get(s);
      if (p === undefined) throw new TypeError(`LEVEL_ARRIVED(${segmentId}, ${level}) 창 ${first}..${first + n - 1} 의 pieceSeq ${s} 조각을 받지 못했다`);
      if (p.segmentId !== segmentId || p.level !== level) throw new TypeError(`LEVEL_ARRIVED(${segmentId}, ${level}) 창에 다른 구간·수준 조각: ${p.key}`);
      if (seen.has(p.key)) throw new TypeError(`LEVEL_ARRIVED(${segmentId}, ${level}) 창에 같은 key 가 두 번: ${p.key}`);
      seen.add(p.key);
      out.push(p);
    }
    return out;
  }

  function onLevelArrived(m) {
    const win = windowPieces(m);
    levels.arrive(m.segmentId, m.level, win.map((p) => ({ key: p.key, count: p.count })));
    // 해제는 levels.released() 한 곳에서 받는다(skip 이면 빈 목록). 받은 즉시 비워 levels 쪽에 쌓이지 않게 한다.
    // 받은 창의 key 는 이미 받은 조각이라 요청 계획에 넣지 않는다.
    for (const key of levels.released()) {
      pendingReleased.push(key);
      const seqs = seqsByKey.get(key);
      if (seqs === undefined) continue;
      for (const s of seqs) bySeq.delete(s);
      seqsByKey.delete(key);
    }
  }

  /** MISSING 구간의 아직 받지 않은 PieceKey(호출자 자산 색인 기준). 구간이 이미 도착했으면 없다. */
  function missingRequestKeys(segmentId) {
    if (pieceIndex === undefined) return [];
    if (levels.snapshots().some((s) => s.segmentId === segmentId && s.level >= 0)) return [];
    const list = pieceIndex(segmentId);
    if (!Array.isArray(list)) throw new TypeError('pieceIndex 결과는 PieceKey 배열이어야 한다');
    const out = [];
    for (const k of list) {
      if (!isObject(k)) throw new TypeError('pieceIndex 결과는 PieceKey 배열이어야 한다');
      if (k.segmentId !== segmentId) throw new TypeError(`pieceIndex(${segmentId}) 에 다른 구간 key: ${String(k.segmentId)}`);
      if (!seqsByKey.has(keyString(k))) out.push(copyKey(k));
    }
    return out;
  }

  function onMissing(m) {
    const { segmentId } = m;
    if (!Number.isInteger(segmentId) || Object.is(segmentId, -0) || segmentId < 0) throw new TypeError(`MISSING segmentId 가 틀림: ${String(segmentId)}`);
    const ask = missingRequestKeys(segmentId);
    if (ask.length > 0) planner.onSegmentArrived(segmentId, ask); // 검사 위반은 여기서 던지고 상태는 그대로
    levels.expect(segmentId);
  }

  function onError(m) {
    u32(m.code, 'ERROR code', 0);
    fallback.handle({ kind: 'error', code: m.code });
  }

  function handle(message) {
    if (!isObject(message) || typeof message.type !== 'string') throw new TypeError('message 는 type 을 가진 객체여야 한다');
    if (!STATUS_INPUT_MESSAGES.includes(message.type)) throw new TypeError(`받지 않는 메시지 종류: ${message.type}`);
    switch (message.type) {
      case 'WELCOME': return void onWelcome(message);
      case 'PIECE': return void onPiece(message);
      case 'LEVEL_ARRIVED': return void onLevelArrived(message);
      case 'MISSING': return void onMissing(message);
      case 'ERROR': return void onError(message);
      default: throw new TypeError(`받지 않는 메시지 종류: ${message.type}`);
    }
  }

  function setCamera(pose, size) {
    const out = modules.camera.syncCamera(pose, size, viewSeq);
    view = out.view;
    viewSeq = viewSeq === U32_MAX ? 0 : viewSeq + 1;
    return out;
  }

  function setMarkers(list) {
    if (!Array.isArray(list)) throw new TypeError('markers 는 배열이어야 한다');
    for (const mk of list) {
      if (!isObject(mk) || typeof mk.id !== 'string' || !Array.isArray(mk.enu) || mk.enu.length !== 3
        || mk.enu.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
        throw new TypeError('marker 는 {id: string, enu: 유한 수 3개} 여야 한다');
      }
    }
    markers = list.map((mk) => ({ id: mk.id, enu: mk.enu.slice() }));
  }

  function frame() {
    const states = levels.snapshots();
    const drawKeys = levels.drawKeys();
    const drawn = new Set(drawKeys);
    const out = {
      view,
      drawKeys,
      releasedKeys: pendingReleased.filter((k) => !drawn.has(k)),
      markers: view === null ? [] : modules.overlay.projectMarkers(view, markers),
      notices: modules.missing_ui.missingNotices(states),
      reveal: modules.reveal.computeReveal(states),
      fallback: fallback.state(),
    };
    pendingReleased = []; // 다 만든 뒤에 비운다(모듈이 던지면 다음 frame 이 다시 내준다)
    return out;
  }

  function requests() {
    return planner.drain();
  }

  return { handle, setCamera, setMarkers, frame, requests };
}
