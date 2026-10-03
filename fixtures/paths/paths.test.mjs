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

test('자유: 등속 10 m/s(누적 199.7 m ±5%, 프레임 속도 9~11 m/s)·yaw 범위 > 10°', () => {
  // 599 구간 / 30 fps = 19.9667 s × 10 m/s = 199.67 m. 시드를 고르지 않고 1~200 전부에서 성립해야 한다
  // (구현이 곡선을 bounds 안으로 아핀 축소하고 프레임 간 직선 거리를 10/30 m 로 맞춘다).
  for (let seed = 1; seed <= 200; seed++) {
    const p = freePath({ seed });
    let len = 0, yMin = Infinity, yMax = -Infinity, prevYaw = null, yaw = 0;
    for (let i = 0; i < p.frames.length; i++) {
      if (i > 0) {
        const v = norm(sub(p.frames[i].eye, p.frames[i - 1].eye));
        len += v;
        assert.ok(v * 30 >= 9 && v * 30 <= 11, `seed ${seed} 프레임 ${i} 속도 ${v * 30}`);
      }
      const d = sub(p.frames[i].target, p.frames[i].eye);
      const y = Math.atan2(d[0], -d[2]); // 시선 yaw(라디안)
      if (prevYaw === null) yaw = y;
      else { let dy = y - prevYaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI; yaw += dy; }
      prevYaw = y;
      yMin = Math.min(yMin, yaw); yMax = Math.max(yMax, yaw);
    }
    assert.ok(Math.abs(len - 199.7) <= 199.7 * 0.05, `seed ${seed} 누적 이동 ${len}`);
    assert.ok(((yMax - yMin) * 180) / Math.PI > 10, `seed ${seed} yaw 범위 ${((yMax - yMin) * 180) / Math.PI}°`);
  }
});

test('자유: bounds 안에 머문다(오버슈트 시드 276: 축소하지 않으면 최대 9.18 m 벗어남)', () => {
  const bounds = { min: [-50, 10, -50], max: [50, 60, 50] };
  const p = freePath({ seed: 276, bounds });
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const f of p.frames) {
    f.eye.forEach((v, c) => {
      assert.ok(v >= bounds.min[c] && v <= bounds.max[c], `축 ${c} 값 ${v}`);
      lo[c] = Math.min(lo[c], v); hi[c] = Math.max(hi[c], v);
    });
  }
  // 오버슈트 축은 bounds 폭 대부분을 쓰도록 축소돼 있어야 한다(0.5 보다 작은 값으로 줄어든 경로가 아님).
  assert.ok([0, 1, 2].some((c) => hi[c] - lo[c] > 0.5 * (bounds.max[c] - bounds.min[c])), '경로가 bounds 를 쓰지 않음');
});

test('결정성: 같은 시드 JSON 동일, 다른 시드 다름', () => {
  for (const g of [dronePath, freePath]) {
    assert.equal(JSON.stringify(g({ seed: 3 })), JSON.stringify(g({ seed: 3 })));
    assert.notEqual(JSON.stringify(g({ seed: 3 })), JSON.stringify(g({ seed: 4 })));
  }
});

