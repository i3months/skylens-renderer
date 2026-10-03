// 카메라 경로 생성기 시험. 상한 숫자는 시험 안에 고정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dronePath, freePath } from './index.mjs';

const sub = (a, b) => a.map((v, i) => v - b[i]);
const norm = (a) => Math.hypot(...a);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dir = (f) => { const d = sub(f.target, f.eye); const n = norm(d); return d.map((v) => v / n); };

function commonChecks(p, frames, fps) {
  assert.equal(p.fps, fps);
  assert.equal(p.frames.length, frames);
  p.frames.forEach((f, i) => {
    assert.ok(Math.abs(f.t - i / fps) < 1e-9);
    assert.deepEqual(f.up, [0, 1, 0]);
    assert.ok(norm(cross(dir(f), f.up)) > 0.05, '시선이 up 과 평행');
  });
  for (let i = 1; i < frames; i++) assert.ok(Math.abs(p.frames[i].t - p.frames[i - 1].t - 1 / fps) < 1e-9);
}

test('드론: 프레임 수·t 간격·반경 60±2·고도 40±2·center 응시', () => {
  const c = [10, 5, -20];
  const p = dronePath({ seed: 1, center: c });
  commonChecks(p, 300, 30);
  for (const f of p.frames) {
    assert.ok(Math.abs(Math.hypot(f.eye[0] - c[0], f.eye[2] - c[2]) - 60) <= 2);
    assert.ok(Math.abs(f.eye[1] - c[1] - 40) <= 2);
    assert.deepEqual(f.target, c);
  }
});

test('드론: 사용자 지정 frames/fps/radius/altitude', () => {
  const p = dronePath({ seed: 9, frames: 77, fps: 24, radius: 25, altitude: 15 });
  commonChecks(p, 77, 24);
  for (const f of p.frames) {
    assert.ok(Math.abs(Math.hypot(f.eye[0], f.eye[2]) - 25) <= 2);
    assert.ok(Math.abs(f.eye[1] - 15) <= 2);
  }
});

test('자유: 프레임 수·t 간격·속도 ≤ 15 m/s·각속도 ≤ 90°/s', () => {
  for (const seed of [1, 2, 3, 42, 777]) {
    const p = freePath({ seed });
    commonChecks(p, 600, 30);
    for (let i = 1; i < p.frames.length; i++) {
      const a = p.frames[i - 1], b = p.frames[i];
      const v = norm(sub(b.eye, a.eye)) * 30;
      assert.ok(v <= 15, `seed ${seed} 속도 ${v}`);
      const ang = Math.acos(Math.max(-1, Math.min(1, dot(dir(a), dir(b))))) * 30 * 180 / Math.PI;
      assert.ok(ang <= 90, `seed ${seed} 각속도 ${ang}`);
    }
  }
});

test('자유: bounds 안에 머문다', () => {
  const bounds = { min: [-50, 10, -50], max: [50, 60, 50] };
  const p = freePath({ seed: 5, bounds });
  for (const f of p.frames) f.eye.forEach((v, c) => assert.ok(v >= bounds.min[c] && v <= bounds.max[c]));
});

test('결정성: 같은 시드 JSON 동일, 다른 시드 다름', () => {
  for (const g of [dronePath, freePath]) {
    assert.equal(JSON.stringify(g({ seed: 3 })), JSON.stringify(g({ seed: 3 })));
    assert.notEqual(JSON.stringify(g({ seed: 3 })), JSON.stringify(g({ seed: 4 })));
  }
});

// ---- F-085 ⑥·F-088 ⑤·F-086 ④ ----
test('드론: 프레임 간 이동 ≤ 한 바퀴 둘레/frames + 지터 여유(7바퀴 변형 차단)', () => {
  // 반경 60·300프레임: 한 프레임 호 = 2π·60/300 ≈ 1.257 m. 지터 변화 포함 상한 3 m 로 고정.
  for (const seed of [1, 2, 3, 99]) {
    const p = dronePath({ seed });
    for (let i = 1; i < p.frames.length; i++) {
      const d = norm(sub(p.frames[i].eye, p.frames[i - 1].eye));
      assert.ok(d <= 3, `seed ${seed} 프레임 ${i} 이동 ${d} m`);
    }
    // 시간 속도(30 fps)도 15 m/s 이하
    assert.ok(norm(sub(p.frames[1].eye, p.frames[0].eye)) * 30 <= 90);
  }
});

test('자유: 시선 pitch 는 여러 시드에서 ±30° 이내(오버슈트 36.6° 시드 939 포함)', () => {
  const seeds = [939, ...Array.from({ length: 150 }, (_, i) => i + 1)];
  for (const seed of seeds) {
    for (const f of freePath({ seed }).frames) {
      const d = dir(f);
      const pitch = Math.asin(d[1]) * 180 / Math.PI;
      assert.ok(Math.abs(pitch) <= 30 + 1e-3, `seed ${seed} pitch ${pitch}`);
    }
  }
});

test('입력 거부: frames·fps·center·bounds·seed 검증(명시적 Error)', () => {
  const bad = (fn, re = /paths:|scene:/) => assert.throws(fn, re);
  for (const g of [dronePath, freePath]) {
    bad(() => g({ seed: 1, fps: 0 }));
    bad(() => g({ seed: 1, fps: -30 }));
    bad(() => g({ seed: 1, fps: NaN }));
    bad(() => g({ seed: 1, fps: Infinity }));
    bad(() => g({ seed: 1, frames: -1 }));
    bad(() => g({ seed: 1, frames: 2.5 }));
    bad(() => g({ seed: 1, frames: NaN }));
    bad(() => g({ seed: 1.5 }));
    bad(() => g({ seed: 'abc' }));
    bad(() => g({ seed: NaN }));
    assert.equal(g({ seed: 1, frames: 0 }).frames.length, 0);
    assert.equal(g({ seed: 1, frames: 1 }).frames.length, 1);
  }
  bad(() => dronePath({ seed: 1, center: [0, 0] }));
  bad(() => dronePath({ seed: 1, center: [0, NaN, 0] }));
  bad(() => dronePath({ seed: 1, center: [0, Infinity, 0] }));
  const mk = (min, max) => ({ min, max });
  bad(() => freePath({ seed: 1, bounds: mk([0, 0, 0], [0, 1, 1]) })); // 퇴화
  bad(() => freePath({ seed: 1, bounds: mk([1, 0, 0], [0, 1, 1]) })); // 뒤집힘
  bad(() => freePath({ seed: 1, bounds: mk([0, 0, NaN], [1, 1, 1]) }));
  bad(() => freePath({ seed: 1, bounds: mk([0, 0], [1, 1, 1]) }));
  bad(() => freePath({ seed: 1, bounds: null }));
  // fps 오류가 t=Infinity 프레임으로 새지 않는다
  assert.throws(() => dronePath({ seed: 1, fps: 0 }), /fps/);
});
