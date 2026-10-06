import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReport, CLOUD_APPROXIMATION_METHODS } from './index.mjs';

function countUnescapedPipes(line) {
  // Count pipes that are not escaped with a backslash
  // An escaped pipe looks like \| but we need to check if the backslash itself is escaped
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|') {
      // Check if this pipe is escaped by counting preceding backslashes
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && line[j] === '\\') {
        backslashCount++;
        j--;
      }
      // If odd number of backslashes, the pipe is escaped
      if (backslashCount % 2 === 0) {
        count++;
      }
    }
  }
  return count;
}

test('loadReport: basic functionality with 2 clients and 2 records', () => {
  const result = {
    scenario: {
      name: 'test_scenario',
      kind: 'steady',
      clients: 2,
      durationS: 10,
      path: [
        { t: 0, e: 0, n: 0, u: 0 },
        { t: 10, e: 100, n: 200, u: 300 },
      ],
    },
    records: [
      {
        metric: 'throughput',
        value: 1500,
        unit: 'B',
        device: 'test_device',
        method: 'measure',
        commit: 'abc1234567890',
      },
      {
        metric: 'latency_p95',
        value: 45.5,
        unit: 'ms',
        device: 'test_device',
        method: 'measure',
        commit: 'abc1234567890',
      },
    ],
    perClient: [
      { id: 0, bytes: 5000, latencyMs: [40, 42, 45] },
      { id: 1, bytes: 3000, latencyMs: [50, 52] },
    ],
  };

  const output = loadReport(result);
  const expected = [
    '| metric | value | unit | device | method |',
    '| --- | --- | --- | --- | --- |',
    '| throughput | 1500 | B | test_device | measure |',
    '| latency_p95 | 45.5 | ms | test_device | measure |',
    '',
    'clients: 2, total bytes: 8000',
    'source: measure, S5/S8 verdict measured on measure',
  ].join('\n');

  assert.equal(output, expected);
});

test('loadReport: escapes pipe character in device and method names', () => {
  const result = {
    scenario: {
      name: 'test_scenario',
      kind: 'steady',
      clients: 1,
      durationS: 10,
      path: [
        { t: 0, e: 0, n: 0, u: 0 },
        { t: 10, e: 100, n: 200, u: 300 },
      ],
    },
    records: [
      {
        metric: 'throughput',
        value: 1500,
        unit: 'B',
        device: 'dev|ice',
        method: 'meas|ure',
        commit: 'abc1234567890',
      },
    ],
    perClient: [
      { id: 0, bytes: 5000, latencyMs: [40, 42, 45] },
    ],
  };

  const output = loadReport(result);
  const lines = output.split('\n');

  // Verify pipes in cell data are escaped
  assert.match(lines[2], /dev\\|ice/, 'pipe in device should be escaped');
  assert.match(lines[2], /meas\\|ure/, 'pipe in method should be escaped');

  // Each table row must have exactly 6 unescaped pipes (5 columns: leading pipe, 4 content separators, trailing pipe)
  const headerUnescapedPipes = countUnescapedPipes(lines[0]);
  const separatorUnescapedPipes = countUnescapedPipes(lines[1]);
  const dataUnescapedPipes = countUnescapedPipes(lines[2]);

  assert.equal(headerUnescapedPipes, 6, 'header row must have 6 unescaped pipes');
  assert.equal(separatorUnescapedPipes, 6, 'separator row must have 6 unescaped pipes');
  assert.equal(dataUnescapedPipes, 6, 'data row with escaped pipes must have 6 unescaped pipes');
});

