// T15.1-A2 z-버퍼 삼각형 래스터. 지형 메시를 한 장의 영상(contracts/raster RenderResult)으로 그린다.
// 좌표·투영은 contracts/raster 규약 그대로다: X_c = R·X_w + t (OpenCV 축: x 오른쪽, y 아래, z 앞),
//   깊이 d = X_c.z, u = fx·X_c.x/d + cx, v = fy·X_c.y/d + cy. 월드는 GeoAnchor 기준 ENU, 1 unit = 1 m.
// 설계 요약
// - 근평면(z ≥ nearM)에서 삼각형을 Sutherland–Hodgman 로 자른다(한 평면이므로 결과는 볼록 3~4각형).
//   4각형은 부채꼴(0,i,i+1)로 삼각형 2개로 나눈다. 완전히 카메라 뒤면 꼭짓점이 3개 미만이라 건너뛴다.
// - 화소 (px,py) 의 표본점은 중심 (px+0.5, py+0.5). 포함은 가장자리 함수 세 개로 판정하고,
//   공유 변이 두 번/0번 칠해지지 않도록 top-left 규칙(변 위 표본은 top 또는 left 변일 때만 포함)을 쓴다.
//   같은 변을 반대 방향으로 지나는 이웃 삼각형끼리 정확히 한쪽만 그 변을 가지므로 틈·겹침이 없다.
// - 깊이는 원근 보정: 화면에서 1/z 가 선형이므로 화면 무게중심으로 1/z 를 보간한 뒤 z = 1/보간값.
//   z-버퍼 비교는 엄격히 가까울 때만 갱신 → 같은 깊이는 먼저 그린 삼각형이 남는다.
// - 지형은 양면을 모두 그린다: 화면 면적 부호가 음(뒷면)이면 꼭짓점 1·2 를 맞바꿔 양의 면적으로 정규화한다.
//   면적 0(퇴화·모서리 정면) 삼각형은 건너뛴다.
// - 비유한 정점이 들어오면 그 삼각형을 건너뛰지 않고 TypeError 로 던진다(계약 위반을 숨기지 않는다).
// - 성능: 경계 상자만 순회하고 가장자리 함수는 증분으로 갱신한다. 삼각형마다 객체를 새로 만들지 않고
//   호출 한 번에 작은 스크래치 배열을 한 번만 할당한다.
import { assertCamera } from '../../../contracts/raster/index.mjs';
import { TERRAIN_DEFAULTS } from '../../../contracts/controlview/terrain.mjs';

/**
 * 삼각형 메시를 z-버퍼로 그려 out 을 채운다.
 * @param {import('../../../contracts/raster/index.mjs').Camera} camera
 * @param {{positions:Float32Array, indices:Uint32Array, tileOfTriangle:Int32Array}} mesh
 * @param {(tri:number)=>number[]} shadeTriangle 삼각형 번호 → [r,g,b] (0..255 정수)
 * @param {import('../../../contracts/raster/index.mjs').RenderResult} out emptyResult 로 만든 결과(제자리 갱신)
 * @returns {void}
 */
