// run_all 이 모듈마다 띄우는 자식 프로세스. 모듈을 import 해 run 을 실행하고 결과를 부모에 보낸다.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

// 모듈이 이벤트 루프를 비워도(영원히 대기) 부모가 타임아웃으로 정리할 때까지 살아 있게 한다.
const keepAlive = setInterval(() => {}, 1 << 30);

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
