import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertRecords } from '../../../contracts/metrics/index.mjs';
import {
  run, rasterize, cameraExtrinsics, intrinsics, worldToCamera, cameraToWorld, projectCamera, decodePly, decodePlyFile, loadViewpoints,
  applySceneFrame, assertSceneFrame, assertCoverage, MIN_COVERAGE, computeSceneFrame, applyFrameTransform,
} from './index.mjs';
import { syntheticPoints, syntheticScene, encodeSplatPly } from './testing.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(await readFile(join(here, '../../../fixtures/viewpoints/viewpoints.json'), 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');

// 좌표 규약: 이 테스트의 카메라는 GL 식이다 (OpenCV 와는 diag(1,-1,-1) 로 변환). index.mjs 머리 주석 참고.
// 기준 카메라: 원점에 있고 -z 방향을 본다. up=+y.
const base = { eye: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0], width: 1280, height: 720, fov_y_deg: 50 };
const one = (p) => ({ positions: Float32Array.from(p), colors: Uint8Array.from([255, 255, 255]), count: 1 });
const whitePixels = (r) => {
  const w = [];
  for (let i = 0; i < r.width * r.height; i++) if (r.rgb[i * 3] === 255) w.push([i % r.width, Math.floor(i / r.width)]);
  return w;
};
const hitX = (r) => whitePixels(r).find(([, y]) => y === r.height / 2)?.[0] - r.width / 2;

test('(1) 카메라 앞 z=-10 의 흰 점이 주 점 픽셀에 찍힌다', () => {
  const r = rasterize(one([0, 0, -10]), base);
  assert.equal(r.drawn, 1);
  assert.deepEqual(whitePixels(r), [[640, 360]]);
});

test('(1b) 눈 뒤의 점은 찍히지 않는다', () => {
  assert.equal(rasterize(one([0, 0, 10]), base).drawn, 0);
});

test('(1c) 투영 부호: 동(+x)은 오른쪽(px>640), 위(+y)는 화면 위쪽(py<360)', () => {
  // f = 360/tan(25°) = 771.96, [1,0,-10] → u = 640 + 77.2 → 717, [0,1,-10] → v = 360 − 77.2 → 282
  assert.deepEqual(whitePixels(rasterize(one([1, 0, -10]), base)), [[717, 360]]);
  assert.deepEqual(whitePixels(rasterize(one([0, 1, -10]), base)), [[640, 282]]);
  assert.deepEqual(whitePixels(rasterize(one([-1, 0, -10]), base)), [[562, 360]]);
  assert.deepEqual(whitePixels(rasterize(one([0, -1, -10]), base)), [[640, 437]]);
});

test('(1d) 시점을 돌려도 부호가 유지된다', () => {
  // +z 에서 원점을 볼 때(-z 방향 시선) 동쪽 점은 오른쪽
  const [[x]] = whitePixels(rasterize(one([5, 0, 0]), { ...base, eye: [0, 0, 50], target: [0, 0, 0] }));
  assert.ok(x > 640);
  // -z 에서 +z 를 보면 동쪽 점은 왼쪽
  const [[x2]] = whitePixels(rasterize(one([5, 0, 0]), { ...base, eye: [0, 0, -50], target: [0, 0, 0] }));
  assert.ok(x2 < 640);
});

test('(1e) 퇴화 카메라는 throw: up∥시선, eye=target, up=0, 비유한 값', () => {
  const W = { width: 1280, height: 720, fov_y_deg: 50 };
  assert.throws(() => cameraExtrinsics({ eye: [0, 300, 0], target: [0, 0, 0], up: [0, 1, 0] }), /퇴화/);
  assert.throws(() => rasterize(one([0, 0, -10]), { ...W, eye: [0, 300, 0], target: [0, 0, 0], up: [0, 1, 0] }), /퇴화/);
  assert.throws(() => cameraExtrinsics({ eye: [0, -300, 0], target: [0, 0, 0], up: [0, 1, 0] }), /퇴화/);
  assert.throws(() => cameraExtrinsics({ eye: [1, 2, 3], target: [1, 2, 3], up: [0, 1, 0] }), /퇴화/);
  assert.throws(() => cameraExtrinsics({ eye: [0, 0, 0], target: [0, 0, -1], up: [0, 0, 0] }), /퇴화/);
  assert.throws(() => cameraExtrinsics({ eye: [NaN, 0, 0], target: [0, 0, -1], up: [0, 1, 0] }), /유한/);
});

test('(2) 해상도 절반이면 f, c 가 절반이고 점은 중심에서 절반 거리에 찍힌다', () => {
  const half = { ...base, width: 640, height: 360 };
  const Kf = intrinsics(base);
  const Kh = intrinsics(half);
  assert.ok(Math.abs(Kh.f - Kf.f / 2) < 1e-9 && Kh.cx === Kf.cx / 2 && Kh.cy === Kf.cy / 2);
  const { R, t } = cameraExtrinsics(base);
  const c = worldToCamera(R, t, [3, 2, -10]);
  const a = projectCamera(Kf, c);
  const b = projectCamera(Kh, c);
  assert.ok(Math.abs(b.u - Kh.cx - (a.u - Kf.cx) / 2) < 1e-9);
  assert.ok(Math.abs(b.v - Kh.cy - (a.v - Kf.cy) / 2) < 1e-9);
  const p = [2.5, 0, -10];
  const rf = rasterize(one(p), base);
  const rh = rasterize(one(p), half);
  assert.equal(rf.drawn, 1);
  assert.equal(rh.drawn, 1);
  assert.ok(Math.abs(hitX(rh) - hitX(rf) / 2) <= 1);
});

test('합성 점군은 결정적이다(테스트 전용)', () => {
  assert.deepEqual(syntheticPoints(1), syntheticPoints(1));
});

// ---- PLY 입력 ----
test('decodePly: 56 B 스플랫은 중심 x y z 와 f_dc 색을 쓴다', () => {
  const buf = encodeSplatPly([{ p: [1, 2, 3], rgb: [255, 0, 128] }, { p: [-4, 5, -6], rgb: [10, 200, 90] }]);
  const d = decodePly(buf, 'a.ply');
  assert.equal(d.count, 2);
  assert.equal(d.stride, 56);
  assert.equal(d.layout, 'splat-f_dc');
  assert.deepEqual([...d.positions], [1, 2, 3, -4, 5, -6]);
  assert.deepEqual([...d.colors], [255, 0, 128, 10, 200, 90]);
  // f_dc = 0 이면 0.5 → 128
  const g = Buffer.from(encodeSplatPly([{ p: [0, 0, 0], rgb: [0, 0, 0] }]));
  for (let k = 0; k < 3; k++) g.writeFloatLE(0, g.length - 56 + 12 + k * 4);
  assert.deepEqual([...decodePly(g, 'g.ply').colors], [128, 128, 128]);
});

