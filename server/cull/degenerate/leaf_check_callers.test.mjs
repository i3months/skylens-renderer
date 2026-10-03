import { strict as assert } from 'assert';
import { test } from 'node:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const cullingRootDir = join(__dirname, '..');

const REQUIRED_STAGES = ['frustum', 'distance', 'predict', 'occlusion', 'priority'];

// Matches static import/export-from statements and dynamic import() of leaf_check.mjs.
const LEAF_CHECK_IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*['"][^'"]*\/leaf_check\.mjs['"]|(?:^|\n)\s*import\s*['"][^'"]*\/leaf_check\.mjs['"]|\bimport\s*\(\s*['"][^'"]*\/leaf_check\.mjs['"]\s*\)/;

// Returns file content, or null only when the file does not exist. Other errors propagate.
function readIfExists(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

// Read all stage directories
const stageNames = readdirSync(cullingRootDir).filter(
  (name) => statSync(join(cullingRootDir, name)).isDirectory() && name !== 'degenerate',
);

// Find modules that import leaf_check.mjs
const importingModules = new Map(); // stageName -> filePath

for (const stageName of stageNames) {
  const indexPath = join(cullingRootDir, stageName, 'index.mjs');
  const content = readIfExists(indexPath);
  if (content !== null && LEAF_CHECK_IMPORT_RE.test(content)) {
    importingModules.set(stageName, indexPath);
  }
}

// Also check client/cull/index.mjs (optional: it may not import leaf_check)
const clientDir = join(cullingRootDir, '..', '..', 'client');
const clientCullPath = join(clientDir, 'cull', 'index.mjs');
const clientContent = readIfExists(clientCullPath);
if (clientContent !== null && LEAF_CHECK_IMPORT_RE.test(clientContent)) {
  importingModules.set('client', clientCullPath);
}

// Read leaf_check.mjs header
const leafCheckPath = join(__dirname, 'leaf_check.mjs');
const leafCheckContent = readFileSync(leafCheckPath, 'utf-8');
const headerEndIndex = leafCheckContent.indexOf('\n\n');
const header = headerEndIndex === -1 ? leafCheckContent : leafCheckContent.substring(0, headerEndIndex);

// 단계 이름 목록이 비어있지 않음을 확인 (leaf_check.mjs 에서 frustum·distance·predict·occlusion·priority 5개 필요)
test('stageNames is not empty', () => {
  assert(stageNames.length >= 5, `Expected at least 5 stage names, but got ${stageNames.length}`);
});

test('client directory path exists', () => {
  assert(existsSync(clientDir), `client directory not found: ${clientDir}`);
  assert(existsSync(join(clientDir, 'cull')), 'client/cull directory not found');
});

test('importingModules contains all required stages', () => {
  for (const stage of REQUIRED_STAGES) {
    assert(importingModules.has(stage), `stage "${stage}" must import leaf_check.mjs (found: ${[...importingModules.keys()].sort().join(', ') || 'none'})`);
  }
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
