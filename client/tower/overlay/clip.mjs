// 관제탑 경로 선분의 근평면 자르기(clip). 계약: contracts/controlview/overlay.mjs 의 TOWER_OVERLAY_FORMULA.pathClip.
// 자르기는 카메라 공간(X_c = R·X_w + t)에서 하고, 교점을 구한 뒤에 투영한다. 화면 밖 자르기는 하지 않는다(그리기가 한다).
// view: {width, height, K:{fx, fy, cx, cy}, R:[9](행 우선), t:[3]}. 입력을 고치지 않는다. 네트워크·타이머 없음.

function toCam(R, t, p) {
  const x = p[0], y = p[1], z = p[2];
  return [
    R[0] * x + R[1] * y + R[2] * z + t[0],
    R[3] * x + R[4] * y + R[5] * z + t[1],
    R[6] * x + R[7] * y + R[8] * z + t[2],
  ];
}

function finite3(c) {
  return Number.isFinite(c[0]) && Number.isFinite(c[1]) && Number.isFinite(c[2]);
}

// 교점 P = A + (B−A)·(nearM−dA)/(dB−dA). 깊이는 정의상 nearM 이므로 그대로 박는다(반올림 흔들림 없음).
function cross(A, B, nearM) {
  const s = (nearM - A[2]) / (B[2] - A[2]);
  return [A[0] + (B[0] - A[0]) * s, A[1] + (B[1] - A[1]) * s, nearM];
}

/**
 * points:[[e,n,u],...] 를 깊이 ≥ nearM 인 연속 구간마다 polyline 하나로 자르고 투영한다.
 * 결과: [[{u, v, depth}, ...], ...]. 점 1개짜리 구간은 버린다. 투영이 유한하지 않은 점에서 polyline 을 끊는다.
 */
export function clipPolyline(view, points, nearM) {
  if (!Array.isArray(points)) throw new TypeError('points 는 배열이어야 한다');
  if (typeof nearM !== 'number') throw new TypeError('nearM 은 숫자여야 한다');
  if (!Number.isFinite(nearM) || nearM <= 0) throw new RangeError('nearM 은 양의 유한 수여야 한다');
  const { R, t } = view;
  const { fx, fy, cx, cy } = view.K;

  // 1단계: 카메라 공간에서 자른 구간들(각 점은 X_c). 비유한 점은 구간을 끊는다.
  const runs = [];
  let cur = null;
  const close = () => { if (cur) runs.push(cur); cur = null; };
  let prev = null; // 직전 점의 X_c(비유한이면 null)
  for (const p of points) {
    const c = toCam(R, t, p);
    if (!finite3(c)) { close(); prev = null; continue; }
    const inB = c[2] >= nearM;
    if (prev === null) {
      if (inB) cur = [c];
    } else {
      const inA = prev[2] >= nearM;
      if (inA && inB) {
        cur.push(c);
      } else if (inA && !inB) {
        // 나간다. A 가 근평면 위에 정확히 있으면 교점이 A 자신이라 넣지 않는다.
        if (prev[2] !== nearM) cur.push(cross(prev, c, nearM));
        close();
      } else if (!inA && inB) {
        // 들어온다. B 가 근평면 위에 정확히 있으면 교점이 B 자신이다.
        cur = c[2] === nearM ? [c] : [cross(prev, c, nearM), c];
      }
      // 둘 다 뒤면 아무것도 없다.
    }
    prev = c;
  }
  close();

  // 2단계: 투영. 넘치는 점에서 끊고, 2점 미만 조각은 버린다.
  const out = [];
  for (const run of runs) {
    let line = [];
    for (const c of run) {
      const d = c[2];
      const u = fx * c[0] / d + cx;
      const v = fy * c[1] / d + cy;
      if (Number.isFinite(u) && Number.isFinite(v)) {
        line.push({ u, v, depth: d });
      } else {
        if (line.length >= 2) out.push(line);
        line = [];
      }
    }
    if (line.length >= 2) out.push(line);
  }
  return out;
}