test('decodePly 음성: 잘린 파일·깨진 헤더는 파일 이름을 넣어 실패', () => {
  const buf = encodeSplatPly([{ p: [1, 2, 3], rgb: [1, 2, 3] }]);
  assert.throws(() => decodePly(buf.subarray(0, buf.length - 1), 'cut.ply'), /cut\.ply.*크기/);
  assert.throws(() => decodePly(Buffer.from('ply\nformat ascii 1.0\nelement vertex 0\nend_header\n'), 'asc.ply'), /asc\.ply.*ascii/);
  assert.throws(() => decodePly(Buffer.from('garbage'), 'bad.ply'), /bad\.ply.*end_header/);
  const noColor = Buffer.from('ply\nformat binary_little_endian 1.0\nelement vertex 0\nproperty float x\nproperty float y\nproperty float z\nend_header\n');
  assert.throws(() => decodePly(noColor, 'nc.ply'), /nc\.ply.*색/);
});

// ---- 동률 깊이, 해상도·fov 검증 ----
test('동률 깊이: 같은 픽셀·같은 깊이면 먼저 온 점이 이긴다 (순서를 바꾸면 결과도 바뀐다)', () => {
  const pos = Float32Array.from([0, 0, -10, 0, 0, -10]);
  const red = rasterize({ positions: pos, colors: Uint8Array.from([255, 0, 0, 0, 0, 255]), count: 2 }, base);
  const blue = rasterize({ positions: pos, colors: Uint8Array.from([0, 0, 255, 255, 0, 0]), count: 2 }, base);
  const at = (r) => [...r.rgb.subarray((360 * 1280 + 640) * 3, (360 * 1280 + 640) * 3 + 3)];
  assert.equal(red.drawn, 1);
  assert.deepEqual(at(red), [255, 0, 0]);
  assert.deepEqual(at(blue), [0, 0, 255]);
  // 더 가까운 점은 순서와 상관없이 이긴다
  const near = rasterize({ positions: Float32Array.from([0, 0, -10, 0, 0, -9]), colors: Uint8Array.from([255, 0, 0, 0, 255, 0]), count: 2 }, base);
  assert.deepEqual(at(near), [0, 255, 0]);
});

test('fov_y_deg 는 0 초과 180 미만의 유한 수여야 한다', () => {
  for (const bad of [-50, 0, 180, 181, NaN, Infinity, '50', null, undefined]) {
    assert.throws(() => intrinsics({ ...base, fov_y_deg: bad }), /fov_y_deg/, String(bad));
    assert.throws(() => rasterize(one([0, 0, -10]), { ...base, fov_y_deg: bad }), /fov_y_deg/, String(bad));
  }
  for (const ok of [1e-3, 50, 179.9]) assert.doesNotThrow(() => intrinsics({ ...base, fov_y_deg: ok }));
});

test('width·height 는 양의 정수여야 한다', () => {
  for (const bad of [1280.5, 0, -1, NaN, Infinity, '1280', null, undefined]) {
    assert.throws(() => intrinsics({ ...base, width: bad }), /width/, String(bad));
    assert.throws(() => rasterize(one([0, 0, -10]), { ...base, width: bad }), /width/, String(bad));
    assert.throws(() => intrinsics({ ...base, height: bad }), /height/, String(bad));
  }
  assert.throws(() => rasterize(one([0, 0, -10]), { ...base, height: 720.5 }), /height/);
});

test('loadViewpoints: 시점의 fov·해상도가 틀리면 시점 id 를 넣어 throw', () => {
  const doc = (patch) => ({ ...FIXTURE, viewpoints: [{ ...FIXTURE.viewpoints[0], ...patch }] });
  for (const patch of [{ fov_y_deg: -50 }, { fov_y_deg: 0 }, { fov_y_deg: 180 }]) {
    assert.throws(() => loadViewpoints(doc(patch), FIXTURE.anchor, 'bad.json'), /bad\.json.*시점 1.*fov_y_deg/);
  }
  assert.throws(() => loadViewpoints(doc({ width: 1280.5 }), FIXTURE.anchor, 'bad.json'), /bad\.json.*시점 1.*width/);
  assert.throws(() => loadViewpoints(doc({ height: 0 }), FIXTURE.anchor, 'bad.json'), /bad\.json.*시점 1.*height/);
});

// ---- 점유율 ----
test('assertCoverage: 400 픽셀 화면에서 20 픽셀(정확히 5 %)은 통과, 19 픽셀은 throw', () => {
  const vp = { id: 1, name: 'tiny', width: 20, height: 20 };
  assert.equal(MIN_COVERAGE, 0.05);
  assert.equal(assertCoverage(vp, 20), 0.05);
  assert.throws(() => assertCoverage(vp, 19), /점유율.*시점 1|시점 1.*점유율/);
  assert.throws(() => assertCoverage(vp, 0), /점유율/);
});

test('합성 점군: 앱 틀을 적용하면 fixture 시점 8곳 모두 점유율 5 % 이상', () => {
  const framed = applySceneFrame(decodePly(SCENE_PLY, 'scene.ply'), FIXTURE.sceneFrame);
  assert.equal(FIXTURE.viewpoints.length, 8);
  for (const vp of FIXTURE.viewpoints) {
    const cov = rasterize(framed, vp).drawn / (vp.width * vp.height);
    assert.ok(cov >= MIN_COVERAGE, `시점 ${vp.id} ${vp.name} 점유율 ${cov}`);
  }
});

test('합성 점군: 앱 틀 없이 원좌표 그대로 그리면 점유율 5 % 미만이다 (틀이 필요한 이유)', () => {
  const raw = decodePly(SCENE_PLY, 'scene.ply');
  const low = FIXTURE.viewpoints.filter((vp) => rasterize(raw, vp).drawn / (vp.width * vp.height) < MIN_COVERAGE);
  assert.equal(low.length, 8);
});

test('run 음성: 성긴 점군은 점유율 때문에 실패하고 출력 디렉터리를 만들지 않는다', async (t) => {
  const sparse = encodeSplatPly(syntheticScene({ spacing: 2 }));
  const { dir, ply } = await setup(t, sparse, sparse);
  const o = join(dir, 'o');
  await assert.rejects(run({ skylensDir: dir, outDir: o, commit: 'c', inputs: { pointsPath: ply, anchor: FIXTURE.anchor } }), /시점 \d+ \S+: 점유율 [\d.]+ % 가 최소 5 %/);
  assert.ok(!(await readdir(dir)).includes('o'));
});

