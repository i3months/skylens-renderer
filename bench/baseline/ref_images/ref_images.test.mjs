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
} from './index.mjs';
import { syntheticPoints, encodeSplatPly } from './testing.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(await readFile(join(here, '../../../fixtures/viewpoints/viewpoints.json'), 'utf8'));
const ANCHOR = { lat: 37.5, lon: 127.0, alt: 40 }; // 테스트용 임의 앵커 (실제 값은 fixtures 가 정한다)
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

// ---- run ----
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ref-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ply = join(dir, 'syn.ply');
  await writeFile(ply, encodeSplatPly(syntheticPoints(1)));
  const vp = join(dir, 'viewpoints.json');
  await writeFile(vp, JSON.stringify({ ...FIXTURE, coord: 'scene (x=east, y=up, z=-north), local ENU 에서 변환, 1 unit = 1 m', anchor: ANCHOR }));
  return { dir, ply, vp };
}

// 합성 점군(seed=1)·fixtures 시점 8곳의 PPM 전체 sha256 과 찍힌 픽셀 수. 구현 확정 때 한 번 박은 숫자이며 입력에서 도출하지 않는다.
const GOLDEN = {
  1: '5926932348b191f7bf3f8f690630820774e747258a4df8714f5fcc882a925978',
  2: 'e93a8e82eff8e1dc545502c011287cde7de64b48a18ae92fd48655d5bd5ffdd3',
  3: '518fd52b9bc13219131f96a66526f5c0fceed1f6c02f8a6314c3e3bcba78d260',
  4: 'ba558db195de020d11548e77de97ec535620fea9b258e1629fbd6f5f6b87b87c',
  5: '8171cd06ebd722bc311ac33cceaff03679840007620c2fa3a279474b168e9d82',
  6: '8aeee077291fd4ac808e73edc8c5df50624853f20ca5bac391ff0eaa906009ed',
  7: '09dc96d00829503ba1a95c025235fe9c503a4a8fc6b8f2fafdfe3b1fead9ab59',
  8: '22a00db3ff4bf183ec9856ad4127c97db10d2102f855484b93bfe26a13cc1631',
};
const GOLDEN_DRAWN = { 1: 43631, 2: 15067, 3: 17847, 4: 55348, 5: 43138, 6: 21805, 7: 47389, 8: 48650 };

test('(3) 시점 8곳 PPM 8장, 모두 drawn>0, 시점별 sha256 골든, 재실행 시 바이트 동일', async (t) => {
  const { dir, ply, vp } = await setup(t);
  const d1 = join(dir, 'o1');
  const d2 = join(dir, 'o2');
  const inputs = { pointsPath: ply, anchor: ANCHOR };
  const rec1 = await run({ skylensDir: '.', outDir: d1, commit: 'abcdef1', inputs, viewpointsPath: vp });
  const rec2 = await run({ skylensDir: '.', outDir: d2, commit: 'abcdef1', inputs, viewpointsPath: vp });
  assertRecords(rec1);
  assert.deepEqual(rec1, rec2);
  assert.ok(rec1.every((r) => r.method.includes('f_dc') && r.method.includes('56B')));
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
    assert.ok(drawn > 0, `v${id} drawn`);
    assert.equal(drawn, GOLDEN_DRAWN[id], `v${id} drawn 값`);
  }
});

test('run 음성: pointsPath 없음 → throw (합성 대체 없음)', async (t) => {
  const { dir, vp } = await setup(t);
  const o = join(dir, 'o');
  await assert.rejects(run({ skylensDir: '.', outDir: o, commit: 'c', inputs: { anchor: ANCHOR }, viewpointsPath: vp }), /input missing: pointsPath/);
  await assert.rejects(run({ skylensDir: '.', outDir: o, commit: 'c', viewpointsPath: vp }), /input missing: pointsPath/);
  await assert.rejects(run({ skylensDir: '/nonexistent', outDir: o, commit: 'c', inputs: {} }), /input missing/);
  assert.ok(!(await readdir(dir)).includes('o'));
});

test('run 음성: 존재하지 않는 점군 파일은 실패', async (t) => {
  const { dir, vp } = await setup(t);
  await assert.rejects(run({ skylensDir: '.', outDir: join(dir, 'o'), commit: 'c', inputs: { pointsPath: join(dir, 'nope.ply'), anchor: ANCHOR }, viewpointsPath: vp }), /ENOENT/);
});

test('run 음성: inputs.anchor 없음·불일치 → 실패', async (t) => {
  const { dir, ply, vp } = await setup(t);
  const o = join(dir, 'o');
  await assert.rejects(run({ skylensDir: '.', outDir: o, commit: 'c', inputs: { pointsPath: ply }, viewpointsPath: vp }), /input missing: anchor/);
  for (const k of ['lat', 'lon', 'alt']) {
    const bad = { ...ANCHOR, [k]: ANCHOR[k] + 0.001 };
    await assert.rejects(run({ skylensDir: '.', outDir: o, commit: 'c', inputs: { pointsPath: ply, anchor: bad }, viewpointsPath: vp }), new RegExp(`anchor\\.${k}`));
  }
});

