// 렌더 뷰 CLI. node tools/render_views/cli.mjs <장면이름> <시드> <출력디렉터리>

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENES } from '../../contracts/scenes/index.mjs';
import { renderViews } from './index.mjs';
import { encodePng } from '../scene_preview/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 메인 CLI 진입점
 */
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    console.error('사용법: node tools/render_views/cli.mjs <장면이름> <시드> <출력디렉터리>');
    console.error('장면:', Object.keys(SCENES).join(', '));
    process.exit(1);
  }

  const [sceneName, seedStr, outDir] = args;
  const seed = parseInt(seedStr, 10);

  if (!Number.isInteger(seed) || seed < 0) {
    console.error('오류: <시드>는 음이 아닌 정수여야 합니다');
    process.exit(1);
  }

  if (!Object.prototype.hasOwnProperty.call(SCENES, sceneName)) {
    console.error(`오류: 알 수 없는 장면 '${sceneName}'. 가능한 장면: ${Object.keys(SCENES).join(', ')}`);
    process.exit(1);
  }

  try {
    // 장면 모듈 동적 로드
    const scenePath = join(here, '../../', SCENES[sceneName]);
    const sceneModule = await import(scenePath);

    if (!sceneModule.generate) {
      throw new Error(`${sceneName}: generate 함수가 없음`);
    }

    // 시점 로드
    const viewpointsPath = join(here, '../../fixtures/viewpoints/synthetic.json');
    const viewpointsJson = JSON.parse(await readFile(viewpointsPath, 'utf8'));
    const viewpoints = viewpointsJson.viewpoints;

    if (!viewpoints || viewpoints.length === 0) {
      throw new Error('시점이 없습니다');
    }

    // 점군 생성
    console.log(`장면 생성 중: ${sceneName} (시드 ${seed})...`);
    const sceneResult = sceneModule.generate({ seed, scene: sceneName });
    const cloud = sceneResult.cloud;

    if (!cloud || !cloud.count) {
      throw new Error('점군이 비어있습니다');
    }

    console.log(`점 ${cloud.count}개로 렌더링 중...`);

    // 렌더링
    const results = renderViews(cloud, viewpoints, { pointSizeM: 0.05 });

    if (results.length !== viewpoints.length) {
      throw new Error(`렌더링 결과 개수가 시점 개수와 다름: ${results.length} !== ${viewpoints.length}`);
    }

    // 출력 디렉터리 생성
    await mkdir(outDir, { recursive: true });

    // PNG 저장
    console.log(`${results.length}개 이미지를 ${outDir}에 저장 중...`);
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const vp = viewpoints[i];
      const filename = `view_${vp.id}_${vp.name}.png`;
      const filepath = join(outDir, filename);

      const png = encodePng(result.width, result.height, result.color);
      await writeFile(filepath, png);
      console.log(`  저장됨: ${filename}`);
    }

    console.log('완료!');
  } catch (err) {
    console.error('오류:', err.message);
    process.exit(1);
  }
}

main();
