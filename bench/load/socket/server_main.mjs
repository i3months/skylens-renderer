// Child-process entry for the real-socket load run (see contract.mjs). Reads SKYLENS_WS_HOST / SKYLENS_WS_PORT,
// serves LEVEL_PAYLOAD_BYTES as one binary message per level right after the upgrade, prints `listening <port>`.
import { createWsServer, loadConfig } from '../../../server/ws/index.mjs';
import { LEVEL_PAYLOAD_BYTES } from './contract.mjs';

const { host, port } = loadConfig(process.env);
const payloads = LEVEL_PAYLOAD_BYTES.map((n, i) => new Uint8Array(n).fill(i + 1));

const ws = await createWsServer({
  host,
  port,
  onConnection(conn) {
    for (const p of payloads) conn.send(p);
    conn.onMessage(() => {});
    conn.onClose(() => {});
  },
  onError() {},
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  ws.close().then(() => process.exit(0), () => process.exit(0));
}
process.on('SIGTERM', shutdown);
// The parent holds the write end of our stdin; when it dies (any way) the pipe closes and we exit too.
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.stdin.on('error', shutdown);
process.stdin.resume();

process.stdout.write(`listening ${ws.address().port}\n`);