// ---- 앱 틀 ----
const X180 = { ...FIXTURE.sceneFrame, rotate: 'x180' }; // 인터넷 샘플 경로(x180)를 따로 시험한다.
test('applySceneFrame: x180 회전, 분위 상자 최대 변 44, XZ 중심 원점, 바닥 y=0, 이상점 제거, 입력 불변', () => {
  // 원좌표(y 아래): x∈[0,100] 균일, y∈[−10,10], z∈[−20,20]. 100 점 + 이상점 1개.
  const P = [];
  for (let i = 0; i <= 99; i++) P.push([i, -10 + (i % 5) * 5, -20 + (i % 9) * 5]);
  P.push([5000, 5000, 5000]);
  const positions = Float32Array.from(P.flat());
  const colors = Uint8Array.from(P.flatMap((_, i) => [i, 1, 2]));
  const before = Float32Array.from(positions);
  const out = applySceneFrame({ positions, colors, count: P.length }, X180);
  assert.deepEqual([...positions], [...before]);
  assert.equal(out.count, 100);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < out.count; i++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], out.positions[i * 3 + k]); hi[k] = Math.max(hi[k], out.positions[i * 3 + k]); }
  // x 방향이 가장 길다: 5~95 % 분위(x=5..95, 폭 90)가 44 가 되도록 축척
  const s = 44 / 90;
  assert.ok(Math.abs(hi[0] - lo[0] - 99 * s) < 1e-3, `x 폭 ${hi[0] - lo[0]}`);
  assert.ok(Math.abs((hi[0] + lo[0]) / 2 - s * (99 / 2 - 50)) < 1e-3);
  // 회전 (x,y,z)→(x,−y,−z): 원좌표 y 가 작을수록 출력 y 가 크다
  const small = P.findIndex((q) => q[1] === -10);
  const big = P.findIndex((q) => q[1] === 10);
  assert.ok(out.positions[small * 3 + 1] > out.positions[big * 3 + 1]);
  assert.ok(Math.abs(lo[1]) < 1e-3, `바닥 y ${lo[1]}`);
  // 점마다 색은 그대로 따라간다
  assert.equal(out.colors[0], 0);
  assert.equal(out.colors[99 * 3], 99);
});

test('applySceneFrame: 합성 장면에서 지면이 y≈0 에 놓이고 이상점이 제거된다', () => {
  const raw = decodePly(SCENE_PLY, 'scene.ply');
  const out = applySceneFrame(raw, FIXTURE.sceneFrame);
  assert.ok(out.count < raw.count, '이상점 제거');
  assert.ok(out.count > raw.count * 0.95);
  let minY = Infinity;
  for (let i = 0; i < out.count; i++) minY = Math.min(minY, out.positions[i * 3 + 1]);
  assert.ok(Math.abs(minY) < 1e-3, `최소 y ${minY}`);
});

test('applySceneFrame 음성: 빈 점군, 크기 0 상자, 틀 필드 오류', () => {
  const z = { positions: new Float32Array(0), colors: new Uint8Array(0), count: 0 };
  assert.throws(() => applySceneFrame(z, FIXTURE.sceneFrame, 'n.json'), /n\.json.*점이 없다/);
  const same = { positions: Float32Array.from([1, 1, 1, 1, 1, 1]), colors: new Uint8Array(6), count: 2 };
  assert.throws(() => applySceneFrame(same, FIXTURE.sceneFrame), /크기가 0/);
  for (const patch of [{ rotate: 'z90' }, { rotate: undefined }, { rotate: 'toString' }, { targetExtent: 0 }, { percentileLo: 0.96 }, { percentileHi: 1.5 }, { clipMargin: -1 },
    { sampleTarget: 0 }, { sampleTarget: 1.5 }, { framePly: '/abs/x.ply' }, { framePly: 'x.splat' }, { framePly: undefined }]) {
    assert.throws(() => assertSceneFrame({ ...FIXTURE.sceneFrame, ...patch }, 'f.json'), /f\.json.*sceneFrame/, JSON.stringify(patch));
  }
  for (const rotate of ['none', 'x180']) assert.doesNotThrow(() => assertSceneFrame({ ...FIXTURE.sceneFrame, rotate }));
  assert.throws(() => assertSceneFrame(undefined), /sceneFrame/);
});

test('fixture 는 점군 틀을 coord 와 sceneFrame 에 명시한다 (44, 자체 촬영 none, demoPreview 틀 PLY)', () => {
  assert.match(FIXTURE.coord, /sceneFrame/);
  assert.match(FIXTURE.coord, /GeoAnchor ENU 아님/);
  assert.doesNotMatch(FIXTURE.coord, /1 unit = 1 m/);
  assert.equal(FIXTURE.sceneFrame.rotate, 'none');
  assert.equal(FIXTURE.sceneFrame.targetExtent, 44);
  assert.equal(FIXTURE.sceneFrame.sampleTarget, 60000);
  assert.equal(FIXTURE.sceneFrame.framePly, 'res/static/demo/step00250_light.ply');
});

// 앱 sceneSource.ts deriveFromSplat(:329-391) 의 s·P·clip 계산을 줄 단위로 옮긴 독립 구현. index.mjs 와 코드를 공유하지 않는다.
// 회전은 THREE.Euler 대신 none=항등, x180=(x,−y,−z) 로 쓴다(Euler(π,0,0) 의 쿼터니언 회전과 같다).
function appDerive(raw, upright) {
  const total = raw.count;
  const sampleStride = Math.max(1, Math.floor(total / 60_000));
  const samples = [];
  for (let i = 0; i < total; i += sampleStride) samples.push([raw.positions[i * 3], raw.positions[i * 3 + 1], raw.positions[i * 3 + 2]]);
  const apply = (c) => (upright === 'x180' ? [c[0], -c[1], -c[2]] : [c[0], c[1], c[2]]);
  const xs = []; const ys = []; const zs = [];
  for (const sv of samples) { const c = apply(sv); xs.push(c[0]); ys.push(c[1]); zs.push(c[2]); }
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b); zs.sort((a, b) => a - b);
  const pctA = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  const rMin = [pctA(xs, 0.05), pctA(ys, 0.05), pctA(zs, 0.05)];
  const rMax = [pctA(xs, 0.95), pctA(ys, 0.95), pctA(zs, 0.95)];
  const size = [rMax[0] - rMin[0], rMax[1] - rMin[1], rMax[2] - rMin[2]];
  const maxDim = Math.max(...size) || 1;
  const s = 44 / maxDim;
  const rCenter = [(rMin[0] + rMax[0]) * 0.5, (rMin[1] + rMax[1]) * 0.5, (rMin[2] + rMax[2]) * 0.5];
  const P = [-s * rCenter[0], -s * rMin[1], -s * rCenter[2]];
  const margin = maxDim * 0.15;
  return { s, P, clipMin: rMin.map((v) => v - margin), clipMax: rMax.map((v) => v + margin), sampleStride };
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

