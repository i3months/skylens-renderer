// 웹소켓 프레임 바이트 기록기 (T01.4).
// 녹화 파일(JSON Lines)을 재생해 집계만 한다. 소켓을 열거나 네트워크를 호출하지 않는다.
// 한 줄 형식: {"t_ms": 상대시각>=0, "dir": "rx"|"tx", "bytes": 정수>=0, "kind": string,
//              "segment": 정수>=0, "level": 0..3}   (segment·level 은 점 프레임에만, 둘이 함께)
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertRecords, serialize } from '../../../contracts/metrics/index.mjs';
import { requireInput } from '../../../contracts/inputs/index.mjs';

export const FIRST_FRAME_KIND = 'first_frame';
export const DEFAULT_WINDOW_MS = 1000;
export const LEVELS = [0, 1, 2, 3];

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
  }
}

/**
 * 프레임 배열을 집계하는 순수 함수.
 * - initial_bytes: 첫 'first_frame' 프레임까지(포함)의 바이트 합. 해당 프레임이 없으면 null.
 * - segments: 구간 ID 별 4수준 바이트 합 (ID 오름차순). Map 을 쓰므로 시각·ID 크기와 무관.
 *   4수준이 다 없는 구간이 있으면 오류(과소 집계로 예산을 거짓 통과하는 것을 막는다).
 * - windows: windowMs 시간 창별 바이트 합 (트래픽이 있는 창만, 창 번호 오름차순).
 */
export function summarize(frames, { windowMs = DEFAULT_WINDOW_MS } = {}) {
  if (!Array.isArray(frames)) throw new Error('frames 는 배열이어야 함');
  if (!(Number.isFinite(windowMs) && windowMs > 0)) throw new Error('windowMs 는 양수여야 함');
  let totalBytes = 0;
  let initialBytes = null;
  let initialSum = 0;
  const byKind = {};
  const segMap = new Map(); // 구간 ID -> { sum, levels }
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
      const s = segMap.get(f.segment) ?? { sum: 0, levels: new Set() };
      s.sum += f.bytes;
      s.levels.add(f.level);
      segMap.set(f.segment, s);
    }
  });
  const segIds = [...segMap.keys()].sort((a, b) => a - b);
  for (const id of segIds) {
    const missing = LEVELS.filter((l) => !segMap.get(id).levels.has(l));
    if (missing.length) throw new Error(`구간 ${id}: 수준 ${missing.join(',')} 프레임이 없음`);
  }
  const winIds = [...winMap.keys()].sort((a, b) => a - b);
  return {
    frame_count: frames.length,
    total_bytes: totalBytes,
    initial_bytes: initialBytes,
    by_kind: byKind,
    segment_ids: segIds,
    segments: segIds.map((id) => segMap.get(id).sum),
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
  if (s.segments.length === 0) throw new Error(`${path}: segment 프레임이 없음`);
  const device = 'replay';
  const rec = (metric, value, unit, method, extra = {}) => ({ metric, value, unit, device, method, commit, ...extra });
  const mSeg = 'ws_recording_replay by_segment_id';
  const mWin = `ws_recording_replay window_ms=${DEFAULT_WINDOW_MS}`;
  const mAll = 'ws_recording_replay';
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const out = [
    rec('ws_bytes.total', s.total_bytes, 'B', mAll),
    rec('ws_bytes.frames', s.frame_count, 'count', mAll),
    rec('ws_bytes.initial', s.initial_bytes, 'B', mAll),
    // 구간 ID 별 4수준 합: value 는 평균, samples 는 구간별 합 (SPEC §4).
    rec('ws_bytes.segment_total', mean(s.segments), 'B', mSeg, { samples: s.segments }),
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
