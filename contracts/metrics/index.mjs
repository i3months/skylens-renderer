// Measurement record validation (contract T01.0). Shared by every bench/baseline/* module.
export const UNITS = ['B', 'count', 'ms', 'fps', 'MB', 'ratio', 'px'];
const REQUIRED = ['metric', 'value', 'unit', 'device', 'method', 'commit'];
const ALLOWED = new Set([...REQUIRED, 'samples']);

/** Returns a list of violation strings; empty means valid. */
export function validateRecord(r) {
  const errs = [];
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return ['record must be an object'];
  for (const k of REQUIRED) if (!(k in r)) errs.push(`missing ${k}`);
  for (const k of Object.keys(r)) if (!ALLOWED.has(k)) errs.push(`unknown field ${k}`);
  if ('metric' in r && !(typeof r.metric === 'string' && /^[a-z0-9_.]+$/.test(r.metric))) errs.push('bad metric');
  if ('value' in r && !(typeof r.value === 'number' && Number.isFinite(r.value))) errs.push('bad value');
  if ('unit' in r && !UNITS.includes(r.unit)) errs.push('bad unit');
  for (const k of ['device', 'method']) if (k in r && typeof r[k] !== 'string') errs.push(`bad ${k}`);
  if ('commit' in r && !(typeof r.commit === 'string' && /^[0-9a-f]{7,40}$/.test(r.commit))) errs.push('bad commit');
  if ('samples' in r && !(Array.isArray(r.samples) && r.samples.every((x) => Number.isFinite(x)))) errs.push('bad samples');
  return errs;
}

export function assertRecords(list) {
  list.forEach((r, i) => {
    const e = validateRecord(r);
    if (e.length) throw new Error(`record ${i}: ${e.join('; ')}`);
  });
  return list;
}

/** Deterministic serialization: stable key order, trailing newline. */
export function serialize(list) {
  assertRecords(list);
  const order = [...REQUIRED, 'samples'];
  return JSON.stringify(list.map((r) => Object.fromEntries(order.filter((k) => k in r).map((k) => [k, r[k]]))), null, 2) + '\n';
}

export function parse(text) {
  return assertRecords(JSON.parse(text));
}

/*
 * Bench module contract (every bench/baseline/<name>/index.mjs):
 *   export async function run({ skylensDir, outDir, commit }) -> Record[]
 *   - skylensDir: checkout of skylens `develop` (read-only; never modify it, copy if a build is needed)
 *   - outDir: where to write artifacts; commit: skylens commit hash (7-40 hex)
 *   - returned records must pass assertRecords(); no network calls except the package registry.
 * Tests live next to the module as <name>.test.mjs and read SKYLENS_DIR from the environment.
 */

/*
 * T01 rework: run receives { skylensDir, outDir, commit, inputs }; see contracts/inputs/index.mjs.
 * A module whose required input is missing throws (run_all records it as failed); it never substitutes synthetic data.
 */
