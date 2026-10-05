// 'no_network.test.mjs' 의 검사 함수가 변이를 잡는지 보이기 위한 시험용 가짜 층.
// BuildingsLayer 서명(accept/setMode/mode/render/state)을 흉내 내며 옵션마다 다른 색을 그린다.
// 실제 그리기는 하지 않는다: 화면 중앙 사각형을 옵션 색으로 채울 뿐이다.
import { lookup as namedLookup } from 'node:dns'; // 이름으로 가져온 바인딩(M3)
import { emptyResult } from '../../../contracts/raster/index.mjs';
import { DISPLAY_MODES } from '../../../contracts/tower_assets/index.mjs';

const MODE_RGB = Object.freeze({ points: [255, 255, 255], black: [40, 40, 40], aerial: [200, 120, 30] });

function baseFake(onSetMode) {
  let mode = 'black';
  let bundle = null;
  let level = -1;
  const layer = {
    accept(lv, b) {
      if (!b || !Array.isArray(b.groups)) throw new Error('가짜 층: 잘못된 묶음');
      const action = level < 0 ? 'first' : 'replace';
      bundle = b;
      level = lv;
      return action;
    },
    setMode(m) {
      if (!DISPLAY_MODES.includes(m)) throw new RangeError(`가짜 층: 알 수 없는 옵션 ${String(m)}`);
      mode = m;
      onSetMode(layer, () => bundle, () => level);
    },
    mode: () => mode,
    render(camera) {
      const out = emptyResult(camera.width, camera.height);
      if (!bundle) return out;
      const rgb = MODE_RGB[mode];
      for (let y = Math.floor(camera.height / 4); y < Math.floor((3 * camera.height) / 4); y += 1) {
        for (let x = Math.floor(camera.width / 4); x < Math.floor((3 * camera.width) / 4); x += 1) {
          const p = y * camera.width + x;
          out.color.set(rgb, 3 * p);
          out.depth[p] = 30;
          out.index[p] = 0;
        }
      }
      return out;
    },
    state: () => ({ level, groupCount: bundle ? bundle.groups.length : 0, buildingCount: 0, mode }),
  };
  return layer;
}

/** 음성 (a): setMode 안에서 fetch 를 부르는 층(전환 때 네트워크 요청을 하는 변이). */
export function createFetchOnSetModeFake() {
  return baseFake(() => {
    // 응답은 쓰지 않는다. 호출 자체가 위반이다.
    globalThis.fetch('http://127.0.0.1:1/aerial.png');
  });
}

/** 음성 (b): 전환마다 accept 를 다시 요구하는 층(layer.accept 를 다시 부른다. 자료 재요청에 해당). */
export function createReacceptOnSetModeFake() {
  return baseFake((layer, getBundle, getLevel) => {
    layer.accept(Math.max(0, getLevel()), getBundle());
  });
}

/** 양성 대조용: 위반 없는 가짜 층(검사 함수가 정상 층은 통과시키는지 확인). */
export function createCleanFake() {
  return baseFake(() => {});
}

/** 변이 M4: 전환 직후가 아니라 setTimeout 으로 미뤄서 fetch 를 부르는 층(동기 루프가 끝난 뒤에 나간다). */
export function createDelayedFetchFake() {
  return baseFake(() => {
    setTimeout(() => { globalThis.fetch('http://127.0.0.1:1/aerial.png'); }, 0);
  });
}

/** 변이 M3: import { lookup } from 'node:dns' 로 이름 가져온 lookup 을 전환 때 부르는 층. */
export function createNamedDnsLookupFake() {
  return baseFake(() => {
    try { namedLookup('example.invalid', () => {}); } catch { /* 호출 자체가 위반 */ }
  });
}

/** 변이 M5: 전환 때 1000 ms 뒤에 fetch 를 부르는 층(짧은 대기로는 놓치는 지연 변이). */
export function createSlowDelayedFetchFake() {
  return baseFake(() => {
    setTimeout(() => { globalThis.fetch('http://127.0.0.1:1/aerial.png'); }, 1000);
  });
}
