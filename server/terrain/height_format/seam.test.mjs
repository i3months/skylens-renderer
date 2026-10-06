// F-492: 같은 DEM·같은 LOD 이웃 타일을 서버 인코더 → 클라 디코더로 왕복한 뒤 공유 열·행 높이가 비트 단위로 같아야 한다(균열 없음).
// 한쪽만 f32 폴백하는 조합(가운데 표본에 큰 봉우리를 넣어 높이 범위를 키운 타일)과 큰 |h|(8000 m 올림)도 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTerrainTileH32 } from './index.mjs';
import { decodeTerrainTileH32 } from '../../../client/tower/terrain/decode.mjs';
import { buildTerrainTile } from '../mesh_lod/index.mjs';
import { smoothDem, noiseBigDem } from '../../../bench/tower/lod_bytes.mjs';
import { makeHillDem } from '../../../client/tower/terrain/fixtures.mjs';

const roundTrip = (dem, tx, ty, lod) => {
  const bytes = encodeTerrainTileH32(buildTerrainTile(dem, tx, ty, lod));
  const kbase = bytes[3] & 1 ? new DataView(bytes.buffer, bytes.byteOffset).getInt32(16, true) : null;
  return { flags: bytes[3], kbase, tile: decodeTerrainTileH32(bytes) };
};
const bits = (x) => new Uint32Array(new Float32Array([x]).buffer)[0];

/** 이웃 쌍(가로: (tx,ty)-(tx+1,ty), 세로: (tx,ty)-(tx,ty+1))의 공유 가장자리 비트 불일치 수와 플래그 조합을 센다. */
function seamCheck(dem, txs, tys, lods) {
  let pairs = 0, bad = 0;
  const flagCombos = new Set();
  const kbases = new Set(); // 양자화 타일의 kbase 종류(타일별 base 변이를 잡으려면 둘 이상이어야 한다)
  for (const lod of lods) {
    const cache = new Map();
    const get = (tx, ty) => {
      const k = `${tx},${ty}`;
      if (!cache.has(k)) cache.set(k, roundTrip(dem, tx, ty, lod));
      return cache.get(k);
    };
    for (const ty of tys) for (const tx of txs) {
      const a = get(tx, ty);
      if (a.kbase !== null) kbases.add(`${lod}:${a.kbase}`);
      const n = a.tile.cells;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        if (!txs.includes(tx + dx) || !tys.includes(ty + dy)) continue;
        const b = get(tx + dx, ty + dy);
        assert.equal(b.tile.cells, n);
        pairs++;
        flagCombos.add(`${a.flags}${b.flags}`);
        for (let t = 0; t < n; t++) {
          // 가로 이웃: a 의 오른쪽 열(i = n−1) = b 의 왼쪽 열(i = 0). 세로 이웃: a 의 위 행(j = n−1) = b 의 아래 행(j = 0).
          const ka = dx ? t * n + (n - 1) : (n - 1) * n + t;
          const kb = dx ? t * n : t;
          if (bits(a.tile.heights[ka]) !== bits(b.tile.heights[kb])) { bad++; break; }
        }
      }
    }
  }
  return { pairs, bad, flagCombos, kbases };
}

const R6 = [-3, -2, -1, 0, 1, 2];
const LODS = [1, 2, 3];

/** 타일 (0,0) 가운데 표본(모든 LOD 가 뽑는 점)에 봉우리를 넣어 그 타일만 범위 초과 폴백하게 한 DEM 사본. */
function withSpike(dem, spikeM) {
  const heights = new Float32Array(dem.heights);
  const i = Math.round((32 - dem.originX) / dem.cellM), j = Math.round((32 - dem.originY) / dem.cellM);
  heights[j * dem.width + i] += spikeM;
  return { ...dem, heights };
}
/** 기울기(동서 0.013·남북 0.007 m/m)를 더해 타일마다 최솟값(kbase)이 달라지게 한 DEM 사본. */
function tilted(dem) {
  const heights = new Float32Array(dem.heights);
  for (let j = 0; j < dem.height; j++) for (let i = 0; i < dem.width; i++) heights[j * dem.width + i] += 0.013 * i + 0.007 * j;
  return { ...dem, heights };
}
function offset(dem, dz) {
  return { ...dem, heights: dem.heights.map((v) => v + dz) };
}

