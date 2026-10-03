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
