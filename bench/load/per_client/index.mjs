// T16.3 per-client stats: perClientFromEvents(events, clients) -> perClient[].
// Aggregates bytes and latency by client from event log.
// Returns array of exactly clients entries, indexed by id, with bytes sum and latencyMs array.
// Throws if a client has no bytes events.

export function perClientFromEvents(events, clients) {
  const perClient = Array(clients);

  for (let id = 0; id < clients; id++) {
    const clientEvents = events.filter((e) => e.id === id && e.kind === 'bytes');

    if (clientEvents.length === 0) {
      throw new Error(`client ${id} has no bytes events`);
    }

    const bytes = clientEvents.reduce((sum, e) => sum + e.bytes, 0);
    const latencyMs = clientEvents.map((e) => e.latencyMs);

    perClient[id] = { id, bytes, latencyMs };
  }

  return perClient;
}
