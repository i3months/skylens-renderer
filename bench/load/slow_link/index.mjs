// T16.7 slow-link simulation: one FIFO sender queue per client, drained at scenario.linkBytesPerS.
// Pure function over a seed; no sockets, no wall clock. Backpressure pauses the producer; a payload still
// blocked on backpressure at close is discarded (dropped). Bytes still queued at close are undelivered.
import { rng, validateEvent } from '../../../contracts/load/harness.mjs';
import { validateScenario } from '../../../contracts/load/index.mjs';

export const QUEUE_LIMIT_BYTES = 262144;
const MIN_PAYLOAD = 4096;
const MAX_PAYLOAD = 40960;
const MIN_GAP_MS = 100;
const MAX_GAP_MS = 300;

/** Simulates one client; returns its events, peak queue size, bytes still queued at close and bytes dropped. */
function simulateClient(id, scenario, random) {
  const closeMs = scenario.durationS * 1000;
  const rate = scenario.linkBytesPerS / 1000; // bytes per ms
  const events = [{ id, tMs: 0, kind: 'connect' }];
  const pending = []; // FIFO of { size, deliverMs } still in the queue (whole payload counts until delivered)
  let queued = 0;
  let linkFreeMs = 0;
  let maxQueue = 0;
  let firstDone = false;
  let undelivered = 0;
  let dropped = 0;
  let wantMs = MIN_GAP_MS + random() * (MAX_GAP_MS - MIN_GAP_MS);

  while (wantMs < closeMs) {
    const size = MIN_PAYLOAD + Math.floor(random() * (MAX_PAYLOAD - MIN_PAYLOAD + 1));
    const gap = MIN_GAP_MS + random() * (MAX_GAP_MS - MIN_GAP_MS);
    let t = wantMs;
    while (pending.length > 0 && pending[0].deliverMs <= t) queued -= pending.shift().size;
    // Backpressure: wait for the oldest payloads to finish until the new one fits. deliverMs is strictly
    // increasing along the FIFO, so once the loop ends every remaining entry is still undelivered at t.
    while (queued + size > QUEUE_LIMIT_BYTES && pending.length > 0) {
      const head = pending.shift();
      queued -= head.size;
      t = Math.max(t, head.deliverMs);
    }
    if (t >= closeMs) { dropped += size; break; }
    const deliverMs = Math.max(t, linkFreeMs) + size / rate;
    linkFreeMs = deliverMs;
    pending.push({ size, deliverMs });
    queued += size;
    if (queued > maxQueue) maxQueue = queued;
    if (deliverMs < closeMs) {
      events.push({ id, tMs: deliverMs, kind: 'bytes', bytes: size, latencyMs: deliverMs - wantMs });
      if (!firstDone) { events.push({ id, tMs: deliverMs, kind: 'first_frame' }); firstDone = true; }
    } else undelivered += size;
    wantMs = t + gap;
  }
  events.push({ id, tMs: closeMs, kind: 'close' });
  return { events, maxQueue, undelivered, dropped };
}

/** simulateSlowLink(scenario, { seed }) -> { events, maxQueueBytes, undeliveredBytes, dropped }. */
export function simulateSlowLink(scenario, { seed } = {}) {
  const errs = validateScenario(scenario);
  if (!(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff)) throw new Error('seed must be an integer in 0..2^32-1');
  if (errs.length > 0) throw new Error(`invalid scenario: ${errs.join('; ')}`);
  if (scenario.kind !== 'slow_link') throw new Error('scenario kind must be slow_link');
  const events = [];
  let maxQueueBytes = 0;
  let undeliveredBytes = 0;
  let dropped = 0;
  for (let id = 0; id < scenario.clients; id++) {
    const r = simulateClient(id, scenario, rng((seed + Math.imul(id + 1, 0x9e3779b1)) >>> 0));
    for (const e of r.events) events.push(e);
    undeliveredBytes += r.undelivered;
    dropped += r.dropped;
    if (r.maxQueue > maxQueueBytes) maxQueueBytes = r.maxQueue;
  }
  events.sort((a, b) => a.tMs - b.tMs || a.id - b.id); // stable: keeps bytes before first_frame
  for (const e of events) {
    const v = validateEvent(e, scenario.clients);
    if (v.length > 0) throw new Error(`invalid event: ${v.join('; ')}`);
  }
  return { events, maxQueueBytes, undeliveredBytes, dropped };
}
