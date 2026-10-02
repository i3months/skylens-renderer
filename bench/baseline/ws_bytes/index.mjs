// 웹소켓 프레임 바이트 기록기.
// 녹화 파일(JSON Lines)을 재생해 집계만 한다. 소켓을 열거나 네트워크를 호출하지 않는다.
// 한 줄 형식: {"t_ms": 상대시각>=0, "dir": "rx"|"tx", "bytes": 정수>=0, "kind": string,
//              "segment": 정수>=0, "level": 0..MAX_LEVEL, "resend": true(선택), "final": 불리언(선택)}
//   segment·level 은 점 프레임에만, 둘이 함께. resend 는 재접속 스냅샷 등으로 같은 (구간,수준)을 다시 보낸 프레임 표시.
//   final 은 splat-chunk 의 final(그 수준이 사다리 최고 수준) 을 그대로 옮긴 값이며 segment 프레임에만 쓸 수 있다.
//   같은 (구간,수준) 의 resend 표시 없는 프레임은 그 구간의 다른 수준 프레임이 끼기 전까지 연속일 때만 분할 프레임으로 합산한다.
//   resend 프레임 하나는 재전송 한 회차다. 단 녹화 전체에서 바로 앞 프레임이 같은 (구간,수준) resend 이면 같은 회차로 이어 붙인다
//   (relay 재생은 재생 1회에 구간당 메시지 1개라 다른 구간 프레임이 사이에 끼면 다른 회차).
//   이 때문에 구간 하나뿐인 relay 를 여러 번 재생한 녹화([r40, r40])는 한 회차의 분할 프레임과 녹화만으로 구분할 수 없다.
//   원본 없는 수준에서 이렇게 이어 붙인 회차가 있으면 run 이 method 에 그 모호성을 적는다.
//   resend 프레임은 같은 구간 원본의 분할 연속을 끊는다(뒤에 온 같은 수준 원본과 그 뒤 조각·final 은 stale 사본).
//   원본의 stale 판정은 재전송으로 받은 수준까지 포함한 최고 수준 기준이다(더 높은 수준 resend 뒤의 낮은 수준 원본은 stale).
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertRecords, serialize } from '../../../contracts/metrics/index.mjs';
import { requireInput } from '../../../contracts/inputs/index.mjs';

export const FIRST_FRAME_KIND = 'first_frame';
export const DEFAULT_WINDOW_MS = 1000;
/** 수준 상한(내부 번호). 수준 비트마스크가 정수 연산이므로 30 까지. */
export const MAX_LEVEL = 30;
/** 완결 판정용 기본 최고 수준(내부 번호): skylens 코어 기본 사다리는 3수준이라 2. */
export const DEFAULT_TOP_LEVEL = 2;

/** 수준 번호 변환의 유일한 지점: 녹화·내부는 0부터, skylens 프로토콜은 1부터. */
export const toProtocolLevel = (internal) => internal + 1;

const isLevel = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_LEVEL;

