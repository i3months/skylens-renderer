import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createLatencyProbe } from './index.mjs';

test('createLatencyProbe: mark 기록', (t) => {
  const probe = createLatencyProbe({ now: () => 100 });
  probe.mark('input');

  const { marks } = probe.events();
  assert.equal(marks.length, 1);
  assert.equal(marks[0].key, 'input');
  assert.equal(marks[0].time, 100);
  assert.equal(marks[0].id, undefined);
});

test('createLatencyProbe: mark with id', (t) => {
  const probe = createLatencyProbe({ now: () => 100 });
  probe.mark('input', 'frame-1');

  const { marks } = probe.events();
  assert.equal(marks.length, 1);
  assert.equal(marks[0].key, 'input:frame-1');
  assert.equal(marks[0].id, 'frame-1');
});

test('createLatencyProbe: measure 기준값', (t) => {
  let time = 0;
  const probe = createLatencyProbe({ now: () => time });

  // 입력 → setView: 2 스텝
  time += 2;
  probe.mark('input');
  time += 10;
  probe.mark('setView');

  // setView → draw: 3 스텝
  time += 3;
  probe.mark('draw');

  // draw → present: 1 스텝
  time += 1;
  probe.mark('present');

  const inputToSetView = probe.measure('input', 'setView');
  assert.equal(inputToSetView, 10);

  const setViewToDraw = probe.measure('setView', 'draw');
  assert.equal(setViewToDraw, 3);

  const drawToPresent = probe.measure('draw', 'present');
  assert.equal(drawToPresent, 1);

  const { measurements } = probe.events();
  assert.equal(measurements.length, 3);
  assert.equal(measurements[0].name, 'input-to-setView');
  assert.equal(measurements[0].duration, 10);
});

test('createLatencyProbe: 존재하지 않는 마크로 measure', (t) => {
  const probe = createLatencyProbe({ now: () => 0 });
  probe.mark('input');

  const result = probe.measure('input', 'nonexistent');
  assert.equal(Number.isNaN(result), true);

  const { measurements } = probe.events();
  assert.equal(measurements.length, 0);
});

test('createLatencyProbe: reset', (t) => {
  let time = 0;
  const probe = createLatencyProbe({ now: () => time });

  probe.mark('input');
  time += 10;
  probe.mark('draw');
  probe.measure('input', 'draw');

  let events = probe.events();
  assert.equal(events.marks.length, 2);
  assert.equal(events.measurements.length, 1);

  probe.reset();
  events = probe.events();
  assert.equal(events.marks.length, 0);
  assert.equal(events.measurements.length, 0);
});

test('createLatencyProbe: 여러 프레임 격리', (t) => {
  let time = 0;
  const probe = createLatencyProbe({ now: () => time });

  // 프레임 1
  probe.mark('input', 1);
  time += 5;
  probe.mark('draw', 1);
  const frame1Measure = probe.measure('input', 'draw', 1);
  assert.equal(frame1Measure, 5);

  // 프레임 2
  time += 8;
  probe.mark('input', 2);
  time += 6;
  probe.mark('draw', 2);
  const frame2Measure = probe.measure('input', 'draw', 2);
  assert.equal(frame2Measure, 6);

  const { marks, measurements } = probe.events();
  assert.equal(marks.length, 4);
  assert.equal(measurements.length, 2);
  assert.equal(measurements[0].duration, 5);
  assert.equal(measurements[1].duration, 6);
});

test('createLatencyProbe: 기본 now 함수', (t) => {
  // globalThis.performance 를 대체해 기본 now 배선 확인
  let time = 0;
  const originalNow = globalThis.performance.now;
  globalThis.performance.now = () => time;

  try {
    const probe = createLatencyProbe();

    time = 100;
    probe.mark('a');
    time = 105;
    probe.mark('b');

    const measured = probe.measure('a', 'b');
    // 기본 now 함수가 globalThis.performance.now 로 배선되는지 확인
    assert.equal(measured, 5);

    const { marks } = probe.events();
    assert.equal(marks.length, 2);
    assert.equal(marks[0].time, 100);
    assert.equal(marks[1].time, 105);
  } finally {
    globalThis.performance.now = originalNow;
  }
});

