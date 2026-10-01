import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertRecords } from '../../../contracts/metrics/index.mjs';
import {
  run, rasterize, cameraExtrinsics, intrinsics, worldToCamera, cameraToWorld, projectCamera, decodePly, loadViewpoints,
  applySceneFrame, assertSceneFrame, assertCoverage, MIN_COVERAGE,
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
  const dir = await mkdtemp(join(tmpdir(), 'ref-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ply = join(dir, 'sparse.ply');
  await writeFile(ply, encodeSplatPly(syntheticScene({ spacing: 2 })));
  const o = join(dir, 'o');
  await assert.rejects(run({ skylensDir: '.', outDir: o, commit: 'c', inputs: { pointsPath: ply, anchor: FIXTURE.anchor } }), /시점 \d+ \S+: 점유율 [\d.]+ % 가 최소 5 %/);
  assert.ok(!(await readdir(dir)).includes('o'));
});

// ---- 앱 틀 ----
test('applySceneFrame: x180 회전, 분위 상자 최대 변 44, XZ 중심 원점, 바닥 y=0, 이상점 제거, 입력 불변', () => {
  // 원좌표(y 아래): x∈[0,100] 균일, y∈[−10,10], z∈[−20,20]. 100 점 + 이상점 1개.
  const P = [];
  for (let i = 0; i <= 99; i++) P.push([i, -10 + (i % 5) * 5, -20 + (i % 9) * 5]);
  P.push([5000, 5000, 5000]);
  const positions = Float32Array.from(P.flat());
  const colors = Uint8Array.from(P.flatMap((_, i) => [i, 1, 2]));
  const before = Float32Array.from(positions);
  const out = applySceneFrame({ positions, colors, count: P.length }, FIXTURE.sceneFrame);
  assert.deepEqual([...positions], [...before]);
  assert.equal(out.count, 100);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < out.count; i++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], out.positions[i * 3 + k]); hi[k] = Math.max(hi[k], out.positions[i * 3 + k]); }
  // x 방향이 가장 길다: 5~95 % 분위(x=5..95, 폭 90)가 44 m 가 되도록 축척
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
  for (const patch of [{ rotate: 'none' }, { targetExtent: 0 }, { percentileLo: 0.96 }, { percentileHi: 1.5 }, { clipMargin: -1 }]) {
    assert.throws(() => assertSceneFrame({ ...FIXTURE.sceneFrame, ...patch }, 'f.json'), /f\.json.*sceneFrame/, JSON.stringify(patch));
  }
  assert.throws(() => assertSceneFrame(undefined), /sceneFrame/);
});

test('fixture 는 점군 틀을 coord 와 sceneFrame 에 명시한다 (44 m, x180)', () => {
  assert.match(FIXTURE.coord, /sceneFrame/);
  assert.equal(FIXTURE.sceneFrame.rotate, 'x180');
  assert.equal(FIXTURE.sceneFrame.targetExtent, 44);
});

// ---- run ----
// 앱 틀 밖 원좌표 합성 장면(y 아래, 축척 0.1). 틀을 적용해야 시점에서 보인다. 한 번만 만든다.
const SCENE_PLY = encodeSplatPly(syntheticScene());
const INPUT_ANCHOR = FIXTURE.anchor; // 실제 fixture 앵커. 덮어쓰지 않는다.

