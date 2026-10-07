// T13.HQ 어려운 변형 장면 정의: S6 송출 화질(evaluateFullSend)을 flat_boxes 밖의 장면에서도 재기 위한 장면·시점 표. 새로 작성한 코드이며 외부 코드를 차용하지 않았다.
// 변형 = fixtures/scenes 의 depth_noise(깊이 잡음)·buildings(건물 외곽). 시점은 장면마다 고정 8곳(GL 규약 eye/target/up, 320x180 은 측정 쪽에서 정한다).
// fixtures/viewpoints 에는 flat_boxes 전용(synthetic.json)과 실자산용(viewpoints.json)만 있어 두 변형의 시점은 여기서 정한다.
import { generate as flatBoxes } from '../../fixtures/scenes/flat_boxes/index.mjs';
import { generate as depthNoise, DOC_K } from '../../fixtures/scenes/depth_noise/index.mjs';
import { generate as buildings } from '../../fixtures/scenes/buildings/index.mjs';
import { VIEWPOINTS } from './index.mjs';

/** SPEC 규모(구간당 점 수). */
export const SPEC_COUNT = 2500000;

// buildings 생성기는 count = 건물 수이고 점군은 건물마다 지붕 중심점 1개다. 2000 m 정사각을 ceil(√n) 칸 격자로 나누고
// 칸 폭 − 간격 1 m 가 밑면 최소 8 m 이상이어야 하므로 칸 수 ≤ floor(2000/9) = 222, 건물(= 점) 수 ≤ 222² = 49,284 다.
// 그보다 크면 생성기가 '밑면 8 m 를 둘 수 없음' 으로 던진다(fixtures/scenes/buildings). 250만 점은 이 생성기로 만들 수 없다.
export const BUILDINGS_MAX_COUNT = 222 * 222;

const vp = (id, name, eye, target, fov_y_deg = 50) => Object.freeze({ id, name, eye, target, up: [0, 1, 0], width: 1280, height: 720, fov_y_deg });

// depth_noise 시점 8곳. 장면은 원점의 촬영 카메라가 북쪽(−z)을 수평으로 본 기울어진 평면 5장(x −10..50, y −23..23, z −83..−5)이다.
// 잡음은 촬영 광선 방향이라 촬영 위치에서는 보이지 않으므로, 촬영 시점 1곳에 더해 옆·위·아래로 비켜선 시점에서 잡음 두께가 드러나게 했다.
// 평면 법선이 촬영 카메라 쪽이라 뒤(−z 쪽)에서 보는 시점은 두지 않았다(단안·스테레오 복원 점군을 뒤에서 보는 일은 없다).
// 1: 촬영 시점(문서 K 의 수직 시야각 2·atan(270/753.85) ≈ 39.4°, 16:9 라 320x180 과 화면 비가 같다).
const CAPTURE_FOV = (2 * Math.atan(DOC_K.cy / DOC_K.fy) * 180) / Math.PI;
export const DEPTH_NOISE_VIEWPOINTS = Object.freeze([
  vp(1, 'capture', [0, 0, 0], [0, 0, -40], CAPTURE_FOV),
  vp(2, 'raised_back', [0, 10, 12], [15, 0, -45]),
  vp(3, 'low_back', [0, -8, 6], [15, 0, -45]),
  vp(4, 'left_offset', [-8, 3, 4], [8, 0, -35]),
  vp(5, 'right_offset', [14, 3, 4], [18, 0, -45]),
  vp(6, 'top_oblique', [20, 60, 0], [20, 0, -45], 40),
  vp(7, 'near_planes', [2, 1, 2], [-4, 0, -14], 40), // 가까운 평면 0·1(깊이 5~26 m, σ 작음)
  vp(8, 'far_plane_zoom', [6, 4, 2], [37, 0, -69], 18), // 가장 먼 평면 4(깊이 55~84 m, σ 최대 약 1.1 m)를 좁은 시야로 확대
]);

// buildings 시점 8곳. 장면은 x,z −1000..1000 m 에 건물 지붕 중심점만 있는 넓고 성긴 점군(높이 5~60 m)이라
// flat_boxes 시점(200 m 바닥 기준)으로는 장면 대부분이 화면 밖이다. 전경·사선·수직과 관제탑 높이의 중·근거리, 지붕 높이 시점을 둔다.
export const BUILDINGS_VIEWPOINTS = Object.freeze([
  vp(1, 'aerial_overview', [0, 1400, 1700], [0, 0, 0]),
  vp(2, 'aerial_oblique_ne', [900, 600, -900], [0, 0, 0]),
  vp(3, 'top_down', [0, 2400, 1], [0, 0, 0]),
  vp(4, 'tower_high', [0, 150, 300], [0, 0, 0]),
  vp(5, 'tower_mid_sw', [-400, 80, 400], [-200, 20, 200]),
  vp(6, 'low_oblique_se', [500, 40, 500], [300, 30, 300]),
  vp(7, 'close_block', [150, 80, -150], [40, 15, -40]),
  vp(8, 'roof_level', [0, 30, 200], [0, 30, 0]),
]);

/**
 * 변형 표. generate(seed, count) 는 SceneResult.cloud(형식 1)를 낸다. defaultCount 는 count 를 주지 않을 때의 점 수.
 */
export const VARIANTS = Object.freeze({
  flat_boxes: Object.freeze({ generate: (seed, count) => flatBoxes({ seed, count }).cloud, viewpoints: VIEWPOINTS, defaultCount: SPEC_COUNT }),
  depth_noise: Object.freeze({ generate: (seed, count) => depthNoise({ seed, count }).cloud, viewpoints: DEPTH_NOISE_VIEWPOINTS, defaultCount: SPEC_COUNT }),
  // count 를 주지 않으면 생성 가능한 최대(49,284)를 쓴다. 더 큰 count 를 직접 주면 생성기가 던진다.
  buildings: Object.freeze({ generate: (seed, count) => buildings({ seed, count }).cloud, viewpoints: BUILDINGS_VIEWPOINTS, defaultCount: BUILDINGS_MAX_COUNT }),
});

/** 변형 이름 → 정의. 알 수 없는 이름은 RangeError. */
export function variantOf(name = 'flat_boxes') {
  if (typeof name !== 'string' || !Object.hasOwn(VARIANTS, name)) throw new RangeError(`variant 는 ${Object.keys(VARIANTS).join('|')} 중 하나여야 함: ${String(name)}`);
  return VARIANTS[name];
}
