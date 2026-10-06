// 서버 대조(checkAgainstServer)가 항상 실행되고, 사본 높이·간격이 어긋나면 실패하는지 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAgainstServer, measureDem, parseOnly, lowNoiseDem } from './b1_measure.mjs';
import { lodStrides, buildTileWithStride } from './b1_lod.mjs';
import { terrainLodMaxErrorM } from '../../../contracts/tower_assets/index.mjs';
import { makeHillDem } from '../../../client/tower/terrain/fixtures.mjs';

const caps = (cellM) => [0, 1, 2, 3].map((l) => terrainLodMaxErrorM(l, cellM));

// 64 m 타일 4×4 = 256 m, 셀 1 m 와 2 m. 1024 m DEM 전체는 느려서 작은 DEM 으로 한다.
function smallDem(cellM) {
  const side = 256 / cellM + 1;
  const heights = new Float32Array(side * side);
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) {
    heights[j * side + i] = 20 + 5 * Math.sin(i * cellM / 30) * Math.cos(j * cellM / 40) + 0.3 * (((i * 7 + j * 13) % 11) / 11 - 0.5);
  }
  return { originX: -128, originY: -128, cellM, width: side, height: side, heights };
}

// 가로 ≠ 세로(5×3 타일), originX ≠ originY(-192, 64)인 비대칭 DEM(F-489). 대각선 표본만으로는 못 잡는 오류를 드러낸다.
function rectDem(cellM) {
  const w = 5 * 64 / cellM + 1, h = 3 * 64 / cellM + 1;
  const heights = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    heights[j * w + i] = 20 + 5 * Math.sin(i * cellM / 30) * Math.cos(j * cellM / 40) + 0.3 * (((i * 7 + j * 13) % 11) / 11 - 0.5);
  }
  return { originX: -192, originY: 64, cellM, width: w, height: h, heights };
}

test('비대칭 DEM(가로 ≠ 세로, originX ≠ originY)에서 대조가 통과하고 모서리 5곳을 본다', () => {
  const dem = rectDem(2);
  const { strides } = lodStrides(dem, caps(2));
  const seen = new Set();
  const spy = (d, tx, ty, lod, s) => { seen.add(`${tx},${ty}`); return buildTileWithStride(d, tx, ty, lod, s); };
  const r = checkAgainstServer(dem, strides, { build: spy });
  assert.equal(r.tiles, 4 * 5);
  // 타일 좌표 x −3..1, y 1..3: 네 모서리와 가운데가 모두 들어 있어야 한다.
  for (const k of ['-3,1', '1,3', '1,1', '-3,3', '-1,2']) assert.ok(seen.has(k), `표본에 ${k} 없음: ${[...seen]}`);
});

test('비대칭 DEM: i0·j0 의 tx/ty 를 뒤바꾼 사본은 실패한다', () => {
  const dem = rectDem(2);
  const { strides } = lodStrides(dem, caps(2));
  // 사본이 타일 (tx, ty) 대신 상대 위치를 뒤바꾼 (tx0 + (ty - ty0), ty0 + (tx - tx0)) 를 만든다. 범위 밖이어도 던지므로 실패로 본다.
  const swapped = (d, tx, ty, lod, s) => buildTileWithStride(d, -3 + (ty - 1), 1 + (tx + 3), lod, s);
  assert.throws(() => checkAgainstServer(dem, strides, { build: swapped }));
});

test('비대칭 DEM: 대각선 밖 타일에만 +0.01 을 더한 사본은 실패한다', () => {
  const dem = rectDem(2);
  const { strides } = lodStrides(dem, caps(2));
  const offDiag = (d, tx, ty, lod, s) => {
    const t = buildTileWithStride(d, tx, ty, lod, s);
    if (tx + 3 !== ty - 1) t.heights[0] += 0.01;
    return t;
  };
  assert.throws(() => checkAgainstServer(dem, strides, { build: offDiag }), /사본 타일 불일치/);
});

