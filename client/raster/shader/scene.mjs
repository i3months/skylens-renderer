// T12.2 시험용 합성 장면: fixtures/scenes/flat_boxes 점군과 fixtures/viewpoints/synthetic.json 의 8시점.
// 점군 법선은 ASSET_FORMAT §5.3 팔면체 snorm8 로 부호화(server/asset/pack encodeOctNormal)해 GPU 평면과 같게 만든다.
import { readFileSync } from 'node:fs';
import { generate } from '../../../fixtures/scenes/flat_boxes/index.mjs';
import { encodeOctNormal } from '../../../server/asset/pack/index.mjs';
import { viewpointToCamera } from '../../../tools/render_views/index.mjs';
import { pointUniformValues } from './index.mjs';

const VIEWPOINTS = new URL('../../../fixtures/viewpoints/synthetic.json', import.meta.url);

/** 장면 점 평면. seed·count 가 같으면 같은 바이트다. */
export function scenePoints(seed, count) {
  const { cloud } = generate({ seed, count });
  const n = cloud.count;
  const normalOct = new Int8Array(2 * n);
  for (let k = 0; k < n; k += 1) {
    const [qx, qy] = encodeOctNormal(cloud.normals[3 * k], cloud.normals[3 * k + 1], cloud.normals[3 * k + 2]);
    normalOct[2 * k] = qx;
    normalOct[2 * k + 1] = qy;
  }
  return { positions: cloud.positions, colors: cloud.colors, normalOct };
}

/**
 * 8시점 카메라(장치 픽셀). 해상도는 원래 시점(1280×720)을 1/scaleDown 로 줄이고 fov 는 그대로 둔다.
 * @returns {Array<{name: string, camera: import('../../../contracts/raster/index.mjs').Camera}>}
 */
export function sceneCameras(scaleDown) {
  const { viewpoints } = JSON.parse(readFileSync(VIEWPOINTS, 'utf8'));
  return viewpoints.map((vp) => ({
    name: vp.name,
    camera: viewpointToCamera({ ...vp, width: Math.round(vp.width / scaleDown), height: Math.round(vp.height / scaleDown) }),
  }));
}

/** 카메라와 셰이딩 설정으로 셰이더 유니폼 값을 만든다. */
export function cameraUniforms(camera, o) {
  return pointUniformValues({
    R: camera.R, t: camera.t, K: camera.K, bw: camera.width, bh: camera.height,
    lightDirWorld: o.lightDirWorld, pointSizeM: o.pointSizeM, ambient: o.ambient, shade: o.shade,
    near: o.near, far: o.far, maxPointSize: o.maxPointSize,
  });
}
