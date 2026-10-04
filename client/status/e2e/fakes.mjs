// 통합 시험용 가짜 모듈(T13.8). contracts/statusview STATUSVIEW_API 의 rule 문장을 최소로 따른다.
// 실제 모듈(client/status/<모듈>)이 합쳐지기 전에 createStatusView 를 시험하려고 둔다. 화면 코드는 이 파일을 쓰지 않는다.
import { createLevelMachine } from '../../levels/index.mjs';
import { MISSING_LABEL } from '../../levels/missing/index.mjs';
import { MAX_REQUEST_ITEMS, pieceKeyString } from '../../../contracts/proto/index.mjs';
import { NONE, sumPieceCounts } from '../../../contracts/levels/index.mjs';
import { assertViewport } from '../../../contracts/statusview/index.mjs';

/** arrival: 도착 순서대로 쌓고 같은 PieceKey 는 한 번만, drain 이 PIECE_REQUEST 로 나눈다. */
export const arrival = {
  createArrivalPlanner(options = {}) {
    const maxItems = options.maxItems === undefined ? MAX_REQUEST_ITEMS : options.maxItems;
    if (!Number.isInteger(maxItems) || maxItems < 1) throw new RangeError('maxItems 는 1 이상 정수');
    const per = Math.min(maxItems, MAX_REQUEST_ITEMS);
    const asked = new Set();
    let queue = [];
    let reqId = 0;
    return {
      onSegmentArrived(segmentId, keys) {
        if (!Number.isInteger(segmentId) || segmentId < 0) throw new RangeError('segmentId');
        if (!Array.isArray(keys)) throw new TypeError('keys 는 배열');
        const add = [];
        const local = new Set();
        for (const k of keys) {
          const s = pieceKeyString(k);
          if (asked.has(s) || local.has(s)) continue;
          local.add(s);
          add.push({ ...k });
        }
        for (const s of local) asked.add(s);
        queue = queue.concat(add);
      },
      drain() {
        const out = [];
        for (let i = 0; i < queue.length; i += per) out.push({ type: 'PIECE_REQUEST', reqId: reqId++, items: queue.slice(i, i + per) });
        queue = [];
        return out;
      },
      pendingCount() {
        return queue.length;
      },
    };
  },
};

/** levels: createLevelMachine 위에 얹는다. released() 는 누적 목록. */
export const levels = {
  createStatusLevels() {
    const machine = createLevelMachine();
    const releasedAll = [];
    return {
      arrive(segmentId, level, pieces) {
        const r = machine.arrive(segmentId, level, pieces);
        for (const p of r.released) releasedAll.push(p.key);
        return r;
      },
      expect: (segmentId) => machine.expect(segmentId),
      snapshots: () => machine.segments().map((id) => machine.snapshot(id)),
      drawKeys: () => machine.segments().flatMap((id) => machine.snapshot(id).pieces.map((p) => p.key)),
      renderPointCount: () => machine.segments().reduce((a, id) => a + machine.pointCount(id), 0),
      released: () => releasedAll.slice(),
    };
  },
};

/** reveal: 도착한 구간만 visible. */
export const reveal = {
  computeReveal(states) {
    if (!Array.isArray(states)) throw new TypeError('states 는 배열');
    const visible = [];
    const hidden = [];
    let renderPointCount = 0;
    for (const s of states) {
      if (s.level >= 0) {
        visible.push(s.segmentId);
        renderPointCount += sumPieceCounts(s.pieces);
      } else hidden.push(s.segmentId);
    }
    return { visible, hidden, renderPointCount };
  },
};

function quatToMatrix([x, y, z, w]) {
  // 카메라→ENU 회전(행 우선)
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

/** camera: R = (카메라→ENU)ᵀ, t = −R·pos, fy = (h/2)/tan(fovY/2), fx = fy. */
export const camera = {
  syncCamera(pose, size, viewSeq) {
    assertViewport(size);
    if (pose === null || typeof pose !== 'object') throw new TypeError('pose');
    const { pos, quat, fovY } = pose;
    if (!Array.isArray(pos) || pos.length !== 3 || pos.some((v) => !Number.isFinite(v))) throw new TypeError('pos');
    if (!Array.isArray(quat) || quat.length !== 4 || quat.some((v) => !Number.isFinite(v))) throw new TypeError('quat');
    if (!(fovY > 0 && fovY < Math.PI)) throw new RangeError('fovY');
    const n = Math.hypot(...quat);
    if (!(n > 0)) throw new RangeError('quat 노름 0');
    const q = quat.map((v) => v / n);
    const C = quatToMatrix(q);
    const R = [C[0], C[3], C[6], C[1], C[4], C[7], C[2], C[5], C[8]];
    const t = [0, 1, 2].map((i) => -(R[3 * i] * pos[0] + R[3 * i + 1] * pos[1] + R[3 * i + 2] * pos[2]));
    const fy = size.height / 2 / Math.tan(fovY / 2);
    const view = { R, t, K: { fx: fy, fy, cx: size.width / 2, cy: size.height / 2 }, width: size.width, height: size.height, devicePixelRatio: size.devicePixelRatio };
    return { view, viewUpdate: { type: 'VIEW_UPDATE', viewSeq, pos: pos.slice(), quat: q, fovY, width: size.width, height: size.height } };
  },
};

/** overlay: u = fx·X_c.x/d + cx, depth ≤ 0 이면 visible=false. */
export const overlay = {
  projectMarkers(view, markers) {
    const { R, t, K, width, height } = view;
    return markers.map(({ id, enu }) => {
      const xc = [0, 1, 2].map((i) => R[3 * i] * enu[0] + R[3 * i + 1] * enu[1] + R[3 * i + 2] * enu[2] + t[i]);
      const d = xc[2];
      if (!(d > 0)) return { id, u: NaN, v: NaN, depth: d, visible: false };
      const u = K.fx * xc[0] / d + K.cx;
      const v = K.fy * xc[1] / d + K.cy;
      return { id, u, v, depth: d, visible: u >= 0 && u <= width && v >= 0 && v <= height };
    });
  },
};

/** missing_ui: 도착 전 구간만 '없음'. */
export const missing_ui = {
  missingNotices(states) {
    return states.filter((s) => s.level === NONE).map((s) => ({ segmentId: s.segmentId, text: MISSING_LABEL }));
  },
};

/** fallback: error code 5·closed(1000 제외)·timeout → fallback, connected → live. */
export const fallback = {
  createFallbackController() {
    let st = { mode: 'live', reason: null, message: null };
    return {
      handle(event) {
        if (event === null || typeof event !== 'object') throw new TypeError('event');
        if (event.kind === 'connected') st = { mode: 'live', reason: null, message: null };
        else if (event.kind === 'error') {
          if (event.code === 5) st = { mode: 'fallback', reason: 'unavailable', message: '서버를 쓸 수 없다' };
        } else if (event.kind === 'closed') {
          if (event.code !== 1000) st = { mode: 'fallback', reason: 'closed', message: '연결이 끊겼다' };
        } else if (event.kind === 'timeout') st = { mode: 'fallback', reason: 'timeout', message: '응답이 없다' };
        else throw new TypeError(`event.kind: ${String(event.kind)}`);
        return { ...st };
      },
      state: () => ({ ...st }),
    };
  },
};

/** 일곱 가짜 모듈 묶음(createStatusView options.modules). */
export const FAKE_MODULES = Object.freeze({ arrival, levels, reveal, camera, overlay, missing_ui, fallback });
