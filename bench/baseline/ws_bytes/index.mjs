// 웹소켓 프레임 바이트 기록기 (T01.4).
// 녹화 파일(JSON Lines)을 재생해 집계만 한다. 소켓을 열거나 네트워크를 호출하지 않는다.
// 한 줄 형식: {"t_ms": number, "dir": "rx"|"tx", "bytes": number, "kind": string}
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertRecords } from '../../../contracts/metrics/index.mjs';

export const FIRST_FRAME_KIND = 'first_frame';
export const DEFAULT_SEGMENT_MS = 1000;

/** 프레임 한 건의 형식을 검사한다. 위반 시 오류를 던진다. */
function checkFrame(f, where) {
  if (f === null || typeof f !== 'object' || Array.isArray(f)) throw new Error(`${where}: 프레임은 객체여야 함`);
  if (!(Number.isFinite(f.t_ms) && f.t_ms >= 0)) throw new Error(`${where}: t_ms 가 올바르지 않음`);
  if (f.dir !== 'rx' && f.dir !== 'tx') throw new Error(`${where}: dir 은 rx 또는 tx 여야 함`);
  if (!(Number.isInteger(f.bytes) && f.bytes >= 0)) throw new Error(`${where}: bytes 가 올바르지 않음`);
  if (typeof f.kind !== 'string' || f.kind === '') throw new Error(`${where}: kind 가 올바르지 않음`);
}

/**
 * 프레임 배열을 집계하는 순수 함수.
 * - initial_bytes: 첫 'first_frame' 프레임까지(포함)의 바이트 합. 해당 프레임이 없으면 null.
 * - segments: segmentMs 단위 구간별 바이트 합 (0 번 구간부터 마지막 구간까지, 빈 구간은 0).
 */
export function summarize(frames, { segmentMs = DEFAULT_SEGMENT_MS } = {}) {
  if (!Array.isArray(frames)) throw new Error('frames 는 배열이어야 함');
  if (!(Number.isFinite(segmentMs) && segmentMs > 0)) throw new Error('segmentMs 는 양수여야 함');
  let totalBytes = 0;
  let initialBytes = null;
  let initialSum = 0;
  const byKind = {};
  const segments = [];
  frames.forEach((f, i) => {
    checkFrame(f, `frame ${i}`);
    totalBytes += f.bytes;
    byKind[f.kind] = (byKind[f.kind] ?? 0) + f.bytes;
    if (initialBytes === null) {
      initialSum += f.bytes;
      if (f.kind === FIRST_FRAME_KIND) initialBytes = initialSum;
    }
    const seg = Math.floor(f.t_ms / segmentMs);
    while (segments.length <= seg) segments.push(0);
    segments[seg] += f.bytes;
  });
  return { frame_count: frames.length, total_bytes: totalBytes, initial_bytes: initialBytes, by_kind: byKind, segments };
}

/** 녹화 파일을 읽어 프레임 배열로 돌려준다. 손상된 줄은 줄 번호와 함께 오류로 처리한다. */
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

/** 벤치 모듈 계약: 녹화를 재생해 측정 레코드 목록을 돌려준다. */
export async function run({ skylensDir, outDir, commit, recording, segmentMs = DEFAULT_SEGMENT_MS }) {
  const path = recording ?? join(skylensDir, 'fixtures', 'ws_recording.jsonl');
  const s = summarize(replay(path), { segmentMs });
  if (s.initial_bytes === null) throw new Error(`${path}: '${FIRST_FRAME_KIND}' 프레임이 없음`);
  const device = 'replay';
  const method = `ws_recording_replay segment_ms=${segmentMs}`;
  const rec = (metric, value, unit, extra = {}) => ({ metric, value, unit, device, method, commit, ...extra });
  const out = [
    rec('ws_bytes.total', s.total_bytes, 'B'),
    rec('ws_bytes.frames', s.frame_count, 'count'),
    rec('ws_bytes.initial', s.initial_bytes, 'B'),
    // 구간당 합: value 는 구간별 합의 평균, samples 는 구간별 합 전체.
    rec('ws_bytes.segment_total', s.segments.reduce((a, b) => a + b, 0) / s.segments.length, 'B', { samples: s.segments }),
  ];
  for (const k of Object.keys(s.by_kind).sort()) {
    out.push(rec(`ws_bytes.kind.${k.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`, s.by_kind[k], 'B'));
  }
  return assertRecords(out);
}
