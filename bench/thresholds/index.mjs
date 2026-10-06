// Threshold checks over measurement records (see contracts/metrics).
import { readFileSync } from 'node:fs';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

function assertThresholds(thresholds) {
  if (thresholds === null || typeof thresholds !== 'object' || Array.isArray(thresholds)) {
    throw new Error('thresholds must be an object');
  }
  for (const [name, t] of Object.entries(thresholds)) {
    if (t === null || typeof t !== 'object' || Array.isArray(t)) throw new Error(`${name}: threshold must be an object`);
    const hasMax = 'max' in t;
    const hasMin = 'min' in t;
    if (!hasMax && !hasMin) throw new Error(`${name}: threshold needs max or min`);
    if (hasMax && !isNum(t.max)) throw new Error(`${name}: max must be a finite number`);
    if (hasMin && !isNum(t.min)) throw new Error(`${name}: min must be a finite number`);
  }
}

/**
 * Returns a list of violation strings; empty means all thresholds hold.
 * A threshold key with no matching record is a violation; records without a
 * threshold entry are ignored. Every record carrying a listed metric is checked.
 */
export function checkThresholds(records, thresholds) {
  assertThresholds(thresholds);
  const out = [];
  for (const [name, t] of Object.entries(thresholds)) {
    const matches = records.filter((r) => r && r.metric === name);
    if (matches.length === 0) {
      out.push(`${name}: missing`);
      continue;
    }
    for (const r of matches) {
      if ('max' in t && r.value > t.max) out.push(`${name}: ${r.value} > max ${t.max}`);
      if ('min' in t && r.value < t.min) out.push(`${name}: ${r.value} < min ${t.min}`);
    }
  }
  return out;
}

export function loadThresholds() {
  return JSON.parse(readFileSync(new URL('./thresholds.json', import.meta.url), 'utf8'));
}
