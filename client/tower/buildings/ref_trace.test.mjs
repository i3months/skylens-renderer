// 건물 참조 렌더러(ref_trace.mjs) 시험: 손 계산, 빈 화소, 영상 색의 물리 정합, 점, 선 가림, 결정성, 변이 검출.
import test from 'node:test';
import assert from 'node:assert/strict';
import { refRenderBuildings, intersectTriangle, sampleAerial } from './ref_trace.mjs';
import { makeBundle, makeCameras, makeFootprints, bundleFromFootprints, makeAerialImage } from './test_support/fixtures.mjs';
import { assertRenderResult } from '../../../contracts/raster/index.mjs';
import { BUILDINGS_DEFAULTS } from '../../../contracts/controlview/buildings.mjs';
import { buildingHeightM } from '../../../contracts/tower_assets/index.mjs';

const CAMS = makeCameras();
const camOf = (name) => CAMS.find((c) => c.name === name);
const BOX = { id: 7, ring: [[-5, -5], [5, -5], [5, 5], [-5, 5]], floors: 4 }; // 높이 12 m
const H = 12;
const boxBundle = (opts) => bundleFromFootprints([BOX], opts);
const resBytes = (r) => Buffer.concat([Buffer.from(r.color), Buffer.from(r.depth.buffer), Buffer.from(r.index.buffer)]);

/** 화소 중심 광선(시험 쪽 독립 계산): 원점 C, 방향 d = Rᵀ(xn, yn, 1). */
function ray(cam, px, py) {
  const { K, R, t } = cam;
  const xn = (px + 0.5 - K.cx) / K.fx, yn = (py + 0.5 - K.cy) / K.fy;
  const C = [0, 1, 2].map((k) => -(R[k] * t[0] + R[3 + k] * t[1] + R[6 + k] * t[2]));
  const d = [0, 1, 2].map((k) => R[k] * xn + R[3 + k] * yn + R[6 + k]);
  return { C, d };
}

/** 축 정렬 상자 [-5,5]²×[0,12] 에 대한 해석 분류. 'roof'·'south' 면 깊이(s), 'miss' 면 null, 애매하면 'edge'. */
function classifyBox(cam, px, py, margin = 0.05) {
  const { C, d } = ray(cam, px, py);
  // 슬랩 시험(여유 margin 만큼 넓힌 상자와 만나지 않으면 확실한 빈 화소)
  let t0 = 0, t1 = Infinity;
  const lo = [-5 - margin, -5 - margin, -margin], hi = [5 + margin, 5 + margin, H + margin];
  for (let k = 0; k < 3; k++) {
    if (d[k] === 0) { if (C[k] < lo[k] || C[k] > hi[k]) return { kind: 'miss' }; continue; }
    let a = (lo[k] - C[k]) / d[k], b = (hi[k] - C[k]) / d[k];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
  }
  if (t0 > t1) return { kind: 'miss' };
  // 지붕 평면 z = 12 (위에서 내려올 때)
  if (d[2] < 0 && C[2] > H) {
    const s = (H - C[2]) / d[2];
    const x = C[0] + s * d[0], y = C[1] + s * d[1];
    if (Math.abs(x) < 5 - margin && Math.abs(y) < 5 - margin) return { kind: 'roof', s, x, y };
  }
  // 남쪽 벽 y = −5 (남쪽에서 북으로 볼 때)
  if (d[1] > 0 && C[1] < -5) {
    const s = (-5 - C[1]) / d[1];
    const x = C[0] + s * d[0], z = C[2] + s * d[2];
    if (Math.abs(x) < 5 - margin && z > margin && z < H - margin) return { kind: 'south', s };
  }
  return { kind: 'edge' };
}

