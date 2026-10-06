// T16.1 mock clients: simulateClients(scenario, { seed }) -> ClientEvent[] (see contracts/load/harness.mjs).
// Pure and deterministic: all randomness comes from rng(seed), time is the event tMs.
import { rng } from '../../../contracts/load/harness.mjs';
import { validateScenario } from '../../../contracts/load/index.mjs';
import { LEVEL_COUNT } from '../../../contracts/asset/index.mjs';

const CONNECT_JITTER_MS = 200;
const FIRST_LEVEL_MS = 300; // mean delay from connect to level 0
const LEVEL_STEP_MS = 400; // mean gap between successive level arrivals
const LEVEL_BYTES = [4000, 12000, 40000, 120000]; // payload size per level
const BASE_LATENCY_MS = 20;

/** Event log for scenario.clients mock clients, sorted by tMs then id. Throws on a bad scenario or seed. */
export function simulateClients(scenario, { seed } = {}) {
  const errs = validateScenario(scenario);
  if (errs.length) throw new Error(`invalid scenario: ${errs.join('; ')}`);
  if (!(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff)) throw new Error('seed must be an integer in 0..2^32-1');
  const rand = rng(seed);
  const closeMs = scenario.durationS * 1000;
  const burst = scenario.kind === 'burst' ? scenario.burstLevels : 1;
  const events = [];
  for (let id = 0; id < scenario.clients; id++) {
    const connect = Math.min(Math.round(rand() * CONNECT_JITTER_MS), Math.floor(closeMs / 10));
    events.push({ id, tMs: connect, kind: 'connect' });
    let t = connect + FIRST_LEVEL_MS * (0.5 + rand());
    // Draw payloads for every level; burst levels 0..burst-1 share one arrival time.
    const draws = [];
    for (let level = 0; level < LEVEL_COUNT; level++) {
      if (level >= burst) t += LEVEL_STEP_MS * (0.5 + rand());
      const bytes = Math.round(LEVEL_BYTES[level % LEVEL_BYTES.length] * (0.8 + 0.4 * rand()));
      let latencyMs = BASE_LATENCY_MS + rand() * 80;
      if (scenario.kind === 'slow_link') latencyMs += (bytes / scenario.linkBytesPerS) * 1000;
      draws.push({ bytes, latencyMs: Math.round(latencyMs * 10) / 10, t });
    }
    let prev = 0;
    for (let level = 0; level < LEVEL_COUNT; level++) {
      const d = draws[level];
      let tMs;
      if (level < burst) {
        // Burst group shares one tMs: the largest latency in the group, so no payload arrives before it was due.
        const group = draws.slice(0, burst);
        tMs = Math.round(d.t + Math.max(...group.map((g) => g.latencyMs)));
      } else {
        tMs = Math.round(d.t + d.latencyMs);
      }
      tMs = Math.max(tMs, prev);
      if (tMs > closeMs) break; // arrives after close: not delivered, never clamped to closeMs
      events.push({ id, tMs, kind: 'bytes', bytes: d.bytes, latencyMs: d.latencyMs });
      events.push({ id, tMs, kind: 'level', level });
      if (level === 0) events.push({ id, tMs, kind: 'first_frame' });
      t = tMs;
      prev = tMs;
    }
    events.push({ id, tMs: closeMs, kind: 'close' });
  }
  // Array.prototype.sort is stable, so same-time events of one client keep bytes, level, first_frame order.
  return events.sort((a, b) => a.tMs - b.tMs || a.id - b.id);
}

/**
 * Open connections over time: { max } over the whole log, { min } over the steady window, i.e. the states after the
 * last connect and before the final close time. A client that drops early lowers min below the client count.
 */
export function countOpenConnections(events) {
  let open = 0;
  let max = 0;
  let lastConnect = -1;
  let endMs = 0;
  const states = [];
  for (const e of events) {
    if (e.kind === 'connect') { open++; lastConnect = states.length; }
    else if (e.kind === 'close') { open--; endMs = Math.max(endMs, e.tMs); }
    else continue;
    max = Math.max(max, open);
    states.push({ tMs: e.tMs, open });
  }
  let min = Infinity;
  for (let i = Math.max(lastConnect, 0); i < states.length; i++) {
    if (states[i].tMs < endMs) min = Math.min(min, states[i].open);
  }
  return { min: Number.isFinite(min) ? min : max, max };
}
