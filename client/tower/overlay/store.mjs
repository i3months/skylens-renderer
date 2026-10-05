// 관제탑 드론·경로·탐지 마커 저장소(T15.6). 상태만 보관하고 투영·검사는 하지 않는다.
// 입력은 이미 validate 를 거친 값이므로 검사하지 않는다.
// 계약: contracts/controlview/overlay.mjs 의 TOWER_OVERLAY_MODULES.store.

/** 깊은 복사: 중첩된 배열·객체도 복사한다. */
function deepCopy(obj) {
  if (Array.isArray(obj)) return obj.map(deepCopy);
  if (obj !== null && typeof obj === 'object') {
    const copy = {};
    for (const k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        copy[k] = deepCopy(obj[k]);
      }
    }
    return copy;
  }
  return obj;
}

/** 드론·탐지·경로 저장소를 만든다. 이미 validate 를 거친 값을 받는다(검사 안 함). */
export function createOverlayStore() {
  // 상태: 배열 또는 {id, ...} 객체들의 맵
  let drones = [];
  let detections = [];
  const pathsMap = new Map(); // id -> {id, points}

  return {
    // 드론 목록 전체를 교체한다(누적 아님). 입력 배열과 내용을 복사해 불변성 보장.
    setDrones(list) {
      drones = deepCopy(list);
    },

    // 탐지 목록 전체를 교체한다(누적 아님). 입력 배열과 내용을 복사해 불변성 보장.
    setDetections(list) {
      detections = deepCopy(list);
    },

    // 경로를 저장한다. 같은 id 가 있으면 교체하고 자리는 유지한다.
    // 순서는 처음 등록된 순서를 지킨다. 입력을 복사한다.
    setPath(path) {
      const copy = deepCopy(path);
      pathsMap.set(copy.id, copy);
    },

    // 경로를 지운다. 있었으면 true, 없었으면 false.
    removePath(id) {
      return pathsMap.delete(id);
    },

    // 드론, 탐지, 경로 전부 지운다.
    clear() {
      drones = [];
      detections = [];
      pathsMap.clear();
    },

    // 현재 개수를 돌려준다.
    counts() {
      return {
        drones: drones.length,
        detections: detections.length,
        paths: pathsMap.size,
      };
    },

    // 현재 드론 목록의 깊은 복사를 돌려준다. 밖에서 고쳐도 상태가 안 변한다.
    drones() {
      return deepCopy(drones);
    },

    // 현재 탐지 목록의 깊은 복사를 돌려준다. 밖에서 고쳐도 상태가 안 변한다.
    detections() {
      return deepCopy(detections);
    },

    // 현재 경로 목록의 깊은 복사를 돌려준다. 맵의 값들을 배열로 돌린다.
    // 순서는 맵의 삽입 순서를 지킨다(같은 id 교체 시 원래 자리 유지).
    paths() {
      return Array.from(pathsMap.values()).map(deepCopy);
    },
  };
}