for (const cellM of [1, 2]) {
  test(`서버 실효 상한 사본이 서버와 일치하고 대조가 실제 돌았다 (cellM ${cellM})`, () => {
    const dem = smallDem(cellM);
    const { strides } = lodStrides(dem, caps(cellM));
    const r = checkAgainstServer(dem, strides);
    assert.equal(r.lods, 4);
    assert.ok(r.tiles >= 4 * 2, `대조한 타일 ${r.tiles}`);
  });

  test(`사본 높이를 바꾸면 실패한다 (cellM ${cellM})`, () => {
    const dem = smallDem(cellM);
    const { strides } = lodStrides(dem, caps(cellM));
    const mutated = (d, tx, ty, lod, s) => { const t = buildTileWithStride(d, tx, ty, lod, s); t.heights[0] += 0.001; return t; };
    assert.throws(() => checkAgainstServer(dem, strides, { build: mutated }), /사본 타일 불일치/);
  });

  test(`사본 간격이 다르면 실패한다 (cellM ${cellM})`, () => {
    const dem = smallDem(cellM);
    const { strides } = lodStrides(dem, caps(cellM));
    const bad = strides.map((s, k) => (k === 3 ? s * 2 : s));
    assert.throws(() => checkAgainstServer(dem, bad), /사본 간격 불일치/);
  });
}

test('옛 절대표 [0,0.5,1,1] 간격은 1 m 셀 서버와 어긋날 수 있어 항상 검출된다(생략 없음)', () => {
  const dem = lowNoiseDem(1, 1);
  const old = lodStrides(dem, [0, 0.5, 1, 1]).strides;
  const now = lodStrides(dem, caps(1)).strides;
  // 두 간격이 같아지면 아래 단언이 공허해지므로 먼저 다름을 못 박는다.
  assert.notEqual(old.join(), now.join());
  assert.throws(() => checkAgainstServer(dem, old), /사본 간격 불일치/);
});

test('hill(2 m 셀, 16 타일) 에서도 대조가 돈다', () => {
  const dem = makeHillDem({ seed: 1, noiseRatio: 0.015 });
  const { strides } = lodStrides(dem, caps(dem.cellM));
  assert.ok(checkAgainstServer(dem, strides).tiles > 0);
});

test('measureDem check 는 대조를 실제로 돌려 횟수를 결과에 싣는다', () => {
  const r = measureDem({ name: 'small', make: () => smallDem(2) }, [], { check: true, optionTable: { v: [0, 0.25, 0.25, 0.25] } });
  assert.equal(r.serverCheck.lods, 4);
  assert.ok(r.serverCheck.tiles > 0, `대조한 타일 ${r.serverCheck.tiles}`);
  assert.equal(r.cellM, 2);
  // check 를 끄면 대조 결과가 없다.
  assert.equal(measureDem({ name: 'small', make: () => smallDem(2) }, [], { check: false, optionTable: { v: [0, 0.25, 0.25, 0.25] } }).serverCheck, null);
});

test('measureDem 은 두 표 간격이 다른 DEM(lowNoise 1 m 셀)에서도 서버 실효 상한 사본으로 대조해 통과한다', () => {
  // 절대표 [0,0.5,1,1] 과 서버 실효 상한의 간격이 다른 입력이다. 사본 간격을 절대표로 구하면 /사본/ 으로 던져야 한다.
  const dem = lowNoiseDem(1, 1);
  assert.notEqual(lodStrides(dem, [0, 0.5, 1, 1]).strides.join(), lodStrides(dem, caps(1)).strides.join());
  const r = measureDem({ name: 'lowNoise:1', make: () => dem }, [], { check: true, optionTable: { i: [0, 0.5, 1, 1] } });
  assert.ok(r.serverCheck.tiles > 0);
});

test('measureDem check 는 틀린 사본 타일을 주입하면 /사본/ 으로 던진다', () => {
  const bad = (d, tx, ty, lod, s) => { const t = buildTileWithStride(d, tx, ty, lod, s); t.heights[0] += 0.001; return t; };
  assert.throws(
    () => measureDem({ name: 'small', make: () => smallDem(2) }, [], { check: true, optionTable: { v: [0, 0.25, 0.25, 0.25] }, checkBuild: bad }),
    /사본/,
  );
});

test('parseOnly: 빈 값·알 수 없는 이름은 던진다', () => {
  assert.equal(parseOnly(null), null);
  assert.deepEqual(parseOnly('smooth,noiseBig:1'), ['smooth', 'noiseBig:1']);
  assert.throws(() => parseOnly(''), /비어/);
  assert.throws(() => parseOnly('smooth,'), /빈 이름/);
  assert.throws(() => parseOnly('smoth'), /알 수 없는/);
});
