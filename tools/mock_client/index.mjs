// 시험용 모의 클라이언트. 추상 Transport 와 루프백 쌍, createMockClient, replayPath 를 내보낸다.
//
// quat 규약(계약 contracts/proto·contracts/raster): VIEW_UPDATE 의 quat(x,y,z,w) 는 카메라→월드(ENU) 회전이다.
//   카메라 축은 OpenCV 규약(x 오른쪽, y 아래, +z 앞)이고 월드 축은 x=동, y=북, z=위다. 앞 방향 = quat·(0,0,1).
//   그래서 기본값 [0,0,0,1](항등)은 "카메라 축 = ENU 축", 즉 앞(+z)이 하늘(+u)을 향하고 오른쪽은 동, 아래는 북이다.
//   항등이 "정면 수평 시선" 이 아님에 주의한다. 역회전(켤레) quat 이면 같은 자세가 아니라 다른 방향을 본다.

/**
 * 추상 전송층(주입).
 * @typedef {Object} Transport
 * @property {(bytes: Uint8Array) => void} send 바이트 전송
 * @property {(callback: (bytes: Uint8Array) => void) => void} onMessage 도착한 메시지 리스너 등록(최대 1개)
 * @property {(callback: () => void) => void} onClose 연결 종료 리스너 등록(최대 1개)
 * @property {() => void} close 연결 종료
 */

/**
 * 루프백 쌍(메모리 내 양방향 전송).
 * @typedef {Object} LoopbackPair
 * @property {Transport} a 첫 번째 끝
 * @property {Transport} b 두 번째 끝
 */

/**
 * 메모리 내 양방향 전송 쌍을 만든다.
 * @returns {LoopbackPair}
 */
export function createLoopbackPair() {
  let aClosed = false;
  let bClosed = false;
  // a 가 받을 메시지를 처리하는 리스너
  let aReceiveListener = null;
  // b 가 받을 메시지를 처리하는 리스너
  let bReceiveListener = null;
  let aCloseListener = null;
  let bCloseListener = null;

  const a = {
    send(bytes) {
      if (aClosed) throw new Error('Transport a is closed');
      // 복사본으로 b 에 전달
      const copy = new Uint8Array(bytes);
      if (bReceiveListener) {
        queueMicrotask(() => bReceiveListener(copy));
      }
    },
    onMessage(callback) {
      aReceiveListener = callback;
    },
    onClose(callback) {
      aCloseListener = callback;
    },
    close() {
      if (aClosed) return;
      aClosed = true;
      if (aCloseListener) {
        queueMicrotask(() => aCloseListener());
      }
    },
  };

  const b = {
    send(bytes) {
      if (bClosed) throw new Error('Transport b is closed');
      // 복사본으로 a 에 전달
      const copy = new Uint8Array(bytes);
      if (aReceiveListener) {
        queueMicrotask(() => aReceiveListener(copy));
      }
    },
    onMessage(callback) {
      bReceiveListener = callback;
    },
    onClose(callback) {
      bCloseListener = callback;
    },
    close() {
      if (bClosed) return;
      bClosed = true;
      if (bCloseListener) {
        queueMicrotask(() => bCloseListener());
      }
    },
  };

  return { a, b };
}

/**
 * 모의 클라이언트 만들기.
 * @param {Object} options
 * @param {Transport} options.transport 추상 전송
 * @param {Object} options.codec 메시지 부호화·복호기
 * @param {(bytes: Uint8Array) => Uint8Array} options.codec.encodeMessage 메시지 → 바이트
 * @param {(bytes: Uint8Array) => Object} options.codec.decodeMessage 바이트 → 메시지
 * @param {() => number} options.now 현재 시각 ms(주입된 시계, 실제 sleep 없이)
 * @returns {Object} 모의 클라이언트
 */