test('loadReport: escapes newline characters in device and method names', () => {
  const result = {
    scenario: {
      name: 'test_scenario',
      kind: 'steady',
      clients: 1,
      durationS: 10,
      path: [
        { t: 0, e: 0, n: 0, u: 0 },
        { t: 10, e: 100, n: 200, u: 300 },
      ],
    },
    records: [
      {
        metric: 'throughput',
        value: 1500,
        unit: 'B',
        device: 'dev\nice',
        method: 'meas\nure',
        commit: 'abc1234567890',
      },
    ],
    perClient: [
      { id: 0, bytes: 5000, latencyMs: [40, 42, 45] },
    ],
  };

  const output = loadReport(result);
  const lines = output.split('\n');

  // Newlines should be converted to spaces, so we should only have 5 lines (header, separator, 1 data, summary - no empty line)
  assert.equal(lines.length, 6, 'newlines in cells should be converted to spaces, not causing line breaks');

  // Each table row must have exactly 6 unescaped pipes
  const headerUnescapedPipes = countUnescapedPipes(lines[0]);
  const separatorUnescapedPipes = countUnescapedPipes(lines[1]);
  const dataUnescapedPipes = countUnescapedPipes(lines[2]);

  assert.equal(headerUnescapedPipes, 6, 'header row must have 6 unescaped pipes');
  assert.equal(separatorUnescapedPipes, 6, 'separator row must have 6 unescaped pipes');
  assert.equal(dataUnescapedPipes, 6, 'data row with newlines converted must have 6 unescaped pipes');
});

test('loadReport: handles both pipes and newlines in same fields', () => {
  const result = {
    scenario: {
      name: 'test_scenario',
      kind: 'steady',
      clients: 1,
      durationS: 10,
      path: [
        { t: 0, e: 0, n: 0, u: 0 },
        { t: 10, e: 100, n: 200, u: 300 },
      ],
    },
    records: [
      {
        metric: 'metric',
        value: 1500,
        unit: 'B',
        device: 'device|name\nhere',
        method: 'method|\ntest',
        commit: 'abc1234567890',
      },
    ],
    perClient: [
      { id: 0, bytes: 5000, latencyMs: [40, 42, 45] },
    ],
  };

  const output = loadReport(result);
  const lines = output.split('\n');

  // Should still only have 5 lines (newlines converted to spaces)
  assert.equal(lines.length, 6, 'all newlines should be converted to spaces');

  // Each table row must have exactly 6 unescaped pipes
  const headerUnescapedPipes = countUnescapedPipes(lines[0]);
  const separatorUnescapedPipes = countUnescapedPipes(lines[1]);
  const dataUnescapedPipes = countUnescapedPipes(lines[2]);

  assert.equal(headerUnescapedPipes, 6, 'header row must have 6 unescaped pipes');
  assert.equal(separatorUnescapedPipes, 6, 'separator row must have 6 unescaped pipes');
  assert.equal(dataUnescapedPipes, 6, 'data row with both pipes and newlines must have 6 unescaped pipes');
});

test('loadReport: all table rows must have consistent pipe count', () => {
  const result = {
    scenario: {
      name: 'test_scenario',
      kind: 'steady',
      clients: 1,
      durationS: 10,
      path: [
        { t: 0, e: 0, n: 0, u: 0 },
        { t: 10, e: 100, n: 200, u: 300 },
      ],
    },
    records: [
      {
        metric: 'metric1',
        value: 100,
        unit: 'ms',
        device: 'dev|ice',
        method: 'meth|od',
        commit: 'abc1234567890',
      },
      {
        metric: 'metric2',
        value: 200,
        unit: 'B',
        device: 'device|name',
        method: 'method\ntest',
        commit: 'abc1234567890',
      },
      {
        metric: 'metric3',
        value: 300,
        unit: 'ms',
        device: 'dev|ice\nname',
        method: 'method|and\nnewline',
        commit: 'abc1234567890',
      },
    ],
    perClient: [
      { id: 0, bytes: 5000, latencyMs: [40, 42, 45] },
    ],
  };

  const output = loadReport(result);
  const lines = output.split('\n');

  // Count unescaped pipes in each table row (header, separator, 3 data rows = first 5 lines)
  const pipesCounts = [];
  for (let i = 0; i < 5; i++) {
    pipesCounts.push(countUnescapedPipes(lines[i]));
  }

  // All table rows should have exactly 6 unescaped pipes (5 columns with leading and trailing pipes)
  for (let i = 0; i < 5; i++) {
    assert.equal(pipesCounts[i], 6, `row ${i} must have 6 unescaped pipes, got ${pipesCounts[i]}`);
  }

  // Verify all counts are the same
  assert.deepEqual(pipesCounts, [6, 6, 6, 6, 6], 'all table rows must have the same pipe count');
});