test('computeSceneFrame 는 앱 알고리즘 이식 결과와 1e-6 안에서 같다 (none·x180, 표본 stride>1 포함)', () => {
  // 70만 점: stride = floor(700000/60000) = 11 이 되도록 큰 합성 점군을 만든다.
  const n = 700_000;
  const positions = new Float32Array(n * 3);
  // mulberry32(Math.imul 기반): 32 비트 정수 연산만 쓰므로 곱이 2^53 을 넘어 값이 겹치는 일이 없다.
  let a = 9;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < n * 3; i++) positions[i] = (rnd() - 0.5) * (i % 3 === 0 ? 300 : i % 3 === 1 ? 14 : 40) + (i % 3 === 0 ? -20 : 3);
  const big = { positions, colors: new Uint8Array(n * 3), count: n };
  // 분위 색인 q·(n−1) 의 소수부가 0.5 이상이면 round 와 floor 가 다른 칸을 고른다. 그 이웃 값이 같으면 변형을 못 잡으므로
  // 표본이 그 칸에서 서로 달라야 하고, 이 조건이 깨지면(표본 구성이 바뀌면) 여기서 먼저 실패한다.
  {
    const stride = Math.floor(n / 60_000);
    const m = Math.ceil(n / stride);
    const frac = (q) => (q * (m - 1)) % 1;
    assert.ok(frac(0.05) >= 0.5 || frac(0.95) >= 0.5, `표본 ${m}개에서 분위 색인 소수부가 모두 0.5 미만이다`);
    for (let axis = 0; axis < 3; axis++) {
      const vals = [];
      for (let i = 0; i < n; i += stride) vals.push(positions[i * 3 + axis]);
      vals.sort((p, q) => p - q);
      for (const q of [0.05, 0.95]) {
        if (frac(q) < 0.5) continue;
        const k = Math.floor(q * (m - 1));
        assert.notEqual(vals[k], vals[k + 1], `축 ${axis} q=${q}: floor/round 이웃 값이 같다`);
      }
    }
  }
  for (const rotate of ['none', 'x180']) {
    const fr = computeSceneFrame(big, { ...FIXTURE.sceneFrame, rotate });
    const ap = appDerive(big, rotate);
    assert.equal(fr.sampleStride, 11);
    assert.equal(fr.sampleStride, ap.sampleStride);
    assert.ok(near(fr.s, ap.s), `${rotate} s ${fr.s} vs ${ap.s}`);
    for (let k = 0; k < 3; k++) {
      assert.ok(near(fr.P[k], ap.P[k]), `${rotate} P[${k}]`);
      assert.ok(near(fr.clipMin[k], ap.clipMin[k]) && near(fr.clipMax[k], ap.clipMax[k]), `${rotate} clip[${k}]`);
    }
  }
  const synth = decodePly(SCENE_PLY, 'scene.ply');
  const fr = computeSceneFrame(synth, FIXTURE.sceneFrame);
  const ap = appDerive(synth, 'none');
  assert.ok(near(fr.s, ap.s));
  for (let k = 0; k < 3; k++) assert.ok(near(fr.P[k], ap.P[k]));
});

test('틀은 틀 PLY 에서 한 번 구하고 다른 점군에는 적용만 한다 (그리는 점군의 분위로 다시 구하지 않는다)', () => {
  const full = decodePly(SCENE_PLY, 'scene.ply');
  const fr = computeSceneFrame(full, FIXTURE.sceneFrame);
  // 앞쪽 1/4 만 자른 점군: 같은 변환을 적용하면 같은 점은 같은 자리에 놓인다.
  const cutN = Math.floor(full.count / 4);
  const cut = { positions: full.positions.slice(0, cutN * 3), colors: full.colors.slice(0, cutN * 3), count: cutN };
  const a = applyFrameTransform(full, fr);
  const b = applyFrameTransform(cut, fr);
  for (let i = 0; i < 50; i++) for (let k = 0; k < 3; k++) assert.equal(b.positions[i * 3 + k], a.positions[i * 3 + k]);
  // 잘린 점군 자신의 분위로 구하면 다르다 (그래서 run 은 그렇게 하지 않는다)
  assert.notEqual(computeSceneFrame(cut, FIXTURE.sceneFrame).s, fr.s);
});

test('합성 장면(rotate none): 지면 점의 y 중앙값이 지붕보다 낮다', () => {
  const raw = decodePly(SCENE_PLY, 'scene.ply');
  const out = applySceneFrame(raw, FIXTURE.sceneFrame);
  const ground = [];
  const roof = [];
  // 지면색 (90+…,120,90+…) 과 4번 건물 지붕(높이 38) 색 (140,185,150)
  for (let i = 0; i < out.count; i++) {
    const [r, g, b] = out.colors.subarray(i * 3, i * 3 + 3);
    if (g === 120 && r >= 90 && b >= 90) ground.push(out.positions[i * 3 + 1]);
    if (r === 140 && g === 185 && b === 150) roof.push(out.positions[i * 3 + 1]);
  }
  const med = (v) => v.sort((p, q) => p - q)[Math.floor(v.length / 2)];
  assert.ok(ground.length > 1000 && roof.length > 1000);
  assert.ok(med(ground) < med(roof), `지면 ${med(ground)} 지붕 ${med(roof)}`);
  // x180 로 잘못 돌리면 뒤집힌다
  const flipped = applySceneFrame(raw, X180);
  let gy = 0;
  let ry = 0;
  for (let i = 0; i < flipped.count; i++) {
    const [r, g, b] = flipped.colors.subarray(i * 3, i * 3 + 3);
    if (g === 120 && r >= 90 && b >= 90) gy += flipped.positions[i * 3 + 1];
    if (r === 140 && g === 185 && b === 150) ry += flipped.positions[i * 3 + 1];
  }
  assert.ok(gy / ground.length > ry / roof.length);
});

