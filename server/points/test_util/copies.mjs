// 테스트 보조: 실행 중 Buffer 로 새로 만들어진(복사·할당된) 바이트 수를 센다.
// 세는 경로: Buffer.from(뷰/배열)·concat·alloc·allocUnsafe·copyBytesFrom, TypedArray.prototype.slice(Uint8Array.prototype.slice.call 포함),
// ArrayBuffer.prototype.slice, new Uint8Array(뷰·배열 등 길이 있는 인자). 새 Uint8Array(길이) 는 할당 계수 대상이 아니다(열 배열 생성용).
// 문자열 인자와 (arrayBuffer, offset, length) 형태의 감싸기는 복사가 아니므로 세지 않는다.
function patch() {
  const orig = { from: Buffer.from, concat: Buffer.concat, alloc: Buffer.alloc, allocUnsafe: Buffer.allocUnsafe };
  const st = { copied: 0 };
  Buffer.from = function (a, ...r) {
    if (ArrayBuffer.isView(a)) st.copied += a.byteLength;
    else if (Array.isArray(a)) st.copied += a.length;
    return orig.from.call(Buffer, a, ...r);
  };
  Buffer.concat = function (l, n) { const b = orig.concat.call(Buffer, l, n); st.copied += b.length; return b; };
  Buffer.alloc = function (n, ...r) { st.copied += n; return orig.alloc.call(Buffer, n, ...r); };
  Buffer.allocUnsafe = function (n) { st.copied += n; return orig.allocUnsafe.call(Buffer, n); };
  // 추가 복사 경로(원본 보관 후 복원)
  const TA = Object.getPrototypeOf(Uint8Array.prototype); // %TypedArray%.prototype
  const origTaSlice = TA.slice;
  const origAbSlice = ArrayBuffer.prototype.slice;
  const origCopyBytesFrom = Buffer.copyBytesFrom;
  const OrigU8 = globalThis.Uint8Array;
  TA.slice = function (...a) { const r = origTaSlice.apply(this, a); st.copied += r.byteLength; return r; };
  ArrayBuffer.prototype.slice = function (...a) { const r = origAbSlice.apply(this, a); st.copied += r.byteLength; return r; };
  if (origCopyBytesFrom) {
    Buffer.copyBytesFrom = function (v, ...r) { const b = origCopyBytesFrom.call(Buffer, v, ...r); st.copied += b.byteLength; return b; };
  }
  // new Uint8Array(뷰|배열|이터러블) 는 복사다. (buffer, offset, length) 형태와 숫자 길이는 세지 않는다.
  globalThis.Uint8Array = new Proxy(OrigU8, {
    construct(target, args, newTarget) {
      const a = args[0];
      if (ArrayBuffer.isView(a)) st.copied += a.byteLength;
      else if (a !== null && typeof a === 'object' && !(a instanceof ArrayBuffer) && !(typeof SharedArrayBuffer !== 'undefined' && a instanceof SharedArrayBuffer)) st.copied += a.length ?? 0;
      return Reflect.construct(target, args, newTarget === globalThis.Uint8Array ? target : newTarget);
    },
  });
  st.restore = () => {
    Object.assign(Buffer, orig);
    TA.slice = origTaSlice;
    ArrayBuffer.prototype.slice = origAbSlice;
    if (origCopyBytesFrom) Buffer.copyBytesFrom = origCopyBytesFrom;
    globalThis.Uint8Array = OrigU8;
  };
  return st;
}
export function countCopies(fn) {
  const st = patch();
  try { fn(); } finally { st.restore(); }
  return st.copied;
}
// 비동기 본문용(본문이 끝날 때까지 계수한다. 테스트 입력 생성은 밖에서 미리 해 둘 것)
export async function countCopiesAsync(fn) {
  const st = patch();
  try { await fn(); } finally { st.restore(); }
  return st.copied;
}