test('run 음성: viewpoints 에 anchor 없음, coord 가 ENU 표기면 실패', async (t) => {
  const { dir, ply } = await setup(t);
  const noAnchor = join(dir, 'na.json');
  await writeFile(noAnchor, JSON.stringify({ coord: 'scene (x=east, y=up, z=-north)', viewpoints: FIXTURE.viewpoints }));
  const inputs = { pointsPath: ply, anchor: ANCHOR };
  await assert.rejects(run({ skylensDir: '.', outDir: join(dir, 'o'), commit: 'c', inputs, viewpointsPath: noAnchor }), /na\.json.*anchor/);
  assert.throws(() => loadViewpoints({ coord: 'ENU, x=east y=up z=-north', anchor: ANCHOR, viewpoints: FIXTURE.viewpoints }, ANCHOR, 'enu.json'), /enu\.json.*coord/);
  assert.throws(() => loadViewpoints({ coord: 'scene', anchor: { lat: 1, lon: 'x', alt: 3 }, viewpoints: FIXTURE.viewpoints }, ANCHOR), /anchor/);
});

test('run 음성: 아무것도 안 찍히는 시점, 퇴화 시점이 있으면 실패', async (t) => {
  const { dir, ply } = await setup(t);
  const mk = async (name, vps) => {
    const p = join(dir, name);
    await writeFile(p, JSON.stringify({ coord: 'scene (x=east, y=up, z=-north)', anchor: ANCHOR, viewpoints: vps }));
    return p;
  };
  const inputs = { pointsPath: ply, anchor: ANCHOR };
  const v0 = FIXTURE.viewpoints[0];
  const away = await mk('away.json', [{ ...v0, id: 9, name: 'away', eye: [0, 120, 500], target: [0, 120, 600] }]);
  await assert.rejects(run({ skylensDir: '.', outDir: join(dir, 'o'), commit: 'c', inputs, viewpointsPath: away }), /시점 9.*0/);
  const vertical = await mk('vert.json', [{ ...v0, id: 10, name: 'down', eye: [0, 300, 0], target: [0, 0, 0], up: [0, 1, 0] }]);
  await assert.rejects(run({ skylensDir: '.', outDir: join(dir, 'o'), commit: 'c', inputs, viewpointsPath: vertical }), /퇴화/);
});

// ---- 실제 skylens 레벨4(step07000) PLY ----
// seg0_step07000.ply (sha256 c3a818cf...30ac) 로 만든 값. 파일이 다르면(skylens 갱신) 골든 비교만 건너뛰고 나머지는 검사한다.
const REAL_SHA = 'c3a818cfc04e6123f3eb566caf0bd0a7d8f43fb2fdf099ed78fe2d6a917a30ac';
const REAL_GOLDEN = {
  1: '9f7bbe652a435c71818bc823645007e88c8453206f3809b8a8181f6bc8a5fde2',
  2: '7c41db06ba7c99d59c78cd4e9b7d23ccfbfe69c18b50f10cdeb80bfe61925435',
  3: '22e1aa35cde2113043181f4cffad0443a4badc56842850f6e44e0e45096dbf7f',
  4: '9520c8a07089b6ee7cf386f6a604c0e31b4e6f30e38cc14562215c9608dd6d8b',
  5: '9322602ade873bafebd8d73bff0cbe3176fba54dab4a47f9d4e5736711d72a60',
  6: 'c1dc1b67c81fa1aa03e777f1cc5f56ba2b42d02d7210d8a1f46cd564a321e713',
  7: 'b1a1778c64ddc9d6269c1f6f984a049b5134dab019e6df8db273867e33978147',
  8: '2e8274d0a74b2d82168586440f33640a48f8dda4a701f9cc9c79e99226e5db1d',
};
const REAL_DRAWN = { 1: 3381, 2: 346, 3: 1277, 4: 1254, 5: 2964, 6: 7720, 7: 3386, 8: 629 };
const SKYLENS = process.env.SKYLENS_DIR ?? '/tmp/skylens';
const REAL = join(SKYLENS, 'res/static/demo/segments/seg0_step07000.ply');
const hasReal = await access(REAL).then(() => true, () => false);
test('실제 레벨4 PLY: 8장, 모두 비어 있지 않고 재실행 sha256 동일', { skip: !hasReal && '실제 skylens 트리 없음' }, async (t) => {
  const { dir, vp } = await setup(t);
  const inputs = { pointsPath: REAL, anchor: ANCHOR };
  const a = await run({ skylensDir: SKYLENS, outDir: join(dir, 'a'), commit: 'abcdef1', inputs, viewpointsPath: vp });
  await run({ skylensDir: SKYLENS, outDir: join(dir, 'b'), commit: 'abcdef1', inputs, viewpointsPath: vp });
  assertRecords(a);
  assert.ok(a[0].method.includes('f_dc'));
  const files = (await readdir(join(dir, 'a'))).sort();
  assert.equal(files.length, 8);
  const same = sha(await readFile(REAL)) === REAL_SHA;
  for (const f of files) {
    const id = Number(f.match(/^viewpoint_(\d+)_/)[1]);
    const h = sha(await readFile(join(dir, 'a', f)));
    assert.equal(h, sha(await readFile(join(dir, 'b', f))), f);
    if (same) assert.equal(h, REAL_GOLDEN[id], `real v${id} sha256`);
  }
  for (const r of a.filter((x) => x.metric.startsWith('ref_images.drawn_pixels'))) {
    assert.ok(r.value > 0, r.metric);
    if (same) assert.equal(r.value, REAL_DRAWN[Number(r.metric.split('.v')[1])], r.metric);
  }
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
