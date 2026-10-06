import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { randomBytes } from 'node:crypto';
import { startServerProcess } from './server_proc.mjs';
import { LEVEL_PAYLOAD_BYTES, SOCKET_HOST } from './contract.mjs';
import { FrameParser } from '../../../server/ws/frame/index.mjs';

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('server process serves the level payloads and stops cleanly', async () => {
  const proc = await startServerProcess({ host: SOCKET_HOST });
  let sock = null;
  try {
    assert.ok(Number.isInteger(proc.port) && proc.port > 0);
    assert.ok(alive(proc.pid));
    sock = net.connect({ host: SOCKET_HOST, port: proc.port });
    const sizes = await new Promise((resolve, reject) => {
      const parser = new FrameParser({ requireMask: false });
      const got = [];
      let head = Buffer.alloc(0);
      let upgraded = false;
      const timer = setTimeout(() => reject(new Error('timeout waiting for frames')), 8000);
      const done = (v, e) => { clearTimeout(timer); if (e) reject(e); else resolve(v); };
      sock.on('error', (e) => done(null, e));
      sock.on('close', () => { if (got.length < LEVEL_PAYLOAD_BYTES.length) done(null, new Error('closed early')); });
      sock.on('connect', () => {
        sock.write('GET / HTTP/1.1\r\nHost: test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
          + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      sock.on('data', (chunk) => {
        let data = chunk;
        if (!upgraded) {
          head = Buffer.concat([head, chunk]);
          const i = head.indexOf('\r\n\r\n');
          if (i < 0) return;
          if (!/^HTTP\/1\.1 101/.test(head.subarray(0, i).toString('latin1'))) return done(null, new Error('handshake not accepted'));
          upgraded = true;
          data = head.subarray(i + 4);
        }
        for (const ev of parser.push(data)) {
          if (ev.type === 'error') return done(null, new Error(`frame error ${ev.code}`));
          if (ev.type === 'message') got.push(ev.data.length);
        }
        if (got.length >= LEVEL_PAYLOAD_BYTES.length) done(got);
      });
    });
    assert.deepEqual(sizes, [...LEVEL_PAYLOAD_BYTES]);
  } finally {
    sock?.destroy();
    await proc.stop();
  }
  assert.equal(alive(proc.pid), false);
});

test('startServerProcess rejects when the child exits early', async () => {
  await assert.rejects(
    startServerProcess({ host: SOCKET_HOST, env: { NODE_OPTIONS: '--no-such-flag-xyz' } }),
    /exited before listening/,
  );
});

test('the server child exits when its parent is killed', async () => {
  const mod = fileURLToPath(new URL('./server_proc.mjs', import.meta.url));
  const code = `import(${JSON.stringify(mod)}).then(async (m) => { const p = await m.startServerProcess({ host: '127.0.0.1' }); console.log('pid ' + p.pid); setInterval(() => {}, 1000); });`;
  const parent = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  let childPid;
  try {
    childPid = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('no child pid')), 8000);
      parent.stdout.on('data', (d) => {
        out += d;
        const m = /pid (\d+)/.exec(out);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
      parent.on('exit', () => reject(new Error('parent exited early')));
    });
    assert.ok(alive(childPid));
    parent.kill('SIGTERM');
    // Death is normally near-instant; the generous limit only absorbs a loaded CI host, polling returns as soon as it dies.
    const deadline = Date.now() + 20000;
    while (alive(childPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(childPid), false);
  } finally {
    parent.kill('SIGKILL');
    if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = async (p, ms) => {
  let timer;
  const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`still pending after ${ms} ms`)), ms); });
  try { return await Promise.race([p, limit]); } finally { clearTimeout(timer); }
};
const until = async (cond, limitMs) => {
  const end = Date.now() + limitMs;
  while (!cond() && Date.now() < end) await sleep(20);
};

