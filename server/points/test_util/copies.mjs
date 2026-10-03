// 테스트 보조: 실행 중 Buffer 로 새로 만들어진(복사·할당된) 바이트 수를 센다.
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
  st.restore = () => Object.assign(Buffer, orig);
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