/** 손 계산 검사기: 지붕·남벽 화소 깊이 = 해석값(1e-4 m), 빈 화소는 깊이 0·번호 −1. 어긋난 화소 수를 돌려준다. */
function boxMismatches(cam, r) {
  let bad = 0, checked = 0;
  for (let py = 0; py < cam.height; py++) {
    for (let px = 0; px < cam.width; px++) {
      const o = py * cam.width + px;
      const c = classifyBox(cam, px, py);
      if (c.kind === 'miss') { checked++; if (r.depth[o] !== 0 || r.index[o] !== -1) bad++; }
      else if (c.kind === 'roof' || c.kind === 'south') { checked++; if (!(Math.abs(r.depth[o] - c.s) <= 1e-4) || r.index[o] !== 0) bad++; }
    }
  }
  assert.ok(checked > cam.width * cam.height * 0.5);
  return bad;
}

test('intersectTriangle: 손 계산(양면, 변 밖은 null)', () => {
  const p0 = [0, 0, 0], p1 = [1, 0, 0], p2 = [0, 1, 0];
  const h = intersectTriangle([0.25, 0.25, 5], [0, 0, -1], p0, p1, p2);
  assert.deepEqual(h, [5, 0.25, 0.25]);
  assert.deepEqual(intersectTriangle([0.25, 0.25, -5], [0, 0, 2], p0, p1, p2), [2.5, 0.25, 0.25]); // 뒷면도 맞는다
  assert.equal(intersectTriangle([0.75, 0.75, 5], [0, 0, -1], p0, p1, p2), null);
  assert.equal(intersectTriangle([0.25, 0.25, 5], [1, 0, 0], p0, p1, p2), null); // 평행
});

test('상자 하나: top 지붕 중심 화소 깊이 = 120 − 12 = 108 (1e-4), 모서리 화소 깊이 0', () => {
  const cam = camOf('top');
  for (const mode of ['black', 'aerial']) {
    const r = refRenderBuildings(cam, boxBundle(), mode, { lines: false });
    assertRenderResult(r);
    const o = 21 * 80 + 40; // 화소 중심 (40.5, 21.5): 주점에서 약 1.1 화소 → 지붕 중심 근처(약 1.7 m)
    assert.ok(Math.abs(r.depth[o] - 108) <= 1e-4, `${mode} 깊이 ${r.depth[o]}`);
    assert.equal(r.index[o], 0);
    for (const q of [0, 79, 44 * 80, 44 * 80 + 79]) { assert.equal(r.depth[q], 0); assert.equal(r.index[q], -1); }
    assert.equal(boxMismatches(cam, r), 0);
  }
});

test('상자 하나: 세 카메라 모두 지붕·남벽 깊이 = 해석값, 빈 화소 = 0', () => {
  for (const cam of CAMS) {
    const r = refRenderBuildings(cam, boxBundle(), 'black', { lines: false });
    assert.equal(boxMismatches(cam, r), 0, cam.name);
    let roof = 0;
    for (let py = 0; py < 45; py++) for (let px = 0; px < 80; px++) if (classifyBox(cam, px, py).kind === 'roof') roof++;
    assert.ok(roof > 0, `${cam.name} 에서 지붕이 보여야 한다`);
  }
  // 눈높이 17 m: 남벽이 보인다.
  const cam = camOf('eye17');
  let south = 0;
  for (let py = 0; py < 45; py++) for (let px = 0; px < 80; px++) if (classifyBox(cam, px, py).kind === 'south') south++;
  assert.ok(south > 20);
});

test('black: 면 색 = faceRgb(검정), lines:false 면 선 색이 없다', () => {
  const b = makeBundle(2);
  for (const cam of CAMS) {
    const r = refRenderBuildings(cam, b, 'black', { lines: false });
    for (let o = 0; o < 80 * 45; o++) {
      if (r.index[o] >= 0) assert.deepEqual([...r.color.subarray(3 * o, 3 * o + 3)], [...BUILDINGS_DEFAULTS.faceRgb]);
    }
    const rl = refRenderBuildings(cam, b, 'black');
    assertRenderResult(rl);
    let lines = 0;
    for (let o = 0; o < 80 * 45; o++) if (rl.color[3 * o] === BUILDINGS_DEFAULTS.lineRgb[0]) lines++;
    assert.ok(lines > 10, `${cam.name} 선 화소 ${lines}`);
  }
});

