// Event log guard: turns every malformed log into violation strings instead of exceptions.
import { validateEvent } from '../../../contracts/load/harness.mjs';

/** Returns violation strings for an event log; never throws. */
export function checkEventLog(events, clients) {
  if (!Array.isArray(events)) return ['event log: not an array'];
  const out = [];
  let prevT = -Infinity; // last valid tMs seen, for the monotonic check
  for (let i = 0; i < events.length; i++) {
    try {
      // Index access (not forEach) so sparse array holes are visited as undefined.
      const msgs = validateEvent(events[i], clients);
      for (const m of msgs) out.push(`event ${i}: ${m}`);
      const ev = events[i];
      const t = ev !== null && typeof ev === 'object' ? ev.tMs : undefined;
      if (Number.isFinite(t) && t >= 0) {
        if (t < prevT) out.push(`event ${i}: tMs goes backwards`);
        else prevT = t;
      }
    } catch (e) {
      out.push(`event ${i}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/** Runs fn; a throw becomes a violation string tagged with name. */
export function guarded(name, fn) {
  try {
    return { value: fn() };
  } catch (e) {
    return { violation: `${name}: bad event log: ${e instanceof Error ? e.message : String(e)}` };
  }
}
