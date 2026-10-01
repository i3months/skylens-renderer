import test from 'node:test';
import assert from 'node:assert/strict';
import { toMarkdown } from './index.mjs';

test('baseline_report_table', () => {
  const c = 'abc1234';
  const records = [
    { metric: 'bundle.3d_gzip', value: 2621440, unit: 'B', device: 'n/a', method: 'gzip', commit: c },
    { metric: 'fps', value: 58, unit: 'fps', device: 'desktop', method: 'replay', commit: c, samples: [60, 55, 58, 61] },
    { metric: 'bundle.3d_gzip', value: 512, unit: 'B', device: 'a-dev', method: 'gzip', commit: c },
    { metric: 'fps', value: 24, unit: 'fps', device: 'lowend', method: 'replay', commit: c, samples: [20, 24, 30] },
    { metric: 'ws.segment_bytes', value: 70254592, unit: 'B', device: 'n/a', method: 'ws sum', commit: c },
    { metric: 'ttff', value: 1500, unit: 'ms', device: 'p|ipe', method: 'timer', commit: c },
  ];
  const expected = [
    '| item | unit | value | median | samples | device | method |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| bundle.3d_gzip | B | 512 | - | - | a-dev | gzip |',
    '| bundle.3d_gzip | MB | 2.5 (2621440 B) | - | - | n/a | gzip |',
    '| fps | fps | 58 | 59 | 4 | desktop | replay |',
    '| fps | fps | 24 | 24 | 3 | lowend | replay |',
    '| ttff | ms | 1500 | - | - | p\\|ipe | timer |',
    '| ws.segment_bytes | MB | 67 (70254592 B) | - | - | n/a | ws sum |',
    '',
  ].join('\n');
  assert.equal(toMarkdown(records), expected);
  assert.equal(toMarkdown([...records].reverse()), expected);
});
