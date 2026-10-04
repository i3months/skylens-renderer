// T14.3 건물 외곽 돌출: 외곽(ring) → 프리즘 Mesh. 외부 의존성 없음, 결정적.
import { TowerAssetError, buildingHeightM, signedArea } from '../../../contracts/tower_assets/index.mjs';

/** 외곽 꼭짓점 수 상한. 자기 교차 검사가 O(n²)이라 입력 크기를 제한한다. */
export const MAX_RING_VERTICES = 4096;

const fail = (fp, why) => new TowerAssetError(`extrudeBuilding: id=${fp && fp.id} ${why}`);

// 두 선분이 (끝점 접촉 포함) 교차하는지.
function segmentsTouch(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const on = (p, q, r) =>
    Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) &&
    Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
}

// 링 검증 + 정규화: 연속 중복점 제거, 반시계로 정렬한 새 배열을 돌려준다.
function normalizeRing(fp) {
  const raw = fp && fp.ring;
  if (!Array.isArray(raw)) throw fail(fp, 'ring 이 배열이 아님');
  const pts = [];
  for (const p of raw) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw fail(fp, '좌표가 유한수가 아님');
    const last = pts[pts.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push([p[0], p[1]]);
  }
  while (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  if (pts.length < 3) throw fail(fp, '서로 다른 꼭짓점이 3개 미만');
  const area = signedArea(pts);
  if (area === 0) throw fail(fp, '넓이 0 퇴화 다각형');
  const n = pts.length;
  if (n > MAX_RING_VERTICES) throw fail(fp, `꼭짓점 수 ${n} 가 상한 ${MAX_RING_VERTICES} 초과`);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // 이웃 변은 건너뜀
      if (segmentsTouch(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) throw fail(fp, '자기 교차 다각형');
    }
  }
  if (area < 0) pts.reverse();
  return pts;
}

// 귀 자르기. 반시계 링 → 정점 번호 삼각형 목록(반시계).
function earClip(pts) {
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  const same = (p, q) => p[0] === q[0] && p[1] === q[1];
  const idx = pts.map((_, i) => i);
  const tris = [];
  while (idx.length > 3) {
    const m = idx.length;
    let cut = -1;
    for (let k = 0; k < m && cut < 0; k++) {
      const a = pts[idx[(k + m - 1) % m]], b = pts[idx[k]], c = pts[idx[(k + 1) % m]];
      if (cross(a, b, c) <= 0) continue;
      let ok = true;
      for (let t = 0; t < m && ok; t++) {
        const p = pts[idx[t]];
        if (same(p, a) || same(p, b) || same(p, c)) continue;
        if (inside(p, a, b, c)) ok = false;
      }
      if (ok) cut = k;
    }
    if (cut < 0) {
      // 귀가 없으면 일직선 꼭짓점(넓이 0)을 삼각형 없이 제거한다.
      for (let k = 0; k < m; k++) {
        if (cross(pts[idx[(k + m - 1) % m]], pts[idx[k]], pts[idx[(k + 1) % m]]) === 0) { cut = k; break; }
      }
      if (cut < 0) throw new TowerAssetError('earClip: 삼각분할 실패');
      idx.splice(cut, 1);
      continue;
    }
    tris.push([idx[(cut + m - 1) % m], idx[cut], idx[(cut + 1) % m]]);
    idx.splice(cut, 1);
  }
  if (cross(pts[idx[0]], pts[idx[1]], pts[idx[2]]) > 0) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

/** (fp: Footprint) → Mesh. 바닥 z = 0, 지붕 z = buildingHeightM(fp.floors). 벽 + 지붕 + 바닥 덮개, 모두 바깥에서 볼 때 반시계. */
export function extrudeBuilding(fp) {
  const ring = normalizeRing(fp);
  const h = buildingHeightM(fp.floors);
  if (!Number.isFinite(h)) throw fail(fp, '높이가 유한수가 아님');
  const n = ring.length;
  const tris = earClip(ring);
  const pos = [];
  const idx = [];
  // 지붕 정점 [0, n), 바닥 덮개 정점 [n, 2n), 이후 변마다 벽 정점 4개.
  for (const [x, y] of ring) pos.push(x, y, h);
  for (const [x, y] of ring) pos.push(x, y, 0);
  for (const [a, b, c] of tris) {
    idx.push(a, b, c); // 지붕: 위쪽이 바깥
    idx.push(n + a, n + c, n + b); // 바닥: 아래쪽이 바깥이라 순서를 뒤집는다
  }
  for (let i = 0; i < n; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % n];
    const base = pos.length / 3;
    pos.push(x0, y0, 0, x1, y1, 0, x1, y1, h, x0, y0, h);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3); // 반시계 링의 바깥 방향 벽
  }
  const positions = new Float32Array(pos);
  // 유한한 double 이라도 Float32 로 내리면 Infinity 가 될 수 있다(좌표 1e39, floors 1e300 등). 메시에 넣지 않는다.
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) throw fail(fp, 'Float32 로 변환하면 좌표가 유한수가 아님');
  }
  return { positions, indices: new Uint32Array(idx) };
}

/** (fps: Footprint[]) → Array<{ id, mesh }> 입력 순서·동 수 보존. 퇴화 입력은 id 를 담아 던진다. */
export function extrudeAll(fps) {
  if (!Array.isArray(fps)) throw new TowerAssetError('extrudeAll: 입력이 배열이 아님');
  for (const fp of fps) if (!fp || typeof fp !== 'object') throw new TowerAssetError('extrudeAll: 항목이 객체가 아님');
  return fps.map((fp) => ({ id: fp.id, mesh: extrudeBuilding(fp) }));
}
