import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReport } from './index.mjs';

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
  assert.equal(lines.length, 5, 'newlines in cells should be converted to spaces, not causing line breaks');

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
  assert.equal(lines.length, 5, 'all newlines should be converted to spaces');

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

test('MUTATION TEST: removing pipe escape breaks table structure', () => {
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

test('MUTATION TEST: removing newline escape breaks table structure', () => {
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
  // Expected: 5 lines (header, separator, 1 data, empty, summary)
  // With broken newline escape: 8+ lines
  assert.equal(lines.length, 5, 'output must have exactly 5 lines; if more, newline escaping is broken');
});

test('MUTATION TEST: removing both pipe and newline escape breaks table completely', () => {
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
  assert.equal(lines.length, 5, 'output must have exactly 5 lines');

  // Check pipe count - should be 6 per row, not more
  const dataRowPipes = countUnescapedPipes(lines[2]);
  assert.equal(dataRowPipes, 6, 'data row must have exactly 6 unescaped pipes');
});
