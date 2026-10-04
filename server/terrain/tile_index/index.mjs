// T14.8 타일 색인. 관제탑 범위 안의 64 m 타일 격자에 항목(건물 id + bounds)을 색인한다.
// 타일은 절대 격자(tx = floor(x / 64))이고 반개구간 [min, max) 이다. 항목·점·질의 범위는 닫힌 구간으로 다룬다.
import { TERRAIN_TILE_SIZE_M, TowerAssetError } from '../../../contracts/tower_assets/index.mjs';

const S = TERRAIN_TILE_SIZE_M;

function checkBounds(b, what) {
  if (!b || !Number.isFinite(b.minX) || !Number.isFinite(b.minY) || !Number.isFinite(b.maxX) || !Number.isFinite(b.maxY)
    || b.minX > b.maxX || b.minY > b.maxY) {
    throw new TowerAssetError(`buildTileIndex: ${what} bounds 가 올바르지 않다`);
  }
}

// 범위 b 가 덮는 타일 번호 구간. 색인 범위 밖은 잘라 낸다. 겹침이 없으면 null.
function tileRange(b, root) {
  const x0 = Math.max(b.minX, root.minX), x1 = Math.min(b.maxX, root.maxX);
  const y0 = Math.max(b.minY, root.minY), y1 = Math.min(b.maxY, root.maxY);
  if (x0 > x1 || y0 > y1) return null;
  return { tx0: Math.floor(x0 / S), tx1: Math.floor(x1 / S), ty0: Math.floor(y0 / S), ty1: Math.floor(y1 / S) };
}

/**
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} bounds 색인 범위(ENU m)
 * @param {Array<{id:number, bounds:object}>} items
 */
export function buildTileIndex(bounds, items) {
  checkBounds(bounds, '색인');
  const root = { minX: bounds.minX, minY: bounds.minY, maxX: bounds.maxX, maxY: bounds.maxY };
  const cells = new Map(); // `${tx},${ty}` → 항목 배열
  const rec = [];
  if (!Array.isArray(items)) throw new TowerAssetError('buildTileIndex: items 는 배열이어야 한다');
  const seen = new Set();
  for (const it of items) {
    if (!it || typeof it !== 'object') throw new TowerAssetError('buildTileIndex: 항목이 null 이거나 객체가 아니다');
    if (!Number.isInteger(it.id)) throw new TowerAssetError(`buildTileIndex: 항목 id 가 정수가 아니다 (${it.id})`);
    if (seen.has(it.id)) throw new TowerAssetError(`buildTileIndex: id 가 중복됐다 (${it.id})`);
    seen.add(it.id);
    checkBounds(it.bounds, `항목 ${it.id}`);
    const r = { id: it.id, minX: it.bounds.minX, minY: it.bounds.minY, maxX: it.bounds.maxX, maxY: it.bounds.maxY };
    rec.push(r);
    const t = tileRange(r, root);
    if (!t) continue;
    for (let ty = t.ty0; ty <= t.ty1; ty++) {
      for (let tx = t.tx0; tx <= t.tx1; tx++) {
        const k = `${tx},${ty}`;
        const c = cells.get(k);
        if (c) c.push(r); else cells.set(k, [r]);
      }
    }
  }

  return {
    // 점을 덮는 타일의 항목 중 그 점이 bounds 안(경계 포함)인 id, 오름차순. 색인 범위 밖 점은 빈 목록.
    query(x, y) {
      if (!(x >= root.minX && x <= root.maxX && y >= root.minY && y <= root.maxY)) return [];
      const c = cells.get(`${Math.floor(x / S)},${Math.floor(y / S)}`);
      if (!c) return [];
      const out = [];
      for (const r of c) if (x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY) out.push(r.id);
      return out.sort((a, b) => a - b);
    },
    // b 와 겹치는(닫힌 b 가 반개구간 타일과 만나는) 타일, (tx, ty) 오름차순, 색인 범위 밖 제외.
    tilesIn(b) {
      checkBounds(b, '질의');
      const t = tileRange(b, root);
      const out = [];
      if (!t) return out;
      for (let tx = t.tx0; tx <= t.tx1; tx++) for (let ty = t.ty0; ty <= t.ty1; ty++) out.push({ tx, ty });
      return out;
    },
  };
}