test('loadReport: throws on invalid result (clients mismatch)', () => {
  const result = {
    scenario: {
      name: 'test_scenario',
      kind: 'steady',
      clients: 2,
      durationS: 10,
      path: [
        { t: 0, e: 0, n: 0, u: 0 },
        { t: 10, e: 100, n: 200, u: 300 },
      ],
    },
    records: [
      {
        metric: 'throughput',
        value: 1500,
        unit: 'B',
        device: 'test_device',
        method: 'measure',
        commit: 'abc1234567890',
      },
    ],
    perClient: [
      { id: 0, bytes: 5000, latencyMs: [40, 42, 45] },
    ],
  };

  assert.throws(() => loadReport(result), /perClient length != clients/);
});

test('regression: removing pipe escape breaks table structure', () => {
  // This test ensures that escaping pipes is necessary.
  // If the escaping logic is removed or broken, this test will fail
  // because the table will have too many unescaped pipes.

  const result = {
    scenario: {
      name: 'test_scenario',
      kind: 'steady',
      clients: 1,
      durationS: 10,
      path: [
        { t: 0, e: 0, n: 0, u: 0 },
        { t: 10, e: 100, n: 200, u: 300 },
      ],
    },
    records: [
      {
        metric: 'metric',
        value: 100,
        unit: 'ms',
        device: 'device|with|pipes',
        method: 'method|test',
        commit: 'abc1234567890',
      },
    ],
    perClient: [
      { id: 0, bytes: 5000, latencyMs: [40, 42, 45] },
    ],
  };

  const output = loadReport(result);
  const lines = output.split('\n');

  // If escaping is removed, the data row will have 12 unescaped pipes instead of 6
  // (3 in device + 1 in method = 4 extra pipes)
  const dataRowPipes = countUnescapedPipes(lines[2]);
  assert.equal(dataRowPipes, 6, 'data row must have exactly 6 unescaped pipes; if more, pipe escaping is broken');
});

test('regression: removing newline escape breaks table structure', () => {
  // This test ensures that escaping newlines is necessary.
  // If the newline escaping logic is removed, this test will fail
  // because the table structure will be broken (extra lines).

  const result = {
    scenario: {
      name: 'test_scenario',
      kind: 'steady',
      clients: 1,
      durationS: 10,
      path: [
        { t: 0, e: 0, n: 0, u: 0 },
        { t: 10, e: 100, n: 200, u: 300 },
      ],
    },
    records: [
      {
        metric: 'metric',
        value: 100,
        unit: 'ms',
        device: 'device\nwith\nnewlines',
        method: 'method\ntest',
        commit: 'abc1234567890',
      },
    ],
    perClient: [
      { id: 0, bytes: 5000, latencyMs: [40, 42, 45] },
    ],
  };

  const output = loadReport(result);
  const lines = output.split('\n');

  // If newline escaping is removed, there will be extra lines
  // Expected: 5 lines (header, separator, 1 data, empty, summary, source)
  // With broken newline escape: 8+ lines
  assert.equal(lines.length, 6, 'output must have exactly 6 lines; if more, newline escaping is broken');
});

test('regression: removing both pipe and newline escape breaks table completely', () => {
  // This test ensures both escaping mechanisms are necessary.
  // If both are removed, the table becomes corrupted.

  const result = {
    scenario: {
      name: 'test_scenario',
      kind: 'steady',
      clients: 1,
      durationS: 10,
      path: [
        { t: 0, e: 0, n: 0, u: 0 },
        { t: 10, e: 100, n: 200, u: 300 },
      ],
    },
    records: [
      {
        metric: 'metric',
        value: 100,
        unit: 'ms',
        device: 'device|with\nboth',
        method: 'method|\nescapes',
        commit: 'abc1234567890',
      },
    ],
    perClient: [
      { id: 0, bytes: 5000, latencyMs: [40, 42, 45] },
    ],
  };

  const output = loadReport(result);
  const lines = output.split('\n');

  // Check line count - should be 5, not more
  assert.equal(lines.length, 6, 'output must have exactly 6 lines');

  // Check pipe count - should be 6 per row, not more
  const dataRowPipes = countUnescapedPipes(lines[2]);
  assert.equal(dataRowPipes, 6, 'data row must have exactly 6 unescaped pipes');
});

