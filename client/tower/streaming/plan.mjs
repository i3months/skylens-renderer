// 관제탑 조각 요청 계획(T15.7 / 7.2). 순수 함수: 입력 집합을 바꾸지 않고 새 집합을 돌려준다. 네트워크·타이머 없음.

const TILE_M = 64; // 한 변 길이(m). contracts/tower_assets 의 타일 크기와 같다.

/** 타일 키 'tx,ty'. */
export function tileKey(tx, ty) {
  return `${tx},${ty}`;
}

/** 키 → {tx, ty}. */
export function parseKey(key) {
  const i = key.indexOf(',');
  return { tx: Number(key.slice(0, i)), ty: Number(key.slice(i + 1)) };
}

const cmpTile = (a, b) => a.tx - b.tx || a.ty - b.ty;

function checkInt(v, name) {
  if (!Number.isInteger(v)) throw new TypeError(`${name} 는 정수여야 한다`);
}

const KEY_RE = /^(0|-?[1-9]\d*),(0|-?[1-9]\d*)$/; // tileKey 가 만드는 정수 키 형식

function checkSet(v, name) {
  if (!(v instanceof Set)) throw new TypeError(`${name} 는 Set 이어야 한다`);
  for (const k of v) {
    if (typeof k !== 'string' || !KEY_RE.test(k)) throw new TypeError(`${name} 원소는 정수 키 'tx,ty' 문자열이어야 한다: ${String(k)}`);
  }
}

/**
 * 요청·취소·내보내기 계획을 만든다.
 * needed: 정렬된 TileId[]; held·inflight: Set<'tx,ty'>; opts: {maxInflight, retainMargin, maxHeld}; center: [x,y](ENU m).
 * 반환: {plan:{needed,request,cancel,evict,deferred}, held, inflight} (held·inflight 는 갱신된 새 Set).
 */
export function planRequests({ needed, held, inflight, opts, center }) {
  if (!Array.isArray(needed)) throw new TypeError('needed 는 배열이어야 한다');
  checkSet(held, 'held');
  checkSet(inflight, 'inflight');
  if (opts === null || typeof opts !== 'object') throw new TypeError('opts 는 객체여야 한다');
  const { maxInflight, retainMargin, maxHeld } = opts;
  checkInt(maxInflight, 'maxInflight');
  checkInt(retainMargin, 'retainMargin');
  checkInt(maxHeld, 'maxHeld');
  if (maxInflight < 0 || retainMargin < 0 || maxHeld < 0) throw new RangeError('opts 값은 0 이상이어야 한다');
  if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) {
    throw new TypeError('center 는 유한한 [x,y] 여야 한다');
  }

  // needed: 입력 순서 유지, 중복 제거.
  const neededOut = [];
  const neededKeys = new Set();
  for (const t of needed) {
    checkInt(t?.tx, 'tx');
    checkInt(t?.ty, 'ty');
    if (!Number.isSafeInteger(t.tx)) throw new TypeError(`tx 는 안전한 정수여야 한다: ${t.tx}`);
    if (!Number.isSafeInteger(t.ty)) throw new TypeError(`ty 는 안전한 정수여야 한다: ${t.ty}`);
    const k = tileKey(t.tx, t.ty);
    if (neededKeys.has(k)) continue;
    neededKeys.add(k);
    neededOut.push({ tx: t.tx, ty: t.ty });
  }

  // retain: needed 를 retainMargin 타일(체비쇼프)만큼 팽창. 행(ty)별로 tx 구간(±margin)을 병합해 두고 질의 때 확인한다.
  const rows = new Map();
  for (const t of neededOut) {
    const r = rows.get(t.ty);
    if (r) r.push(t.tx);
    else rows.set(t.ty, [t.tx]);
  }
  for (const [ty, xs] of rows) {
    xs.sort((a, b) => a - b);
    const iv = []; // [lo0, hi0, lo1, hi1, ...] 서로 겹치지 않는 오름차순 구간
    for (const x of xs) {
      const lo = x - retainMargin;
      const hi = x + retainMargin;
      const n = iv.length;
      if (n && lo <= iv[n - 1]) iv[n - 1] = Math.max(iv[n - 1], hi);
      else iv.push(lo, hi);
    }
    rows.set(ty, iv);
  }
  const inRetain = (key) => {
    const { tx, ty } = parseKey(key);
    const probe = (iv) => {
      let lo = 0;
      let hi = (iv.length >> 1) - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (tx < iv[2 * mid]) hi = mid - 1;
        else if (tx > iv[2 * mid + 1]) lo = mid + 1;
        else return true;
      }
      return false;
    };
    if (2 * retainMargin + 1 > rows.size) {
      for (const [r, iv] of rows) if (Math.abs(r - ty) <= retainMargin && probe(iv)) return true;
      return false;
    }
    for (let r = ty - retainMargin; r <= ty + retainMargin; r++) {
      const iv = rows.get(r);
      if (iv && probe(iv)) return true;
    }
    return false;
  };

  // 취소: retain 밖 inflight.
  const cancel = [];
  const newInflight = new Set();
  for (const k of inflight) {
    if (inRetain(k)) newInflight.add(k);
    else cancel.push(parseKey(k));
  }
  cancel.sort(cmpTile);

  // 요청 / 보류: 취소 반영 후 남은 자리만큼 needed 순서로.
  let slots = Math.max(0, maxInflight - newInflight.size);
  const request = [];
  const deferred = [];
  for (const t of neededOut) {
    const k = tileKey(t.tx, t.ty);
    if (held.has(k) || newInflight.has(k)) continue;
    if (slots > 0) {
      slots--;
      request.push(t);
      newInflight.add(k);
    } else {
      deferred.push(t);
    }
  }

  // 내보내기: retain 밖 held, 이어서 maxHeld 초과분은 retain 안의 비 needed 를 center 에서 먼 순으로.
  const evict = [];
  const newHeld = new Set();
  for (const k of held) {
    if (inRetain(k)) newHeld.add(k);
    else evict.push(parseKey(k));
  }
  if (newHeld.size > maxHeld) {
    const cands = [];
    for (const k of newHeld) {
      if (neededKeys.has(k)) continue;
      const t = parseKey(k);
      const d = Math.hypot((t.tx + 0.5) * TILE_M - center[0], (t.ty + 0.5) * TILE_M - center[1]);
      cands.push({ ...t, d });
    }
    cands.sort((a, b) => b.d - a.d || cmpTile(a, b)); // 먼 것 먼저, 같으면 (tx,ty) 사전순
    for (const c of cands) {
      if (newHeld.size <= maxHeld) break;
      newHeld.delete(tileKey(c.tx, c.ty));
      evict.push({ tx: c.tx, ty: c.ty });
    }
  }
  evict.sort(cmpTile);

  return { plan: { needed: neededOut, request, cancel, evict, deferred }, held: newHeld, inflight: newInflight };
}
