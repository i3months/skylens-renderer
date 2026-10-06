// T16.6 burst: shown levels come from the product level machine (client/levels), checked against the measured arrivals.
// Same-instant choice: arrivals of one client at one tMs are fed highest level first, so the machine's own decideArrival
// skips the lower ones (one show per instant); the harness only orders the input and never computes a max itself.
// This is a harness policy, not product behavior: fed in ascending order the same machine would show every level of the
// instant, so the order is fixed here to keep "one show per instant, the highest" a property of the checked log.
import { createLevelMachine } from '../../../client/levels/index.mjs';
import { ACTIONS } from '../../../contracts/levels/index.mjs';
import { LEVEL_COUNT } from '../../../contracts/asset/index.mjs';
import { validateScenario, MAX_CLIENTS } from '../../../contracts/load/index.mjs';
import { simulateClients } from '../clients/index.mjs';

const SEGMENT = 0;

const validId = (id, clients) => Number.isInteger(id) && id >= 0 && id < clients;
const validLevel = (level, limit) => Number.isInteger(level) && level >= 0 && level < limit;

/** Stable sort by tMs, then id (original order kept for ties). */
function byTimeThenId(list) {
  return list.map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.tMs - b.e.tMs || a.e.id - b.e.id || a.i - b.i)
    .map((x) => x.e);
}

/**
 * Feeds the 'level' events into one product level machine per client and returns what it accepts.
 * Events with an id outside 0..clients-1 or a level the machine cannot take are not shown (the checker reports them).
 */
export function showFromArrivals(events, clients) {
  if (!Array.isArray(events)) throw new Error('events must be an array');
  if (!(Number.isInteger(clients) && clients >= 1 && clients <= MAX_CLIENTS)) {
    throw new Error(`clients must be an integer in 1..${MAX_CLIENTS}`);
  }
  const arrivals = byTimeThenId(events.filter((e) => e && e.kind === 'level' && validId(e.id, clients)
    && Number.isFinite(e.tMs) && validLevel(e.level, LEVEL_COUNT)));
  const machines = new Map();
  const shown = [];
  let i = 0;
  while (i < arrivals.length) {
    let j = i;
    while (j < arrivals.length && arrivals[j].id === arrivals[i].id && arrivals[j].tMs === arrivals[i].tMs) j++;
    // One instant of one client: highest level first, so lower same-instant levels are skipped by the machine.
    const group = arrivals.slice(i, j).map((e, k) => ({ e, k })).sort((a, b) => b.e.level - a.e.level || a.k - b.k);
    const { id, tMs } = arrivals[i];
    if (!machines.has(id)) machines.set(id, createLevelMachine());
    const machine = machines.get(id);
    for (const { e } of group) {
      const { action } = machine.arrive(SEGMENT, e.level);
      if (action === ACTIONS.FIRST || action === ACTIONS.REPLACE) shown.push({ id, tMs, level: e.level });
    }
    i = j;
  }
  return shown;
}

function entryErrors(what, e, scenario) {
  const errs = [];
  if (!validId(e?.id, scenario.clients)) errs.push(`${what}: id ${e?.id} out of range 0..${scenario.clients - 1}`);
  if (!Number.isFinite(e?.tMs)) errs.push(`${what}: client ${e?.id} tMs ${e?.tMs} not finite`);
  if (!validLevel(e?.level, scenario.burstLevels)) errs.push(`${what}: client ${e?.id} level ${e?.level} at ${e?.tMs}ms out of range 0..${scenario.burstLevels - 1}`);
  return errs;
}

function groupById(list, clients) {
  const groups = Array.from({ length: clients }, () => []);
  for (const e of list) groups[e.id].push(e);
  return groups;
}

/**
 * Level events of a measured log that belong to the burst check. Levels the scenario places after the burst
 * (burstLevels..LEVEL_COUNT-1) are outside it; anything else invalid stays in and is reported by the checker.
 */
export function burstArrivals(events, burstLevels) {
  return events
    .filter((e) => e && e.kind === 'level')
    .filter((e) => !(Number.isInteger(e.level) && e.level >= burstLevels && e.level < LEVEL_COUNT));
}