async function setup(t, ply = SCENE_PLY) {
  const dir = await mkdtemp(join(tmpdir(), 'ref-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'syn.ply');
  await writeFile(file, ply);
  return { dir, ply: file };
}

// 합성 장면(syntheticScene 기본값)·fixtures 시점 8곳의 PPM 전체 sha256 과 찍힌 픽셀 수.
// 구현 확정 때 한 번 박은 숫자이며 입력에서 도출하지 않는다.
const GOLDEN = {
  1: '759bfcbdf765f1767c1ff186dd097c7df83930327cbddb0499a35d6fd2f2e690',
  2: 'fbb9aca0160926f5f3eefab237e2ba627b44452006007437737b4467294342a2',
  3: 'ed933f69656fe3d003cbae697beca8e8d2ee2ec7833020622649ff0edf3c1033',
  4: 'abffdf86a331e2ddde0f3a05c5e63c057e0003a8ca80699f254adbdfc4e5ab71',
  5: 'f13f76de64e7bff81816a666696615e65d1bfb6aadf0b9d5929011ffc893925a',
  6: '4ba5b6c296fa47fda7756fe7d086d0b964e1b969627fde04ffd9090f50350ff3',
  7: '641220513242f2619dbea33892f9463a1c2aa7bb4dd02433858c6ee1b485f94c',
  8: '967b1c6c8def3d7980429093f4314b3c1473cb3a0851cb7ddb4f85db9f16c27c',
};
const GOLDEN_DRAWN = { 1: 174495, 2: 222304, 3: 211859, 4: 121252, 5: 185153, 6: 177948, 7: 174398, 8: 76753 };

test('(3) 시점 8곳 PPM 8장, 모두 점유율 5 % 이상, 시점별 sha256 골든, 재실행 시 바이트 동일', async (t) => {
  const { dir, ply } = await setup(t);
  const d1 = join(dir, 'o1');
  const d2 = join(dir, 'o2');
  const inputs = { pointsPath: ply, anchor: INPUT_ANCHOR };
  const rec1 = await run({ skylensDir: '.', outDir: d1, commit: 'abcdef1', inputs });
  const rec2 = await run({ skylensDir: '.', outDir: d2, commit: 'abcdef1', inputs });
  assertRecords(rec1);
  assert.deepEqual(rec1, rec2);
  assert.ok(rec1.every((r) => r.method.includes('f_dc') && r.method.includes('56B') && r.method.includes('앱 틀')));
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
  await assert.rejects(run({ skylensDir: '.', outDir: o, commit: 'c', inputs: { anchor: INPUT_ANCHOR } }), /input missing: pointsPath/);
  await assert.rejects(run({ skylensDir: '.', outDir: o, commit: 'c' }), /input missing: pointsPath/);
  await assert.rejects(run({ skylensDir: '/nonexistent', outDir: o, commit: 'c', inputs: {} }), /input missing/);
  assert.ok(!(await readdir(dir)).includes('o'));
});

test('run 음성: 존재하지 않는 점군 파일은 실패', async (t) => {
  const { dir } = await setup(t, encodeSplatPly(syntheticPoints(1)));
  await assert.rejects(run({ skylensDir: '.', outDir: join(dir, 'o'), commit: 'c', inputs: { pointsPath: join(dir, 'nope.ply'), anchor: INPUT_ANCHOR } }), /ENOENT/);
});

// 앵커는 운영자가 선언한 값이다. fixture 의 값과 inputs.anchor 두 선언만 대조하고 점군 파일은 보지 않는다.
test('run 음성: inputs.anchor 없음, fixture 앵커와 한 성분이라도 다르면 실패 (fixture 실제 값 기준)', async (t) => {
  const { dir, ply } = await setup(t, encodeSplatPly(syntheticPoints(1)));
  const o = join(dir, 'o');
  await assert.rejects(run({ skylensDir: '.', outDir: o, commit: 'c', inputs: { pointsPath: ply } }), /input missing: anchor/);
  for (const k of ['lat', 'lon', 'alt']) {
    const bad = { ...INPUT_ANCHOR, [k]: INPUT_ANCHOR[k] + 0.001 };
    await assert.rejects(run({ skylensDir: '.', outDir: o, commit: 'c', inputs: { pointsPath: ply, anchor: bad } }), new RegExp(`anchor\\.${k}=${FIXTURE.anchor[k]} 가 inputs\\.anchor\\.${k}=${bad[k]}.*점군은 보지 않는다`));
  }
  assert.ok(!(await readdir(dir)).includes('o'));
});

test('run: 앵커가 같으면 점군 내용과 상관없이 통과한다 (점군 쪽 앵커 대조는 없다)', async (t) => {
  const { dir, ply } = await setup(t);
  const recs = await run({ skylensDir: '.', outDir: join(dir, 'o'), commit: 'c', inputs: { pointsPath: ply, anchor: { ...FIXTURE.anchor } } });
  assert.equal(recs.length, 16);
});

test('run 음성: viewpoints 에 anchor·sceneFrame 없음, coord 가 ENU 표기, 시점 fov 오류면 실패', async (t) => {
  const { dir, ply } = await setup(t, encodeSplatPly(syntheticPoints(1)));
  const noAnchor = join(dir, 'na.json');
  await writeFile(noAnchor, JSON.stringify({ coord: 'scene (x=east, y=up, z=-north)', sceneFrame: FIXTURE.sceneFrame, viewpoints: FIXTURE.viewpoints }));
  const inputs = { pointsPath: ply, anchor: INPUT_ANCHOR };
  await assert.rejects(run({ skylensDir: '.', outDir: join(dir, 'o'), commit: 'c', inputs, viewpointsPath: noAnchor }), /na\.json.*anchor/);
  const noFrame = join(dir, 'nf.json');
  await writeFile(noFrame, JSON.stringify({ ...FIXTURE, sceneFrame: undefined }));
  await assert.rejects(run({ skylensDir: '.', outDir: join(dir, 'o'), commit: 'c', inputs, viewpointsPath: noFrame }), /nf\.json.*sceneFrame/);
  const badFov = join(dir, 'fov.json');
  await writeFile(badFov, JSON.stringify({ ...FIXTURE, viewpoints: [{ ...FIXTURE.viewpoints[0], fov_y_deg: 180 }] }));
  await assert.rejects(run({ skylensDir: '.', outDir: join(dir, 'o'), commit: 'c', inputs, viewpointsPath: badFov }), /fov\.json.*fov_y_deg/);
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
  await assert.rejects(run({ skylensDir: '.', outDir: join(dir, 'o'), commit: 'c', inputs, viewpointsPath: away }), /시점 9.*0/);
  const vertical = await mk('vert.json', [{ ...v0, id: 10, name: 'down', eye: [0, 300, 0], target: [0, 0, 0], up: [0, 1, 0] }]);
  await assert.rejects(run({ skylensDir: '.', outDir: join(dir, 'o'), commit: 'c', inputs, viewpointsPath: vertical }), /퇴화/);
});

// ---- 실제 skylens 레벨4(step07000) PLY ----
// 파일이 없으면 건너뛴다. 앱 틀 적용 뒤 점유율 5 % 미만인 시점이 있으면 run 이 실패하며, 그것이 정상 판정이다.
const SKYLENS = process.env.SKYLENS_DIR ?? '/tmp/skylens';
const REAL = join(SKYLENS, 'res/static/demo/segments/seg0_step07000.ply');
const hasReal = await access(REAL).then(() => true, () => false);
test('실제 레벨4 PLY: 8장, 재실행 sha256 동일, 점유율 5 % 이상', { skip: !hasReal && '실제 skylens 트리 없음' }, async (t) => {
  const { dir } = await setup(t, encodeSplatPly(syntheticPoints(1)));
  const inputs = { pointsPath: REAL, anchor: INPUT_ANCHOR };
  const a = await run({ skylensDir: SKYLENS, outDir: join(dir, 'a'), commit: 'abcdef1', inputs });
  await run({ skylensDir: SKYLENS, outDir: join(dir, 'b'), commit: 'abcdef1', inputs });
  assertRecords(a);
  assert.ok(a[0].method.includes('f_dc'));
  const files = (await readdir(join(dir, 'a'))).sort();
  assert.equal(files.length, 8);
  for (const f of files) assert.equal(sha(await readFile(join(dir, 'a', f))), sha(await readFile(join(dir, 'b', f))), f);
  for (const r of a.filter((x) => x.metric.startsWith('ref_images.coverage'))) assert.ok(r.value >= MIN_COVERAGE, r.metric);
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
