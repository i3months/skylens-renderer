import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
    const deadline = Date.now() + 2500;
    while (alive(childPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(childPid), false);
  } finally {
    parent.kill('SIGKILL');
    if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
  }
});