// ---- 비유한 값 ----
test('decodePly: NaN·Inf 좌표나 f_dc 를 가진 레코드는 제외하고 수를 센다 (색을 조용히 바꾸지 않는다)', () => {
  const buf = Buffer.from(encodeSplatPly([
    { p: [1, 2, 3], rgb: [10, 20, 30] }, { p: [4, 5, 6], rgb: [40, 50, 60] }, { p: [7, 8, 9], rgb: [70, 80, 90] }, { p: [0, 0, 0], rgb: [1, 1, 1] },
  ]));
  const head = buf.length - 4 * 56;
  buf.writeFloatLE(NaN, head + 56 * 1 + 4); // 2번 점 y = NaN
  buf.writeFloatLE(Infinity, head + 56 * 2 + 12 + 4); // 3번 점 f_dc_1 = Inf
  const d = decodePly(buf, 'nan.ply');
  assert.equal(d.rawCount, 4);
  assert.equal(d.nonFinite, 2);
  assert.equal(d.count, 2);
  assert.deepEqual([...d.positions], [1, 2, 3, 0, 0, 0]);
  assert.deepEqual([...d.colors], [10, 20, 30, 1, 1, 1]);
  const nanDc = Buffer.from(encodeSplatPly([{ p: [1, 1, 1], rgb: [9, 9, 9] }]));
  nanDc.writeFloatLE(NaN, nanDc.length - 56 + 12);
  assert.equal(decodePly(nanDc, 'dc.ply').count, 0);
});

test('applyFrameTransform: 비유한 좌표는 clip 을 통과하지 못한다', () => {
  const fr = computeSceneFrame(decodePly(SCENE_PLY, 'scene.ply'), FIXTURE.sceneFrame);
  const pts = { positions: Float32Array.from([NaN, 20, -30, 50, NaN, -30, 50, 20, Infinity, 50, 20, -30]), colors: new Uint8Array(12), count: 4 };
  const out = applyFrameTransform(pts, fr);
  assert.equal(out.count, 1);
  assert.equal(out.clipped, 3);
  assert.ok([...out.positions].every(Number.isFinite));
});

test('computeSceneFrame 음성: 틀 PLY 에 비유한 레코드가 있으면 throw', () => {
  const ok = decodePly(SCENE_PLY, 'scene.ply');
  assert.throws(() => computeSceneFrame({ ...ok, nonFinite: 1 }, FIXTURE.sceneFrame, 'frame.ply'), /frame\.ply.*비유한/);
  const p = Float32Array.from(ok.positions);
  p[4] = NaN;
  assert.throws(() => computeSceneFrame({ positions: p, count: ok.count }, FIXTURE.sceneFrame, 'frame.ply'), /frame\.ply.*비유한/);
});

// ---- run ----
// 앱 틀 밖 원좌표 합성 장면(y 위, 축척 0.1, 원점 이동). 틀을 적용해야 시점에서 보인다. 한 번만 만든다.
const SCENE_PLY = encodeSplatPly(syntheticScene());
const INPUT_ANCHOR = FIXTURE.anchor; // 실제 fixture 앵커. 덮어쓰지 않는다.

