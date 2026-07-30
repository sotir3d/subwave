// The handoff-file write path and the spoken-segment serialiser.
//
// Liquidsoap polls each handoff file (say.txt, intro.txt, sfx.txt, next.txt)
// and deletes it after reading, so two writes inside one poll window silently
// lose the first (issue #140). Every write goes through writeHandoff(), which
// serialises per file and waits for the previous one to be consumed. On top of
// that, airVoice() serialises the spoken segments themselves (issue #310) and
// holds them past any jingle already on air (issue #997).
//
// Part of the queue/ split - see ../queue.ts, which owns the Queue class.

import { existsSync, readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { config } from '../../config.js';
import { writeFileAtomic } from '../../util/atomic-file.js';
import * as settings from '../../settings.js';
import { sleep } from './pure.js';

const _handoffChains: Map<string, Promise<void>> = new Map();

async function waitForConsumed(path: string, maxWaitMs: number) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      await stat(path);
    } catch {
      return; // liquidsoap deleted it — file gone, safe to write next
    }
    await sleep(100);
  }
  // Timed out — file still on disk. Caller proceeds anyway.
}

export async function writeHandoff(path: string, contents: string, { maxWaitMs = 1500 } = {}) {
  const prev = _handoffChains.get(path) || Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      // Make sure liquidsoap has already consumed whatever was there. If the
      // file doesn't exist (the common case — liquidsoap polled in the
      // meantime, or this is the first write of the session), this returns
      // immediately.
      if (existsSync(path)) await waitForConsumed(path, maxWaitMs);
      // Write-to-temp + rename so liquidsoap's poll never observes a
      // half-written (or truncated-but-empty) file — its poll handlers read,
      // DELETE, then check non-empty, so a poll landing mid-write would drop
      // this handoff silently. rename(2) is atomic on the same volume.
      await writeFileAtomic(path, contents);
    });
  // Hold the slot until liquidsoap consumes THIS write too, so the next
  // queued writer waits for the audio to land, not just for the write call to
  // return. Errors don't break the chain — the .catch above ensures the next
  // writer still gets its turn.
  const release = next.then(() => waitForConsumed(path, maxWaitMs).catch(() => undefined));
  _handoffChains.set(path, release);
  return next;
}

// --- Spoken-segment serialiser (issue #310) -------------------------------
//
// writeHandoff above stops two writes to ONE file from clobbering each other,
// but it releases the moment liquidsoap *reads* the path (~0.5s) — long before
// the ~20s of speech has actually played. And say.txt and intro.txt are
// separate chains, so nothing stopped a station ID / hourly check (say.txt)
// from airing on top of a between-track link (intro.txt), or two scheduled
// idents stacking when their cron handlers fired together.
//
// airVoice() chains EVERY spoken segment across BOTH channels through one lock
// and holds it for the clip's actual playback duration, so the next voice waits
// for silence instead of talking over the last one. The caller unblocks as soon
// as its own clip is handed to liquidsoap (writeHandoff resolved); only the
// *next* caller pays the duration wait.
let _voiceChain: Promise<void> = Promise.resolve();

export const VOICE_LEADIN_MS = 800;   // /sounds/leadin.wav pushed before each spoken clip
const VOICE_TAIL_MS = 700;     // duck ramp-back + poll/scheduling slack
// Cap a single hold so a wildly-wrong duration estimate (or a clip that never
// really aired) can't wedge the voice channel for minutes.
const VOICE_HOLD_MAX_MS = 90_000;

export async function airVoice(path: string, wavPath: string, text: string, gainDb = 0) {
  // Duration is read from the bare WAV path (header parse), so compute it BEFORE
  // wrapping — the annotate URI isn't a real file. The wrapped URI is only what
  // gets written to the handoff file for Liquidsoap to consume.
  const holdMs = Math.min(VOICE_HOLD_MAX_MS, speechDurationMs(wavPath, text));
  const uri = voiceUriWithGain(wavPath, gainDb);
  const turn = _voiceChain
    .catch(() => undefined)
    .then(async () => {
      // A jingle stinger may be on air (or inside the cross buffer) right now —
      // it plays outside this serialiser, so wait it out before handing over.
      await waitForJingleClear();
      return writeHandoff(path, uri);
    });
  // Extend the shared lock until this clip has (about) finished playing.
  _voiceChain = turn.then(() => sleep(holdMs)).then(() => {}, () => {});
  return turn;
}

// Timeline speech must begin only after any already-handed-off overlay has
// cleared. The long-form runtime acquires its exclusive mic lease before it
// calls this, so no new autonomous voice can extend the chain behind us.
export async function waitForVoiceIdle(signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await _voiceChain.catch(() => undefined);
    return;
  }
  const abortError = () => {
    if (signal.reason instanceof Error) return signal.reason;
    return new DOMException('Timeline voice handoff was aborted', 'AbortError');
  };
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    void _voiceChain.catch(() => undefined).then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

