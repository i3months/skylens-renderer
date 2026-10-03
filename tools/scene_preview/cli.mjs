#!/usr/bin/env node
// 장면 미리보기 생성 CLI (T05.10)
// 사용법: node cli.mjs <장면이름> <시드> <출력디렉터리>

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPreview, encodePng } from './index.mjs';

const __dirname = import.meta.dirname || join(fileURLToPath(import.meta.url), '..');

/**
 * 시드 인자를 엄격히 읽는다: 10진 숫자만(부호·소수점·지수·공백·접미 문자 금지), 0~4294967295.
 * parseInt 는 '12abc'→12, '1e3'→1 로 조용히 받으므로 쓰지 않는다.
 * @param {string} s
 * @returns {number}
 */
export function parseSeedArg(s) {
  if (typeof s !== 'string' || !/^[0-9]{1,10}$/.test(s)) {
    throw new Error(`scene_preview: 시드는 0~4294967295 범위의 10진 정수여야 함: ${JSON.stringify(s)}`);
  }
  const v = Number(s);
  if (v > 0xffffffff) throw new Error(`scene_preview: 시드는 0~4294967295 범위의 10진 정수여야 함: ${JSON.stringify(s)}`);
  return v;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length !== 3) {
    console.error('사용법: node cli.mjs <장면이름> <시드> <출력디렉터리>');
    process.exit(1);
  }

  const [sceneName, seedStr, outputDir] = args;
  let seed;
  try {
    seed = parseSeedArg(seedStr);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  // contracts/scenes/index.mjs 로드하여 SCENES 및 관련 함수 가져오기
  let SCENES, SCENES_MODULE;
  try {
    const scenesPath = resolve(__dirname, '../../contracts/scenes/index.mjs');
    SCENES_MODULE = await import(`file://${scenesPath}`);
    SCENES = SCENES_MODULE.SCENES;
  } catch (e) {
    console.error('오류: contracts/scenes/index.mjs 로드 실패:', e.message);
    process.exit(1);
  }

  // 장면 모듈 확인
  if (!(sceneName in SCENES)) {
    console.error(`오류: 알 수 없는 장면 "${sceneName}"`);
    console.error(`알려진 장면: ${Object.keys(SCENES).join(', ')}`);
    process.exit(1);
  }

  // 장면 생성기 로드
  let generateFunc;
  try {
    const modulePath = SCENES[sceneName];
    const fullPath = resolve(__dirname, '../../', modulePath);
    const sceneModule = await import(`file://${fullPath}`);
    generateFunc = sceneModule.generate;

    if (typeof generateFunc !== 'function') {
      throw new Error(`export generate 함수가 없음`);
    }
  } catch (e) {
    console.error(`오류: 장면 모듈 "${sceneName}" 로드 실패:`, e.message);
    process.exit(1);
  }

  // 시점 로드
  let viewpointsData;
  try {
    const viewpointsPath = resolve(__dirname, '../../fixtures/viewpoints/synthetic.json');
    const content = readFileSync(viewpointsPath, 'utf-8');
    viewpointsData = JSON.parse(content);
  } catch (e) {
    console.error('오류: fixtures/viewpoints/synthetic.json 로드 실패:', e.message);
    process.exit(1);
  }

  // 장면 생성
  let sceneResult;
  try {
    sceneResult = generateFunc({ seed });

    // 결과 검증
    if (!sceneResult || typeof sceneResult !== 'object') {
      throw new Error('generate() 함수가 유효한 SceneResult를 반환하지 않음');
    }
    if (!sceneResult.cloud) {
      throw new Error('SceneResult.cloud 없음');
    }
  } catch (e) {
    console.error(`오류: 장면 생성 실패:`, e.message);
    process.exit(1);
  }

  // 출력 디렉터리 생성
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch (e) {
    console.error('오류: 출력 디렉터리 생성 실패:', e.message);
    process.exit(1);
  }

  // 8개 시점별로 이미지 생성
  const { viewpoints } = viewpointsData;
  if (!Array.isArray(viewpoints) || viewpoints.length === 0) {
    console.error('오류: synthetic.json에 viewpoints 배열이 없음');
    process.exit(1);
  }

  console.log(`장면 "${sceneName}" (seed=${seed}), 총 ${sceneResult.cloud.count} 점`);

  for (let idx = 0; idx < Math.min(viewpoints.length, 8); idx++) {
    const vp = viewpoints[idx];

    try {
      // 렌더링
      const { width, height, rgb } = renderPreview(sceneResult.cloud, {
        eye: vp.eye,
        target: vp.target,
        up: vp.up,
        width: vp.width,
        height: vp.height,
        fov_y_deg: vp.fov_y_deg,
      });

      // PNG 인코딩
      const pngData = encodePng(width, height, rgb);

      // 저장
      const filename = `${sceneName}_${seed}_vp${idx + 1}.png`;
      const filepath = join(outputDir, filename);
      writeFileSync(filepath, pngData);

      console.log(`  [${idx + 1}/8] ${vp.name} → ${filename}`);
    } catch (e) {
      console.error(`  [${idx + 1}/8] 오류: ${e.message}`);
      process.exit(1);
    }
  }

  console.log('완료');
}

// 직접 실행할 때만 main 을 돈다(시험이 parseSeedArg 를 import 할 수 있도록).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error('예기치 않은 오류:', e);
    process.exit(1);
  });
}
