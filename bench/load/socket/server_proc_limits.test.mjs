import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServerProcess } from './server_proc.mjs';

const HOST = '127.0.0.1';

function marker() {
  const dir = mkdtempSync(join(tmpdir(), 'sp-limits-'));
  const mark = join(dir, 'spawned');
  const mainPath = join(dir, 'main.mjs');
  writeFileSync(mainPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(mark)}, '1'); console.log('listening 1'); process.stdin.resume();`);
  return { dir, mark, mainPath };
}

test('timeouts above 2**31-1 throw RangeError before spawning', { timeout: 10000 }, async () => {
  const f = marker();
  try {
    for (const opt of [{ startTimeoutMs: 2 ** 31 }, { killAfterMs: 2 ** 31 }]) {
      await assert.rejects(async () => {
        const proc = await startServerProcess({ host: HOST, mainPath: f.mainPath, ...opt });
        // Validation is missing: stop the child so it cannot keep this process alive, then fail.
        await proc.stop();
        assert.fail(`startServerProcess resolved instead of throwing RangeError for ${JSON.stringify(opt)}`);
      }, RangeError, JSON.stringify(opt));
    }
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(existsSync(f.mark), false);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('2**31-1 is accepted by validation', { timeout: 10000 }, async () => {
  const f = marker();
  let proc;
  try {
    proc = await startServerProcess({ host: HOST, mainPath: f.mainPath, startTimeoutMs: 2 ** 31 - 1, killAfterMs: 2 ** 31 - 1 });
    assert.ok(Number.isInteger(proc.pid));
    assert.equal(existsSync(f.mark), true);
  } finally {
    if (proc) await proc.stop();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
