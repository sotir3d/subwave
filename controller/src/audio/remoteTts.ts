// HTTP client for a user-configured remote TTS engine.
//
// When settings.tts.remote.url is set, the `remote` engine POSTs to that
// endpoint's /speak and receives the rendered audio BYTES back in the HTTP
// response, then writes them to a local file the controller (and Liquidsoap)
// can read. Unlike the tts-heavy sidecar — which shares the /var/sub-wave
// volume and returns a path — `remote` carries the audio in the response
// body, so the endpoint can live on any host reachable over the network
// (LAN, Tailscale, …) with no shared filesystem. This is the TTS equivalent
// of the LLM's custom base URL: a first-class, self-hosted HTTP engine
// without impersonating pocket-tts or chatterbox.
//
// Contract:
//   GET  {url}/health  → 200 JSON { ok: true }
//   POST {url}/speak   → 200, request JSON { text, voice }, response BODY is
//                        the rendered audio (WAV, Content-Type audio/*). The
//                        controller writes the body to its own voice dir.
//                        Optional response headers make a silent voice
//                        substitution visible (issue #238): X-TTS-Fell-Back,
//                        X-TTS-Voice-Used, X-TTS-Fell-Back-Reason.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import * as settings from '../settings.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { cachedHealthProbe } from '../util/health-probe.js';

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 180_000;
const LONG_REQUEST_TIMEOUT_MAX_MS = 15 * 60_000;

export interface RemoteTtsCapabilities {
  ok: boolean;
  ready?: boolean;
  engine?: string;
  streaming?: boolean;
  maxSeconds?: number;
  voices?: string[];
  [key: string]: unknown;
}

let lastCapabilities: RemoteTtsCapabilities | null = null;

function getUrl(): string {
  return settings.get().tts?.remote?.url || '';
}

// One /health probe. true iff the endpoint reports ok. No engine-name check —
// the remote endpoint is a generic bridge; it decides what it supports.
// Network/timeout/parse failures collapse to unavailable.
async function probeOnce(): Promise<boolean> {
  const url = getUrl();
  if (!url) return false;
  try {
    const res = await fetchWithTimeout(`${url}/health`, { timeoutMs: PROBE_TIMEOUT_MS, bodyDeadline: true });
    if (!res.ok) return false;
    const body = (await res.json()) as RemoteTtsCapabilities;
    const available = body.ok === true && body.ready !== false;
    lastCapabilities = available ? { ...body, ok: true } : null;
    return available;
  } catch {
    lastCapabilities = null;
    return false;
  }
}

// Cached availability — read synchronously by the dispatcher in tts.ts. The
// shared probe runs probeOnce() on an interval (and on demand via refresh()),
// caches the result, and logs only on a change — re-reading the URL so the
// "no URL configured" variant stays intact.
const probe = cachedHealthProbe<boolean>({
  probe: probeOnce,
  intervalMs: PROBE_INTERVAL_MS,
  initial: false,
  onChange: (available) => {
    const url = getUrl();
    console.log(
      url
        ? `[remote] TTS endpoint ${available ? 'available' : 'unavailable'} (${url})`
        : '[remote] TTS endpoint unavailable (no URL configured)',
    );
  },
});

// Start the periodic /health probe loop (idempotent). Called from server.ts
// AFTER settings.load(): the remote URL lives in settings (not env), so unlike
// the tts-heavy probe this can't self-start at import time — it would only ever
// see the empty default and leave the engine unavailable for the first tick.
// The interval is unref'd so it doesn't keep the event loop alive on its own.
export function start(): void {
  probe.start();
}

// Force an immediate probe — called when the URL changes via the admin UI so
// availability (and the UI badge) reflects the new endpoint without waiting for
// the next 30s tick.
export async function refresh(): Promise<void> {
  await probe.refresh();
}

// Optional health metadata for long-form production. Existing endpoints that
// return only {ok:true} remain fully compatible; richer Windows wrappers can
// advertise the resident engine and its preferred acoustic-context limit.
export function capabilities(): RemoteTtsCapabilities | null {
  return lastCapabilities ? { ...lastCapabilities } : null;
}

export function isAvailable(): boolean {
  if (!getUrl()) return false;
  return probe.get();
}