export function createMockClient({ transport, codec, now }) {
  if (!transport) throw new Error('transport is required');
  if (!codec || !codec.encodeMessage || !codec.decodeMessage) {
    throw new Error('codec with encodeMessage and decodeMessage is required');
  }
  if (typeof now !== 'function') throw new Error('now function is required');

  const received = [];
  let closed = false;

  // 원격 메시지 수신 대기
  transport.onMessage((bytes) => {
    const message = codec.decodeMessage(bytes);
    received.push(message);
  });

  transport.onClose(() => {
    closed = true;
  });

  return {
    /**
     * HELLO 메시지 전송.
     * @param {number} sessionId
     * @param {number} lastPieceSeq
     */
    hello(sessionId = 0, lastPieceSeq = 0) {
      const message = { type: 'HELLO', sessionId, lastPieceSeq };
      const bytes = codec.encodeMessage(message);
      transport.send(bytes);
    },

    /**
     * VIEW_UPDATE 메시지 전송.
     * @param {Object} pose
     * @param {number} pose.viewSeq
     * @param {number[]} pose.pos [e, n, u]
     * @param {number[]} pose.quat [x, y, z, w]
     * @param {number} pose.fovY
     * @param {number} pose.width
     * @param {number} pose.height
     */
    sendView(pose) {
      const message = {
        type: 'VIEW_UPDATE',
        viewSeq: pose.viewSeq,
        pos: pose.pos,
        quat: pose.quat,
        fovY: pose.fovY,
        width: pose.width,
        height: pose.height,
      };
      const bytes = codec.encodeMessage(message);
      transport.send(bytes);
    },

    /**
     * PIECE_REQUEST 메시지 전송.
     * @param {Object} options
     * @param {number} options.reqId
     * @param {Array<Object>} options.items PieceKey 배열
     */
    requestPieces(options) {
      const message = {
        type: 'PIECE_REQUEST',
        reqId: options.reqId,
        items: options.items,
      };
      const bytes = codec.encodeMessage(message);
      transport.send(bytes);
    },

    /**
     * ACK 메시지 전송.
     * @param {number} upToPieceSeq
     */
    ack(upToPieceSeq) {
      const message = {
        type: 'ACK',
        upToPieceSeq,
      };
      const bytes = codec.encodeMessage(message);
      transport.send(bytes);
    },

    /** 받은 메시지 배열(누적). */
    received,

    /**
     * 경로 스크립트 재생.
     * @param {Array<Object>} script 동작 배열 [{atMs, action: 'view'|'request'|'ack', ...}]
     * @returns {Promise<void>}
     */
    async run(script) {
      if (!Array.isArray(script)) throw new Error('script must be an array');

      // 상태: 마지막으로 실행한 스크립트 인덱스
      if (!this._scriptIndex) {
        this._scriptIndex = 0;
      }

      // 스크립트의 동작들을 now() 기반으로 시뮬레이션(실제 sleep 없이)
      while (this._scriptIndex < script.length && !closed) {
        const action = script[this._scriptIndex];
        const currentTime = now();

        // atMs 에 도달했으면 실행
        if (action.atMs <= currentTime) {
          switch (action.action) {
            case 'view':
              this.sendView({
                viewSeq: action.viewSeq ?? 0,
                pos: action.pos ?? [0, 0, 0],
                quat: action.quat ?? [0, 0, 0, 1],
                fovY: action.fovY ?? 1.5,
                width: action.width ?? 1024,
                height: action.height ?? 768,
              });
              break;
            case 'request':
              this.requestPieces({
                reqId: action.reqId ?? 0,
                items: action.items ?? [],
              });
              break;
            case 'ack':
              this.ack(action.upToPieceSeq ?? 0);
              break;
            default:
              throw new Error(`unknown action: ${action.action}`);
          }
          this._scriptIndex++;
        } else {
          // 다음 동작 시간까지 기다림(실제로는 now() 가 진행해야 함)
          // 이곳은 yield/await 가 아니라 단순히 루프를 빠져나감
          // 호출자가 now() 를 진행시켜야 함
          break;
        }
      }
    },
  };
}

// ---- 경로 재생 ----

