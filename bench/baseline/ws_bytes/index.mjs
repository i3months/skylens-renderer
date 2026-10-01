// 웹소켓 프레임 바이트 기록기.
// 녹화 파일(JSON Lines)을 재생해 집계만 한다. 소켓을 열거나 네트워크를 호출하지 않는다.
// 한 줄 형식: {"t_ms": 상대시각>=0, "dir": "rx"|"tx", "bytes": 정수>=0, "kind": string,
//              "segment": 정수>=0, "level": 0..MAX_LEVEL, "resend": true(선택), "final": 불리언(선택)}
//   segment·level 은 점 프레임에만, 둘이 함께. resend 는 재접속 스냅샷 등으로 같은 (구간,수준)을 다시 보낸 프레임 표시.
//   final 은 splat-chunk 의 final(그 수준이 사다리 최고 수준) 을 그대로 옮긴 값이며 segment 프레임에만 쓸 수 있다.
//   같은 (구간,수준) 의 resend 표시 없는 프레임은 그 구간의 다른 수준 프레임이 끼기 전까지 연속일 때만 분할 프레임으로 합산한다.
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
  if (!(Number.isInteger(f.bytes) && f.bytes >= 0)) throw new Error(`${where}: bytes 가 올바르지 않음`);
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
 * - segment_levels: 구간별 받은 수준 (프로토콜 번호). segment_levels_skipped: 원본으로 받은 최고 수준보다 낮은데
 *   받지 못한 수준 (프로토콜 번호). 재전송 프레임만으로 생긴 최고 수준 때문에 생기는 공백은 건너뜀이 아니다.
 * - stale_levels: 도착 순서상 그 구간에서 이미 받은 최고 수준 이하가 resend 표시 없이 다시 온 프레임 수.
 *   같은 수준이 다른 수준 프레임 없이 연속으로 오면 분할 프레임이라 세지 않는다.
 * - 같은 (구간,수준)의 resend 프레임은 원본이 녹화에 있으면 합에 넣지 않고 resend_bytes 로 센다.
 *   원본이 없으면 첫 재전송 프레임 하나만 유일한 사본으로 합에 넣고 나머지 재전송은 resend_bytes
 *   (재전송은 회차를 구분할 수 없어 분할 프레임으로 합산하지 않는다).
 *   total_bytes·by_kind·windows 에는 항상 포함한다.
 * - 완결 판정: 녹화에 final 필드가 하나라도 있으면 구간에 final 프레임이 있을 때, 없으면 받은 수준이 topLevel 이상일 때.
 *   도착 순서상 끝에서부터 이어지는 미완 구간은 모두 segments 에서 빼고 trailing_segments 로 따로 낸다
 *   (trailing_segment 는 그중 마지막 도착 구간, 없으면 null). 구간 도착 순서는 원본(resend 아닌) 프레임의 마지막 도착 기준이다.
 * - windows: windowMs 시간 창별 바이트 합 (트래픽이 있는 창만, 창 번호 오름차순).
 */
