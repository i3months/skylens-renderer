// 웹소켓 프레임 바이트 기록기 (T01.4).
// 녹화 파일(JSON Lines)을 재생해 집계만 한다. 소켓을 열거나 네트워크를 호출하지 않는다.
// 한 줄 형식: {"t_ms": 상대시각>=0, "dir": "rx"|"tx", "bytes": 정수>=0, "kind": string,
//              "segment": 정수>=0, "level": 0..3, "resend": true(선택)}
//   segment·level 은 점 프레임에만, 둘이 함께. resend 는 재접속 스냅샷 등으로 같은 (구간,수준)을 다시 보낸 프레임 표시.
//   resend 표시가 없는 같은 (구간,수준) 프레임은 분할 프레임으로 보고 합산한다.
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertRecords, serialize } from '../../../contracts/metrics/index.mjs';
import { requireInput } from '../../../contracts/inputs/index.mjs';

export const FIRST_FRAME_KIND = 'first_frame';
export const DEFAULT_WINDOW_MS = 1000;
export const LEVELS = [0, 1, 2, 3];
const TOP_LEVEL = LEVELS[LEVELS.length - 1];

/** 수준 번호 변환의 유일한 지점: 녹화·내부는 0..3, skylens 프로토콜은 1..4. */
export const toProtocolLevel = (internal) => internal + 1;

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
    if (!LEVELS.includes(f.level)) throw new Error(`${where}: level 은 0..3 정수여야 함`);
    if (f.resend !== undefined && typeof f.resend !== 'boolean') throw new Error(`${where}: resend 는 불리언이어야 함`);
  } else if (f.resend !== undefined) {
    throw new Error(`${where}: resend 는 segment 프레임에만 쓸 수 있음`);
  }
}

/**
 * 프레임 배열을 집계하는 순수 함수.
 * - initial_bytes: 첫 'first_frame' 프레임까지(포함)의 바이트 합. 해당 프레임이 없으면 null.
 * - segments: 구간 ID 별로 실제 받은 수준의 바이트 합 (ID 오름차순). Map 을 쓰므로 시각·ID 크기와 무관.
 *   빠진 수준은 오류가 아니라 기록 대상이다. 코어는 대기 중 추월된 수준을 버리고 재접속 상황판은
 *   구간마다 가장 높은 수준만 받기 때문이다.
 * - segment_levels: 구간별 받은 수준 (프로토콜 번호 1..4). segment_levels_skipped: 받은 최고 수준보다
 *   낮은데 받지 못한 수준 (프로토콜 번호). 최고 수준 위쪽의 미수신은 건너뜀이 아니다.
 * - 같은 (구간,수준)의 resend 프레임은 원본이 녹화에 있으면 합에 넣지 않고 resend_bytes 로 센다.
 *   원본이 없으면 그 재전송이 유일한 사본이므로 합에 넣는다. total_bytes·by_kind·windows 에는 항상 포함한다.
 * - 녹화 끝의 미완 구간: ID 가 가장 큰 구간에 최고 수준(내부 3)이 없으면 미완으로 보고 segments 에서 제외하고
 *   trailing_segment 로 따로 낸다 (ID·바이트·받은 수준).
 * - windows: windowMs 시간 창별 바이트 합 (트래픽이 있는 창만, 창 번호 오름차순).
 */