/** 경로에 시야각 정보가 없을 때 쓰는 기본값. */
const REPLAY_DEFAULTS = Object.freeze({ fovY: 1.0, width: 1024, height: 768, firstViewSeq: 1 });

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : null;
};
// fixtures/paths 의 GL 규약(x=동, y=위, z=-북) 벡터 → ENU(e, n, u)
const glToEnu = (v) => [v[0], -v[2], v[1]];

/**
 * 회전 행렬(열 벡터 c0,c1,c2 = 카메라 x,y,z 축의 월드 방향) → 단위 quat(x,y,z,w), w >= 0.
 * @param {number[]} c0
 * @param {number[]} c1
 * @param {number[]} c2
 * @returns {number[]}
 */
function quatFromColumns(c0, c1, c2) {
  const m00 = c0[0], m10 = c0[1], m20 = c0[2];
  const m01 = c1[0], m11 = c1[1], m21 = c1[2];
  const m02 = c2[0], m12 = c2[1], m22 = c2[2];
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4;
  }
  const n = Math.hypot(x, y, z, w);
  const sign = w < 0 ? -1 : 1;
  return [x, y, z, w].map((v) => (v / n) * sign);
}

/**
 * 경로 한 시점(GL 규약 eye/target/up) → VIEW_UPDATE 의 pos·quat(카메라→ENU, OpenCV 축).
 * 앞 = target-eye, 오른쪽 = 앞×위, 아래 = 앞×오른쪽. 앞이 위 벡터와 나란하면 ENU 북쪽을 위로 대신 쓴다.
 * @param {{eye:number[], target:number[], up?:number[]}} frame
 * @returns {{pos:number[], quat:number[]}}
 */
export function poseFromLookAt(frame) {
  const eye = glToEnu(frame.eye);
  const fwd = unit(sub(glToEnu(frame.target), eye));
  if (!fwd) throw new Error('replayPath: eye 와 target 이 같아 시선 방향이 없다');
  let right = unit(cross(fwd, glToEnu(frame.up ?? [0, 1, 0])));
  if (!right) right = unit(cross(fwd, [0, 1, 0]));
  if (!right) right = unit(cross(fwd, [1, 0, 0]));
  const down = cross(fwd, right);
  return { pos: eye, quat: quatFromColumns(right, down, fwd) };
}

/**
 * 카메라 경로(fixtures/paths 형식 {fps, frames:[{t, eye, target, up}]})를 시점마다 VIEW_UPDATE 한 개로 보낸다.
 * viewSeq 는 firstViewSeq 부터 1씩 늘어난다. 실제 sleep 은 하지 않는다(시각은 호출자 몫).
 * @param {{fps?:number, frames:Array<Object>}} path
 * @param {{encodeMessage:(m:Object)=>Uint8Array}} codec
 * @param {Object} options
 * @param {Transport} options.transport 보낼 전송
 * @param {number} [options.fovY] 수직 시야각 rad
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {number} [options.firstViewSeq]
 * @returns {number} 보낸 VIEW_UPDATE 수(= path.frames.length)
 */
export function replayPath(path, codec, options = {}) {
  if (!path || !Array.isArray(path.frames)) throw new Error('replayPath: path.frames 배열이 필요하다');
  if (!codec || typeof codec.encodeMessage !== 'function') throw new Error('replayPath: codec.encodeMessage 가 필요하다');
  const { transport } = options;
  if (!transport || typeof transport.send !== 'function') throw new Error('replayPath: options.transport 가 필요하다');
  const { fovY, width, height, firstViewSeq } = { ...REPLAY_DEFAULTS, ...options };
  // 보내기 전에 전부 부호화해 도중 실패로 일부만 나가는 일을 막는다.
  const frames = path.frames.map((frame, i) => {
    const { pos, quat } = poseFromLookAt(frame);
    return codec.encodeMessage({ type: 'VIEW_UPDATE', viewSeq: firstViewSeq + i, pos, quat, fovY, width, height });
  });
  for (const bytes of frames) transport.send(bytes);
  return frames.length;
}