// ---- F-085 ⑥·F-088 ⑤·F-086 ④ ----
test('드론: 한 바퀴(회전 합 +2π±0.05)·프레임 이동 0.7~1.8 m·지터 존재(정지·2바퀴·0.5바퀴·역방향·지터 제거 변이 차단)', () => {
  // 반경 60·300프레임: 한 프레임 호 = 2π·60/300 ≈ 1.257 m. 지터(축당 ≤1.5 m, 저주파) 변화가 프레임당 ≈0.5 m 이하이므로 0.7~1.8 m.
  // 시간 속도로는 0.7*30 = 21 ~ 1.8*30 = 54 m/s 이다(드론 시나리오 값이며 자유 경로 15 m/s 상한과 무관).
  for (const seed of [1, 2, 3, 67, 99]) {
    const p = dronePath({ seed });
    const n = p.frames.length;
    let rot = 0;
    const r = p.frames.map((f) => Math.hypot(f.eye[0], f.eye[2]));
    let altitudeMin = Infinity, altitudeMax = -Infinity;
    const angRes = []; // 이론 궤도각(2π·i/n)을 뺀 각 잔차(시작각은 평균 제거로 흡수)
    for (let i = 0; i < n; i++) {
      const a = p.frames[i].eye, b = p.frames[(i + 1) % n].eye; // 마지막→처음 닫힘 구간 포함
      altitudeMin = Math.min(altitudeMin, a[1]);
      altitudeMax = Math.max(altitudeMax, a[1]);
      let e = Math.atan2(a[2], a[0]) - (2 * Math.PI * i) / n;
      e = Math.atan2(Math.sin(e), Math.cos(e));
      angRes.push(e);
      let d = Math.atan2(b[2], b[0]) - Math.atan2(a[2], a[0]);
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      rot += d;
      if (i === n - 1) continue; // 닫힘 구간은 지터가 주기적이지 않아 이음매 점프가 있다(회전 합에만 쓴다)
      const m = norm(sub(b, a));
      assert.ok(m >= 0.7 && m <= 1.8, `seed ${seed} 프레임 ${i} 이동 ${m} m`);
    }
    assert.ok(Math.abs(rot - 2 * Math.PI) <= 0.05, `seed ${seed} 회전 합 ${rot}`);
    assert.ok(Math.max(...r) - Math.min(...r) > 1.0, `seed ${seed} 반경 지터 없음`);
    assert.ok(altitudeMax - altitudeMin > 1.0, `seed ${seed} 고도 폭 ${altitudeMax - altitudeMin} m`);
    // 접선 지터 jt(진폭 ≤ 1.5 m, 사인 합이라 최대-최소 폭: 실측 ≈2.52~2.98 m)는 궤도 진행을 뺀 접선 잔차(원형 평균 제거 각 × 반경 60 m)의 폭으로 드러난다.
    // jt=0 이면 잔차는 반올림 오차(~1e-6 m)뿐이므로 1.3 m 한계는 양쪽에서 큰 마진을 갖는다(jt 0.4배 변이도 감지; 한계 설정 근거: 실측 폭 최대값 ≈1.19 m, 안전율 약 1.09배).
    const c = Math.atan2(angRes.reduce((s, v) => s + Math.sin(v), 0), angRes.reduce((s, v) => s + Math.cos(v), 0));
    const tRes = angRes.map((v) => Math.atan2(Math.sin(v - c), Math.cos(v - c)) * 60);
    const tWidth = Math.max(...tRes) - Math.min(...tRes);
    assert.ok(tWidth > 1.3, `seed ${seed} 접선 잔차 폭 ${tWidth} m > 1.3 m`);
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
  // F-090: fps 하한·frames 상한·극단 bounds·결과 유한 검사는 명시적 paths: Error 여야 한다(TypeError 불가)
  for (const g of [dronePath, freePath]) {
    assert.throws(() => g({ seed: 1, fps: 1e-320 }), (e) => e.constructor === Error && /paths: fps/.test(e.message));
    assert.throws(() => g({ seed: 1, fps: 5e-4 }), /paths: fps/);
    assert.throws(() => g({ seed: 1, frames: 1e6 + 1 }), (e) => e.constructor === Error && /paths: frames/.test(e.message));
  }
  assert.throws(() => freePath({ seed: 1, bounds: mk([-1e308, 0, 0], [1e308, 1, 1]) }), (e) => e.constructor === Error && /paths:/.test(e.message));
  assert.throws(() => freePath({ seed: 1, frames: 3, bounds: mk([-1e307, 0, 0], [1e307, 1, 1]) }), (e) => e.constructor === Error && /paths:/.test(e.message));
  assert.throws(() => dronePath({ seed: 1, frames: 3, radius: 1e308 }), (e) => e.constructor === Error && /paths: 결과/.test(e.message));
  assert.throws(() => dronePath({ seed: 1, frames: 3, center: [1e308, 0, 0], radius: 1e308 }), (e) => e.constructor === Error && /paths:/.test(e.message));
  // F-091: opts 가 null 이어도 기본값으로 생성(TypeError 아님)
  for (const g of [dronePath, freePath]) assert.ok(g(null).frames.length > 0);
  // fps 오류가 t=Infinity 프레임으로 새지 않는다
  assert.throws(() => dronePath({ seed: 1, fps: 0 }), /fps/);
});