// dir 는 가짜 skylens 트리이기도 하다: 틀 PLY(framePly) 자리에 frame 을 둔다(기본은 합성 장면 자체).
async function setup(t, ply = SCENE_PLY, frame = SCENE_PLY) {
  const dir = await mkdtemp(join(tmpdir(), 'ref-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'syn.ply');
  await writeFile(file, ply);
  await mkdir(dirname(join(dir, FIXTURE.sceneFrame.framePly)), { recursive: true });
  await writeFile(join(dir, FIXTURE.sceneFrame.framePly), frame);
  return { dir, ply: file };
}

// 합성 장면(syntheticScene 기본값)·fixtures 시점 8곳의 PPM 전체 sha256 과 찍힌 픽셀 수.
// 구현 확정 때 한 번 박은 숫자이며 입력에서 도출하지 않는다.
const GOLDEN = {
  1: '858bc38ccf92f95bd9b43b65cb645710b40686c82ed4d95b95b173cc50827563',
  2: '07ca2cc6d15fe82d07c1c4fb483f17ce1691d97f99f6d3fcb8ae21b4e8907436',
  3: 'c7b6b154d7b1143a724305426f0319f41df697b4f4407f4e82d8336d7ac17b40',
  4: '9341aaea6b764811d5644d5e12d49b72f8aea2d0b63728a7bbbe6ac9345e2e62',
  5: '798bf99381dbbce522de86feb24f880d1ae086170bcb2f6b6c7d59ad30202b7b',
  6: '974e7ef024666c3b54a00d08f2e4319afe9d62a2361ef5fefefd49fc91466e95',
  7: '406c3980fdcebb2ccb4c80166b234f278faacca695864869898d19cdcca5eb18',
  8: 'a4c03ca1220dd639d07ec44fdccdab0adb5a2fe9acf1af0bbfacf23e3a33da65',
};
const GOLDEN_DRAWN = { 1: 143285, 2: 105798, 3: 73141, 4: 115112, 5: 65050, 6: 59573, 7: 138797, 8: 79524 };

test('(3) 시점 8곳 PPM 8장, 모두 점유율 5 % 이상, 시점별 sha256 골든, 재실행 시 바이트 동일', async (t) => {
  const { dir, ply } = await setup(t);
  const d1 = join(dir, 'o1');
  const d2 = join(dir, 'o2');
  const inputs = { pointsPath: ply, anchor: INPUT_ANCHOR };
  const rec1 = await run({ skylensDir: dir, outDir: d1, commit: 'abcdef1', inputs });
  const rec2 = await run({ skylensDir: dir, outDir: d2, commit: 'abcdef1', inputs });
  assertRecords(rec1);
  assert.deepEqual(rec1, rec2);
  assert.ok(rec1.every((r) => r.method.includes('f_dc') && r.method.includes('56B') && r.method.includes('앱 틀')));
  for (const r of rec1) {
    assert.match(r.method, /§7-4/);
    assert.match(r.method, /법선/);
    assert.match(r.method, /renderer_basis §7-4 27 B 와 다름: 56 B 스플랫, 법선 없음, 중심점만 사용/);
  }
  const f1 = (await readdir(d1)).sort();
  assert.equal(f1.length, 8);
  assert.deepEqual(f1, (await readdir(d2)).sort());
  const head = 'P6\n1280 720\n255\n';
  for (const f of f1) {
    const id = Number(f.match(/^viewpoint_(\d+)_/)[1]);
    const a = await readFile(join(d1, f));
    assert.equal(a.subarray(0, head.length).toString('ascii'), head);
    assert.equal(a.length, head.length + 1280 * 720 * 3);
    assert.ok(a.equals(await readFile(join(d2, f))), f);
    assert.equal(sha(a), GOLDEN[id], `v${id} sha256`);
    const drawn = rec1.find((r) => r.metric === `ref_images.drawn_pixels.v${id}`).value;
    assert.equal(drawn, GOLDEN_DRAWN[id], `v${id} drawn 값`);
    const cov = rec1.find((r) => r.metric === `ref_images.coverage.v${id}`).value;
    assert.ok(cov >= MIN_COVERAGE, `v${id} 점유율 ${cov}`);
  }
});

test('run 음성: pointsPath 없음 → throw (합성 대체 없음)', async (t) => {
  const { dir } = await setup(t, encodeSplatPly(syntheticPoints(1)));
  const o = join(dir, 'o');
  await assert.rejects(run({ skylensDir: dir, outDir: o, commit: 'c', inputs: { anchor: INPUT_ANCHOR } }), /input missing: pointsPath/);
  await assert.rejects(run({ skylensDir: dir, outDir: o, commit: 'c' }), /input missing: pointsPath/);
  await assert.rejects(run({ skylensDir: '/nonexistent', outDir: o, commit: 'c', inputs: {} }), /input missing/);
  assert.ok(!(await readdir(dir)).includes('o'));
});

test('run 음성: 존재하지 않는 점군 파일은 실패', async (t) => {
  const { dir } = await setup(t, encodeSplatPly(syntheticPoints(1)));
  await assert.rejects(run({ skylensDir: dir, outDir: join(dir, 'o'), commit: 'c', inputs: { pointsPath: join(dir, 'nope.ply'), anchor: INPUT_ANCHOR } }), /ENOENT/);
});

// 앵커는 운영자가 선언한 값이다. fixture 의 값과 inputs.anchor 두 선언만 대조하고 점군 파일은 보지 않는다.
test('run 음성: inputs.anchor 없음, fixture 앵커와 한 성분이라도 다르면 실패 (fixture 실제 값 기준)', async (t) => {
  const { dir, ply } = await setup(t, encodeSplatPly(syntheticPoints(1)));
  const o = join(dir, 'o');
  await assert.rejects(run({ skylensDir: dir, outDir: o, commit: 'c', inputs: { pointsPath: ply } }), /input missing: anchor/);
  for (const k of ['lat', 'lon', 'alt']) {
    const bad = { ...INPUT_ANCHOR, [k]: INPUT_ANCHOR[k] + 0.001 };
    await assert.rejects(run({ skylensDir: dir, outDir: o, commit: 'c', inputs: { pointsPath: ply, anchor: bad } }), new RegExp(`anchor\\.${k}=${FIXTURE.anchor[k]} 가 inputs\\.anchor\\.${k}=${bad[k]}.*점군은 보지 않는다`));
  }
  assert.ok(!(await readdir(dir)).includes('o'));
});

test('run: 앵커가 같으면 점군 내용과 상관없이 통과한다 (점군 쪽 앵커 대조는 없다)', async (t) => {
  const { dir, ply } = await setup(t);
  const recs = await run({ skylensDir: dir, outDir: join(dir, 'o'), commit: 'c', inputs: { pointsPath: ply, anchor: { ...FIXTURE.anchor } } });
  assert.equal(recs.length, 17);
  assert.equal(recs.find((r) => r.metric === 'ref_images.nonfinite_excluded').value, 0);
});

test('run: 그릴 점군의 비유한 레코드는 제외 수를 지표와 method 로 보고하고, 틀 PLY 의 비유한 값은 throw', async (t) => {
  const bad = Buffer.from(SCENE_PLY);
  const n = decodePly(SCENE_PLY, 'scene.ply').count;
  const body = bad.length - n * 56;
  bad.writeFloatLE(NaN, body + 0); // 0번 점 x
  bad.writeFloatLE(NaN, body + 56 * 7 + 12); // 7번 점 f_dc_0
  const { dir, ply } = await setup(t, bad);
  const recs = await run({ skylensDir: dir, outDir: join(dir, 'o'), commit: 'c', inputs: { pointsPath: ply, anchor: INPUT_ANCHOR } });
  assert.equal(recs.find((r) => r.metric === 'ref_images.nonfinite_excluded').value, 2);
  assert.match(recs[0].method, /비유한 2점 제외/);
  const s2 = await setup(t, SCENE_PLY, bad);
  await assert.rejects(run({ skylensDir: s2.dir, outDir: join(s2.dir, 'o'), commit: 'c', inputs: { pointsPath: s2.ply, anchor: INPUT_ANCHOR } }), /step00250_light\.ply.*비유한 레코드 2개/);
  assert.ok(!(await readdir(s2.dir)).includes('o'));
});

test('run 음성: viewpoints 에 anchor·sceneFrame 없음, coord 가 ENU 표기, 시점 fov 오류면 실패', async (t) => {
  const { dir, ply } = await setup(t, encodeSplatPly(syntheticPoints(1)));
  const noAnchor = join(dir, 'na.json');
  await writeFile(noAnchor, JSON.stringify({ coord: 'scene (x=east, y=up, z=-north)', sceneFrame: FIXTURE.sceneFrame, viewpoints: FIXTURE.viewpoints }));
  const inputs = { pointsPath: ply, anchor: INPUT_ANCHOR };
  await assert.rejects(run({ skylensDir: dir, outDir: join(dir, 'o'), commit: 'c', inputs, viewpointsPath: noAnchor }), /na\.json.*anchor/);
  const noFrame = join(dir, 'nf.json');
  await writeFile(noFrame, JSON.stringify({ ...FIXTURE, sceneFrame: undefined }));
  await assert.rejects(run({ skylensDir: dir, outDir: join(dir, 'o'), commit: 'c', inputs, viewpointsPath: noFrame }), /nf\.json.*sceneFrame/);
  const badFov = join(dir, 'fov.json');
  await writeFile(badFov, JSON.stringify({ ...FIXTURE, viewpoints: [{ ...FIXTURE.viewpoints[0], fov_y_deg: 180 }] }));
  await assert.rejects(run({ skylensDir: dir, outDir: join(dir, 'o'), commit: 'c', inputs, viewpointsPath: badFov }), /fov\.json.*fov_y_deg/);
  assert.throws(() => loadViewpoints({ ...FIXTURE, coord: 'ENU, x=east y=up z=-north' }, INPUT_ANCHOR, 'enu.json'), /enu\.json.*coord/);
  assert.throws(() => loadViewpoints({ ...FIXTURE, anchor: { lat: 1, lon: 'x', alt: 3 } }, INPUT_ANCHOR), /anchor/);
});

test('run 음성: 아무것도 안 찍히는 시점, 퇴화 시점이 있으면 실패', async (t) => {
  const { dir, ply } = await setup(t);
  const mk = async (name, vps) => {
    const p = join(dir, name);
    await writeFile(p, JSON.stringify({ ...FIXTURE, viewpoints: vps }));
    return p;
  };
  const inputs = { pointsPath: ply, anchor: INPUT_ANCHOR };
  const v0 = FIXTURE.viewpoints[0];
  const away = await mk('away.json', [{ ...v0, id: 9, name: 'away', eye: [0, 30, 500], target: [0, 30, 600] }]);
  // 찍힌 픽셀 0 은 점유율 검사(assertCoverage)가 맡는다: 시점 id·name 과 0 % 가 메시지에 들어 있어야 한다.
  await assert.rejects(run({ skylensDir: dir, outDir: join(dir, 'o'), commit: 'c', inputs, viewpointsPath: away }), /시점 9 away: 점유율 0\.000 % .*보다 낮다/);
  const vertical = await mk('vert.json', [{ ...v0, id: 10, name: 'down', eye: [0, 300, 0], target: [0, 0, 0], up: [0, 1, 0] }]);
  await assert.rejects(run({ skylensDir: dir, outDir: join(dir, 'o'), commit: 'c', inputs, viewpointsPath: vertical }), /퇴화/);
});

// ---- 실제 skylens 수준 3(step07000) PLY ----
// 파일이 없으면 건너뛴다. 앱 틀 적용 뒤 점유율 5 % 미만인 시점이 있으면 run 이 실패하며, 그것이 정상 판정이다.
// 그리는 점군은 틀 PLY(demoPreview step00250_light.ply)와 같은 원좌표 틀인 step07000_light.ply 다.
// 구간 PLY(segments/*)는 align_scene.py 로 옮긴 다른 틀이라 demoPreview 틀에서는 전부 clip 된다(아래 시험).
const SKYLENS = process.env.SKYLENS_DIR ?? '/tmp/skylens';
const REAL = join(SKYLENS, 'res/static/demo/step07000_light.ply');
const PREVIEW = join(SKYLENS, FIXTURE.sceneFrame.framePly);
const SEG0 = join(SKYLENS, 'res/static/demo/segments/seg0_step07000.ply');
const hasReal = await Promise.all([REAL, PREVIEW].map((f) => access(f).then(() => true, () => false))).then((v) => v.every(Boolean));
const hasSeg = await access(SEG0).then(() => true, () => false);
// develop 59edcf9 step00250_light.ply(8434점)에서 구한 값. 구현 확정 때 박은 숫자다.
const PREVIEW_S = 5.442149081417863;
const PREVIEW_P = [-8.851082038839118, 2.3253396724926905, -1.7505949670611007];

test('실제 demoPreview: s·P 가 앱 알고리즘 이식 결과·고정값과 1e-6 안에서 같다', { skip: !hasReal && '실제 skylens 트리 없음' }, async () => {
  const raw = decodePly(await readFile(PREVIEW), PREVIEW);
  const fr = computeSceneFrame(raw, FIXTURE.sceneFrame, PREVIEW);
  const ap = appDerive(raw, 'none');
  assert.equal(fr.sampleStride, 1);
  assert.ok(near(fr.s, ap.s) && near(fr.s, PREVIEW_S), `s ${fr.s}`);
  for (let k = 0; k < 3; k++) assert.ok(near(fr.P[k], ap.P[k]) && near(fr.P[k], PREVIEW_P[k]), `P[${k}] ${fr.P[k]}`);
});

test('실제 수준 3 PLY: 8장, 재실행 sha256 동일, 점유율 5 % 이상, method 에 s·P 기록', { skip: !hasReal && '실제 skylens 트리 없음' }, async (t) => {
  const { dir } = await setup(t, encodeSplatPly(syntheticPoints(1)));
  const inputs = { pointsPath: REAL, anchor: INPUT_ANCHOR };
  const a = await run({ skylensDir: SKYLENS, outDir: join(dir, 'a'), commit: 'abcdef1', inputs });
  await run({ skylensDir: SKYLENS, outDir: join(dir, 'b'), commit: 'abcdef1', inputs });
  assertRecords(a);
  assert.ok(a[0].method.includes('f_dc'));
  assert.ok(a[0].method.includes('rotate none') && a[0].method.includes(`s=${Number(PREVIEW_S.toPrecision(10))}`), a[0].method);
  assert.equal(a.find((r) => r.metric === 'ref_images.nonfinite_excluded').value, 0);
  const files = (await readdir(join(dir, 'a'))).sort();
  assert.equal(files.length, 8);
  for (const f of files) assert.equal(sha(await readFile(join(dir, 'a', f))), sha(await readFile(join(dir, 'b', f))), f);
  const cov = a.filter((x) => x.metric.startsWith('ref_images.coverage'));
  assert.equal(cov.length, 8);
  for (const r of cov) assert.ok(r.value >= MIN_COVERAGE, `${r.metric} ${r.value}`);
});

test('실제 구간 PLY 는 demoPreview 틀과 좌표 틀이 달라 전부 clip 된다 (구간 PLY 를 pointsPath 로 쓰면 run 이 실패)', { skip: !(hasReal && hasSeg) && '실제 skylens 트리 없음' }, async () => {
  const fr = computeSceneFrame(decodePly(await readFile(PREVIEW), PREVIEW), FIXTURE.sceneFrame, PREVIEW);
  const seg = decodePly(await readFile(SEG0), SEG0);
  assert.equal(applyFrameTransform(seg, fr).count, 0);
});

test('(4) 역투영 X_w = Rᵀ(X_c − t) 왕복 오차 < 1e-6', () => {
  const views = [
    base,
    { eye: [150, 150, 250], target: [0, 10, 0], up: [0, 1, 0] },
    { eye: [-300, 80, 200], target: [0, 10, 0], up: [0, 1, 0] },
  ];
  for (const v of views) {
    const { R, t } = cameraExtrinsics(v);
    for (const p of [[1, 2, 3], [-40.5, 7.25, -90], [100, 0, 100]]) {
      const q = cameraToWorld(R, t, worldToCamera(R, t, p));
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(q[k] - p[k]) < 1e-6);
    }
    // R 은 직교 행렬
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const dot = R[i * 3] * R[j * 3] + R[i * 3 + 1] * R[j * 3 + 1] + R[i * 3 + 2] * R[j * 3 + 2];
        assert.ok(Math.abs(dot - (i === j ? 1 : 0)) < 1e-12);
      }
    }
  }
});

