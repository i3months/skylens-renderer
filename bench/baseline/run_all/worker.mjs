// run_all 이 모듈마다 띄우는 자식 프로세스. 모듈을 import 해 run 을 실행하고 결과를 부모에 보낸다.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

// 모듈이 이벤트 루프를 비워도(영원히 대기) 부모가 타임아웃으로 정리할 때까지 살아 있게 한다.
const keepAlive = setInterval(() => {}, 1 << 30);

// 부모가 죽거나 IPC 가 끊기면 모듈이 outDir 에 계속 쓰지 못하도록 자기 프로세스 그룹째 즉시 종료한다.
process.on('disconnect', () => {
  try { process.kill(-process.pid, 'SIGKILL'); } catch { /* 그룹 리더가 아니면 아래로 */ }
  process.exit(1);
});

// 모듈이 동기 루프(while(true))로 메인 스레드를 막으면 위 'disconnect' 핸들러가 영원히 돌지 못한다.
// 그래서 별도 Worker thread 가 부모 PID 를 주기적으로 확인하고, 부모가 사라지면(재부모화되거나 PID 가 없어짐)
// 프로세스 그룹째 SIGKILL 한다. 한계: 감시 주기(200ms)만큼 지연되고, 부모 PID 가 재사용되는 극히 드문 경우엔
// ppid 변경 검사로만 잡는다. Worker thread 자체가 스케줄되지 못하는 환경(CPU 전부 점유)은 보장하지 못한다.
const WATCHDOG = `
const { workerData } = require('node:worker_threads');
const { parent, self } = workerData;
setInterval(() => {
  let gone = process.ppid !== parent;
  if (!gone) { try { process.kill(parent, 0); } catch (e) { gone = e.code === 'ESRCH'; } }
  if (!gone) return;
  try { process.kill(-self, 'SIGKILL'); } catch {}
  try { process.kill(self, 'SIGKILL'); } catch {}
}, 200);
`;
if (process.platform !== 'win32') {
  const wd = new Worker(WATCHDOG, { eval: true, workerData: { parent: process.ppid, self: process.pid } });
  wd.unref();
}

process.once('message', async ({ modulesDir, name, args }) => {
  process.send({ ready: true });
  let stage = 'import';
  let reply;
  try {
    const mod = await import(pathToFileURL(join(modulesDir, name, 'index.mjs')).href);
    if (typeof mod.run !== 'function') throw new Error('run 함수를 export 하지 않음');
    stage = 'run';
    await mkdir(args.outDir, { recursive: true });
    const list = await mod.run(args);
    if (!Array.isArray(list)) throw new Error('run 이 배열을 반환하지 않음');
    assertRecords(list);
    reply = { ok: true, list };
  } catch (e) {
    reply = { ok: false, stage, error: e instanceof Error ? e.message : String(e) };
  }
  clearInterval(keepAlive);
  process.send(reply, () => process.exit(0));
});
