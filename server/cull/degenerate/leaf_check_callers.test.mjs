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

// 블록 주석(/* */), 줄 주석(//), 템플릿 문자열(`) 내용을 제거한 뒤 정규식을 적용한다.
// import 가 주석이나 템플릿 문자열 안에 있으면 일치하지 않는다.
function stripCommentsAndTemplates(content) {
  let result = '';
  let i = 0;
  while (i < content.length) {
    // 블록 주석 /* ... */
    if (content[i] === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < content.length) {
        if (content[i] === '*' && content[i + 1] === '/') {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }
    // 줄 주석 // ...
    if (content[i] === '/' && content[i + 1] === '/') {
      i += 2;
      while (i < content.length && content[i] !== '\n') {
        i++;
      }
      if (i < content.length) result += '\n';
      i++;
      continue;
    }
    // 템플릿 문자열 ` ... `
    if (content[i] === '`') {
      i++;
      while (i < content.length) {
        if (content[i] === '\\') {
          i += 2;
          continue;
        }
        if (content[i] === '`') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // 정규 문자열 ' ... ' 또는 " ... " (내용 유지, 주석·템플릿만 제거)
    if (content[i] === '"' || content[i] === "'") {
      const quote = content[i];
      result += content[i];
      i++;
      while (i < content.length) {
        if (content[i] === '\\') {
          result += content[i];
          i++;
          if (i < content.length) {
            result += content[i];
            i++;
          }
          continue;
        }
        if (content[i] === quote) {
          result += content[i];
          i++;
          break;
        }
        result += content[i];
        i++;
      }
      continue;
    }
    result += content[i];
    i++;
  }
  return result;
}

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
  if (content !== null && LEAF_CHECK_IMPORT_RE.test(stripCommentsAndTemplates(content))) {
    importingModules.set(stageName, indexPath);
  }
}

// Also check client/cull/index.mjs (optional: it may not import leaf_check)
const clientDir = join(cullingRootDir, '..', '..', 'client');
const clientCullPath = join(clientDir, 'cull', 'index.mjs');
const clientContent = readIfExists(clientCullPath);
if (clientContent !== null && LEAF_CHECK_IMPORT_RE.test(stripCommentsAndTemplates(clientContent))) {
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

// 변이 검증: 주석 처리된 import 는 매칭되지 않음
test('mutation: commented-out imports are not matched by regex', () => {
  // frustum 모듈을 대상으로 임시 사본을 만들어 import 를 주석 처리
  const frustumPath = join(cullingRootDir, 'frustum', 'index.mjs');
  const originalContent = readFileSync(frustumPath, 'utf-8');

  // import 를 /* */ 로 감싼 주석 처리 버전
  const commentedContent = originalContent.replace(
    /^(\s*)import\s*{[^}]*}\s*from\s*['"][^'"]*\/leaf_check\.mjs['"];?/m,
    (match) => '/* ' + match + ' */'
  );

  // 변이가 제대로 만들어졌는지 확인 (원본과 달라야 함)
  assert(commentedContent !== originalContent, '변이 콘텐츠가 생성되지 않음');

  // 댓글 처리된 버전은 매칭되지 않아야 함
  assert(
    !LEAF_CHECK_IMPORT_RE.test(stripCommentsAndTemplates(commentedContent)),
    '주석 처리된 import 가 여전히 매칭됨 (버그)'
  );

  // 원본은 여전히 매칭되어야 함
  assert(
    LEAF_CHECK_IMPORT_RE.test(stripCommentsAndTemplates(originalContent)),
    '원본 import 가 매칭되지 않음 (회귀)'
  );
});

// 변이 검증: 템플릿 문자열 안의 import 는 매칭되지 않음
test('mutation: imports inside template strings are not matched by regex', () => {
  const frustumPath = join(cullingRootDir, 'frustum', 'index.mjs');
  const originalContent = readFileSync(frustumPath, 'utf-8');

  // import 를 템플릿 문자열 안으로 옮긴 버전
  const templateContent = originalContent.replace(
    /^(\s*)import\s*{[^}]*}\s*from\s*['"][^'"]*\/leaf_check\.mjs['"];?/m,
    (match) => `const dummy = \`${match}\`;`
  );

  // 변이가 제대로 만들어졌는지 확인
  assert(templateContent !== originalContent, '변이 콘텐츠가 생성되지 않음');

  // 템플릿 문자열 버전은 매칭되지 않아야 함
  assert(
    !LEAF_CHECK_IMPORT_RE.test(stripCommentsAndTemplates(templateContent)),
    '템플릿 문자열의 import 가 여전히 매칭됨 (버그)'
  );

  // 원본은 여전히 매칭되어야 함
  assert(
    LEAF_CHECK_IMPORT_RE.test(stripCommentsAndTemplates(originalContent)),
    '원본 import 가 매칭되지 않음 (회귀)'
  );
});
