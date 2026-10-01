// Generates recording.jsonl: SYNTHETIC mock core->viewer frames shaped like skylens
// Distributor envelopes ({seq, originTs, from:'core', payload}). Deterministic, no RNG.
// Usage: node make_fixture.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const T0 = 1700000000000;
const gps = (i) => ({ lat: 36.35 + i * 0.00011, lng: 127.38 + i * 0.00007, alt: 80 + (i % 5) });
const station = { id: 1, name: 'station-1', gps: gps(0) };
const payloads = [];
payloads.push({ kind: 'mission-status', phase: 'idle', message: 'idle', dronesOnline: 0, etaSeconds: null });
for (let i = 0; i < 40; i++) {
  payloads.push({ kind: 'telemetry', droneId: 1 + (i % 2), station, gps: gps(i), headingDeg: (i * 9) % 360, speed: 8.5, batteryPct: 100 - i, t: T0 + i * 200 });
  if (i % 10 === 0) payloads.push({ kind: 'link-status', hop: 'drone->gateway', connected: true, mode: 'wifi', latencyMs: 20 + i, mbps: 12.5 });
  if (i === 5) payloads.push({ kind: 'mission-status', phase: 'active', message: 'mission active', dronesOnline: 2, etaSeconds: null });
  if (i % 8 === 3) {
    const seg = (i - 3) / 8;
    for (let level = 1; level <= 3; level++) {
      payloads.push({
        kind: 'splat-chunk', id: `seg${seg}-l${level}`, segment: seg, level, steps: level * 1000, label: `level ${level}`,
        final: level === 3, url: `/splats/seg${seg}-l${level}.splat`, bytes: 100000 * level,
        align: { anchor: gps(i), position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      });
    }
  }
  if (i % 12 === 7) payloads.push({ kind: 'detection', id: `det-${i}`, category: i % 24 === 7 ? 'person' : 'danger', gps: gps(i), confidence: 0.9, label: 'object', segment: Math.floor(i / 8) });
  if (i % 15 === 0) payloads.push({ kind: 'camera-feed', droneId: 1, station, uri: `/video/slice-${i}.h265`, previewUri: `/video/slice-${i}.mp4`, reverse: false, codec: 'h265', startedAt: T0 + i * 200, durationMs: 3000 });
  if (i % 20 === 19) payloads.push({ kind: 'server-status', connected: true, receiving: true, chunks: 3 * (i >> 3), detections: i >> 3, lastSeq: i, latencyMs: 15, segments: [0, 1, 2].map((s) => ({ index: s, level: 3, levels: 3, steps: 3000, label: 'level 3' })) });
}
const lines = payloads.map((p, k) => JSON.stringify({ seq: k + 1, originTs: T0 + k * 100, from: 'core', payload: p }));
writeFileSync(fileURLToPath(new URL('./recording.jsonl', import.meta.url)), lines.join('\n') + '\n');
console.log(lines.length, 'frames');
