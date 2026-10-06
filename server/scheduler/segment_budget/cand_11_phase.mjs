// 솎기 후보 11: 모턴 등간격 솎기의 위상 변형. 새로 작성한 코드이며 외부 코드를 차용하지 않았다.
// 기준(createSpatialThinner)은 j 번째 점을 ord[floor(j*n/k)] 로 뽑는다(위상 0). 여기서는 ord[floor((j+phase)*n/k)] 로 뽑는다.
// phase ∈ [0,1): 등간격 격자를 간격의 phase 배만큼 민다. 원본 점의 부분집합만 고르고 모턴 순을 유지한다.
import { createSpatialThinner } from './index.mjs';

/**
 * @param {number} phase  0 이상 1 미만
 * @returns {(positions:Float32Array, attrs?:object) => {count:number, select(k:number): Uint32Array}}
 */
export function createPhaseThinnerFactory(phase) {
  if (!Number.isFinite(phase) || phase < 0 || phase >= 1) throw new RangeError(`phase 는 [0,1): ${phase}`);
  return function createThinner(positions) {
    const base = createSpatialThinner(positions);
    const n = base.count;
    return {
      count: n,
      select(k) {
        if (!Number.isInteger(k) || k < 0) throw new RangeError(`k 는 0 이상 정수: ${k}`);
        const ord = base.select(n); // 전체 모턴 순(사본)
        if (k >= n) return ord;
        const out = new Uint32Array(k);
        for (let j = 0; j < k; j++) out[j] = ord[Math.min(n - 1, Math.floor(((j + phase) * n) / k))];
        return out;
      },
    };
  };
}