/** 프레임 한 건의 형식을 검사한다. 위반 시 오류를 던진다. */
function checkFrame(f, where) {
  if (f === null || typeof f !== 'object' || Array.isArray(f)) throw new Error(`${where}: 프레임은 객체여야 함`);
  if (!(Number.isFinite(f.t_ms) && f.t_ms >= 0)) throw new Error(`${where}: t_ms 가 올바르지 않음`);
  if (f.dir !== 'rx' && f.dir !== 'tx') throw new Error(`${where}: dir 은 rx 또는 tx 여야 함`);
  if (!(Number.isSafeInteger(f.bytes) && f.bytes >= 0)) throw new Error(`${where}: bytes 가 올바르지 않음`);
  if (typeof f.kind !== 'string' || f.kind === '') throw new Error(`${where}: kind 가 올바르지 않음`);
  const hasSeg = f.segment !== undefined;
  if (hasSeg !== (f.level !== undefined)) throw new Error(`${where}: segment 와 level 은 함께 있어야 함`);
  if (hasSeg) {
    if (f.dir !== 'rx') throw new Error(`${where}: segment 프레임은 dir 이 rx 여야 함`);
    if (!(Number.isInteger(f.segment) && f.segment >= 0)) throw new Error(`${where}: segment 가 올바르지 않음`);
    if (!isLevel(f.level)) throw new Error(`${where}: level 은 0..${MAX_LEVEL} 정수여야 함`);
    if (f.resend !== undefined && typeof f.resend !== 'boolean') throw new Error(`${where}: resend 는 불리언이어야 함`);
    if (f.final !== undefined && typeof f.final !== 'boolean') throw new Error(`${where}: final 은 불리언이어야 함`);
  } else if (f.resend !== undefined || f.final !== undefined) {
    throw new Error(`${where}: resend·final 은 segment 프레임에만 쓸 수 있음`);
  }
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
const asc = (a, b) => a - b;

/**
 * 프레임 배열을 집계하는 순수 함수.
 * - initial_bytes: 첫 'first_frame' 프레임까지(포함)의 바이트 합. 해당 프레임이 없으면 null.
 * - segments: 구간 ID 별로 실제 받은 수준의 바이트 합 (ID 오름차순). 빠진 수준은 오류가 아니라 기록 대상이다.
 * - segment_levels: 구간별 받은 수준 전체 (프로토콜 번호). 같은 구간에서 나중에 온 더 높은 수준으로 교체된 낮은 수준도
 *   포함한다(교체 여부는 보지 않음). 그래서 [L0, L2] 는 [1,3], 추월로 L0 이 stale 인 [L2, L0] 은 [3] 이다.
 *   levels_received·segment_levels_mask 도 같은 뜻이다. segment_levels_skipped: 원본으로 받은 최고 수준보다 낮은데
 *   받지 못한 수준 (프로토콜 번호). 재전송 프레임만으로 생긴 최고 수준 때문에 생기는 공백은 건너뜀이 아니다.
 * - stale_levels: resend 표시 없이 온 원본 프레임 중 도착 시점에 그 구간에서 이미 받은 최고 수준(rhi, 재전송 포함)보다
 *   낮은 수준이거나, 원본으로 받은 최고 수준과 같은데 분할 연속이 끊긴 프레임 수.
 *   그래서 같은 수준 resend 뒤에 온 원본은 stale 이 아니지만 더 높은 수준 resend 뒤에 온 낮은 수준 원본은 stale 이다.
 *   같은 수준이 다른 수준 프레임 없이 연속으로 오면 분할 프레임이라 세지 않는다.
 *   끊긴 연속은 사본 규칙: 같은 최고 수준의 분할 연속이 resend 나 다른 수준 프레임(stale 포함)으로 끊긴 뒤 온
 *   그 수준 원본은 늦게 온 사본이다. 그 프레임과 뒤따르는 같은 수준 조각은 전부 stale 이고(stale 프레임은 연속을
 *   다시 시작하지 않는다), 그 final 도 완결 근거에서 뺀다. stale 원본의 final 은 추월당한 수준이든 끊긴 연속이든
 *   쓰지 않으므로, 완결 판정과 segments 합은 언제나 같은 프레임 집합(stale 아닌 원본)을 근거로 한다.
 *   가정: 원본은 (구간,수준)에 메시지를 한 번만 보낸다(skylens 가 수준을 교체 송신하므로). 분할 전송은 같은 수준 연속
 *   프레임이라 끊긴 뒤의 조각은 그 메시지의 일부가 될 수 없고, 이 가정 아래 끊긴 뒤 같은 수준은 새 메시지가 아니라 사본이다.
 *   이 가정은 skylens 송신 코드를 대조해 확인한 사실이 아니라 검증되지 않은 가정이다.
 *   그 가정의 대가로, 추월된 낮은 수준의 stale 프레임이 끼어 연속이 끊긴 [L2 5, L1 3, L2 5 final] 도 미완이 된다
 *   (뒤의 L2 가 정말 새 메시지였더라도 사본으로 본다). 가정이 틀리면 정상 완결을 미완으로 잘못 분류한다. 완결을 놓치는 쪽을 택한 설계상 선택이다.
 *   새 메시지로 보면 [L2 5, rL2 5, L2 5 final] 이 한 수준을 두 번 더한 10 이 된다. 또 도착하지 않은 것을 메우지 않는다:
 *   원본 연속이 final 없이 끝났으면 사본의 final 로 그 원본이 끝났다고 채우지 않는다.
 *   대가로 완결이 순서에 의존한다: [L2 5, rL2 5, L2 5 final] 은 미완, [L2 5 final, rL2 5, L2 5] 는 완결 [5]
 *   (추월당한 수준의 final 이 [L1 5, L0 3 final] 미완·[L0 3 final, L1 5] 완결인 것과 같은 종류의 의존).
 * - 같은 (구간,수준)의 resend 프레임은 원본이 녹화에 있으면 합에 넣지 않고 resend_bytes 로 센다.
 *   원본이 없으면 추월되지 않은 첫 회차(녹화 전체에서 바로 이어진 같은 (구간,수준) 재전송 프레임들)만 유일한 사본으로
 *   합에 넣고 나머지 회차는 resend_bytes.
 * - 추월된 resend 회차: 도착 시점에 그 구간에서 이미 받은 최고 수준(rhi)보다 낮은 수준의 회차. rhi 는 원본 프레임과
 *   추월되지 않은 resend 회차(원본 없는 수준이면 합에 들어가는 첫 회차)의 수준으로 올라가므로, 높은 수준이 원본이든
 *   재전송이든 추월 판정이 같다. skylens 보드는 수준을 교체하며 추월당한 수준은 건너뛰므로 받은 수준이 아니다.
 *   합·받은 수준에서 빼 resend_bytes 로 세고, 원본 최고 수준보다 낮은 그 수준은 건너뜀에 들어간다.
 * - resend_merged_rounds: 완결 구간의 원본 없는 수준에서 연속 resend 프레임 여러 개를 한 회차로 이어 붙인 회차 수
 *   (모호성 표시용, 프레임 수와 무관하게 회차당 1). 미완 구간은 segments 에 들어가지 않으므로 세지 않는다.
 * - resend_only_segments: 원본 프레임이 하나도 없는 구간 ID (오름차순).
 * - 모든 바이트 합은 total_bytes 의 부분합이므로 total_bytes 가 safe integer 를 넘으면 오류를 던진다.
 *   total_bytes·by_kind·windows 에는 항상 포함한다.
 * - copy_frames: stale 중 사본 규칙(끊긴 같은 최고 수준)으로 판정된 프레임 수. 추월당한 낮은 수준은 세지 않는다.
 *   원본이 (구간,수준)에 메시지를 한 번만 보낸다는 미검증 가정에 따른 판정이며, 사실로 확인된 개수가 아니다.
 * - stale 프레임 바이트는 total·windows·stale_bytes 에만 넣고 구간 합·받은 수준·건너뜀 계산에서는 뺀다.
 * - incomplete_segments: 위치와 무관한 모든 미완 구간(도착 순서). segments 에는 완결 구간만 남는다.
 * - top_level_assumed: 원본 final 필드 없이 topLevel 기본값을 썼는지(run 이 method 에 경고로 남김).
 * - final_resend_only: final 필드가 resend 프레임에만 있는지(run 이 경고 문구를 'final 필드 없음' 과 구분).
 * - top_level_ignored: final 필드가 있어 주어진 topLevel 을 완결 판정에 쓰지 않았는지(run 이 method 에 남김).
 * - 완결 판정: 원본(resend 아닌) 프레임에 final 필드가 하나라도 있으면 구간에 stale 아닌 final:true 원본 프레임이
 *   있을 때(추월당한 수준·끊긴 같은 최고 수준 연속의 final 은 쓰지 않는다, 위 사본 규칙).
 *   final 필드가 resend 프레임에만 있으면 원본 구간은 topLevel 로 판정한다(resend 프레임의 final 은 보지 않는다).
 *   그 밖에는 받은 수준(위 규칙으로 합에 들어간 수준)이 topLevel 이상일 때. resend 전용 구간은 녹화에 final 필드가
 *   하나도 없을 때만 재전송 사본으로 완결될 수 있다(resend_only_segments 로 표시, run 이 method 에 남김).
 *   도착 순서상 끝에서부터 이어지는 미완 구간은 trailing_segments 로도 낸다
 *   (trailing_segment 는 그중 마지막 도착 구간, 없으면 null). 구간 도착 순서는 원본(resend 아닌) 프레임의 마지막 도착 기준이다.
 * - windows: windowMs 시간 창별 바이트 합 (트래픽이 있는 창만, 창 번호 오름차순).
 */
export function summarize(frames, { windowMs = DEFAULT_WINDOW_MS, topLevel: topLevelOpt } = {}) {
  const topLevel = topLevelOpt === undefined ? DEFAULT_TOP_LEVEL : topLevelOpt;
  if (!Array.isArray(frames)) throw new Error('frames 는 배열이어야 함');
  if (!(Number.isFinite(windowMs) && windowMs > 0)) throw new Error('windowMs 는 양수여야 함');
  if (!isLevel(topLevel)) throw new Error(`topLevel 은 0..${MAX_LEVEL} 정수여야 함`);
  let totalBytes = 0;
  let initialBytes = null;
  let initialSum = 0;
  let stale = 0;
  let staleBytes = 0;
  let copyFrames = 0; // 사본 규칙(끊긴 같은 최고 수준)으로 stale 판정된 원본 프레임 수
  let anyFinal = false; // 원본 프레임에 final 필드가 있음
  let anyFinalField = false; // 어떤 segment 프레임에든 final 필드가 있음
  const byKind = Object.create(null);
  // 구간 ID -> { perLevel: 수준 -> { orig, resend: [회차 { bytes: 프레임 바이트 배열, overtaken }] },
  //            hi(원본으로 받은 최고 수준), rhi(원본·추월되지 않은 재전송으로 받은 최고 수준), last(분할 연속 중인 원본 수준, 끊기면 -1), order, final(원본 final) }
  const segMap = new Map();
  const winMap = new Map(); // 창 번호 -> 합
  let prevResendKey = null; // 바로 앞 프레임이 resend 였으면 그 (구간,수준), 아니면 null
  frames.forEach((f, i) => {
    checkFrame(f, `frame ${i}`);
    totalBytes += f.bytes;
    if (!Number.isSafeInteger(totalBytes)) throw new Error(`frame ${i}: 바이트 합이 safe integer 범위를 넘음`);
    byKind[f.kind] = (byKind[f.kind] ?? 0) + f.bytes;
    if (initialBytes === null) {
      initialSum += f.bytes;
      if (f.kind === FIRST_FRAME_KIND) initialBytes = initialSum;
    }
    const w = Math.floor(f.t_ms / windowMs);
    winMap.set(w, (winMap.get(w) ?? 0) + f.bytes);
    const key = f.segment === undefined || f.resend !== true ? null : `${f.segment}:${f.level}`;
    const continuesRound = key !== null && key === prevResendKey;
    prevResendKey = key;
    if (f.segment === undefined) return;
    if (f.final !== undefined) {
      anyFinalField = true;
      if (f.resend !== true) anyFinal = true;
    }
    const s = segMap.get(f.segment) ?? { perLevel: new Map(), hi: -1, rhi: -1, last: -1, order: -1, lastIdx: -1, final: false };
    segMap.set(f.segment, s);
    const v = s.perLevel.get(f.level) ?? { orig: { n: 0, bytes: 0 }, resend: [] };
    s.perLevel.set(f.level, v);
    if (f.resend === true) {
      // 녹화 전체에서 바로 앞 프레임이 같은 (구간,수준) resend 일 때만 같은 회차. 원본 최고 수준(hi)에는 넣지 않는다.
      // 도착 시점에 이미 받은 최고 수준(rhi, 재전송으로만 받은 수준 포함)보다 낮으면 추월된 회차.
      // 같은 회차 안에서는 rhi 가 바뀌지 않는다(회차 첫 프레임에서 이미 반영).
      if (continuesRound) v.resend[v.resend.length - 1].bytes.push(f.bytes);
      else {
        const overtaken = f.level < s.rhi;
        v.resend.push({ bytes: [f.bytes], overtaken });
        // 추월되지 않은 회차는 받은 수준이다(원본이 없으면 첫 회차가 사본, 있어도 이미 받은 수준 이하가 아님).
        if (!overtaken) s.rhi = Math.max(s.rhi, f.level);
      }
      // 재전송은 같은 구간 원본의 분할 연속을 끊는다.
      s.last = -1;
    } else {
      // 추월 기준은 재전송으로 받은 수준까지 포함한 rhi, 같은 수준 분할 연속은 원본 최고 수준(hi)과 last 로 본다.
      const isStale = f.level < s.rhi || (f.level === s.hi && s.last !== f.level);
      // 사본 규칙: final 은 바이트와 같은 프레임 집합으로 본다. stale 프레임(추월당한 수준이든 끊긴 같은 최고 수준이든)의
      // final 은 완결 근거가 아니다.
      if (f.final === true && !isStale) s.final = true;
      const byCopyRule = isStale && f.level >= s.rhi;
      s.hi = Math.max(s.hi, f.level);
      s.rhi = Math.max(s.rhi, f.level);
      // stale 프레임은 분할 연속을 잇지도 새로 시작하지도 않는다. 끊긴 뒤의 같은 수준 조각은 모두 stale 로 남는다.
      s.last = isStale ? -1 : f.level;
      if (isStale) {
        // 뒤늦은 프레임(추월된 수준, 또는 사본 규칙으로 판정된 끊긴 같은 최고 수준): total·windows·stale_bytes 에만 센다.
        stale += 1;
        staleBytes += f.bytes;
        if (byCopyRule) copyFrames += 1;
      } else {
        s.order = i;
        v.orig.n += 1;
        v.orig.bytes += f.bytes;
      }
    }
    s.lastIdx = i;
  });
  // 원본이 없는 구간의 도착 순서는 마지막 프레임 위치.
  for (const s of segMap.values()) if (s.order < 0) s.order = s.lastIdx;
  const allIds = [...segMap.keys()].sort(asc);
  // (구간,수준) 별 최종 바이트: 원본이 있으면 원본 합, 없으면 추월되지 않은 첫 재전송 회차.
  const effMap = new Map();
  for (const [id, s] of segMap) {
    const out = new Map();
    let resend = 0;
    let merged = 0;
    for (const [l, v] of s.perLevel) {
      const all = sum(v.resend.map((r) => sum(r.bytes)));
      if (v.orig.n > 0) {
        out.set(l, v.orig.bytes);
        resend += all;
        continue;
      }
      // stale 프레임만 있거나 추월된 재전송만 있는 수준은 받은 수준이 아님
      const pick = v.resend.find((r) => !r.overtaken);
      if (pick === undefined) {
        resend += all;
        continue;
      }
      if (pick.bytes.length > 1) merged += 1;
      out.set(l, sum(pick.bytes));
      resend += all - sum(pick.bytes);
    }
    effMap.set(id, { out, resend, merged });
  }
  const effective = (id) => effMap.get(id);
  const resendOnly = (id) => [...segMap.get(id).perLevel.values()].every((v) => v.orig.n === 0);
  const complete = (id) => {
    if (resendOnly(id) && anyFinalField) return false;
    if (anyFinal) return segMap.get(id).final;
    return [...effMap.get(id).out.keys()].some((l) => l >= topLevel);
  };
  const resendOnlyIds = allIds.filter(resendOnly);
  // 도착 순서 끝에서부터 이어지는 미완 구간.
  const arrival = [...allIds].sort((a, b) => segMap.get(a).order - segMap.get(b).order);
  const trailingIds = new Set();
  for (let k = arrival.length - 1; k >= 0 && !complete(arrival[k]); k--) trailingIds.add(arrival[k]);
  const describe = (id) => {
    const e = effective(id);
    const lv = [...e.out.keys()].sort(asc);
    return { id, bytes: sum([...e.out.values()]), levels: lv.map(toProtocolLevel) };
  };
  const trailingList = arrival.filter((id) => trailingIds.has(id)).map(describe);
  // 완결 아닌 구간은 위치와 무관하게 segments 에서 뺀다.
  const incompleteList = arrival.filter((id) => !complete(id)).map(describe);
  const segIds = allIds.filter((id) => complete(id));
  const segments = [];
  const segLevels = [];
  const segSkipped = [];
  let resendBytes = 0;
  let mergedRounds = 0;
  for (const id of allIds) {
    const e = effective(id);
    resendBytes += e.resend;
    if (!complete(id)) continue;
    mergedRounds += e.merged;
    const got = [...e.out.keys()].sort(asc);
    const origLevels = [...segMap.get(id).perLevel].filter(([, v]) => v.orig.n > 0).map(([l]) => l);
    // 건너뜀 기준 top 은 rhi 가 아니라 원본 최고 수준이다. 재접속 스냅샷은 현재 수준만 다시 보내므로 재전송으로만 받은
    // 최고 수준 아래의 공백은 보내졌다가 건너뛴 것인지 녹화로 알 수 없다(도착하지 않은 것을 건너뜀으로 채우지 않는다).
    // 그래서 추월 판정과 달리 [rL2, rL0] 의 건너뜀은 []이고 [L2, rL0] 은 [1,2] 다.
    const top = origLevels.length ? Math.max(...origLevels) : -1;
    const skipped = [];
    for (let l = 0; l < top; l++) if (!e.out.has(l)) skipped.push(toProtocolLevel(l));
    segments.push(sum([...e.out.values()]));
    segLevels.push(got.map(toProtocolLevel));
    segSkipped.push(skipped);
  }
  const winIds = [...winMap.keys()].sort(asc);
  return {
    frame_count: frames.length,
    total_bytes: totalBytes,
    initial_bytes: initialBytes,
    by_kind: byKind,
    segment_ids: segIds,
    segments,
    segment_levels: segLevels,
    segment_levels_skipped: segSkipped,
    stale_levels: stale,
    stale_bytes: staleBytes,
    copy_frames: copyFrames,
    top_level_assumed: !anyFinal && topLevelOpt === undefined,
    final_resend_only: !anyFinal && anyFinalField,
    top_level_ignored: anyFinal && topLevelOpt !== undefined,
    incomplete_segments: incompleteList,
    resend_bytes: resendBytes,
    resend_merged_rounds: mergedRounds,
    resend_only_segments: resendOnlyIds,
    trailing_segment: trailingList.length ? trailingList[trailingList.length - 1] : null,
    trailing_segments: trailingList,
    windows: winIds.map((id) => winMap.get(id)),
  };
}

/** 녹화 파일을 읽어 프레임 배열로 돌려준다. 손상·위반 줄은 (빈 줄 포함한 원래) 줄 번호와 함께 오류로 처리한다. */
export function replay(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const frames = [];
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    let f;
    try {
      f = JSON.parse(line);
    } catch {
      throw new Error(`${path}:${i + 1}: 손상된 줄 (JSON 해석 실패)`);
    }
    checkFrame(f, `${path}:${i + 1}`);
    frames.push(f);
  });
  return frames;
}