test('black 선: 앞쪽 위 모서리는 보이고, 뒤쪽 아래 모서리(남벽에 가림)는 안 보인다', () => {
  const cam = camOf('eye17');
  const r = refRenderBuildings(cam, boxBundle(), 'black');
  const proj = (X) => {
    const { K, R, t } = cam;
    const c = [0, 1, 2].map((k) => R[3 * k] * X[0] + R[3 * k + 1] * X[1] + R[3 * k + 2] * X[2] + t[k]);
    return { o: Math.floor(K.fy * c[1] / c[2] + K.cy) * 80 + Math.floor(K.fx * c[0] / c[2] + K.cx), z: c[2] };
  };
  const front = proj([0.3, -5, 12]);
  assert.deepEqual([...r.color.subarray(3 * front.o, 3 * front.o + 3)], [...BUILDINGS_DEFAULTS.lineRgb]);
  assert.ok(Math.abs(r.depth[front.o] - front.z) < 0.5);
  const back = proj([0.3, 5, 0]);
  assert.equal(r.index[back.o], 0, '남벽이 덮는다');
  assert.deepEqual([...r.color.subarray(3 * back.o, 3 * back.o + 3)], [...BUILDINGS_DEFAULTS.faceRgb]);
  assert.ok(r.depth[back.o] < back.z - 1);
});

/** 영상 색의 물리 정합 검사기: 지붕 안쪽(외곽에서 0.05 m 이상) 화소는 지상 (x, y) 영상 색과 채널당 1 이내. 어긋난 수·검사 수. */
function aerialMismatches(cam, bundle, fps, r) {
  const im = bundle.image;
  const { minX, minY, maxX, maxY } = im.bounds;
  const groundColor = (x, y) => {
    // 독립 표본: 지상 좌표 → 연속 화소 좌표(행 0 = 북) → 이중선형
    const fx = ((x - minX) / (maxX - minX)) * im.width - 0.5, fy = ((maxY - y) / (maxY - minY)) * im.height - 0.5;
    const c0 = Math.floor(fx), r0 = Math.floor(fy), ax = fx - c0, ay = fy - r0;
    const px = (c, rr, k) => im.rgb[3 * (Math.min(im.height - 1, Math.max(0, rr)) * im.width + Math.min(im.width - 1, Math.max(0, c))) + k];
    return [0, 1, 2].map((k) => (px(c0, r0, k) * (1 - ax) + px(c0 + 1, r0, k) * ax) * (1 - ay) + (px(c0, r0 + 1, k) * (1 - ax) + px(c0 + 1, r0 + 1, k) * ax) * ay);
  };
  const distToRing = (ring, x, y) => {
    let m = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
      const ex = bx - ax, ey = by - ay;
      const tau = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
      m = Math.min(m, Math.hypot(ax + tau * ex - x, ay + tau * ey - y));
    }
    return m;
  };
  const inside = (ring, x, y) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  let bad = 0, checked = 0, walls = 0;
  for (let py = 0; py < cam.height; py++) {
    for (let px = 0; px < cam.width; px++) {
      const o = py * cam.width + px;
      const g = r.index[o];
      if (g < 0) continue;
      const { C, d } = ray(cam, px, py);
      const s = r.depth[o];
      const X = [C[0] + s * d[0], C[1] + s * d[1], C[2] + s * d[2]];
      const fp = fps[g];
      const h = buildingHeightM(fp.floors);
      const col = [...r.color.subarray(3 * o, 3 * o + 3)];
      if (Math.abs(X[2] - h) < 1e-3 && inside(fp.ring, X[0], X[1]) && distToRing(fp.ring, X[0], X[1]) > 0.05) {
        checked++;
        const e = groundColor(X[0], X[1]);
        if (col.some((v, k) => Math.abs(v - e[k]) > 1)) bad++;
      } else if (X[2] < h - 0.05) { // 벽(지붕보다 확실히 아래): 검정 면
        walls++;
        if (col.some((v, k) => v !== BUILDINGS_DEFAULTS.faceRgb[k])) bad++;
      }
    }
  }
  return { bad, checked, walls };
}