function fakeMain(body) {
  const dir = mkdtempSync(join(tmpdir(), 'server_proc_'));
  const mainPath = join(dir, 'fake_main.mjs');
  const pidFile = join(dir, 'pid');
  writeFileSync(mainPath, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n${body}\nsetInterval(() => {}, 1000);\n`);
  return { dir, mainPath, pidFile, pid: () => Number(readFileSync(pidFile, 'utf8')) };
}

test('startServerProcess rejects within the timeout and kills a silent child', async () => {
  const f = fakeMain('');
  let pid;
  try {
    const t0 = Date.now();
    await assert.rejects(within(startServerProcess({ host: SOCKET_HOST, mainPath: f.mainPath, startTimeoutMs: 600 }), 5000), (e) => { pid = e.pid; return /did not print a listening line within 600 ms/.test(e.message); });
    assert.ok(Date.now() - t0 < 600 + 1500);
    assert.ok(Number.isInteger(pid));
    await until(() => !alive(pid), 5000);
    assert.equal(alive(pid), false);
  } finally {
    try { process.kill(pid, 'SIGKILL'); } catch {}
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('the start timeout SIGKILLs a silent child that ignores SIGTERM', async () => {
  const f = fakeMain("process.on('SIGTERM', () => {});");
  let pid;
  try {
    await assert.rejects(within(startServerProcess({ host: SOCKET_HOST, mainPath: f.mainPath, startTimeoutMs: 600 }), 5000), (e) => { pid = e.pid; return /did not print a listening line/.test(e.message); });
    assert.ok(Number.isInteger(pid));
    await until(() => !alive(pid), 5000);
    assert.equal(alive(pid), false);
  } finally {
    try { process.kill(pid, 'SIGKILL'); } catch {}
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('stop() falls back to SIGKILL when the child ignores SIGTERM', async () => {
  const f = fakeMain("process.on('SIGTERM', () => {});\nconsole.log('listening 1');");
  let proc = null;
  try {
    proc = await startServerProcess({ host: SOCKET_HOST, mainPath: f.mainPath, killAfterMs: 400 });
    await until(() => { try { f.pid(); return true; } catch { return false; } }, 5000);
    const t0 = Date.now();
    await within(proc.stop(), 5000);
    assert.ok(Date.now() - t0 < 400 + 1500);
    assert.equal(alive(proc.pid), false);
  } finally {
    if (proc && alive(proc.pid)) process.kill(proc.pid, 'SIGKILL');
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('startServerProcess rejects invalid timeouts with a RangeError and spawns nothing', async () => {
  const f = fakeMain("console.log('listening 1');");
  try {
    for (const opt of [{ startTimeoutMs: NaN }, { startTimeoutMs: -1 }, { startTimeoutMs: 0 }, { startTimeoutMs: Infinity },
      { killAfterMs: NaN }, { killAfterMs: -5 }, { killAfterMs: 0 }, { killAfterMs: Infinity }]) {
      await assert.rejects(startServerProcess({ host: SOCKET_HOST, mainPath: f.mainPath, ...opt }), RangeError, JSON.stringify(opt));
    }
    await sleep(300);
    assert.throws(() => readFileSync(f.pidFile), { code: 'ENOENT' });
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

const timeouts = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
const settle = () => new Promise((r) => setImmediate(r));

test('startServerProcess, stop() and within() leave no pending timers behind', async () => {
  const f = fakeMain("console.log('listening 1');");
  try {
    await settle();
    const before = timeouts();
    const proc = await within(startServerProcess({ host: SOCKET_HOST, mainPath: f.mainPath }), 5000);
    await within(proc.stop(), 5000);
    await settle();
    assert.equal(timeouts(), before);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('invalid options are rejected before child_process.spawn is called', async () => {
  const require = createRequire(import.meta.url);
  const cp = require('node:child_process');
  const real = cp.spawn;
  let calls = 0;
  cp.spawn = (...args) => { calls++; return real(...args); };
  syncBuiltinESMExports();
  try {
    for (const opt of [{ startTimeoutMs: NaN }, { killAfterMs: NaN }, { startTimeoutMs: -1 }]) {
      await assert.rejects(startServerProcess({ host: SOCKET_HOST, ...opt }), RangeError, JSON.stringify(opt));
    }
    assert.equal(calls, 0);
  } finally {
    cp.spawn = real;
    syncBuiltinESMExports();
  }
});