/**
 * 벤치 모듈 계약: 녹화를 재생해 측정 레코드 목록을 돌려준다.
 * inputs.wsRecording 이 필수이며 없으면 throw 한다(합성 대체 금지).
 * outDir 이 있으면 ws_bytes.json 을 쓴다.
 */
export async function run({ skylensDir, outDir, commit, inputs }) {
  const path = requireInput(inputs, 'wsRecording');
  const topLevel = inputs.wsTopLevel;
  if (topLevel !== undefined && !isLevel(topLevel)) throw new Error(`inputs.wsTopLevel 은 0..${MAX_LEVEL} 정수여야 함`);
  let s;
  try {
    s = summarize(replay(path), topLevel === undefined ? {} : { topLevel });
  } catch (e) {
    throw new Error(e.message.includes(path) ? e.message : `${path}: ${e.message}`);
  }
  if (s.initial_bytes === null) throw new Error(`${path}: '${FIRST_FRAME_KIND}' 프레임이 없음`);
  if (s.segments.length === 0) {
    throw new Error(`${path}: ${s.incomplete_segments.length ? '완결된 segment 가 없음 (미완 구간만 있음)' : 'segment 프레임이 없음'}`);
  }
  const device = 'replay';
  const rec = (metric, value, unit, method, extra = {}) => ({ metric, value, unit, device, method, commit, ...extra });
  // final 필드가 없는 녹화에서 기본 topLevel 을 쓰면 완결 판정이 가정임을 method 에 남긴다.
  // final 필드가 resend 프레임에만 있으면 '없음' 이 아니므로 그 사실을 구분해 적는다.
  // final 필드가 있으면 inputs.wsTopLevel 은 완결 판정에 쓰이지 않으므로 그 사실도 남긴다.
  const warn = s.top_level_assumed
    ? ` 경고: ${s.final_resend_only ? 'final 필드가 resend 에만 있음' : 'final 필드 없음'}, topLevel 가정(기본 ${DEFAULT_TOP_LEVEL}, inputs.wsTopLevel 로 지정)`
    : s.top_level_ignored
      ? ` 참고: final 필드로 완결 판정, inputs.wsTopLevel=${topLevel} 무시`
      : '';
  // 원본 없는 수준에서 연속 resend 를 한 회차로 이어 붙였으면, 단일 구간 relay 의 반복 재생과 구분할 수 없다는 사실을 남긴다.
  const ambiguous = s.resend_merged_rounds
    ? ` 참고: 원본 없는 연속 resend ${s.resend_merged_rounds}회차를 한 회차의 분할로 합산 (구간 하나뿐인 relay 반복 재생과 녹화만으로 구분 불가)`
    : '';
  // 원본이 없는 구간이 재전송 사본만으로 완결 처리되었으면 남긴다(final 필드 없는 녹화에서만 가능).
  const doneIds = new Set(s.segment_ids);
  const onlyDone = s.resend_only_segments.filter((id) => doneIds.has(id)).length;
  const resendOnly = onlyDone ? ` 참고: 원본 없는 resend 전용 구간 ${onlyDone}개를 재전송 사본으로 집계` : '';
  // 끊긴 같은 수준 원본을 사본으로 판정해 stale 처리했으면 그 사실과 프레임 수를 남긴다(없으면 변화 없음).
  const copies = s.copy_frames ? ` 참고: 끊긴 같은 수준 사본 판정 ${s.copy_frames}프레임을 stale 로 처리 (사본 규칙, 완결 근거에서 제외; 원본이 (구간,수준)에 메시지를 한 번만 보낸다는 미검증 가정에 따른 판정)` : '';
  const mSeg = `ws_recording_replay by_segment_id${warn}${ambiguous}${resendOnly}${copies}`;
  const mWin = `ws_recording_replay window_ms=${DEFAULT_WINDOW_MS}${warn}`;
  const mAll = `ws_recording_replay${warn}`;
  // 받은 수준 지표는 교체된 낮은 수준까지 포함한 전체 수신 수준임을 method 에 밝힌다.
  const mLv = `${mSeg} 받은 수준=교체된 낮은 수준 포함 전체`;
  const mean = (a) => sum(a) / a.length;
  const skipped = s.segment_levels_skipped.map((a) => a.length);
  const received = s.segment_levels.map((a) => a.length);
  const masks = s.segment_levels.map((a) => a.reduce((m, n) => m | (1 << (n - 1)), 0));
  const out = [
    rec('ws_bytes.total', s.total_bytes, 'B', mAll),
    rec('ws_bytes.frames', s.frame_count, 'count', mAll),
    rec('ws_bytes.initial', s.initial_bytes, 'B', mAll),
    // 구간 ID 별 실제 받은 수준의 합: value 는 평균, samples 는 구간별 합.
    rec('ws_bytes.segment_total', mean(s.segments), 'B', mSeg, { samples: s.segments }),
    // 구간별(ID 오름차순, segment_total 과 같은 순서) 건너뛴 수준 수. value 는 전체 합.
    rec('ws_bytes.levels_skipped', sum(skipped), 'count', mSeg, { samples: skipped }),
    // 구간별 받은 수준 수와 받은 수준 비트마스크 (프로토콜 수준 n 은 비트 n-1). 교체된 낮은 수준도 포함한다.
    rec('ws_bytes.levels_received', mean(received), 'count', mLv, { samples: received }),
    rec('ws_bytes.segment_levels_mask', mean(masks), 'count', mLv, { samples: masks }),
    // 이미 받은 최고 수준 이하가 재전송 표시 없이 다시 온 프레임 수 (추월된 수준의 뒤늦은 전송·중복).
    rec('ws_bytes.stale_levels', s.stale_levels, 'count', mSeg),
    // 추월된 수준의 뒤늦은 프레임 바이트 (segment_total 에는 넣지 않음).
    rec('ws_bytes.stale_bytes', s.stale_bytes, 'B', mSeg),
    // 같은 (구간,수준)을 다시 보낸 재전송 바이트 (segment_total 에는 넣지 않음).
    rec('ws_bytes.resend_bytes', s.resend_bytes, 'B', mSeg),
    // 녹화 끝의 미완 구간 바이트 (없으면 0, segment_total 에서 제외).
    rec('ws_bytes.trailing_segment_bytes', sum(s.trailing_segments.map((t) => t.bytes)), 'B', mSeg),
    // 위치와 무관한 모든 미완 구간 바이트 (segment_total 에서 제외).
    rec('ws_bytes.incomplete_segment_bytes', sum(s.incomplete_segments.map((t) => t.bytes)), 'B', mSeg),
    // 시간 창 지표: 트래픽이 있는 창만.
    rec('ws_bytes.window_1000ms', mean(s.windows), 'B', mWin, { samples: s.windows }),
  ];
  const seen = new Map();
  for (const k of Object.keys(s.by_kind).sort()) {
    const norm = k.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (seen.has(norm)) throw new Error(`${path}: kind '${seen.get(norm)}' 와 '${k}' 가 지표 이름 ws_bytes.kind.${norm} 으로 충돌함`);
    seen.set(norm, k);
    out.push(rec(`ws_bytes.kind.${norm}`, s.by_kind[k], 'B', mAll));
  }
  assertRecords(out);
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'ws_bytes.json'), serialize(out));
  }
  return out;
}
