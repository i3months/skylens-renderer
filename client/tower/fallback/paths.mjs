// 관제탑 폴백 경로 그리기 목록(T15.8). 계약: contracts/controlview/fallback.mjs TOWER_FALLBACK_MODULES.paths, TOWER_FALLBACK_FORMULA.toScreen.
// 수식(view.mjs 를 import 하지 않고 여기서 직접 계산한다):
//   x = width/2 + (e − centerE)/metersPerPx,  y = height/2 − (n − centerN)/metersPerPx. 높이(u)는 쓰지 않는다.
// 받은 점 전부를 순서대로 한 polyline 으로 낸다. 솎지 않고 자르지 않고 잇지 않으며, 화면 밖 점도 그대로 남긴다.
// 입력 순서·id 를 지키고 입력을 바꾸지 않는다. 결과는 새 객체다. 경로마다 단일 순회로 점 객체만 하나씩 만든다.

/**
 * 경로 목록을 화면 좌표 polyline 으로 바꾼다.
 * @param {{centerE:number, centerN:number, metersPerPx:number}} view
 * @param {{width:number, height:number}} size
 * @param {{id:string, points:number[][]}[]} paths overlay store 의 pathsRaw() 형태
 * @returns {{id:string, polyline:{x:number, y:number}[]}[]}
 */
export function buildPaths(view, size, paths) {
  const cx = size.width / 2;
  const cy = size.height / 2;
  const { centerE, centerN, metersPerPx } = view;
  const out = new Array(paths.length);
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    const pts = p.points;
    const n = pts.length;
    const polyline = new Array(n);
    for (let j = 0; j < n; j++) {
      const q = pts[j];
      polyline[j] = { x: cx + (q[0] - centerE) / metersPerPx, y: cy - (q[1] - centerN) / metersPerPx };
    }
    out[i] = { id: p.id, polyline };
  }
  return out;
}