test('regression: using /\\n/ regex fails with \\r\\n line breaks', () => {
  // This test ensures that the regex handles \r\n sequences correctly.
  // If someone changes the regex to only /\n/ and ignores \r, this test will fail.
  // The device field has a \r\n sequence which must be converted to a space.

  const result = {
    scenario: {
      name: 'test_scenario',
      kind: 'steady',
      clients: 1,
      durationS: 10,
      path: [
        { t: 0, e: 0, n: 0, u: 0 },
        { t: 10, e: 100, n: 200, u: 300 },
      ],
    },
    records: [
      {
        metric: 'metric',
        value: 100,
        unit: 'ms',
        device: 'device\r\nname',
        method: 'method',
        commit: 'abc1234567890',
      },
    ],
    perClient: [
      { id: 0, bytes: 5000, latencyMs: [40, 42, 45] },
    ],
  };

  const output = loadReport(result);
  const lines = output.split('\n');

  // Must have exactly 6 lines (header, separator, 1 data, empty, summary, source)
  // If \r\n is not properly handled, there will be more lines
  assert.equal(lines.length, 6, 'output with \\r\\n should have exactly 6 lines');

  // Check that the device field has the \r\n converted to a space
  assert.match(lines[2], /device name/, 'carriage return + newline should be converted to space');
});

test('regression: using /\\n/ regex fails with lone \\r line breaks', () => {
  // This test ensures that the regex handles lone \r (carriage return) correctly.
  // If someone changes the regex to only /\n/, it will not match lone \r, causing test failure.
  // A lone \r character must be treated as a line break like \n.

  const result = {
    scenario: {
      name: 'test_scenario',
      kind: 'steady',
      clients: 1,
      durationS: 10,
      path: [
        { t: 0, e: 0, n: 0, u: 0 },
        { t: 10, e: 100, n: 200, u: 300 },
      ],
    },
    records: [
      {
        metric: 'metric',
        value: 100,
        unit: 'ms',
        device: 'device\rname',
        method: 'method',
        commit: 'abc1234567890',
      },
    ],
    perClient: [
      { id: 0, bytes: 5000, latencyMs: [40, 42, 45] },
    ],
  };

  const output = loadReport(result);
  const lines = output.split('\n');

  // Must have exactly 6 lines (header, separator, 1 data, empty, summary, source)
  // If lone \r is not properly handled, the split('\n') will create more lines or malformed output
  assert.equal(lines.length, 6, 'output with lone \\r should have exactly 6 lines');

  // Check that the device field has the \r converted to a space
  assert.match(lines[2], /device name/, 'lone carriage return should be converted to space');
});

test('loadReport: handles already-escaped backslash-pipe correctly', () => {
  // This test ensures that cells containing a backslash followed by pipe (\|)
  // are handled correctly and render identically in markdown.
  // Every backslash is doubled before pipes are escaped, so \| becomes \\\|.

  const result = {
    scenario: {
      name: 'test_scenario',
      kind: 'steady',
      clients: 1,
      durationS: 10,
      path: [
        { t: 0, e: 0, n: 0, u: 0 },
        { t: 10, e: 100, n: 200, u: 300 },
      ],
    },
    records: [
      {
        metric: 'metric',
        value: 100,
        unit: 'ms',
        device: 'device\\|name',
        method: 'method',
        commit: 'abc1234567890',
      },
    ],
    perClient: [
      { id: 0, bytes: 5000, latencyMs: [40, 42, 45] },
    ],
  };

  const output = loadReport(result);
  const lines = output.split('\n');

  // Must have exactly 6 lines (header, separator, 1 data, empty, summary, source)
  assert.equal(lines.length, 6, 'output should have exactly 6 lines');

  // The data row should have exactly 6 unescaped pipes (5 columns)
  const dataRowPipes = countUnescapedPipes(lines[2]);
  assert.equal(dataRowPipes, 6, 'data row must have exactly 6 unescaped pipes');

  // The device field should properly render the backslash and pipe
  // In the output, backslash-pipe should appear as \\\| (escaped backslash and escaped pipe)
  assert.match(lines[2], /device\\\\\\\|name/, 'backslash-pipe should be properly escaped');
});