test('aerial: 지붕 화소 색 = 그 지상 점의 영상 색(채널당 1), 벽은 검정', () => {
  for (const seed of [1, 4, 9]) {
    const b = makeBundle(seed);
    const fps = makeFootprints(seed, 6);
    for (const cam of CAMS) {
      const r = refRenderBuildings(cam, b, 'aerial');
      assertRenderResult(r);
      const m = aerialMismatches(cam, b, fps, r);
      assert.equal(m.bad, 0, `시드 ${seed} ${cam.name}`);
      assert.ok(m.checked > 20, `${cam.name} 지붕 화소 ${m.checked}`);
      if (cam.name === 'eye17') assert.ok(m.walls > 20);
    }
  }
});

test('aerial: 영상이 null 이면 모든 면이 검정(메우지 않음), 덮임은 black 과 같다', () => {
  const b = makeBundle(3, { image: false });
  for (const cam of CAMS) {
    const r = refRenderBuildings(cam, b, 'aerial');
    const k = refRenderBuildings(cam, b, 'black', { lines: false });
    assert.ok(Buffer.from(r.color).equals(Buffer.from(k.color)));
    assert.ok(Buffer.from(r.depth.buffer).equals(Buffer.from(k.depth.buffer)));
    assert.ok(Buffer.from(r.index.buffer).equals(Buffer.from(k.index.buffer)));
  }
});

test('sampleAerial: 화소 중심은 그 화소 색, 계약 v = 0 이 북', () => {
  const im = makeAerialImage();
  const at = (c, r) => [...im.rgb.subarray(3 * (r * 96 + c), 3 * (r * 96 + c) + 3)];
  assert.deepEqual(sampleAerial(im, 10.5 / 96, 3.5 / 96), at(10, 3));
  assert.deepEqual(sampleAerial(im, 0, 0), at(0, 0)); // 북서 모서리
  assert.deepEqual(sampleAerial(im, 1, 1), at(95, 95)); // 남동 모서리
});

test('points: 점 하나 = floor 칸 한 화소, 깊이 시험, 카메라 뒤 점은 버린다', () => {
  const cam = camOf('top');
  const base = boxBundle();
  const g = { ...base.groups[0], points: Float32Array.of(0.8, 0.8, 12, 0.874074, 0.874074, 2, 0, 0, 200, 1000, 0, 0) };
  const g2 = { ...base.groups[0], points: Float32Array.of(0.874074, 0.874074, 2) };
  const r = refRenderBuildings(cam, { groups: [g, g2], image: null }, 'points');
  assertRenderResult(r);
  // 손 계산: top 카메라 수평 화각 60°, 폭 80 → fx = fy = 40/tan30° = 69.282, 주점 (40, 22.5). 눈 (0,0,120) 에서 수직으로 내려다봄(위 = 북).
  // 점 (0.8, 0.8, 12): 깊이 120−12 = 108, u = 69.282·0.8/108 + 40 = 40.513 → 열 40(round 면 41), v = 69.282·(−0.8)/108 + 22.5 = 21.987 → 행 21(round 면 22).
  const o = 21 * 80 + 40;
  assert.ok(Math.abs(r.depth[o] - 108) <= 1e-4, `깊이 108 이어야 함: ${r.depth[o]}`);
  assert.equal(r.index[o], 0, '같은 광선 위 더 먼 점(깊이 118, 좌표 0.8·118/108 = 0.874074, 같은 묶음 한 점 + 두 번째 묶음)이 이기면 안 된다');
  assert.deepEqual([...r.color.subarray(3 * o, 3 * o + 3)], [...BUILDINGS_DEFAULTS.pointRgb]);
  let n = 0;
  for (const i of r.index) if (i >= 0) n++;
  assert.equal(n, 1, '뒤의 점(z=2)·카메라 뒤(z=200)·화면 밖 점은 칸을 차지하지 않는다');
});