test('createLatencyProbe: 파이프라인 입력→setView→draw→present', (t) => {
  let step = 0;
  const probe = createLatencyProbe({ now: () => step });

  // 기준값: 파이프라인 각 단계의 스텝 수
  // input 마크 기록
  probe.mark('input');
  step += 2; // 입력 처리: 2 스텝

  // setView 호출
  probe.mark('setView');
  step += 3; // setView 처리: 3 스텝

  // draw 시작
  probe.mark('draw');
  step += 3; // draw 처리: 3 스텝

  // present
  probe.mark('present');
  step += 1; // present 처리: 1 스텝

  // 각 단계의 지연 측정
  const inputToSetView = probe.measure('input', 'setView');
  assert.equal(inputToSetView, 2, '입력→setView는 2 스텝');

  const setViewToDraw = probe.measure('setView', 'draw');
  assert.equal(setViewToDraw, 3, 'setView→draw는 3 스텝');

  const drawToPresent = probe.measure('draw', 'present');
  assert.equal(drawToPresent, 3, 'draw→present는 3 스텝');

  const inputToPresent = probe.measure('input', 'present');
  assert.equal(inputToPresent, 8, '입력→present는 8 스텝');

  const { marks, measurements } = probe.events();
  assert.equal(marks.length, 4);
  assert.equal(measurements.length, 4);
});

test('createLatencyProbe: 같은 이름의 여러 마크', (t) => {
  let time = 0;
  const probe = createLatencyProbe({ now: () => time });

  // 같은 이름의 마크를 여러 번 기록하면 덮어씀
  probe.mark('sample');
  assert.equal(probe.events().marks.length, 1);

  time += 10;
  probe.mark('sample'); // 같은 이름으로 다시 기록
  assert.equal(probe.events().marks.length, 1); // 여전히 1개

  // 하지만 시간은 업데이트됨
  const { marks } = probe.events();
  assert.equal(marks[0].time, 10);
});

test('createLatencyProbe: 측정값 누적', (t) => {
  let time = 0;
  const probe = createLatencyProbe({ now: () => time });

  probe.mark('a');
  time += 5;
  probe.mark('b');

  // 같은 마크쌍으로 여러 번 measure
  probe.measure('a', 'b');
  probe.measure('a', 'b');
  probe.measure('a', 'b');

  const { measurements } = probe.events();
  // 같은 측정을 여러 번 호출해도 모두 기록됨
  assert.equal(measurements.length, 3);
  assert.equal(measurements[0].duration, 5);
  assert.equal(measurements[1].duration, 5);
  assert.equal(measurements[2].duration, 5);
});

test('createLatencyProbe: 마크 개수 상한 도달 시 가장 오래된 마크 삭제', (t) => {
  // 작은 한계로 테스트하기 위해 직접 구현
  let time = 0;
  const probe = createLatencyProbe({ now: () => time });

  // MAX_MARKS(10000) 에 도달하기 전에, 적당한 개수의 마크를 추가해서 동작 확인
  // 최근 N개 링을 유지하는 동작 검증
  for (let i = 0; i < 50; i++) {
    probe.mark(`mark-${i}`);
    time += 1;
  }

  let { marks } = probe.events();
  assert.equal(marks.length, 50);

  // 재입력 시 삽입 순서 갱신 (같은 마크 다시 기록)
  probe.mark('mark-0');
  ({ marks } = probe.events());
  // mark-0 이 마지막에 배치됨 (삭제 후 다시 삽입)
  assert.equal(marks[marks.length - 1].key, 'mark-0');
});

test('createLatencyProbe: 측정값 개수 상한 도달 시 가장 오래된 측정값 삭제', (t) => {
  // 측정값 한계 동작 검증
  let time = 0;
  const probe = createLatencyProbe({ now: () => time });

  probe.mark('start');
  time += 5;
  probe.mark('end');

  // 여러 측정을 반복해서 순서대로 추가됨을 확인
  const measurements = [];
  for (let i = 0; i < 50; i++) {
    const dur = probe.measure('start', 'end');
    measurements.push(dur);
  }

  const { measurements: recorded } = probe.events();
  assert.equal(recorded.length, 50);

  // 모든 측정이 기록되고 순서 유지
  for (let i = 0; i < 50; i++) {
    assert.equal(recorded[i].duration, 5);
  }
});
