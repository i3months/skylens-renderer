// T16.3 per-client stats: perClientFromEvents(events, clients) -> perClient[].
// Aggregates bytes and latency by client from the event log, ordered by id.
// A client that received no bytes has no schema-valid entry (validateResult rejects an empty
// latencyMs), so it is left out of the array instead of throwing or being faked with a
// placeholder; unreachableClients(events, clients) reports those ids so the runner can
// record them as violations.
import { MAX_CLIENTS } from '../../../contracts/load/index.mjs';

function checkClients(clients) {
  if (!(Number.isInteger(clients) && clients >= 1 && clients <= MAX_CLIENTS)) {
    throw new RangeError(`clients must be an integer in 1..${MAX_CLIENTS}`);
  }
}

function groupBytes(events, clients) {
  checkClients(clients);
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  const groups = Array.from({ length: clients }, () => []);
  for (const e of events) {
    if (e && e.kind === 'bytes' && Number.isInteger(e.id) && e.id >= 0 && e.id < clients) groups[e.id].push(e);
  }
  return groups;
}

export function perClientFromEvents(events, clients) {
  const out = [];
  groupBytes(events, clients).forEach((list, id) => {
    if (list.length === 0) return;
    let bytes = 0;
    const latencyMs = [];
    for (const e of list) { bytes += e.bytes; latencyMs.push(e.latencyMs); }
    out.push({ id, bytes, latencyMs });
  });
  return out;
}

/** Ids (ascending) of clients that received no bytes events. */
export function unreachableClients(events, clients) {
  const ids = [];
  groupBytes(events, clients).forEach((list, id) => { if (list.length === 0) ids.push(id); });
  return ids;
}
