// 시험용 모의 클라이언트. 추상 Transport 와 루프백 쌍, createMockClient 함수를 내보낸다.

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