// --- Jingle collision guard (issue #997) -----------------------------------
//
// Jingles rotate into the broadcast inside Liquidsoap (radio.liq's jingle
// rotate), entirely outside the airVoice serialiser — and because music_meta
// is captured ABOVE that rotate, the incoming track's on_metadata fires while
// the stinger is still audible in the crossfade, so a boundary-aired link or
// ident talked straight over it. radio.liq announces each jingle by writing
// jingle-playing.json ({filename, startedAt}) the moment it starts feeding;
// the clip stays audible for up to its own length plus the cross buffer.
// Before any voice handoff, sleep out whatever remains of that window.
//
// The marker is never deleted — a stale one simply computes a window in the
// past. If the jingle WAV can't be measured (non-WAV upload, path not visible
// to a native-dev controller), a fixed fallback length keeps the guard useful
// without wedging the chain.

const JINGLE_FALLBACK_MS = 15_000; // clip length when the WAV can't be parsed
const JINGLE_TAIL_MS = 1_000;      // fade tail + poll slack
const JINGLE_WAIT_MAX_MS = 60_000; // never wedge the voice chain on a bad marker

// How recent a bed-playing.json startedAt must be to count as a live edge in
// onBedStarted. Detection latency is one 1.5s watcher tick; anything much
// older is the previous bed's marker surviving a controller restart (the file
// is never deleted, and the in-memory dedupe baseline doesn't persist).
export const BED_MARKER_FRESH_MS = 10_000;

function jingleClearAtMs(): number {
  try {
    const m = JSON.parse(readFileSync(config.liquidsoap.jinglePlayingFile, 'utf8'));
    const startedMs = Number(m?.startedAt) * 1000; // liquidsoap time() is unix seconds
    if (!Number.isFinite(startedMs) || startedMs <= 0) return 0;
    const clipMs = (typeof m?.filename === 'string' && wavDurationMs(m.filename)) || JINGLE_FALLBACK_MS;
    const crossMs = (Number(settings.get()?.crossfadeDuration) || 10) * 1000;
    return startedMs + clipMs + crossMs + JINGLE_TAIL_MS;
  } catch {
    return 0; // no marker (or unreadable) — nothing on air to avoid
  }
}

async function waitForJingleClear() {
  const waitMs = Math.min(JINGLE_WAIT_MAX_MS, jingleClearAtMs() - Date.now());
  if (waitMs > 0) await sleep(waitMs);
}

// Wrap a rendered voice-clip path in a Liquidsoap `annotate:` URI carrying a
// liq_amplify gain, so the per-engine/persona voice trim is applied as the clip
// plays (radio.liq wraps the voice queues in amplify(override="liq_amplify")).
// 0 dB → the bare path, no annotation — byte-for-byte today's behaviour. Mirrors
// subsonic.getAnnotatedUri's liq_amplify="<n> dB" form (the music loudness path).
function voiceUriWithGain(wavPath: string, gainDb: number): string {
  return gainDb !== 0 ? `annotate:liq_amplify="${gainDb} dB":${wavPath}` : wavPath;
}

// Best-effort playback duration of a rendered voice clip, plus the lead-in and
// duck-tail padding. Reads the exact length from a WAV header (the local
// engines), and estimates from word count for anything else (cloud mp3).
export function speechDurationMs(wavPath: string, text: string): number {
  const body = wavDurationMs(wavPath) ?? estimateSpeechMs(text);
  return body + VOICE_LEADIN_MS + VOICE_TAIL_MS;
}

// ~140 wpm, deliberately on the slow side so we over-, never under-estimate
// (an over-estimate just adds a little dead air; an under-estimate lets the
// next segment clip in over the tail).
function estimateSpeechMs(text: string): number {
  const words = (text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil((words / 2.3) * 1000);
}

// Duration from a WAV header (byteRate from `fmt `, byte count from `data`).
// Returns null for non-WAV or anything it can't parse, so the caller falls back
// to the word-count estimate. Reads only the first 4KB — headers are tiny.
function wavDurationMs(path: string): number | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(4096);
    const n = readSync(fd, head, 0, head.length, 0);
    if (n < 12 || head.toString('ascii', 0, 4) !== 'RIFF'
        || head.toString('ascii', 8, 12) !== 'WAVE') return null;
    let byteRate = 0;
    let dataSize = 0;
    let off = 12;
    while (off + 8 <= n) {
      const id = head.toString('ascii', off, off + 4);
      const size = head.readUInt32LE(off + 4);
      if (id === 'fmt ') {
        byteRate = head.readUInt32LE(off + 8 + 8);   // fmt body offset 8 → byteRate
      } else if (id === 'data') {
        dataSize = size;
        break;
      }
      off += 8 + size + (size % 2);   // chunks are word-aligned
    }
    if (!byteRate) return null;
    // Streamed WAVs sometimes write a bogus/placeholder data size — fall back
    // to the real file size minus the header we walked.
    if (!dataSize || dataSize > 0x7fffffff) {
      dataSize = Math.max(0, statSync(path).size - (off + 8));
    }
    if (!dataSize) return null;
    return Math.ceil((dataSize / byteRate) * 1000);
  } catch {
    return null;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