test('points: 합성 번들에서 칸마다 가장 가까운 점의 깊이', () => {
  const b = makeBundle(6);
  for (const cam of CAMS) {
    const r = refRenderBuildings(cam, b, 'points');
    assertRenderResult(r);
    const { K, R, t } = cam;
    const best = new Float64Array(80 * 45).fill(Infinity);
    for (const g of b.groups) {
      for (let k = 0; k < g.points.length; k += 3) {
        const X = [g.points[k], g.points[k + 1], g.points[k + 2]];
        const c = [0, 1, 2].map((q) => R[3 * q] * X[0] + R[3 * q + 1] * X[1] + R[3 * q + 2] * X[2] + t[q]);
        if (c[2] <= 0.01) continue;
        const u = Math.floor(K.fx * c[0] / c[2] + K.cx), v = Math.floor(K.fy * c[1] / c[2] + K.cy);
        if (u < 0 || u >= 80 || v < 0 || v >= 45) continue;
        best[v * 80 + u] = Math.min(best[v * 80 + u], c[2]);
      }
    }
    for (let o = 0; o < 80 * 45; o++) {
      if (best[o] === Infinity) assert.equal(r.index[o], -1);
      else assert.ok(Math.abs(r.depth[o] - best[o]) <= 1e-4);
    }
  }
});

test('결정성: 시드별로 같은 입력 → 같은 바이트, 다른 시드 → 다른 결과', () => {
  for (const seed of [1, 2, 3]) {
    for (const cam of CAMS) {
      for (const mode of ['black', 'aerial', 'points']) {
        const a = refRenderBuildings(cam, makeBundle(seed), mode);
        const b = refRenderBuildings(cam, makeBundle(seed), mode);
        assert.ok(resBytes(a).equals(resBytes(b)), `${seed} ${cam.name} ${mode}`);
      }
    }
  }
  const cam = camOf('oblique');
  assert.ok(!resBytes(refRenderBuildings(cam, makeBundle(1), 'black')).equals(resBytes(refRenderBuildings(cam, makeBundle(2), 'black'))));
});

test('입력 검사: 모르는 옵션은 RangeError, 잘못된 카메라는 raster: 오류', () => {
  const b = boxBundle();
  assert.throws(() => refRenderBuildings(camOf('top'), b, 'wire'), RangeError);
  assert.throws(() => refRenderBuildings({ ...camOf('top'), width: 0 }, b, 'black'), /raster:/);
  const empty = refRenderBuildings(camOf('top'), { groups: [], image: null }, 'black');
  assert.ok(empty.index.every((i) => i === -1));
});

// ── 변이 시험: 검사기가 실제로 틀린 입력을 잡는지 확인한다 ──

/** 상자 지붕 삼각형 두 개(z 가 모두 H 인 삼각형) 위치. */
function roofTris(g) {
  const p = g.mesh.positions, idx = g.mesh.indices, out = [];
  for (let t = 0; t < idx.length; t += 3) if ([0, 1, 2].every((k) => p[3 * idx[t + k] + 2] === H)) out.push(t);
  return out;
}

function withIndices(bundle, idx) {
  const g = bundle.groups[0];
  return { ...bundle, groups: [{ ...g, mesh: { positions: g.mesh.positions, indices: idx } }] };
}