test('smoothDem LOD1~3 가로·세로 이웃 공유 가장자리 비트 동일', () => {
  const r = seamCheck(smoothDem(), R6, R6, LODS);
  assert.equal(r.pairs, 3 * 2 * 30);
  assert.equal(r.bad, 0);
});

test('noiseBig 시드 0~3 LOD1~3 이웃 공유 가장자리 비트 동일', () => {
  for (const seed of [0, 1, 2, 3]) {
    const r = seamCheck(noiseBigDem(seed), R6, R6, LODS);
    assert.equal(r.bad, 0, `시드 ${seed}`);
  }
  // 원본 noiseBig 은 모든 타일 최솟값이 −1 이라 타일별 base 변이를 못 잡는다 → 기울기를 더해 kbase 가 타일마다 다르게 한다(F-499 ②)
  for (const seed of [0, 1]) {
    const r = seamCheck(tilted(noiseBigDem(seed)), R6, R6, LODS);
    assert.equal(r.bad, 0, `기울기 시드 ${seed}`);
    assert.ok(r.kbases.size > LODS.length, `LOD 안에서도 kbase 가 갈린다 ${r.kbases.size}`);
  }
});

test('hill(시드 1·7, 2 m 셀) LOD1~3 이웃 공유 가장자리 비트 동일', () => {
  for (const seed of [1, 7]) {
    const dem = makeHillDem({ seed });
    const r = seamCheck(dem, [-2, -1, 0, 1], [-2, -1, 0, 1], LODS);
    assert.equal(r.pairs, 3 * 2 * 12);
    assert.equal(r.bad, 0, `hill 시드 ${seed}`);
  }
});

test('한쪽만 f32 폴백한 이웃(봉우리 5000 m 타일 (0,0))도 공유 가장자리 비트 동일', () => {
  const dem = withSpike(smoothDem(), 5000);
  const r = seamCheck(dem, [-1, 0, 1], [-1, 0, 1], LODS);
  assert.ok(r.flagCombos.has('01') && r.flagCombos.has('10'), `조합 ${[...r.flagCombos]}`);
  assert.equal(r.bad, 0);
  for (const lod of LODS) assert.equal(roundTrip(dem, 0, 0, lod).flags, 0, `lod ${lod} 폴백`);
});

test('F-499 ①: 전체 −0.01 + 봉우리 5000 m, LOD1 — 한쪽 폴백 이웃 공유 열이 −0/+0 까지 비트 동일', () => {
  const base = smoothDem();
  const flat = { ...base, heights: new Float32Array(base.heights.length).fill(-0.01) };
  const dem = withSpike(flat, 5000);
  const r = seamCheck(dem, [-1, 0, 1], [-1, 0, 1], [1]);
  assert.ok(r.flagCombos.has('01') || r.flagCombos.has('10'), `조합 ${[...r.flagCombos]}`);
  assert.equal(roundTrip(dem, 0, 0, 1).flags, 0, '타일 (0,0) 폴백');
  assert.equal(r.bad, 0);
});

test('큰 |h|(8000 m 올림) 와 폴백 혼합에서도 공유 가장자리 비트 동일', () => {
  const dem = withSpike(offset(smoothDem(), 8000), 4000);
  const r = seamCheck(dem, [-2, -1, 0, 1], [-2, -1, 0, 1], LODS);
  assert.ok(r.flagCombos.has('01') || r.flagCombos.has('10'));
  assert.equal(r.bad, 0);
  const n0 = offset(noiseBigDem(2), -8000.3);
  assert.equal(seamCheck(n0, [-1, 0, 1], [-1, 0, 1], LODS).bad, 0);
});
