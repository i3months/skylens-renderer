import { strict as assert } from 'assert';
import { test } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const cullingRootDir = join(__dirname, '..');

// Read all stage directories
const stageNames = readdirSync(cullingRootDir).filter((name) => {
  const fullPath = join(cullingRootDir, name);
  try {
    return statSync(fullPath).isDirectory() && name !== 'degenerate';
  } catch {
    return false;
  }
});

// Find modules that import leaf_check.mjs
const importingModules = new Map(); // stageName -> filePath

for (const stageName of stageNames) {
  const indexPath = join(cullingRootDir, stageName, 'index.mjs');
  try {
    const content = readFileSync(indexPath, 'utf-8');
    if (content.includes("from '../degenerate/leaf_check.mjs'") ||
        content.includes('from "../degenerate/leaf_check.mjs"') ||
        content.includes('leaf_check')) {
      importingModules.set(stageName, indexPath);
    }
  } catch (e) {
    // File doesn't exist or can't be read, skip
  }
}

// Also check client/cull/index.mjs
const clientCullPath = join(cullingRootDir, '..', 'client', 'cull', 'index.mjs');
try {
  const clientContent = readFileSync(clientCullPath, 'utf-8');
  if (clientContent.includes("from '../degenerate/leaf_check.mjs'") ||
      clientContent.includes('from "../degenerate/leaf_check.mjs"') ||
      clientContent.includes('leaf_check')) {
    importingModules.set('client', clientCullPath);
  }
} catch (e) {
  // File doesn't exist or can't be read, skip
}

// Read leaf_check.mjs header
const leafCheckPath = join(__dirname, 'leaf_check.mjs');
const leafCheckContent = readFileSync(leafCheckPath, 'utf-8');
const headerEndIndex = leafCheckContent.indexOf('\n\n');
const header = leafCheckContent.substring(0, headerEndIndex || 500);

// 단계 이름 목록이 비어있지 않음을 확인 (leaf_check.mjs 에서 frustum·distance·predict·occlusion·priority 5개 필요)
test('stageNames is not empty', () => {
  assert(stageNames.length >= 5, `Expected at least 5 stage names, but got ${stageNames.length}`);
});

// Test: each importing module's stage name must be mentioned in the header
test('leaf_check.mjs header lists all importing stages', () => {
  const missingStages = [];

  for (const stageName of importingModules.keys()) {
    if (!header.includes(stageName)) {
      missingStages.push(stageName);
    }
  }

  if (missingStages.length > 0) {
    const stagesStr = Array.from(importingModules.keys()).sort().join('·');
    throw new Error(
      `leaf_check.mjs header is missing stage names: ${missingStages.join(', ')}. ` +
      `All importing stages (${stagesStr}) must be mentioned in the header comment.`
    );
  }
});
