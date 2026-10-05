// 응집 후보 색인(makeClusterIndex) 검증: 큰 좌표에서 끝나는지(F-372), 촘촘한 같은 높이 건물·긴 띠 건물에서 조회 작업이 n 에 선형인지(F-373).
// 판정은 벽시계가 아니라 작업량 계수(agglomerateStats)로 한다. F-372 만은 끝나지 않는 것이 실패 양상이라 작업자 스레드와 시간 상한으로 잰다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { buildBuildingLod, agglomerateStats, BUILDING_LOD_REF_PIXEL_RAD, BUILDING_LOD_MAX_GAP_PX } from './index.mjs';
import { prism } from './scene.mjs';

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const tris = (out) => out.reduce((t, g) => t + g.mesh.indices.length / 3, 0);
const resetStats = () => { for (const k of Object.keys(agglomerateStats)) agglomerateStats[k] = 0; };

// F-372: 높이 z 인 납작한 10×10 상자 두 개(틈 1 m), 카메라 1500 m. 칸 번호 floor(z/B) 가 2^53 을 넘으면 예전 조회 반복이 끝나지 않았다.
// 동기 함수라 같은 스레드의 시험 timeout 은 멈춘 반복을 끊지 못한다. 작업자 스레드에서 돌리고 상한이 지나면 작업자를 끝내고 실패로 본다.
// 기대값: hideTol = 1500 × (π/3/1080) × 0.25 ≈ 0.364 m < 틈 1 m 라 합쳐지지 않고, 같은 64 m 칸이라 한 그룹에 상자 2개(삼각형 20개)다.
// (0b9ea51, 색인 이전 판도 z = 3e15·3e16·1e17·1e20·3e38 에서 그룹 1개 ids [1, 2] 를 돌려준다.)
const WORKER_SRC = `
import { parentPort, workerData } from 'node:worker_threads';
const { buildBuildingLod } = await import(workerData.url);
const box = (id, x, z) => {
  const p = [x, 0, z, x + 10, 0, z, x + 10, 10, z, x, 10, z, x, 0, z, x + 10, 0, z, x + 10, 10, z, x, 10, z];
  const idx = [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7, 4, 5, 6, 4, 6, 7];
  return { id, mesh: { positions: Float32Array.from(p), indices: Uint32Array.from(idx) } };
};
const out = buildBuildingLod([box(1, 0, workerData.z), box(2, 11, workerData.z)], 1500);
parentPort.postMessage(out.map((g) => ({ ids: g.ids, tris: g.mesh.indices.length / 3 })));
`;
const LIMIT_MS = 1000;
function runInWorker(z) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(`data:text/javascript,${encodeURIComponent(WORKER_SRC)}`), {
      workerData: { url: new URL('./index.mjs', import.meta.url).href, z },
    });
    // 상한은 작업자 시작·모듈 적재까지 포함한 1 s 다(적재는 수십 ms, 끝나지 않는 반복은 상한이 얼마든 걸린다).
    const timer = setTimeout(() => { w.terminate(); reject(new Error(`z=${z}: ${LIMIT_MS} ms 안에 끝나지 않음`)); }, LIMIT_MS);
    w.once('message', (m) => { clearTimeout(timer); w.terminate(); resolve(m); });
    w.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
for (const z of [3e16, 1e17, 1e20, 3e38]) {
  test(`F-372: 높이 ${z} 의 상자 두 개가 1 s 안에 끝나고 결과는 그룹 1개 ids [1, 2] 상자 2개`, { timeout: 5000 }, async () => {
    const out = await runInWorker(z);
    assert.deepEqual(out, [{ ids: [1, 2], tris: 20 }]);
  });
}

// F-372 의 같은 곳을 같은 스레드에서: 큰 xy 좌표(칸 번호가 색인 상한을 넘는 곳)에서도 붙은 두 상자는 합쳐진다(전쌍 비교로 후보를 찾는다).
// 600 m 의 hideTol ≈ 0.145 m, 틈 0.1 m. 좌표는 float32 로 저장되므로 0.1 m 가 표현되는 크기(1e5 m)에서 확인한다.
test('색인: 원점에서 먼 좌표(1e5 m)의 틈 0.1 m 두 상자는 합쳐진다', () => {
  const o = 1e5;
  const bs = [
    { id: 1, mesh: prism(rect(o, o, o + 10, o + 10), 3) },
    { id: 2, mesh: prism(rect(o + 10.125, o, o + 20.125, o + 10), 3) },
  ];
  const out = buildBuildingLod(bs, 600);
  assert.deepEqual(out.map((g) => g.ids), [[1, 2]]);
  assert.equal(tris(out), 10);
});

