// T15.3 건물 면 z-버퍼 삼각형 래스터(단색 면). 계약: contracts/controlview/buildings.mjs BUILDINGS_MODULES.raster_flat.
// 좌표·투영은 contracts/raster 규약 그대로다: X_c = R·X_w + t (OpenCV 축: x 오른쪽, y 아래, z 앞),
//   깊이 d = X_c.z, u = fx·X_c.x/d + cx, v = fy·X_c.y/d + cy. 화소 (i,j) 는 [i,i+1)×[j,j+1) 칸, 표본은 중심 (i+0.5, j+0.5).
// 설계 요약(client/tower/terrain/raster.mjs 와 같은 규약을 따르는 독립 구현)
// - 근평면 z = nearM(0.01 m)에서 삼각형을 Sutherland–Hodgman 로 자른다. z > nearM 인 꼭짓점만 안쪽이고,
//   절단점은 z = nearM 위에 놓인다. 결과는 볼록 3~4각형이며 부채꼴(0,i,i+1)로 나눠 그린다. 전부 뒤면 건너뛴다.
// - 포함 판정은 가장자리 함수 세 개 + top-left 규칙(공유 변이 두 번/0번 칠해지지 않게).
// - 깊이는 원근 보정: 화면 무게중심으로 1/z 를 보간한 뒤 z = 1/보간값(Float32 로 맞춰 비교·저장).
//   out 에 이미 있는 깊이보다 엄격히 가까울 때만 쓴다(빈 화소 index −1 이면 무조건 쓴다). 같은 깊이는 앞선 것 유지.
// - 속성(uv)은 카메라 공간에서 근평면 절단 변을 따라 선형 보간하고, 화소에서는 (속성/z) 를 보간한 뒤 1/z 로 나눈다.
// - 건물 면은 양면 모두 그린다(화면 면적이 음이면 꼭짓점 순서를 바꿔 정규화). 면적 0 삼각형은 건너뛴다.
// - 비유한 정점·범위 밖 인덱스는 TypeError 로 던진다(계약 위반을 숨기지 않는다).
import { assertCamera } from '../../../contracts/raster/index.mjs';
import { BUILDINGS_DEFAULTS } from '../../../contracts/controlview/buildings.mjs';

const ERR = 'buildings/raster:';

/**
 * 묶음 목록의 모든 삼각형을 그리는 공용 핵심. raster_flat·raster_tex 가 함께 쓴다.
 * @param {import('../../../contracts/raster/index.mjs').Camera} camera
 * @param {Array<{mesh:{positions:Float32Array, indices:Uint32Array}, uv?:Float32Array}>} groups
 * @param {(g:number, tri:number, i0:number, i1:number, i2:number) => void} onTriangle 삼각형을 그리기 직전 한 번 호출(색 준비)
 * @param {(c3:number, u:number, v:number) => void} onPixel 깊이 시험을 통과한 화소마다 호출. c3 = color 배열 오프셋.
 * @param {import('../../../contracts/raster/index.mjs').RenderResult} out 제자리 갱신
 * @param {(g:number) => Float32Array|null} uvOf 묶음별 uv(정점당 2) 또는 null(속성 보간 안 함)
 */