function splitRow(line) {
  const cells = [];
  let cur = '';
  for (let i = 1; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') { cur += c + line[i + 1]; i++; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  return cells;
}
const unescapeCell = (s) => s.replace(/\\([\\|])/g, '$1');

const basePath = [{ t: 0, e: 0, n: 0, u: 0 }, { t: 10, e: 100, n: 200, u: 300 }];

for (const n of [0, 1, 2, 3]) {
  test(`loadReport: ${n} backslashes before pipe round-trip`, () => {
    const original = `a${'\\'.repeat(n)}|b`;
    const result = {
      scenario: { name: 's', kind: 'steady', clients: 1, durationS: 10, path: basePath },
      records: [{ metric: 'm', value: 1, unit: 'ms', device: original, method: 'x', commit: 'abc1234567890' }],
      perClient: [{ id: 0, bytes: 1, latencyMs: [1] }],
    };
    const line = loadReport(result).split('\n')[2];
    assert.equal(countUnescapedPipes(line), 6);
    const cells = splitRow(line);
    assert.equal(cells.length, 5);
    assert.equal(unescapeCell(cells[3]), original);
  });
}

function reportLines(kind) {
  const scenario = { name: 's', kind, clients: 1, durationS: 10, path: basePath };
  if (kind === 'slow_link') scenario.linkBytesPerS = 1000;
  return loadReport({
    scenario,
    records: [{ metric: 'm', value: 1, unit: 'ms', device: 'd', method: 'x', commit: 'abc1234567890' }],
    perClient: [{ id: 0, bytes: 1, latencyMs: [1] }],
  }).split('\n');
}

test('loadReport: slow_link marks S5 threshold exclusion', () => {
  const lines = reportLines('slow_link');
  assert.ok(lines.includes('source: x, S5/S8 verdict measured on x'));
  assert.ok(lines.includes('S5 threshold-excluded scenario'));
});

test('loadReport: non slow_link has source line and no exclusion mark', () => {
  const lines = reportLines('steady');
  assert.equal(lines.at(-1), 'source: x, S5/S8 verdict measured on x');
  assert.ok(!lines.some((l) => l.includes('S5 threshold-excluded')));
});

function srcResult({ method = 'x', serverSamples, durationS = 10 } = {}) {
  const r = {
    scenario: { name: 's', kind: 'steady', clients: 1, durationS, path: basePath },
    records: [{ metric: 'm', value: 1, unit: 'ms', device: 'd', method, commit: 'abc1234567890' }],
    perClient: [{ id: 0, bytes: 1, latencyMs: [1] }],
  };
  if (serverSamples) r.serverSamples = serverSamples;
  return r;
}
const sample = (source, extra = {}) => ({ tS: 0, cpuPct: 1, rssMiB: 1, source, clock: 'real', cpuSource: 'measured', ...extra });
// A valid real-clock run for the 10 s srcResult scenario: one sample per second, tS 1..10.
const samples = (source, n = 10) => Array.from({ length: n }, (_, i) => sample(source, { tS: i + 1 }));
const lines = (out) => out.split('\n');
const srcOf = (out) => lines(out).find((l) => l.startsWith('source:'));
const cpuOf = (out) => lines(out).find((l) => l.startsWith('cpu/rss source:'));
const twoRecords = (m1, m2) => {
  const r = srcResult({ method: m1 });
  r.records.push({ ...r.records[0], metric: 'm2', method: m2 });
  return r;
};

test('source line: samples never change the source line', () => {
  const out = loadReport(srcResult({ method: 'sim', serverSamples: samples('server-process') }));
  assert.equal(srcOf(out), 'source: simulated, S5/S8 verdict [local]');
  assert.equal(cpuOf(out), 'cpu/rss source: server-process');
  assert.ok(!out.includes('measured on server-process'));
});

test('source line: any sim record wins, also when not first', () => {
  assert.equal(srcOf(loadReport(twoRecords('wrk', 'sim'))), 'source: simulated, S5/S8 verdict [local]');
  assert.equal(srcOf(loadReport(twoRecords('sim', 'wrk'))), 'source: simulated, S5/S8 verdict [local]');
});

test('source line: sim method with samples in opts is still simulated', () => {
  const out = loadReport(srcResult({ method: 'sim' }), { serverSamples: samples('server-process') });
  assert.equal(srcOf(out), 'source: simulated, S5/S8 verdict [local]');
});

test('source line: records with different methods give unknown', () => {
  assert.equal(srcOf(loadReport(twoRecords('wrk', 'ab'))), 'source: unknown, S5/S8 verdict origin unknown');
});

test('source line: records with equal methods use that method', () => {
  assert.equal(srcOf(loadReport(twoRecords('wrk', 'wrk'))), 'source: wrk, S5/S8 verdict measured on wrk');
});

test('source line: first record method must be usable (first wins over later)', () => {
  assert.equal(srcOf(loadReport(twoRecords('', 'wrk'))), 'source: unknown, S5/S8 verdict origin unknown');
  assert.equal(srcOf(loadReport(twoRecords('wrk', ''))), 'source: wrk, S5/S8 verdict measured on wrk');
});

test('source line: method with line break is sanitized', () => {
  const out = loadReport(srcResult({ method: 'a\nb' }));
  assert.equal(srcOf(out), 'source: a b, S5/S8 verdict measured on a b');
});

test('source line: no samples, sim maps to simulated and no cpu/rss line', () => {
  const out = loadReport(srcResult({ method: 'sim' }));
  assert.equal(srcOf(out), 'source: simulated, S5/S8 verdict [local]');
  assert.equal(cpuOf(out), undefined);
});

test('source line: other method is used as source', () => {
  assert.equal(srcOf(loadReport(srcResult({ method: 'wrk' }))), 'source: wrk, S5/S8 verdict measured on wrk');
});

test('source line: empty method gives unknown', () => {
  assert.equal(srcOf(loadReport(srcResult({ method: '' }))), 'source: unknown, S5/S8 verdict origin unknown');
});

test('cpu/rss line: valid samples, not simulated', () => {
  const out = loadReport(srcResult({ method: 'wrk', serverSamples: samples('server-process') }));
  assert.equal(cpuOf(out), 'cpu/rss source: server-process, measured on server-process');
  assert.equal(srcOf(out), 'source: wrk, S5/S8 verdict measured on wrk');
});

test('cpu/rss line: valid samples via opts', () => {
  const out = loadReport(srcResult({ method: 'wrk' }), { serverSamples: samples('harness-process') });
  assert.equal(cpuOf(out), 'cpu/rss source: harness-process, measured on harness-process');
});

test('cpu/rss line: follows the source line', () => {
  const l = lines(loadReport(srcResult({ method: 'wrk', serverSamples: samples('server-process') })));
  assert.equal(l.at(-2), 'source: wrk, S5/S8 verdict measured on wrk');
  assert.equal(l.at(-1), 'cpu/rss source: server-process, measured on server-process');
});

test('cpu/rss line: empty samples array prints no line', () => {
  assert.equal(cpuOf(loadReport(srcResult({ method: 'wrk', serverSamples: [] }))), undefined);
});

test('cpu/rss line: sample source unknown', () => {
  assert.equal(cpuOf(loadReport(srcResult({ method: 'wrk', serverSamples: samples('unknown') }))), 'cpu/rss source: unknown');
});

test('cpu/rss line: invalid samples give unknown without measured on', () => {
  for (const bad of [[{ tS: 0 }], [sample('server-process', { rssMiB: -1 })], [sample('server-process', { cpuSource: 'x' })],
    [sample('server-process', { tS: 1 }), sample('server-process', { tS: 1 })], 'nope', {}, [null]]) {
    const out = loadReport(srcResult({ method: 'wrk', serverSamples: bad }));
    assert.equal(cpuOf(out), 'cpu/rss source: unknown', JSON.stringify(bad));
    assert.ok(!out.includes('measured on server-process'));
  }
});

test('cpu/rss line: numeric sample source is rejected as unknown', () => {
  const out = loadReport(srcResult({ method: 'wrk', serverSamples: [sample(5)] }));
  assert.equal(cpuOf(out), 'cpu/rss source: unknown');
});

test('cpu/rss line: numeric record method is rejected by the contract or reported unknown', () => {
  const r = srcResult({ method: 'wrk' });
  r.records[0].method = 5;
  let out;
  try { out = loadReport(r); } catch { return; }
  assert.equal(srcOf(out), 'source: unknown, S5/S8 verdict origin unknown');
});

test('cpu/rss line: two samples with different sources give unknown', () => {
  const two = [sample('server-process', { tS: 0 }), sample('harness-process', { tS: 1 })];
  const out = loadReport(srcResult({ method: 'wrk', serverSamples: two }));
  assert.equal(cpuOf(out), 'cpu/rss source: unknown');
  assert.ok(!out.includes('harness-process'));
});

test('cpu/rss line: opts.serverSamples wins over result.serverSamples', () => {
  const out = loadReport(srcResult({ method: 'wrk', serverSamples: samples('harness-process') }), { serverSamples: samples('server-process') });
  assert.equal(cpuOf(out), 'cpu/rss source: server-process, measured on server-process');
});

test('cpu/rss line: invalid opts samples are not replaced by valid result samples', () => {
  const out = loadReport(srcResult({ method: 'wrk', serverSamples: samples('server-process') }), { serverSamples: [{ tS: 0 }] });
  assert.equal(cpuOf(out), 'cpu/rss source: unknown');
});

test('cpu/rss line: opts null is treated as empty opts', () => {
  const out = loadReport(srcResult({ method: 'wrk', serverSamples: samples('server-process') }), null);
  assert.equal(cpuOf(out), 'cpu/rss source: server-process, measured on server-process');
});

test('cpu/rss line: simulated source prints no measured on', () => {
  const out = loadReport(srcResult({ method: 'sim' }), { serverSamples: samples('simulated') });
  assert.equal(cpuOf(out), 'cpu/rss source: simulated');
});

test('loadReport: non-object result throws', () => {
  for (const bad of [null, undefined, 5, 'x', true]) {
    assert.throws(() => loadReport(bad), { message: 'loadReport: result must be an object' });
  }
});

test('cpu/rss line: sample source is escaped for the markdown cell', () => {
  const out = loadReport(srcResult({ method: 'wrk', serverSamples: samples('a|b\nc\\d') }));
  assert.equal(cpuOf(out), 'cpu/rss source: a\\|b c\\\\d, measured on a\\|b c\\\\d');
});

test('F-561: one mixed-source sample among ten gives unknown without measured on', () => {
  const mixed = samples('server-process');
  mixed[5] = { ...mixed[5], source: 'other' };
  const out = loadReport(srcResult({ method: 'wrk', serverSamples: mixed }));
  assert.equal(cpuOf(out), 'cpu/rss source: unknown');
  assert.ok(!out.includes('measured on server-process'));
  // the same ten samples, all server-process, give the normal line
  const clean = loadReport(srcResult({ method: 'wrk', serverSamples: samples('server-process') }));
  assert.equal(cpuOf(clean), 'cpu/rss source: server-process, measured on server-process');
});

test('F-558: loadReport checks the samples against result.scenario.durationS', () => {
  const one = loadReport(srcResult({ method: 'wrk', durationS: 60, serverSamples: [sample('server-process', { tS: 0.001 })] }));
  assert.equal(cpuOf(one), 'cpu/rss source: unknown');
  assert.ok(!one.includes('measured on server-process'));
  const full = loadReport(srcResult({ method: 'wrk', durationS: 60, serverSamples: samples('server-process', 60) }));
  assert.equal(cpuOf(full), 'cpu/rss source: server-process, measured on server-process');
  // a simulated-clock count shortfall is caught too
  const sim = (n) => Array.from({ length: n }, (_, i) => sample('simulated', { tS: i + 1, clock: 'simulated', cpuSource: 'simulated' }));
  assert.equal(cpuOf(loadReport(srcResult({ method: 'sim', serverSamples: sim(9) }))), 'cpu/rss source: unknown');
  assert.equal(cpuOf(loadReport(srcResult({ method: 'sim', serverSamples: sim(10) }))), 'cpu/rss source: simulated');
});

test('source line: cloud approximation method reports [local], not measured on', () => {
  assert.ok(CLOUD_APPROXIMATION_METHODS.includes('loopback-socket'));
  const out = loadReport(srcResult({ method: 'loopback-socket' }));
  assert.equal(srcOf(out), 'source: loopback-socket (cloud approximation), S5/S8 verdict [local]');
  assert.ok(!out.includes('measured on'));
  assert.ok(out.includes('[local]'));
});

test('source line: non-approximation method still says measured on', () => {
  assert.equal(srcOf(loadReport(srcResult({ method: 'wrk' }))), 'source: wrk, S5/S8 verdict measured on wrk');
});

function ffResult(method) {
  const r = srcResult({ method });
  r.records[0].metric = 'load.first_frame_p95';
  return r;
}
const NOTE = '(handshake-complete basis, not an S5 value)';

test('first-frame p95: loopback-socket row carries the handshake-complete annotation', () => {
  const out = loadReport(ffResult('loopback-socket'));
  assert.ok(out.includes(`| load.first_frame_p95 ${NOTE} | 1 | ms | d | loopback-socket |`));
});

test('first-frame p95: non-cloud output has no annotation', () => {
  const out = loadReport(ffResult('x'));
  assert.ok(!out.includes(NOTE));
  assert.ok(out.includes('| load.first_frame_p95 | 1 | ms | d | x |'));
});

test('first-frame p95: annotation only on the p95 row of a cloud report', () => {
  const out = loadReport(srcResult({ method: 'loopback-socket' }));
  assert.ok(!out.includes(NOTE));
});

function mixedRows(methods) {
  const r = srcResult({ method: 'loopback-socket' });
  const metrics = ['load.first_frame_p95', 'load.first_frame_p50', 'load.other_p95', 'load.first_frame_p95_extra'];
  r.records = metrics.map((metric, i) => ({ ...r.records[0], metric, method: methods[i] }));
  return r;
}
const countNote = (out) => out.split(NOTE).length - 1;

test('first-frame p95: cloud report with p95, p50 and other rows annotates exactly the first_frame p95 row', () => {
  const out = loadReport(mixedRows(Array(4).fill('loopback-socket')));
  assert.equal(countNote(out), 1);
  assert.ok(out.includes(`| load.first_frame_p95 ${NOTE} | 1 | ms | d | loopback-socket |`));
  assert.ok(out.includes('| load.first_frame_p50 | 1 | ms | d | loopback-socket |'));
  assert.ok(out.includes('| load.other_p95 | 1 | ms | d | loopback-socket |'));
  assert.ok(out.includes('| load.first_frame_p95_extra | 1 | ms | d | loopback-socket |'));
});

test('first-frame p95: mixed-method (unknown source) report has no annotation, even on a cloud-method p95 row', () => {
  const out = loadReport(mixedRows(['loopback-socket', 'x', 'loopback-socket', 'loopback-socket']));
  assert.equal(srcOf(out), 'source: unknown, S5/S8 verdict origin unknown');
  assert.equal(countNote(out), 0);
});

test('cloud approximation report: labeled approximation and [local], never measured on loopback-socket', () => {
  const out = loadReport(ffResult('loopback-socket'));
  assert.ok(out.includes('(cloud approximation)'));
  assert.ok(out.includes('[local]'));
  assert.ok(!out.includes('measured on loopback-socket'));
});