// 긴 띠 건물은 걸치는 칸 전부에 놓여야 한다: 최소 모서리 칸에서 먼 쪽 끝에 붙은 작은 건물이 후보로 찾아져야 한다.
// 62 m 띠(폭 s)의 오른쪽 끝에 틈 0.1 m 로 s × s 정사각형이 붙고, 멀리 같은 정사각형 60개(6 × 10, 간격 0.9 m)가 칸 크기를 G = s(긴 변 중앙값)로 만든다.
// s = 0.5: 띠는 62 / 0.5 → 125 칸에 걸쳐 격자에 놓인다. s = 0.2: 62 / 0.2 → 311 칸 × 2 줄로 칸 상한(256)을 넘어 따로 목록(big)으로 간다.
// band-before-tip 은 정사각형 60개와 띠를 먼저 넣어(격자 군집이 조회 범위 칸 수보다 많아 칸 조회를 쓴다) 끝 정사각형이 띠를 칸으로 찾아야 한다.
// 기대값: 끝 정사각형은 띠와 합쳐져(틈 0.1 ≤ hideTol 0.145, 같은 높이) 상자 1개, 나머지 60개는 서로 틈 0.4 m 이상이라 따로 상자 60개 → 상자 61개.
for (const [s, order] of [[0.5, 'band-before-tip'], [0.5, 'tip-before-band'], [0.2, 'band-before-tip'], [0.2, 'tip-before-band']]) {
  test(`색인: 62 m 띠의 먼 끝에 붙은 ${s} m 정사각형은 합쳐진다(${order})`, () => {
    const band = { id: 0, mesh: prism(rect(1, 30, 63, 30 + s), 3) };
    const tip = { id: 1, mesh: prism(rect(63.1, 30, 63.1 + s, 30 + s), 3) };
    const far = [];
    for (let i = 0; i < 60; i++) {
      const x = 10 + (i % 6) * 0.9, y = 10 + Math.floor(i / 6) * 0.9;
      far.push({ id: 2 + i, mesh: prism(rect(x, y, x + s, y + s), 3) });
    }
    const bs = order === 'band-before-tip' ? [...far, band, tip] : [tip, ...far, band];
    resetStats();
    const out = buildBuildingLod(bs, 600);
    assert.equal(out.length, 1);
    assert.deepEqual([...out[0].ids].sort((p, q) => p - q), [...Array(62).keys()]);
    assert.equal(tris(out), 610);
    if (s === 0.2) assert.ok(agglomerateStats.big >= 1, '0.2 m 칸에서 62 m 띠는 big 목록으로 간다');
    else assert.equal(agglomerateStats.big, 0);
  });
}

// F-373: 600 m 에서 0.94 m 간격 0.5 m 정사각형(3층, 같은 높이 띠) n 개를 64 열로 깐다(n = 4000 이면 63 줄, 한 64 m 칸 안).
// bands 이면 같은 칸 위·아래 끝에 62 × 0.3 m 띠 건물 2채를 먼저 넣는다(예전 색인은 최대 폭 W 가 62 m 로 커져 이후 조회가 한 축 전체를 훑었다).
// 정사각형 사이 틈 0.44 m, 띠와 첫 줄 사이 틈 0.5 m 이상 > hideTol 0.145 m 라 어느 쌍도 mayMerge 를 통과하지 않는다: 출력은 상자 n(+2) 개.
// 판정 계수(agglomerateStats): visited(넘긴 군집), cells(본 칸, 빈 칸 포함), hits(칸·목록에서 꺼낸 군집, 중복 포함), regs(등록 칸).
// 비율 기준 RATIO_MAX = 2.2: n 2 배일 때 선형 작업은 2.0 배, 이차는 4.0 배. 측정값에 맞춘 값이 아니라 선형 + 10 % 여유다(dedupe_boxes.test.mjs 와 같은 기준).
// 절대 상한: 정사각형 하나의 조회 범위는 한 변 0.5 + 2·hideTol + 칸 반올림 2·G(G = 중앙값 0.5 m) ≤ 1.8 m 라 정사각형 3 × 3 개, 띠 2채까지:
// visited ≤ 11·n. (예전 색인은 bands n=4000 에서 visited 약 73 만 = 약 184·n, 전쌍은 n²/2 = 800 만.)
const RATIO_MAX = 2.2;
const hideTol600 = 600 * BUILDING_LOD_REF_PIXEL_RAD * BUILDING_LOD_MAX_GAP_PX;
function squares(n, bands) {
  const bs = [];
  if (bands) {
    bs.push({ id: 100000, mesh: prism(rect(1, 0.2, 63, 0.5), 3) });
    bs.push({ id: 100001, mesh: prism(rect(1, 63.2, 63, 63.5), 3) });
  }
  for (let i = 0; i < n; i++) {
    const x = 1 + (i % 64) * 0.94, y = 1 + Math.floor(i / 64) * 0.94;
    bs.push({ id: i, mesh: prism(rect(x, y, x + 0.5, y + 0.5), 3) });
  }
  return bs;
}
for (const bands of [false, true]) {
  test(`F-373: 0.94 m 간격 정사각형 n=1000·2000·4000${bands ? ' + 62 m 띠 2채 먼저' : ''}: 조회 계수가 n 에 선형(2 배당 ≤ ${RATIO_MAX})`, () => {
    assert.ok(hideTol600 < 0.44 && hideTol600 > 0.14); // 틈 0.44 m 는 합쳐지지 않는다
    const runs = [1000, 2000, 4000].map((n) => {
      const bs = squares(n, bands);
      resetStats();
      const out = buildBuildingLod(bs, 600);
      const k = bs.length;
      assert.equal(out.length, 1);
      assert.equal(out[0].ids.length, k);
      assert.equal(tris(out), 10 * k); // 하나도 합쳐지지 않는다
      assert.ok(agglomerateStats.visited <= 11 * n, `n=${n}: visited ${agglomerateStats.visited}`);
      return { n, ...agglomerateStats };
    });
    for (const key of ['visited', 'cells', 'hits', 'regs']) {
      for (let i = 1; i < runs.length; i++) {
        const r = runs[i][key] / runs[i - 1][key];
        assert.ok(r <= RATIO_MAX, `${key}: n=${runs[i - 1].n} ${runs[i - 1][key]} → n=${runs[i].n} ${runs[i][key]} (${r.toFixed(2)} 배)`);
      }
    }
  });
}