export function summarize(frames, { windowMs = DEFAULT_WINDOW_MS, topLevel = DEFAULT_TOP_LEVEL } = {}) {
  if (!Array.isArray(frames)) throw new Error('frames 는 배열이어야 함');
  if (!(Number.isFinite(windowMs) && windowMs > 0)) throw new Error('windowMs 는 양수여야 함');
  if (!isLevel(topLevel)) throw new Error(`topLevel 은 0..${MAX_LEVEL} 정수여야 함`);
  let totalBytes = 0;
  let initialBytes = null;
  let initialSum = 0;
  let stale = 0;
  let anyFinal = false;
  const byKind = Object.create(null);
  // 구간 ID -> { perLevel: 수준 -> { orig, resend: [재전송 프레임별 바이트] }, hi(받은 최고 수준), last(마지막 원본 수준), order, final }
  const segMap = new Map();
  const winMap = new Map(); // 창 번호 -> 합
  frames.forEach((f, i) => {
    checkFrame(f, `frame ${i}`);
    totalBytes += f.bytes;
    byKind[f.kind] = (byKind[f.kind] ?? 0) + f.bytes;
    if (initialBytes === null) {
      initialSum += f.bytes;
      if (f.kind === FIRST_FRAME_KIND) initialBytes = initialSum;
    }
    const w = Math.floor(f.t_ms / windowMs);
    winMap.set(w, (winMap.get(w) ?? 0) + f.bytes);
    if (f.segment === undefined) return;
    if (f.final !== undefined) anyFinal = true;
    const s = segMap.get(f.segment) ?? { perLevel: new Map(), hi: -1, last: -1, order: -1, lastIdx: -1, final: false };
    segMap.set(f.segment, s);
    const v = s.perLevel.get(f.level) ?? { orig: { n: 0, bytes: 0 }, resend: [] };
    s.perLevel.set(f.level, v);
    if (f.final === true) s.final = true;
    if (f.resend === true) {
      v.resend.push(f.bytes);
      s.hi = Math.max(s.hi, f.level);
    } else {
      if (f.level < s.hi || (f.level === s.hi && s.last !== f.level)) stale += 1;
      s.hi = Math.max(s.hi, f.level);
      s.last = f.level;
      s.order = i;
      v.orig.n += 1;
      v.orig.bytes += f.bytes;
    }
    s.lastIdx = i;
  });
  // 원본이 없는 구간의 도착 순서는 마지막 프레임 위치.
  for (const s of segMap.values()) if (s.order < 0) s.order = s.lastIdx;
  const allIds = [...segMap.keys()].sort(asc);
  // (구간,수준) 별 최종 바이트: 원본이 있으면 원본 합, 없으면 첫 재전송 프레임.
  const effective = (id) => {
    const out = new Map();
    let resend = 0;
    for (const [l, v] of segMap.get(id).perLevel) {
      const useOrig = v.orig.n > 0;
      out.set(l, useOrig ? v.orig.bytes : v.resend[0]);
      resend += sum(v.resend) - (useOrig ? 0 : v.resend[0]);
    }
    return { out, resend };
  };
  const complete = (id) => {
    const s = segMap.get(id);
    if (anyFinal) return s.final;
    return [...s.perLevel.keys()].some((l) => l >= topLevel);
  };
  // 도착 순서 끝에서부터 이어지는 미완 구간.
  const arrival = [...allIds].sort((a, b) => segMap.get(a).order - segMap.get(b).order);
  const trailingIds = new Set();
  for (let k = arrival.length - 1; k >= 0 && !complete(arrival[k]); k--) trailingIds.add(arrival[k]);
  const trailingList = arrival.filter((id) => trailingIds.has(id)).map((id) => {
    const e = effective(id);
    const lv = [...e.out.keys()].sort(asc);
    return { id, bytes: sum([...e.out.values()]), levels: lv.map(toProtocolLevel) };
  });
  const segIds = allIds.filter((id) => !trailingIds.has(id));
  const segments = [];
  const segLevels = [];
  const segSkipped = [];
  let resendBytes = 0;
  for (const id of allIds) {
    const e = effective(id);
    resendBytes += e.resend;
    if (trailingIds.has(id)) continue;
    const got = [...e.out.keys()].sort(asc);
    const origLevels = [...segMap.get(id).perLevel].filter(([, v]) => v.orig.n > 0).map(([l]) => l);
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
    resend_bytes: resendBytes,
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
    throw new Error(`${path}: ${s.trailing_segments.length ? '완결된 segment 가 없음 (미완 구간만 있음)' : 'segment 프레임이 없음'}`);
  }
  const device = 'replay';
  const rec = (metric, value, unit, method, extra = {}) => ({ metric, value, unit, device, method, commit, ...extra });
  const mSeg = 'ws_recording_replay by_segment_id';
  const mWin = `ws_recording_replay window_ms=${DEFAULT_WINDOW_MS}`;
  const mAll = 'ws_recording_replay';
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
    // 구간별 받은 수준 수와 받은 수준 비트마스크 (프로토콜 수준 n 은 비트 n-1).
    rec('ws_bytes.levels_received', mean(received), 'count', mSeg, { samples: received }),
    rec('ws_bytes.segment_levels_mask', mean(masks), 'count', mSeg, { samples: masks }),
    // 이미 받은 최고 수준 이하가 재전송 표시 없이 다시 온 프레임 수 (추월된 수준의 뒤늦은 전송·중복).
    rec('ws_bytes.stale_levels', s.stale_levels, 'count', mSeg),
    // 같은 (구간,수준)을 다시 보낸 재전송 바이트 (segment_total 에는 넣지 않음).
    rec('ws_bytes.resend_bytes', s.resend_bytes, 'B', mSeg),
    // 녹화 끝의 미완 구간 바이트 (없으면 0, segment_total 에서 제외).
    rec('ws_bytes.trailing_segment_bytes', sum(s.trailing_segments.map((t) => t.bytes)), 'B', mSeg),
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