export function rasterizeGroupsCore(camera, groups, onTriangle, onPixel, out, uvOf) {
  assertCamera(camera);
  if (!Array.isArray(groups)) throw new TypeError(`${ERR} groups 는 배열이어야 함`);
  if (!out || out.width !== camera.width || out.height !== camera.height
    || !(out.color instanceof Uint8Array) || !(out.depth instanceof Float32Array) || !(out.index instanceof Int32Array)
    || out.color.length !== 3 * camera.width * camera.height || out.depth.length !== camera.width * camera.height
    || out.index.length !== camera.width * camera.height) {
    throw new TypeError(`${ERR} out 은 카메라와 같은 크기의 RenderResult(emptyResult) 여야 함`);
  }
  const near = BUILDINGS_DEFAULTS.nearM;
  const { width, height } = camera;
  const { fx, fy, cx, cy } = camera.K;
  const R = camera.R;
  const t0 = camera.t[0]; const t1 = camera.t[1]; const t2 = camera.t[2];
  const depth = out.depth;
  const index = out.index;

  // 호출당 한 번 할당하는 스크래치.
  const camX = [0, 0, 0]; const camY = [0, 0, 0]; const camZ = [0, 0, 0];
  const aU = [0, 0, 0]; const aV = [0, 0, 0];
  const clipX = [0, 0, 0, 0]; const clipY = [0, 0, 0, 0]; const clipZ = [0, 0, 0, 0];
  const clipU = [0, 0, 0, 0]; const clipV = [0, 0, 0, 0];
  const sx = [0, 0, 0, 0]; const sy = [0, 0, 0, 0]; const iz = [0, 0, 0, 0];
  const uz = [0, 0, 0, 0]; const vz = [0, 0, 0, 0]; // u/z, v/z

  function rasterSub(ia, ib, ic, gid) {
    const ax = sx[ia]; const ay = sy[ia];
    let bx = sx[ib]; let by = sy[ib];
    let qx = sx[ic]; let qy = sy[ic];
    let area2 = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax);
    if (area2 === 0 || !Number.isFinite(area2)) return;
    if (area2 < 0) { // 뒷면: b·c 를 맞바꿔 양의 면적으로
      let tmp = bx; bx = qx; qx = tmp;
      tmp = by; by = qy; qy = tmp;
      tmp = ib; ib = ic; ic = tmp;
      area2 = -area2;
    }
    const aiz = iz[ia]; const biz = iz[ib]; const ciz = iz[ic];
    const auz = uz[ia]; const buz = uz[ib]; const cuz = uz[ic];
    const avz = vz[ia]; const bvz = vz[ib]; const cvz = vz[ic];
    const minX = Math.min(ax, bx, qx); const maxX = Math.max(ax, bx, qx);
    const minY = Math.min(ay, by, qy); const maxY = Math.max(ay, by, qy);
    const pxMin = Math.max(0, Math.ceil(minX - 0.5));
    const pxMax = Math.min(width - 1, Math.floor(maxX - 0.5));
    const pyMin = Math.max(0, Math.ceil(minY - 0.5));
    const pyMax = Math.min(height - 1, Math.floor(maxY - 0.5));
    if (pxMin > pxMax || pyMin > pyMax) return;
    // w0: 변 b→c, w1: 변 c→a, w2: 변 a→b. top-left 규칙(terrain/raster.mjs 와 같은 판정).
    const tl0 = (qy - by < 0) || (qy - by === 0 && qx - bx > 0);
    const tl1 = (ay - qy < 0) || (ay - qy === 0 && ax - qx > 0);
    const tl2 = (by - ay < 0) || (by - ay === 0 && bx - ax > 0);
    const invArea = 1 / area2;
    for (let py = pyMin; py <= pyMax; py += 1) {
      const syc = py + 0.5;
      const rowOff = py * width;
      for (let px = pxMin; px <= pxMax; px += 1) {
        const sxc = px + 0.5;
        const w0 = (qx - bx) * (syc - by) - (qy - by) * (sxc - bx);
        if (!(w0 > 0 || (w0 === 0 && tl0))) continue;
        const w1 = (ax - qx) * (syc - qy) - (ay - qy) * (sxc - qx);
        if (!(w1 > 0 || (w1 === 0 && tl1))) continue;
        const w2 = (bx - ax) * (syc - ay) - (by - ay) * (sxc - ax);
        if (!(w2 > 0 || (w2 === 0 && tl2))) continue;
        const inv = (w0 * aiz + w1 * biz + w2 * ciz) * invArea; // 원근 보정 1/z
        const z = Math.fround(1 / inv);
        const pix = rowOff + px;
        if (index[pix] !== -1 && !(z < depth[pix])) continue; // 같은 깊이·더 먼 것은 앞선 것 유지
        depth[pix] = z;
        index[pix] = gid;
        let u = 0; let v = 0;
        if (uvOn) {
          u = (w0 * auz + w1 * buz + w2 * cuz) * invArea / inv;
          v = (w0 * avz + w1 * bvz + w2 * cvz) * invArea / inv;
        }
        onPixel(3 * pix, u, v);
      }
    }
  }

  let uvOn = false;
  for (let g = 0; g < groups.length; g += 1) {
    const grp = groups[g];
    const mesh = grp && grp.mesh;
    if (!mesh || !(mesh.positions instanceof Float32Array) || !(mesh.indices instanceof Uint32Array)) {
      throw new TypeError(`${ERR} 묶음 ${g}: mesh.positions(Float32Array)·mesh.indices(Uint32Array) 필요`);
    }
    const positions = mesh.positions;
    const indices = mesh.indices;
    const nv = Math.floor(positions.length / 3);
    if (positions.length % 3 !== 0 || indices.length % 3 !== 0) throw new TypeError(`${ERR} 묶음 ${g}: positions·indices 길이는 3 의 배수`);
    const uv = uvOf(g);
    uvOn = uv !== null;
    if (uvOn && (!(uv instanceof Float32Array) || uv.length !== 2 * nv)) throw new TypeError(`${ERR} 묶음 ${g}: uv 길이는 정점 수의 2 배`);
    const triCount = indices.length / 3;
    for (let tri = 0; tri < triCount; tri += 1) {
      const vi = [indices[3 * tri], indices[3 * tri + 1], indices[3 * tri + 2]];
      for (let k = 0; k < 3; k += 1) {
        const i = vi[k];
        if (i >= nv) throw new TypeError(`${ERR} 묶음 ${g} 삼각형 ${tri}: 인덱스 ${i} 가 정점 수 ${nv} 를 넘음`);
        const wx = positions[3 * i]; const wy = positions[3 * i + 1]; const wz = positions[3 * i + 2];
        if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) {
          throw new TypeError(`${ERR} 묶음 ${g} 삼각형 ${tri}: 정점 좌표가 유한하지 않음`);
        }
        camX[k] = R[0] * wx + R[1] * wy + R[2] * wz + t0;
        camY[k] = R[3] * wx + R[4] * wy + R[5] * wz + t1;
        camZ[k] = R[6] * wx + R[7] * wy + R[8] * wz + t2;
        if (uvOn) { aU[k] = uv[2 * i]; aV[k] = uv[2 * i + 1]; }
      }
      // 근평면 절단(z > near 가 안쪽).
      let m = 0;
      for (let e = 0; e < 3; e += 1) {
        const n = e === 2 ? 0 : e + 1;
        const curIn = camZ[e] > near;
        const nxtIn = camZ[n] > near;
        if (curIn) {
          clipX[m] = camX[e]; clipY[m] = camY[e]; clipZ[m] = camZ[e]; clipU[m] = aU[e]; clipV[m] = aV[e];
          m += 1;
        }
        if (curIn !== nxtIn) {
          const s = (near - camZ[e]) / (camZ[n] - camZ[e]);
          clipX[m] = camX[e] + s * (camX[n] - camX[e]);
          clipY[m] = camY[e] + s * (camY[n] - camY[e]);
          clipZ[m] = near;
          clipU[m] = aU[e] + s * (aU[n] - aU[e]);
          clipV[m] = aV[e] + s * (aV[n] - aV[e]);
          m += 1;
        }
      }
      if (m < 3) continue; // 완전히 카메라 뒤
      for (let k = 0; k < m; k += 1) {
        const invz = 1 / clipZ[k];
        sx[k] = fx * clipX[k] * invz + cx;
        sy[k] = fy * clipY[k] * invz + cy;
        iz[k] = invz;
        uz[k] = clipU[k] * invz;
        vz[k] = clipV[k] * invz;
      }
      onTriangle(g, tri, vi[0], vi[1], vi[2]);
      for (let k = 1; k < m - 1; k += 1) rasterSub(0, k, k + 1, g);
    }
  }
}

/**
 * 건물 묶음들을 단색 면으로 z-버퍼에 그린다.
 * @param {import('../../../contracts/raster/index.mjs').Camera} camera
 * @param {import('../../../contracts/controlview/buildings.mjs').BuildingGroup[]} groups
 * @param {(groupIndex:number, triIndex:number) => number[]} shadeFn 삼각형 색 [r,g,b](0..255)
 * @param {import('../../../contracts/raster/index.mjs').RenderResult} out emptyResult(비어 있지 않아도 됨, 제자리 갱신)
 * @returns {void}
 */
export function rasterizeFlat(camera, groups, shadeFn, out) {
  if (typeof shadeFn !== 'function') throw new TypeError(`${ERR} shadeFn 은 함수여야 함`);
  const color = out && out.color;
  let r = 0; let gg = 0; let b = 0;
  rasterizeGroupsCore(camera, groups, (g, tri) => {
    const c = shadeFn(g, tri);
    r = c[0]; gg = c[1]; b = c[2];
  }, (c3) => {
    color[c3] = r; color[c3 + 1] = gg; color[c3 + 2] = b;
  }, out, () => null);
}
