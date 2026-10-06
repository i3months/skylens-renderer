// Load scenario and result contract (T16). Results reuse the metrics record schema (contracts/metrics).
// Decisions: see research decisions/0060. Coordinates are GeoAnchor-relative ENU, 1 unit = 1 m.
import { validateRecord } from '../metrics/index.mjs';
import { LEVEL_COUNT } from '../asset/index.mjs';

export const SCENARIO_KINDS = ['steady', 'burst', 'slow_link'];
export const MAX_CLIENTS = 30;
const ALLOWED = new Set(['name', 'kind', 'clients', 'durationS', 'path', 'burstLevels', 'linkBytesPerS']);
const WAYPOINT_KEYS = new Set(['t', 'e', 'n', 'u']);
const RESULT_KEYS = new Set(['scenario', 'records', 'perClient']);
const CLIENT_KEYS = new Set(['id', 'bytes', 'latencyMs']);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** Path: ENU waypoints in metres; t seconds from start, path[0].t = 0, strictly increasing, last t <= durationS. */
function checkPath(path, durationS, errs) {
  if (!Array.isArray(path) || path.length < 2) { errs.push('path needs >= 2 waypoints'); return; }
  let prev = -Infinity;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (isObj(p)) for (const k of Object.keys(p)) if (!WAYPOINT_KEYS.has(k)) errs.push(`path[${i}] unknown field ${k}`);
    if (!isObj(p) || !['t', 'e', 'n', 'u'].every((k) => Number.isFinite(p[k]))) { errs.push(`path[${i}] needs finite t,e,n,u`); continue; }
    if (!(p.t > prev)) errs.push(`path[${i}].t not increasing`);
    prev = p.t;
  }
  if (isObj(path[0]) && Number.isFinite(path[0].t) && path[0].t !== 0) errs.push('path[0].t must be 0');
  const last = path[path.length - 1];
  if (isObj(last) && Number.isFinite(durationS) && last.t > durationS) errs.push('path ends after durationS');
}

/** Returns violation strings; empty means valid. burstLevels = number of levels (1..LEVEL_COUNT) arriving at once. */
export function validateScenario(s) {
  if (!isObj(s)) return ['scenario must be an object'];
  const errs = [];
  for (const k of Object.keys(s)) if (!ALLOWED.has(k)) errs.push(`unknown field ${k}`);
  if (!(typeof s.name === 'string' && /^[a-z0-9_]+$/.test(s.name))) errs.push('bad name');
  if (!SCENARIO_KINDS.includes(s.kind)) errs.push('bad kind');
  if (!(Number.isInteger(s.clients) && s.clients >= 1 && s.clients <= MAX_CLIENTS)) errs.push('bad clients');
  if (!(Number.isFinite(s.durationS) && s.durationS > 0)) errs.push('bad durationS');
  checkPath(s.path, s.durationS, errs);
  if (s.kind === 'burst' && !(Number.isInteger(s.burstLevels) && s.burstLevels >= 1 && s.burstLevels <= LEVEL_COUNT)) errs.push('burst needs burstLevels');
  if (s.kind === 'slow_link' && !(Number.isFinite(s.linkBytesPerS) && s.linkBytesPerS > 0)) errs.push('slow_link needs linkBytesPerS');
  if (s.kind !== 'burst' && 'burstLevels' in s) errs.push('burstLevels only for burst');
  if (s.kind !== 'slow_link' && 'linkBytesPerS' in s) errs.push('linkBytesPerS only for slow_link');
  return errs;
}

/** latencyMs: non-empty array of finite numbers >= 0; holes are invalid. */
function validLatencies(a) {
  if (!Array.isArray(a) || a.length < 1) return false; // holes read as undefined, so they fail the finite check
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]) || a[i] < 0) return false;
  return true;
}

/** Result: { scenario, records, perClient: [{ id 0..clients-1 unique, bytes >= 0 integer, latencyMs[] >= 0, length >= 1 }] }. */
export function validateResult(r) {
  if (!isObj(r)) return ['result must be an object'];
  const errs = [];
  for (const k of Object.keys(r)) if (!RESULT_KEYS.has(k)) errs.push(`unknown field ${k}`);
  for (const e of validateScenario(r.scenario)) errs.push(e);
  if (!Array.isArray(r.records) || r.records.length === 0) errs.push('records empty');
  else {
    // Index loop (not forEach): holes in a sparse array are violations, not skipped.
    for (let i = 0; i < r.records.length; i++) {
      if (!(i in r.records)) { errs.push(`records[${i}] missing`); continue; }
      for (const e of validateRecord(r.records[i])) errs.push(`records[${i}]: ${e}`);
    }
  }
  if (!Array.isArray(r.perClient)) { errs.push('perClient missing'); return errs; }
  const n = isObj(r.scenario) ? r.scenario.clients : undefined;
  if (r.perClient.length !== n) errs.push('perClient length != clients');
  const seen = new Set();
  for (let i = 0; i < r.perClient.length; i++) {
    if (!(i in r.perClient)) { errs.push(`perClient[${i}] missing`); continue; }
    const c = r.perClient[i];
    if (isObj(c)) for (const k of Object.keys(c)) if (!CLIENT_KEYS.has(k)) errs.push(`perClient[${i}] unknown field ${k}`);
    if (!(isObj(c) && Number.isInteger(c.id) && Number.isInteger(c.bytes) && c.bytes >= 0 && validLatencies(c.latencyMs))) { errs.push(`perClient[${i}] bad`); continue; }
    if (!(Number.isInteger(n) && n >= 1)) continue;
    if (!(c.id >= 0 && c.id < n)) errs.push(`perClient[${i}] id out of range`);
    else if (seen.has(c.id)) errs.push(`perClient[${i}] duplicate id`);
    seen.add(c.id);
  }
  return errs;
}