// ---- F-030: 시점 id·name 검증 ----
const ANCHOR_OK = { lat: FIXTURE.anchor.lat, lon: FIXTURE.anchor.lon, alt: FIXTURE.anchor.alt };
const withVps = (vps) => ({ ...FIXTURE, viewpoints: vps });
const v0 = FIXTURE.viewpoints[0];

test('loadViewpoints: name 에 경로 구분자·점·공백이 있으면 거부 (파일 이름으로 outDir 밖에 쓰지 못한다)', () => {
  for (const bad of ['x/../../escaped', '../a', 'a/b', 'a b', 'a.b', '', 5, null]) {
    assert.throws(() => loadViewpoints(withVps([{ ...v0, name: bad }]), ANCHOR_OK, 'n.json'), /n\.json.*name/, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => loadViewpoints(withVps([{ ...v0, name: 'ok-name_1' }]), ANCHOR_OK));
});

test('loadViewpoints: id 는 정수여야 하고 id·name 중복은 거부', () => {
  for (const bad of ['1', 1.5, null, undefined, NaN]) {
    assert.throws(() => loadViewpoints(withVps([{ ...v0, id: bad }]), ANCHOR_OK, 'i.json'), /i\.json.*id/, String(bad));
  }
  assert.throws(() => loadViewpoints(withVps([v0, { ...v0, name: 'other' }]), ANCHOR_OK), /id 1 .*중복/);
  assert.throws(() => loadViewpoints(withVps([v0, { ...v0, id: 2 }]), ANCHOR_OK), /name status_overview .*중복/);
});

test('loadViewpoints: null·비객체 시점은 TypeError 가 아니라 명확한 오류', () => {
  for (const bad of [null, 3, 'x', [1]]) {
    assert.throws(() => loadViewpoints(withVps([v0, bad]), ANCHOR_OK, 'z.json'), (e) => !(e instanceof TypeError) && /z\.json.*viewpoints\[1\].*객체/.test(e.message), JSON.stringify(bad));
  }
});

test('run 음성: name 이 x/../../escaped 인 시점은 파일을 쓰기 전에 실패하고 outDir 밖에 아무것도 만들지 않는다', async (t) => {
  const { dir, ply } = await setup(t);
  const p = join(dir, 'esc.json');
  await writeFile(p, JSON.stringify(withVps([{ ...v0, name: 'x/../../escaped' }])));
  const out = join(dir, 'a', 'b');
  await assert.rejects(run({ skylensDir: dir, outDir: out, commit: 'c', inputs: { pointsPath: ply, anchor: INPUT_ANCHOR }, viewpointsPath: p }), /name/);
  assert.deepEqual((await readdir(dir)).sort(), ['res', 'syn.ply', 'esc.json'].sort());
});

// ---- F-028: 청크 읽기 ----
test('decodePlyFile 은 decodePly 와 같은 결과를 청크 경계와 무관하게 낸다 (비유한 포함, rgb 배치 포함)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'chunk-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pts = syntheticPoints(3).slice(0, 5000);
  const buf = encodeSplatPly(pts);
  // 비유한 레코드 두 개: 첫 레코드 x, 마지막 레코드 f_dc_1
  const head = buf.length - 56 * pts.length;
  buf.writeFloatLE(NaN, head);
  buf.writeFloatLE(Infinity, head + 56 * (pts.length - 1) + 16);
  const f = join(dir, 'a.ply');
  await writeFile(f, buf);
  const ref = decodePly(buf, 'a.ply');
  assert.equal(ref.nonFinite, 2);
  for (const chunkRecords of [1, 7, 4999, 5000, 5001, 1 << 16]) {
    const d = await decodePlyFile(f, 'a.ply', { chunkRecords });
    assert.equal(d.count, ref.count, `chunk ${chunkRecords}`);
    assert.equal(d.nonFinite, 2);
    assert.ok(Buffer.from(d.positions.buffer, d.positions.byteOffset, d.positions.byteLength).equals(Buffer.from(ref.positions.buffer, ref.positions.byteOffset, ref.positions.byteLength)));
    assert.deepEqual([...d.colors], [...ref.colors]);
  }
  await writeFile(join(dir, 'cut.ply'), buf.subarray(0, buf.length - 1));
  await assert.rejects(decodePlyFile(join(dir, 'cut.ply'), 'cut.ply'), /cut\.ply.*크기/);
  await writeFile(join(dir, 'bad.ply'), 'garbage');
  await assert.rejects(decodePlyFile(join(dir, 'bad.ply'), 'bad.ply'), /bad\.ply.*end_header/);
  await assert.rejects(decodePlyFile(f, 'a.ply', { chunkRecords: 0 }), /chunkRecords/);
});

