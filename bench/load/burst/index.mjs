// T16.6 burst simulation: several delay-pattern levels arrive at the same instant.
// Levels replace each other (never accumulate): only the highest arrived level is shown,
// overtaken lower levels are skipped, and nothing that has not arrived is ever shown or filled in.
import { rng } from '../../../contracts/load/harness.mjs';

/** Seeded in-place Fisher-Yates shuffle. */
function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Returns violation strings for a shown log; empty means valid. */
export function checkBurstInvariants(shown, scenario) {
  const errs = [];
  const maxShown = new Map();
  const perInstant = new Map();
  for (const s of shown) {
    if (!(Number.isInteger(s.level) && s.level >= 0 && s.level < scenario.burstLevels)) {
      errs.push(`client ${s.id}: level ${s.level} at ${s.tMs}ms never arrived`);
    } else if (maxShown.has(s.id) && s.level < maxShown.get(s.id)) {
      errs.push(`client ${s.id}: level ${s.level} at ${s.tMs}ms shown after level ${maxShown.get(s.id)}`);
    }
    if (Number.isInteger(s.level) && s.level > (maxShown.get(s.id) ?? -1)) maxShown.set(s.id, s.level);
    const key = `${s.id}@${s.tMs}`;
    perInstant.set(key, (perInstant.get(key) ?? 0) + 1);
  }
  for (const [key, n] of perInstant) {
    if (n > 1) {
      const [id, t] = key.split('@');
      errs.push(`client ${id}: shown ${n} times at ${t}ms`);
    }
  }
  for (let id = 0; id < scenario.clients; id++) {
    if (!maxShown.has(id) && ![...perInstant.keys()].some((k) => k.startsWith(`${id}@`))) errs.push(`client ${id}: never shown`);
  }
  return errs;
}

export function simulateBurst(scenario, { seed }) {
  if (scenario.kind !== 'burst') throw new Error('simulateBurst needs a burst scenario');
  const rand = rng(seed);
  const shown = [];
  for (let id = 0; id < scenario.clients; id++) {
    const tMs = Math.floor(rand() * scenario.durationS * 1000);
    const arrived = shuffle(Array.from({ length: scenario.burstLevels }, (_, l) => l), rand);
    // All levels land in the same instant; only the highest one is shown.
    shown.push({ id, tMs, level: Math.max(...arrived) });
  }
  shown.sort((a, b) => a.tMs - b.tMs || a.id - b.id);
  return { shown, violations: checkBurstInvariants(shown, scenario) };
}
