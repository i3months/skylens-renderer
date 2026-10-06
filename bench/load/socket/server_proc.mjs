// Spawns server_main.mjs with an OS-chosen port and resolves once it prints `listening <port>`.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ENV_HOST, ENV_PORT } from '../../../server/ws/index.mjs';

const MAIN = fileURLToPath(new URL('./server_main.mjs', import.meta.url));
const START_TIMEOUT_MS = 10000;
const KILL_AFTER_MS = 3000;

export function startServerProcess({ host, env = {}, mainPath = MAIN, startTimeoutMs = START_TIMEOUT_MS, killAfterMs = KILL_AFTER_MS } = {}) {
  if (!host) return Promise.reject(new TypeError('host is required'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mainPath], {
      env: { ...process.env, ...env, [ENV_HOST]: host, [ENV_PORT]: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Kept open for the child's lifetime: its closing (parent death) is the child's cue to exit.
    child.stdin.on('error', () => {});
    let exited = false;
    let settled = false;
    let out = '';
    let err = '';
    const exitWaiters = [];
    const timer = setTimeout(() => {
      fail(new Error(`server process did not print a listening line within ${startTimeoutMs} ms`));
    }, startTimeoutMs);

    function fail(e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!exited) child.kill('SIGKILL');
      reject(e);
    }
    child.on('error', (e) => fail(new Error(`server process failed to start: ${e.message}`)));
    child.on('exit', (code, signal) => {
      exited = true;
      for (const w of exitWaiters) w();
      fail(new Error(`server process exited before listening (code ${code}, signal ${signal})${err ? `: ${err.trim()}` : ''}`));
    });
    child.stderr.on('data', (d) => { err += d; if (err.length > 8192) err = err.slice(-8192); });
    child.stdout.on('data', (d) => {
      if (settled) return;
      out += d;
      const m = /^listening (\d+)$/m.exec(out);
      if (!m) return;
      settled = true;
      clearTimeout(timer);
      const waitExit = () => (exited ? Promise.resolve() : new Promise((r) => exitWaiters.push(r)));
      let stopping = null;
      resolve({
        port: Number(m[1]),
        pid: child.pid,
        stop() {
          if (!stopping) {
            stopping = (async () => {
              if (exited) return;
              const kt = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, killAfterMs);
              child.kill('SIGTERM');
              await waitExit();
              clearTimeout(kt);
            })();
          }
          return stopping;
        },
      });
    });
  });
}
