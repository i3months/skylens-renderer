// ws byte recorder: replays a recorded (SYNTHETIC) core->viewer stream over a loopback
// WebSocket on 127.0.0.1 and sums received UTF-8 bytes per payload kind.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize } from '../../../contracts/metrics/index.mjs';

const FIXTURE = fileURLToPath(new URL('./recording.jsonl', import.meta.url));

export function loadRecording(path = FIXTURE) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

const typeOf = (text) => String(JSON.parse(text).payload.kind).replace(/-/g, '_');

/** Replay frames through a local ws server; returns {perType:{type:{bytes,frames}}, totalBytes, frames}. */
export async function replay(skylensDir, frames) {
  const { WebSocketServer, WebSocket } = createRequire(join(skylensDir, 'package.json'))('ws');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const { port } = wss.address();
  wss.on('connection', (sock) => {
    for (const f of frames) sock.send(f);
  });
  const perType = {};
  let totalBytes = 0;
  let count = 0;
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    client.on('error', reject);
    client.on('message', (data, isBinary) => {
      const text = data.toString('utf8');
      const bytes = data.length;
      const t = isBinary ? 'binary' : typeOf(text);
      const e = (perType[t] ??= { bytes: 0, frames: 0 });
      e.bytes += bytes;
      e.frames += 1;
      totalBytes += bytes;
      if (++count === frames.length) resolve();
    });
  });
  client.close();
  await new Promise((r) => wss.close(r));
  return { perType, totalBytes, frames: count };
}

export async function run({ skylensDir, outDir, commit }) {
  const result = await replay(skylensDir, loadRecording());
  const base = { unit: 'B', device: 'loopback-127.0.0.1', method: 'ws replay of synthetic recorded fixture, sum of received frame bytes', commit };
  const records = Object.keys(result.perType).sort().map((t) => ({ metric: `ws.${t}.bytes`, value: result.perType[t].bytes, ...base }));
  records.push({ metric: 'ws.total.bytes', value: result.totalBytes, ...base });
  records.push({ metric: 'ws.frames', value: result.frames, ...base, unit: 'count' });
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'ws_bytes.json'), serialize(records));
  }
  return records;
}