// 대형 PLY(기본 건너뜀): REF_IMAGES_BIG_POINTS=점수 로 합성 PLY 를 만들어 완료와 피크 RSS 를 확인한다. 점수는 예: 1000000.
test('대형 합성 PLY 청크 읽기 (REF_IMAGES_BIG_POINTS 로 켠다)', { skip: !process.env.REF_IMAGES_BIG_POINTS && '환경변수 REF_IMAGES_BIG_POINTS 없음' }, async (t) => {
  const n = Number(process.env.REF_IMAGES_BIG_POINTS);
  const dir = await mkdtemp(join(tmpdir(), 'big-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const f = join(dir, 'big.ply');
  const { createWriteStream } = await import('node:fs');
  const ws = createWriteStream(f);
  ws.write(`ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${names.map((q) => `property float ${q}\n`).join('')}end_header\n`, 'latin1');
  const blk = Buffer.alloc(56 * 65536);
  for (let w = 0; w < n; w += 65536) {
    const m = Math.min(65536, n - w);
    for (let i = 0; i < m; i++) blk.writeFloatLE((w + i) % 1000, i * 56);
    ws.write(blk.subarray(0, m * 56));
  }
  await new Promise((r) => ws.end(r));
  const d = await decodePlyFile(f, 'big.ply');
  assert.equal(d.count, n);
});

// ---- F-031: 출처·라이선스 표기 ----
test('index.mjs 머리에 skylens(MIT) 출처·라이선스와 GeoAnchor 원점 아님 설명이 있다', async () => {
  const head = (await readFile(join(here, 'index.mjs'), 'utf8')).split('\n').slice(0, 14).join('\n');
  assert.match(head, /skylens\(MIT/);
  assert.match(head, /sceneSource\.ts.*deriveFromSplat/);
  assert.match(head, /재구현/);
  assert.match(head, /sceneFrame 정규화 중심/);
  assert.match(head, /GeoAnchor 의 ENU 원점이 아니다/);
  assert.doesNotMatch(head, /원점의 GeoAnchor/);
});
