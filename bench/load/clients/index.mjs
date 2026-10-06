// T16.1 mock clients: simulateClients(scenario, { seed }) -> ClientEvent[] (see contracts/load/harness.mjs).
// Pure and deterministic: all randomness comes from rng(seed), time is the event tMs.
import { rng } from '../../../contracts/load/harness.mjs';
import { LEVEL_COUNT } from '../../../contracts/asset/index.mjs';

const CONNECT_JITTER_MS = 200;
const FIRST_LEVEL_MS = 300; // mean delay from connect to level 0
const LEVEL_STEP_MS = 400; // mean gap between successive level arrivals
const LEVEL_BYTES = [4000, 12000, 40000, 120000]; // payload size per level
const BASE_LATENCY_MS = 20;

/** Event log for scenario.clients mock clients, sorted by tMs then id. */
export function simulateClients(scenario, { seed } = {}) {
  const rand = rng(seed ?? 0);
  const closeMs = scenario.durationS * 1000;
  const events = [];
  for (let id = 0; id < scenario.clients; id++) {
    const connect = Math.min(Math.round(rand() * CONNECT_JITTER_MS), Math.floor(closeMs / 10));
    events.push({ id, tMs: connect, kind: 'connect' });
    const burst = scenario.kind === 'burst' ? scenario.burstLevels : 1;
    let t = connect + FIRST_LEVEL_MS * (0.5 + rand());
    for (let level = 0; level < LEVEL_COUNT; level++) {
      // Burst: the first burstLevels levels arrive together; later ones keep the normal spacing.
      if (level >= burst) t += LEVEL_STEP_MS * (0.5 + rand());
      const bytes = Math.round(LEVEL_BYTES[level % LEVEL_BYTES.length] * (0.8 + 0.4 * rand()));
      let latencyMs = BASE_LATENCY_MS + rand() * 80;
      if (scenario.kind === 'slow_link') latencyMs += (bytes / scenario.linkBytesPerS) * 1000;
      latencyMs = Math.round(latencyMs * 10) / 10;
      const tMs = Math.min(Math.round(t + latencyMs), closeMs);
      events.push({ id, tMs, kind: 'bytes', bytes, latencyMs });
      events.push({ id, tMs, kind: 'level', level });
      if (level === 0) events.push({ id, tMs, kind: 'first_frame' });
      t = tMs;
    }
    events.push({ id, tMs: closeMs, kind: 'close' });
  }
  // Array.prototype.sort is stable, so same-time events of one client keep bytes, level, first_frame order.
  return events.sort((a, b) => a.tMs - b.tMs || a.id - b.id);
}