test('변이 — 대각선: 올바른 뒤집기는 결과 불변, 한쪽만 뒤집으면(구멍) 손 계산 검사기가 잡는다', () => {
  const base = boxBundle();
  const g = base.groups[0];
  const [t0, t1] = roofTris(g);
  const A = [...g.mesh.indices.subarray(t0, t0 + 3)], B = [...g.mesh.indices.subarray(t1, t1 + 3)];
  const shared = A.filter((v) => B.includes(v));
  assert.equal(shared.length, 2);
  const [p, q] = shared, o0 = A.find((v) => !B.includes(v)), o1 = B.find((v) => !A.includes(v));
  // 반시계 유지: 원래 삼각형 (o0 이 있는 쪽)의 감김 순서를 따른 새 삼각형 두 개
  const rot = (tri, first) => { const i = tri.indexOf(first); return [tri[i], tri[(i + 1) % 3], tri[(i + 2) % 3]]; };
  const a = rot(A, o0); // [o0, x, y]
  const flipA = [o0, a[1], o1], flipB = [o0, o1, a[2]];
  const flipped = Uint32Array.from(g.mesh.indices);
  flipped.set(flipA, t0); flipped.set(flipB, t1);
  // 한쪽만: 두 번째 삼각형만 반대 대각선 쪽으로 바꾼다 → 지붕에 구멍·겹침이 생긴다
  const half = Uint32Array.from(g.mesh.indices);
  half.set(flipB, t1);
  assert.equal(new Set([p, q, o0, o1]).size, 4, '공유 변 두 끝점과 마주 보는 두 꼭짓점은 서로 다른 네 점');
  assert.ok(Number.isInteger(o0) && Number.isInteger(o1) && o0 !== o1);
  for (const cam of CAMS) {
    const ref = refRenderBuildings(cam, base, 'aerial');
    const fl = refRenderBuildings(cam, withIndices(base, flipped), 'aerial');
    assert.equal(boxMismatches(cam, fl), 0, `${cam.name}: 올바른 뒤집기`);
    for (let o = 0; o < 80 * 45; o++) {
      assert.equal(fl.index[o], ref.index[o]);
      assert.ok(Math.abs(fl.depth[o] - ref.depth[o]) <= 1e-4);
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(fl.color[3 * o + k] - ref.color[3 * o + k]) <= 1, '지붕 uv 는 xy 의 아핀 함수라 대각선과 무관');
    }
  }
  // 80×45 에서 상자 지붕은 몇 화소뿐이라, 구멍(지붕의 1/4)이 확실히 보이도록 160×90 에서 잰다.
  for (const cam of makeCameras({ width: 160, height: 90 })) {
    if (cam.name === 'eye17') continue; // 눈높이에서는 지붕이 비스듬해 구멍이 얇다
    const bad = refRenderBuildings(cam, withIndices(base, half), 'black', { lines: false });
    assert.ok(boxMismatches(cam, bad) > 5, `${cam.name}: 한쪽만 뒤집은 지붕을 잡아야 한다`);
    assert.equal(boxMismatches(cam, refRenderBuildings(cam, base, 'black', { lines: false })), 0);
  }
});

test('변이 — uv 뒤집기: 서버 관례 uv를 뒤집으면 물리 정합 검사기가 잡는다', () => {
  const seed = 4;
  const fps = makeFootprints(seed, 6);
  const flippedBundle = makeBundle(seed, { uv: 'flipped' });
  for (const cam of CAMS) {
    const m = aerialMismatches(cam, flippedBundle, fps, refRenderBuildings(cam, flippedBundle, 'aerial'));
    assert.ok(m.bad > m.checked * 0.5, `${cam.name}: 어긋남 ${m.bad}/${m.checked}`);
  }
  // u 만 뒤집어도 잡는다
  const b = makeBundle(seed);
  const uFlip = { ...b, groups: b.groups.map((g) => { const uv = Float32Array.from(g.uv); for (let i = 0; i < uv.length; i += 2) uv[i] = 1 - uv[i]; return { ...g, uv }; }) };
  const cam = camOf('top');
  const m = aerialMismatches(cam, uFlip, fps, refRenderBuildings(cam, uFlip, 'aerial'));
  assert.ok(m.bad > m.checked * 0.5);
});
