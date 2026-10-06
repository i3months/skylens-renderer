// Load scenario and result contract (T16). Results reuse the metrics record schema (contracts/metrics).
import { validateRecord } from '../metrics/index.mjs';

export const SCENARIO_KINDS = ['steady', 'burst', 'slow_link'];
export const MAX_CLIENTS = 30;
const ALLOWED = new Set(['name', 'kind', 'clients', 'durationS', 'path', 'burstLevels', 'linkBytesPerS']);

/** Path: ENU waypoints in metres, t in seconds from start (strictly increasing). */
function checkPath(path, errs) {
  if (!Array.isArray(path) || path.length < 2) { errs.push('path needs >= 2 waypoints'); return; }
  let prev = -Infinity;
  path.forEach((p, i) => {
    const ok = p && ['t', 'e', 'n', 'u'].every((k) => Number.isFinite(p[k]));
    if (!ok) { errs.push(`path[${i}] needs finite t,e,n,u`); return; }
    if (!(p.t > prev)) errs.push(`path[${i}].t not increasing`);
    prev = p.t;
  });
}

/** Returns violation strings; empty means valid. */
export function validateScenario(s) {
  const errs = [];
  if (s === null || typeof s !== 'object' || Array.isArray(s)) return ['scenario must be an object'];
  for (const k of Object.keys(s)) if (!ALLOWED.has(k)) errs.push(`unknown field ${k}`);
  if (!(typeof s.name === 'string' && /^[a-z0-9_]+$/.test(s.name))) errs.push('bad name');
  if (!SCENARIO_KINDS.includes(s.kind)) errs.push('bad kind');
  if (!(Number.isInteger(s.clients) && s.clients >= 1 && s.clients <= MAX_CLIENTS)) errs.push('bad clients');
  if (!(Number.isFinite(s.durationS) && s.durationS > 0)) errs.push('bad durationS');
  checkPath(s.path, errs);
  if (s.kind === 'burst' && !(Number.isInteger(s.burstLevels) && s.burstLevels >= 1)) errs.push('burst needs burstLevels');
  if (s.kind === 'slow_link' && !(Number.isFinite(s.linkBytesPerS) && s.linkBytesPerS > 0)) errs.push('slow_link needs linkBytesPerS');
  if (s.kind !== 'burst' && 'burstLevels' in s) errs.push('burstLevels only for burst');
  if (s.kind !== 'slow_link' && 'linkBytesPerS' in s) errs.push('linkBytesPerS only for slow_link');
  return errs;
}

/** Result: { scenario, records: metrics records, perClient: [{ id, bytes, latencyMs[] }] }. perClient length must equal scenario.clients. */
export function validateResult(r) {
  const errs = [];
  if (r === null || typeof r !== 'object') return ['result must be an object'];
  errs.push(...validateScenario(r.scenario));
  if (!Array.isArray(r.records) || r.records.length === 0) errs.push('records empty');
  else r.records.forEach((x, i) => validateRecord(x).forEach((e) => errs.push(`records[${i}]: ${e}`)));
  if (!Array.isArray(r.perClient)) errs.push('perClient missing');
  else {
    if (r.scenario && r.perClient.length !== r.scenario.clients) errs.push('perClient length != clients');
    r.perClient.forEach((c, i) => {
      if (!(c && Number.isInteger(c.id) && Number.isFinite(c.bytes) && c.bytes >= 0 && Array.isArray(c.latencyMs) && c.latencyMs.every(Number.isFinite))) errs.push(`perClient[${i}] bad`);
    });
  }
  return errs;
}