async function speakNow(
  text: string,
  {
    outPath: customPath,
    voice,
    signal,
    strictVoice = false,
  }: { outPath?: string; voice?: string; signal?: AbortSignal; strictVoice?: boolean },
): Promise<string> {
  const url = getUrl();
  if (!url) throw new Error('remote TTS URL not configured');
  if (!text || !text.trim()) throw new Error('Empty TTS text');

  const outPath = customPath || path.join(config.piper.outDir, `${crypto.randomBytes(6).toString('hex')}.wav`);
  await mkdir(path.dirname(outPath), { recursive: true });

  // A conservative short-link floor plus audio-length headroom for advertised
  // long-context voices. At ~132 spoken wpm, allow up to 2x realtime + 30s;
  // Echo-sized chunks retain the existing 180s cap while a FireRed-sized
  // multi-minute request is not killed exactly as its audio finishes.
  const estimatedAudioMs = Math.ceil(text.trim().split(/\s+/).length / 2.2) * 1_000;
  const timeoutMs = Math.min(
    LONG_REQUEST_TIMEOUT_MAX_MS,
    Math.max(REQUEST_TIMEOUT_MS, estimatedAudioMs * 2 + 30_000),
  );

  const res = await fetchWithTimeout(`${url}/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.trim(), voice: voice ?? '' }),
    timeoutMs,
    bodyDeadline: true,
    signal,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`remote TTS ${res.status}: ${errBody || res.statusText}`);
  }
  // The audio rides back in the response body — write it where the controller
  // and Liquidsoap can both read it (no shared volume needed). An empty body
  // throws so the dispatcher falls back to Piper instead of handing Liquidsoap
  // a zero-byte file (a silent segment with no error).
  const fallbackHeader = res.headers.get('x-tts-fell-back');
  const reportedFallback = fallbackHeader != null && !/^(?:0|false|no)$/i.test(fallbackHeader.trim());
  const requestedVoice = voice?.trim() || '';
  const voiceUsed = res.headers.get('x-tts-voice-used')?.trim() || '';
  const reportedMismatch = !!requestedVoice && !!voiceUsed && requestedVoice !== voiceUsed;
  const voiceUnverified = !!requestedVoice && !voiceUsed;
  if ((reportedFallback || reportedMismatch || voiceUnverified) && strictVoice) {
    throw new Error(
      `remote TTS did not honour voice "${requestedVoice}": `
      + (res.headers.get('x-tts-fell-back-reason')
        || (voiceUsed
          ? `provider rendered "${voiceUsed}"`
          : reportedFallback
            ? 'provider reported a fallback'
            : 'provider did not return X-TTS-Voice-Used')),
    );
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length === 0) throw new Error('remote TTS returned an empty response body');
  await writeFile(outPath, audio);

  // Make a silent voice substitution visible (issue #238): the call succeeded
  // and audio plays, but NOT in the requested voice. Surfaced via optional
  // response headers since the body carries audio, not JSON.
  if (reportedFallback || reportedMismatch) {
    console.warn(
      `[remote] requested voice "${voice || ''}" not honoured`
        + ` (${res.headers.get('x-tts-fell-back-reason') || 'fell back'});`
        + ` rendered "${res.headers.get('x-tts-voice-used') || 'default'}"`,
    );
  }
  return outPath;
}

// Remote neural voices generally occupy one GPU and do not benefit from two
// simultaneous HTTP requests. Serialize every remote render (short links and
// long-form chapters alike) so the Windows wrapper never has to absorb a burst
// from independent controller crons. The queue is intentionally separate from
// the LLM admission lane: on a two-GPU host, script N+1 and voice N may overlap.
interface RemoteRenderJob {
  text: string;
  opts: { outPath?: string; voice?: string; signal?: AbortSignal; strictVoice?: boolean };
  resolve: (path: string) => void;
  reject: (error: unknown) => void;
  onAbort?: () => void;
}

const renderQueue: RemoteRenderJob[] = [];
let activeRenders = 0;

function remoteAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('Remote TTS render was aborted');
  error.name = 'AbortError';
  return error;
}

function drainRenderQueue(): void {
  if (activeRenders > 0) return;
  const job = renderQueue.shift();
  if (!job) return;
  if (job.onAbort && job.opts.signal) job.opts.signal.removeEventListener('abort', job.onAbort);
  if (job.opts.signal?.aborted) {
    job.reject(remoteAbortError(job.opts.signal));
    drainRenderQueue();
    return;
  }
  activeRenders = 1;
  void speakNow(job.text, job.opts).then(job.resolve, job.reject).finally(() => {
    activeRenders = 0;
    drainRenderQueue();
  });
}

export async function speak(
  text: string,
  opts: { outPath?: string; voice?: string; signal?: AbortSignal; strictVoice?: boolean },
): Promise<string> {
  if (opts.signal?.aborted) throw remoteAbortError(opts.signal);
  return new Promise<string>((resolve, reject) => {
    const job: RemoteRenderJob = { text, opts, resolve, reject };
    if (opts.signal) {
      job.onAbort = () => {
        const index = renderQueue.indexOf(job);
        if (index < 0) return; // active fetch owns cancellation via its signal
        renderQueue.splice(index, 1);
        opts.signal?.removeEventListener('abort', job.onAbort!);
        reject(remoteAbortError(opts.signal));
      };
      opts.signal.addEventListener('abort', job.onAbort, { once: true });
    }
    renderQueue.push(job);
    drainRenderQueue();
  });
}

export function renderQueueStatus(): { active: number; queued: number } {
  return { active: activeRenders, queued: renderQueue.length };
}