/** Returns violation strings for a shown log against the arrivals of the same measured log; empty means valid. */
export function checkBurstInvariants(arrivals, shown, scenario) {
  if (scenario === null || typeof scenario !== 'object') throw new Error('checkBurstInvariants needs a scenario object');
  if (!(Number.isInteger(scenario.clients) && scenario.clients >= 1 && scenario.clients <= MAX_CLIENTS)) {
    throw new Error(`scenario.clients must be an integer in 1..${MAX_CLIENTS}`);
  }
  if (!(Number.isInteger(scenario.burstLevels) && scenario.burstLevels >= 1 && scenario.burstLevels <= LEVEL_COUNT)) {
    throw new Error(`scenario.burstLevels must be an integer in 1..${LEVEL_COUNT}`);
  }
  if (!Array.isArray(arrivals)) throw new Error('arrivals must be an array');
  if (!Array.isArray(shown)) throw new Error('shown must be an array');
  const errs = [];
  const keep = (what, list) => list.filter((e) => {
    const bad = entryErrors(what, e, scenario);
    errs.push(...bad);
    return bad.length === 0;
  });
  const arrById = groupById(byTimeThenId(keep('arrival', arrivals)), scenario.clients);
  const shownById = groupById(byTimeThenId(keep('shown', shown)), scenario.clients);

  for (let id = 0; id < scenario.clients; id++) {
    const a = arrById[id];
    const s = shownById[id];
    if (a.length === 0) errs.push(`client ${id}: no burst arrivals`);
    if (a.length > 0 && s.length === 0) {
      errs.push(`client ${id}: levels arrived but never shown`);
      continue;
    }
    const times = [...new Set([...a, ...s].map((e) => e.tMs))].sort((x, y) => x - y);
    const arrived = new Set();
    let maxArrived = -1;
    let maxShown = -1;
    let ai = 0;
    let si = 0;
    for (const t of times) {
      const before = maxArrived;
      while (ai < a.length && a[ai].tMs === t) {
        arrived.add(a[ai].level);
        maxArrived = Math.max(maxArrived, a[ai].level);
        ai++;
      }
      const now = [];
      while (si < s.length && s[si].tMs === t) now.push(s[si++]);
      if (now.length > 1) errs.push(`client ${id}: shown ${now.length} times at ${t}ms`);
      for (const e of now) {
        if (!arrived.has(e.level)) {
          const later = a.find((x) => x.level === e.level);
          errs.push(later
            ? `client ${id}: level ${e.level} shown at ${t}ms before it arrived at ${later.tMs}ms`
            : `client ${id}: level ${e.level} at ${t}ms never arrived`);
        } else if (e.level < maxArrived) {
          errs.push(`client ${id}: level ${e.level} at ${t}ms shown while level ${maxArrived} had arrived`);
        }
        if (e.level < maxShown) errs.push(`client ${id}: level ${e.level} at ${t}ms shown after level ${maxShown}`);
        else if (e.level === maxShown) errs.push(`client ${id}: level ${e.level} at ${t}ms shown again`);
        maxShown = Math.max(maxShown, e.level);
      }
      if (maxArrived > before && !now.some((e) => e.level === maxArrived)) {
        errs.push(`client ${id}: level ${maxArrived} arrived at ${t}ms but was not shown`);
      }
    }
  }
  return errs;
}

/**
 * Burst run over the measured simulateClients log. Arrivals are its 'level' events narrowed by burstArrivals.
 */
export function simulateBurst(scenario, { seed }) {
  const bad = validateScenario(scenario);
  if (bad.length > 0) throw new Error(`invalid scenario: ${bad.join(', ')}`);
  if (scenario.kind !== 'burst') throw new Error('simulateBurst needs a burst scenario');
  const events = simulateClients(scenario, { seed });
  const arrivals = burstArrivals(events, scenario.burstLevels)
    .map(({ id, tMs, level }) => ({ id, tMs, level }));
  const shown = showFromArrivals(arrivals.map((e) => ({ ...e, kind: 'level' })), scenario.clients);
  return { arrivals, shown, violations: checkBurstInvariants(arrivals, shown, scenario) };
}