export function rasterizeTriangles(camera, mesh, shadeTriangle, out) {
  assertCamera(camera);
  const near = TERRAIN_DEFAULTS.nearM;
  const { width, height } = camera;
  const { fx, fy, cx, cy } = camera.K;
  const R = camera.R;
  const t0 = camera.t[0];
  const t1 = camera.t[1];
  const t2 = camera.t[2];
  const r00 = R[0]; const r01 = R[1]; const r02 = R[2];
  const r10 = R[3]; const r11 = R[4]; const r12 = R[5];
  const r20 = R[6]; const r21 = R[7]; const r22 = R[8];

  const positions = mesh.positions;
  const indices = mesh.indices;
  const tileOfTriangle = mesh.tileOfTriangle;
  const color = out.color;
  const depth = out.depth;
  const index = out.index;

  const triCount = Math.floor(indices.length / 3);

  // 호출당 한 번만 할당하는 스크래치(삼각형마다 재사용). 카메라 공간 정점(3개)과 근평면 절단 결과(최대 4개).
  const camX = [0, 0, 0];
  const camY = [0, 0, 0];
  const camZ = [0, 0, 0];
  const clipX = [0, 0, 0, 0];
  const clipY = [0, 0, 0, 0];
  const clipZ = [0, 0, 0, 0];
  const sx = [0, 0, 0, 0];
  const sy = [0, 0, 0, 0];
  const iz = [0, 0, 0, 0];

  // 한 (볼록) 서브 삼각형을 그린다. 화면 좌표와 정점별 1/z 를 받는다.
  function rasterSub(ax, ay, aiz, bx, by, biz, cxs, cys, ciz, tileId, cr, cg, cb) {
    let area2 = (bx - ax) * (cys - ay) - (by - ay) * (cxs - ax);
    if (area2 === 0) return; // 퇴화(또는 화면에서 선분)
    if (area2 < 0) { // 뒷면: 꼭짓점 1·2 를 맞바꿔 양의 면적으로(양면 그리기)
      const tx = bx; bx = cxs; cxs = tx;
      const ty = by; by = cys; cys = ty;
      const ti = biz; biz = ciz; ciz = ti;
      area2 = -area2;
    }
    let minX = ax < bx ? (ax < cxs ? ax : cxs) : (bx < cxs ? bx : cxs);
    let maxX = ax > bx ? (ax > cxs ? ax : cxs) : (bx > cxs ? bx : cxs);
    let minY = ay < by ? (ay < cys ? ay : cys) : (by < cys ? by : cys);
    let maxY = ay > by ? (ay > cys ? ay : cys) : (by > cys ? by : cys);
    let pxMin = Math.ceil(minX - 0.5); if (pxMin < 0) pxMin = 0;
    let pxMax = Math.floor(maxX - 0.5); if (pxMax > width - 1) pxMax = width - 1;
    let pyMin = Math.ceil(minY - 0.5); if (pyMin < 0) pyMin = 0;
    let pyMax = Math.floor(maxY - 0.5); if (pyMax > height - 1) pyMax = height - 1;
    if (pxMin > pxMax || pyMin > pyMax) return;

    // 가장자리 함수 증분 계수. w0: 변 b→c, w1: 변 c→a, w2: 변 a→b.
    const A0 = by - cys; const B0 = cxs - bx;
    const A1 = cys - ay; const B1 = ax - cxs;
    const A2 = ay - by; const B2 = bx - ax;
    // top-left 규칙: 아래로 향하는 왼쪽 변(dy<0) 또는 오른쪽으로 향하는 수평 top 변(dy==0 && dx>0) 위 표본은 포함.
    const tl0 = (cys - by < 0) || (cys - by === 0 && cxs - bx > 0);
    const tl1 = (ay - cys < 0) || (ay - cys === 0 && ax - cxs > 0);
    const tl2 = (by - ay < 0) || (by - ay === 0 && bx - ax > 0);

    const s0x = pxMin + 0.5; const s0y = pyMin + 0.5;
    let w0row = (cxs - bx) * (s0y - by) - (cys - by) * (s0x - bx);
    let w1row = (ax - cxs) * (s0y - cys) - (ay - cys) * (s0x - cxs);
    let w2row = (bx - ax) * (s0y - ay) - (by - ay) * (s0x - ax);
    const invArea = 1 / area2;

    for (let py = pyMin; py <= pyMax; py += 1) {
      let w0 = w0row; let w1 = w1row; let w2 = w2row;
      const rowOff = py * width;
      for (let px = pxMin; px <= pxMax; px += 1) {
        if ((w0 > 0 || (w0 === 0 && tl0)) && (w1 > 0 || (w1 === 0 && tl1)) && (w2 > 0 || (w2 === 0 && tl2))) {
          const inv = (w0 * aiz + w1 * biz + w2 * ciz) * invArea; // 원근 보정된 1/z
          const z = 1 / inv;
          const pix = rowOff + px;
          if (index[pix] === -1 || z < depth[pix]) { // 같은 깊이는 먼저 그린 삼각형 유지
            depth[pix] = z;
            index[pix] = tileId;
            const c3 = 3 * pix;
            color[c3] = cr; color[c3 + 1] = cg; color[c3 + 2] = cb;
          }
        }
        w0 += A0; w1 += A1; w2 += A2;
      }
      w0row += B0; w1row += B1; w2row += B2;
    }
  }

  for (let tri = 0; tri < triCount; tri += 1) {
    const o = 3 * tri;
    const i0 = indices[o]; const i1 = indices[o + 1]; const i2 = indices[o + 2];
    const p0 = 3 * i0; const p1 = 3 * i1; const p2 = 3 * i2;
    const wx0 = positions[p0]; const wy0 = positions[p0 + 1]; const wz0 = positions[p0 + 2];
    const wx1 = positions[p1]; const wy1 = positions[p1 + 1]; const wz1 = positions[p1 + 2];
    const wx2 = positions[p2]; const wy2 = positions[p2 + 1]; const wz2 = positions[p2 + 2];
    if (!Number.isFinite(wx0) || !Number.isFinite(wy0) || !Number.isFinite(wz0)
      || !Number.isFinite(wx1) || !Number.isFinite(wy1) || !Number.isFinite(wz1)
      || !Number.isFinite(wx2) || !Number.isFinite(wy2) || !Number.isFinite(wz2)) {
      throw new TypeError(`raster: 삼각형 ${tri} 의 정점 좌표가 유한하지 않음`);
    }
    // 카메라 공간으로 변환: X_c = R·X_w + t
    camX[0] = r00 * wx0 + r01 * wy0 + r02 * wz0 + t0;
    camY[0] = r10 * wx0 + r11 * wy0 + r12 * wz0 + t1;
    camZ[0] = r20 * wx0 + r21 * wy0 + r22 * wz0 + t2;
    camX[1] = r00 * wx1 + r01 * wy1 + r02 * wz1 + t0;
    camY[1] = r10 * wx1 + r11 * wy1 + r12 * wz1 + t1;
    camZ[1] = r20 * wx1 + r21 * wy1 + r22 * wz1 + t2;
    camX[2] = r00 * wx2 + r01 * wy2 + r02 * wz2 + t0;
    camY[2] = r10 * wx2 + r11 * wy2 + r12 * wz2 + t1;
    camZ[2] = r20 * wx2 + r21 * wy2 + r22 * wz2 + t2;

    // 근평면 z >= near 절단(Sutherland–Hodgman, 한 평면).
    let m = 0;
    for (let e = 0; e < 3; e += 1) {
      const n = e === 2 ? 0 : e + 1;
      const czCur = camZ[e];
      const czNxt = camZ[n];
      const curIn = czCur >= near;
      const nxtIn = czNxt >= near;
      if (curIn) { clipX[m] = camX[e]; clipY[m] = camY[e]; clipZ[m] = czCur; m += 1; }
      if (curIn !== nxtIn) {
        const tI = (near - czCur) / (czNxt - czCur);
        clipX[m] = camX[e] + tI * (camX[n] - camX[e]);
        clipY[m] = camY[e] + tI * (camY[n] - camY[e]);
        clipZ[m] = near;
        m += 1;
      }
    }
    if (m < 3) continue; // 완전히 카메라 뒤 → 그릴 것 없음

    // 투영 + 정점별 1/z.
    for (let i = 0; i < m; i += 1) {
      const z = clipZ[i];
      const invz = 1 / z;
      sx[i] = fx * clipX[i] * invz + cx;
      sy[i] = fy * clipY[i] * invz + cy;
      iz[i] = invz;
    }

    const sh = shadeTriangle(tri);
    const cr = sh[0]; const cg = sh[1]; const cb = sh[2];
    const tileId = tileOfTriangle[tri];

    // 부채꼴로 삼각형화해 그린다.
    for (let i = 1; i < m - 1; i += 1) {
      rasterSub(
        sx[0], sy[0], iz[0],
        sx[i], sy[i], iz[i],
        sx[i + 1], sy[i + 1], iz[i + 1],
        tileId, cr, cg, cb,
      );
    }
  }
}