export function summarize(frames, { windowMs = DEFAULT_WINDOW_MS } = {}) {
  if (!Array.isArray(frames)) throw new Error('frames 는 배열이어야 함');
  if (!(Number.isFinite(windowMs) && windowMs > 0)) throw new Error('windowMs 는 양수여야 함');
  let totalBytes = 0;
  let initialBytes = null;
  let initialSum = 0;
  const byKind = {};
  const segMap = new Map(); // 구간 ID -> { perLevel: 수준 -> { orig, resend } }
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
    if (f.segment !== undefined) {
      const s = segMap.get(f.segment) ?? { perLevel: new Map() };
      const v = s.perLevel.get(f.level) ?? { orig: { n: 0, bytes: 0 }, resend: { n: 0, bytes: 0 } };
      const slot = f.resend === true ? v.resend : v.orig;
      slot.n += 1;
      slot.bytes += f.bytes;
      s.perLevel.set(f.level, v);
      segMap.set(f.segment, s);
    }
  });
  const allIds = [...segMap.keys()].sort((a, b) => a - b);
  // (구간,수준) 별 최종 바이트: 원본이 있으면 원본 합, 없으면 재전송 합.
  const effective = (id) => {
    const out = new Map();
    let resend = 0;
    for (const [l, v] of segMap.get(id).perLevel) {
      const useOrig = v.orig.n > 0;
      out.set(l, useOrig ? v.orig.bytes : v.resend.bytes);
      if (useOrig) resend += v.resend.bytes;
    }
    return { out, resend };
  };
  let trailing = null;
  let segIds = allIds;
  if (allIds.length) {
    const lastId = allIds[allIds.length - 1];
    if (!segMap.get(lastId).perLevel.has(TOP_LEVEL)) {
      segIds = allIds.slice(0, -1);
      const e = effective(lastId);
      const lv = [...e.out.keys()].sort((a, b) => a - b);
      trailing = { id: lastId, bytes: [...e.out.values()].reduce((x, y) => x + y, 0), levels: lv.map(toProtocolLevel) };
    }
  }
  const segments = [];
  const segLevels = [];
  const segSkipped = [];
  let resendBytes = 0;
  for (const id of allIds) {
    const e = effective(id);
    resendBytes += e.resend;
    if (!segIds.includes(id)) continue;
    const got = [...e.out.keys()].sort((a, b) => a - b);
    const top = got[got.length - 1];
    segments.push([...e.out.values()].reduce((x, y) => x + y, 0));
    segLevels.push(got.map(toProtocolLevel));
    segSkipped.push(LEVELS.filter((l) => l < top && !e.out.has(l)).map(toProtocolLevel));
  }
  const winIds = [...winMap.keys()].sort((a, b) => a - b);
  return {
    frame_count: frames.length,
    total_bytes: totalBytes,
    initial_bytes: initialBytes,
    by_kind: byKind,
    segment_ids: segIds,
    segments,
    segment_levels: segLevels,
    segment_levels_skipped: segSkipped,
    resend_bytes: resendBytes,
    trailing_segment: trailing,
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
  let s;
  try {
    s = summarize(replay(path));
  } catch (e) {
    throw new Error(e.message.includes(path) ? e.message : `${path}: ${e.message}`);
  }
  if (s.initial_bytes === null) throw new Error(`${path}: '${FIRST_FRAME_KIND}' 프레임이 없음`);
  if (s.segments.length === 0) {
    throw new Error(`${path}: ${s.trailing_segment ? '완결된 segment 가 없음 (미완 구간만 있음)' : 'segment 프레임이 없음'}`);
  }
  const device = 'replay';
  const rec = (metric, value, unit, method, extra = {}) => ({ metric, value, unit, device, method, commit, ...extra });
  const mSeg = 'ws_recording_replay by_segment_id';
  const mWin = `ws_recording_replay window_ms=${DEFAULT_WINDOW_MS}`;
  const mAll = 'ws_recording_replay';
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
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
    rec('ws_bytes.levels_skipped', skipped.reduce((x, y) => x + y, 0), 'count', mSeg, { samples: skipped }),
    // 구간별 받은 수준 수와 받은 수준 비트마스크 (프로토콜 수준 n 은 비트 n-1).
    rec('ws_bytes.levels_received', mean(received), 'count', mSeg, { samples: received }),
    rec('ws_bytes.segment_levels_mask', mean(masks), 'count', mSeg, { samples: masks }),
    // 같은 (구간,수준)을 다시 보낸 재전송 바이트 (segment_total 에는 넣지 않음).
    rec('ws_bytes.resend_bytes', s.resend_bytes, 'B', mSeg),
    // 녹화 끝의 미완 구간 바이트 (없으면 0, segment_total 에서 제외).
    rec('ws_bytes.trailing_segment_bytes', s.trailing_segment ? s.trailing_segment.bytes : 0, 'B', mSeg),
    // 시간 창 지표: 트래픽이 있는 창만.
    rec('ws_bytes.window_1000ms', mean(s.windows), 'B', mWin, { samples: s.windows }),
  ];
  for (const k of Object.keys(s.by_kind).sort()) {
    out.push(rec(`ws_bytes.kind.${k.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`, s.by_kind[k], 'B', mAll));
  }
  assertRecords(out);
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'ws_bytes.json'), serialize(out));
  }
  return out;
}
