import assert from 'assert';
import { psnr, emptyRatio } from './index.mjs';

// PSNR 테스트
{
  // 케이스 1: 모두 1 차이
  const a1 = new Uint8Array([10, 20, 30, 40, 50]);
  const b1 = new Uint8Array([11, 21, 31, 41, 51]);
  const result1 = psnr(a1, b1);
  const expected1 = 10 * Math.log10(65025);
  assert(Math.abs(result1 - expected1) < 1e-4, `케이스 1 실패: ${result1} vs ${expected1}`);
  console.log(`케이스 1 (모두 1 차이): ${result1.toFixed(4)} (예상: ${expected1.toFixed(4)})`);
}

{
  // 케이스 2: 0 vs 255
  const a2 = new Uint8Array([0, 0, 0]);
  const b2 = new Uint8Array([255, 255, 255]);
  const result2 = psnr(a2, b2);
  assert(result2 === 0, `케이스 2 실패: ${result2} vs 0`);
  console.log(`케이스 2 (0 vs 255): ${result2} dB (예상: 0)`);
}

{
  // 케이스 3: 같은 값
  const a3 = new Uint8Array([100, 150, 200]);
  const b3 = new Uint8Array([100, 150, 200]);
  const result3 = psnr(a3, b3);
  assert(result3 === Infinity, `케이스 3 실패: ${result3} vs Infinity`);
  console.log(`케이스 3 (같은 값): ${result3} (예상: Infinity)`);
}

{
  // 케이스 4: 길이 100, 1개 픽셀만 10 차이
  const a4 = new Uint8Array(100);
  const b4 = new Uint8Array(100);
  a4[0] = 100;
  b4[0] = 110;
  const result4 = psnr(a4, b4);
  // MSE = (100-110)² / 100 = 100/100 = 1
  const expected4 = 10 * Math.log10(65025);
  assert(Math.abs(result4 - expected4) < 1e-4, `케이스 4 실패: ${result4} vs ${expected4}`);
  console.log(`케이스 4 (길이 100, 1개 10 차이): ${result4.toFixed(4)} (예상: ${expected4.toFixed(4)})`);
}

{
  // 케이스 5: 길이 다름 - Error
  const a5 = new Uint8Array([1, 2, 3]);
  const b5 = new Uint8Array([1, 2]);
  assert.throws(() => psnr(a5, b5), /psnr:/, `케이스 5 실패: 길이 다른 경우 Error 필요`);
  console.log(`케이스 5 (길이 다름): Error 발생 ✓`);
}

{
  // 케이스 6: 빈 배열 - Error
  const a6 = new Uint8Array([]);
  const b6 = new Uint8Array([]);
  assert.throws(() => psnr(a6, b6), /psnr:/, `케이스 6 실패: 빈 배열 Error 필요`);
  console.log(`케이스 6 (빈 배열): Error 발생 ✓`);
}

// emptyRatio 테스트
{
  // 케이스 1: 4×2 그리드 (8 픽셀), 빈 픽셀 3개
  const result1 = {
    index: new Int32Array([0, 1, -1, 3, -1, 5, -1, 7])
  };
  const ratio1 = emptyRatio(result1);
  assert(Math.abs(ratio1 - 0.375) < 1e-9, `emptyRatio 케이스 1 실패: ${ratio1} vs 0.375`);
  console.log(`emptyRatio 케이스 1 (4×2 3개 빈): ${ratio1} (예상: 0.375)`);
}

{
  // 케이스 2: 모두 빈 픽셀
  const result2 = {
    index: new Int32Array(16).fill(-1)
  };
  const ratio2 = emptyRatio(result2);
  assert(ratio2 === 1, `emptyRatio 케이스 2 실패: ${ratio2} vs 1`);
  console.log(`emptyRatio 케이스 2 (모두 빈): ${ratio2} (예상: 1)`);
}

{
  // 케이스 3: 모두 채워진 픽셀
  const result3 = {
    index: new Int32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
  };
  const ratio3 = emptyRatio(result3);
  assert(ratio3 === 0, `emptyRatio 케이스 3 실패: ${ratio3} vs 0`);
  console.log(`emptyRatio 케이스 3 (모두 참): ${ratio3} (예상: 0)`);
}

{
  // 케이스 4: 잘못된 입력 - null
  assert.throws(() => emptyRatio(null), /psnr:/, `emptyRatio 케이스 4 실패: null Error 필요`);
  console.log(`emptyRatio 케이스 4 (null 입력): Error 발생 ✓`);
}

{
  // 케이스 5: 잘못된 입력 - index가 없음
  assert.throws(() => emptyRatio({}), /psnr:/, `emptyRatio 케이스 5 실패: index 없음 Error 필요`);
  console.log(`emptyRatio 케이스 5 (index 없음): Error 발생 ✓`);
}

console.log('\n모든 테스트 통과!');
