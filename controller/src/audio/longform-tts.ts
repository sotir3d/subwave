// Long-form TTS rendering: split a script into provider-sized calls, render
// those calls serially, then assemble their PCM WAVs into one canonical WAV.
//
// The synthesis callback is deliberately provider-neutral. The default path
// lazily delegates to the normal TTS dispatcher with kind=longform, while
// tests and alternate providers can inject any callback that honours the
// requested output path.

import { copyFile, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyEdgeFades } from './wav-edges.js';

// Roughly 25 seconds at a measured, broadcast-style 132 words per minute.
// Callers can lower this for voices with a shorter generation ceiling.
export const DEFAULT_LONGFORM_WORD_BUDGET = 55;

export interface LongformChunkOptions {
  wordBudget?: number;
}

export interface PcmWavFormat {
  audioFormat: 1;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
}

export interface PcmWavInfo extends PcmWavFormat {
  dataBytes: number;
  durationSec: number;
}

interface InspectedPcmWav extends PcmWavInfo {
  path: string;
  dataOffset: number;
}

export interface LongformSynthesisRequest {
  outPath: string;
  index: number;
  total: number;
  wordCount: number;
}

export type LongformSynthesizer = (
  text: string,
  request: LongformSynthesisRequest,
) => Promise<string | void>;

export interface RenderLongformTtsOptions extends LongformChunkOptions {
  outPath: string;
  /** Parent directory for the private per-render temporary directory. */
  tempDir?: string;
  synthesize?: LongformSynthesizer;
  /** Passed only to the default tts.speak adapter. */
  persona?: unknown;
  /** Defaults false so a long episode never silently changes voice mid-way. */
  allowFallback?: boolean;
  signal?: AbortSignal;
  /** Applied once to the assembled chapter. Set to 0 for raw PCM fixtures. */
  edgeFadeMs?: number;
}

export interface LongformTtsResult extends PcmWavInfo {
  path: string;
  chunkCount: number;
  wordCount: number;
  chunkWordCounts: number[];
}

const WORD_RE = /\S+/gu;
const SENTENCE_END_RE = /[.!?\u2026]+(?:["'\u201d\u2019)\]}\u00bb]+)?(?=\s|$)/gu;
const PARAGRAPH_END_RE = /(?:\r?\n)[\t ]*(?:\r?\n)+/g;
const CLAUSE_END_RE = /[,;:\u2014\u2013-](?:["'\u201d\u2019)\]}\u00bb]+)?$/u;

export function longformWordCount(text: string): number {
  return Array.from(text.matchAll(WORD_RE)).length;
}

function assertWordBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('wordBudget must be a positive integer');
  }
}

// A generated sentence can itself exceed the provider budget. In that rare
// case prefer the latest clause boundary in the back half of the budget, then
// fall back to the exact word boundary. Every byte (including whitespace) is
// retained in one of the returned pieces.
function splitOversizeSpan(span: string, wordBudget: number): string[] {
  const pieces: string[] = [];
  let rest = span;
  while (longformWordCount(rest) > wordBudget) {
    const words = Array.from(rest.matchAll(WORD_RE));
    const minimumClauseWord = Math.max(1, Math.ceil(wordBudget * 0.55));
    let chosen = words[wordBudget - 1];
    for (let i = minimumClauseWord - 1; i < wordBudget; i++) {
      if (CLAUSE_END_RE.test(words[i][0])) chosen = words[i];
    }
    let cut = (chosen.index ?? 0) + chosen[0].length;
    // Keep separator whitespace with the preceding piece so the next TTS call
    // starts on a word, without changing reconstruction order.
    while (cut < rest.length && /\s/u.test(rest[cut])) cut += 1;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function preferredSpans(text: string): string[] {
  const cuts = new Set<number>([text.length]);
  for (const match of text.matchAll(SENTENCE_END_RE)) {
    cuts.add((match.index ?? 0) + match[0].length);
  }
  for (const match of text.matchAll(PARAGRAPH_END_RE)) {
    cuts.add((match.index ?? 0) + match[0].length);
  }

  const spans: string[] = [];
  let start = 0;
  for (const cut of Array.from(cuts).sort((a, b) => a - b)) {
    if (cut > start) spans.push(text.slice(start, cut));
    start = cut;
  }
  return spans;
}

/**
 * Split prose at paragraph/sentence boundaries while keeping every chunk at
 * or below `wordBudget`. Only a sentence that is itself too long is cut at a
 * clause/word boundary. Concatenating the result recreates the input exactly.
 */
export function splitLongformText(
  text: string,
  { wordBudget = DEFAULT_LONGFORM_WORD_BUDGET }: LongformChunkOptions = {},
): string[] {
  assertWordBudget(wordBudget);
  if (!text) return [];

  const chunks: string[] = [];
  let pending = '';
  for (const span of preferredSpans(text)) {
    const combined = pending + span;
    if (longformWordCount(combined) <= wordBudget) {
      pending = combined;
      continue;
    }

    if (longformWordCount(pending) > 0) {
      chunks.push(pending);
      pending = '';
    }

    const pieces = splitOversizeSpan(pending + span, wordBudget);
    pending = pieces.pop() ?? '';
    chunks.push(...pieces);
  }
  if (pending) chunks.push(pending);

  // Whitespace-only input, or a trailing whitespace span after a pushed
  // chunk, still belongs to exactly one chunk.
  if (!chunks.length && text) return [text];
  return chunks;
}

async function readExactly(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesRead === 0) throw new Error('unexpected end of WAV file');
    offset += bytesRead;
  }
}

function checkedPcmFormat(fmt: Buffer, sourcePath: string): PcmWavFormat {
  if (fmt.length < 16) throw new Error(`invalid fmt chunk in WAV: ${sourcePath}`);
  const audioFormat = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const byteRate = fmt.readUInt32LE(8);
  const blockAlign = fmt.readUInt16LE(12);
  const bitsPerSample = fmt.readUInt16LE(14);

  if (audioFormat !== 1) {
    throw new Error(`long-form WAV must be uncompressed PCM (format 1): ${sourcePath}`);
  }
  if (!channels || !sampleRate || !bitsPerSample || bitsPerSample % 8 !== 0) {
    throw new Error(`invalid PCM format in WAV: ${sourcePath}`);
  }
  const expectedBlockAlign = channels * (bitsPerSample / 8);
  const expectedByteRate = sampleRate * expectedBlockAlign;
  if (blockAlign !== expectedBlockAlign || byteRate !== expectedByteRate) {
    throw new Error(`inconsistent PCM format in WAV: ${sourcePath}`);
  }

  return {
    audioFormat: 1,
    channels,
    sampleRate,
    byteRate,
    blockAlign,
    bitsPerSample,
  };
}

async function inspectPcmWav(sourcePath: string): Promise<InspectedPcmWav> {
  const handle = await open(sourcePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 44) throw new Error(`WAV is too short: ${sourcePath}`);

    const riff = Buffer.alloc(12);
    await readExactly(handle, riff, 0);
    if (riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error(`not a RIFF/WAVE file: ${sourcePath}`);
    }

    let fmt: PcmWavFormat | null = null;
    let dataOffset = -1;
    let dataBytes = -1;
    let offset = 12;
    while (offset + 8 <= size) {
      const header = Buffer.alloc(8);
      await readExactly(handle, header, offset);
      const id = header.toString('ascii', 0, 4);
      const declaredSize = header.readUInt32LE(4);
      const payloadOffset = offset + 8;
      const available = size - payloadOffset;

      if (id !== 'data' && declaredSize > available) {
        throw new Error(`truncated ${id} chunk in WAV: ${sourcePath}`);
      }
      if (id === 'fmt ') {
        if (declaredSize < 16) throw new Error(`invalid fmt chunk in WAV: ${sourcePath}`);
        const fmtBytes = Buffer.alloc(16);
        await readExactly(handle, fmtBytes, payloadOffset);
        fmt = checkedPcmFormat(fmtBytes, sourcePath);
      } else if (id === 'data') {
        if (dataOffset >= 0) throw new Error(`multiple data chunks are unsupported: ${sourcePath}`);
        dataOffset = payloadOffset;
        // A few streaming writers leave zero/oversized data lengths. For a
        // terminal data chunk, the bytes remaining in the file are the truth.
        dataBytes = declaredSize === 0 || declaredSize > available
          ? available
          : declaredSize;
      }

      if (fmt && dataOffset >= 0) break;
      if (declaredSize === 0) break;
      offset = payloadOffset + declaredSize + (declaredSize % 2);
    }

    if (!fmt || dataOffset < 0 || dataBytes <= 0) {
      throw new Error(`WAV is missing a usable fmt or data chunk: ${sourcePath}`);
    }
    // If a stale terminal size made us include the RIFF pad byte, discard that
    // single byte when doing so restores frame alignment.
    if (dataBytes % fmt.blockAlign !== 0
      && dataBytes > 0
      && (dataBytes - 1) % fmt.blockAlign === 0) {
      dataBytes -= 1;
    }
    if (dataBytes % fmt.blockAlign !== 0) {
      throw new Error(`PCM data is not frame-aligned: ${sourcePath}`);
    }

    return {
      ...fmt,
      path: sourcePath,
      dataOffset,
      dataBytes,
      durationSec: dataBytes / fmt.byteRate,
    };
  } finally {
    await handle.close();
  }
}

export async function readPcmWavInfo(sourcePath: string): Promise<PcmWavInfo> {
  const { path: _path, dataOffset: _dataOffset, ...info } = await inspectPcmWav(sourcePath);
  return info;
}

function sameFormat(a: PcmWavFormat, b: PcmWavFormat): boolean {
  return a.audioFormat === b.audioFormat
    && a.channels === b.channels
    && a.sampleRate === b.sampleRate
    && a.byteRate === b.byteRate
    && a.blockAlign === b.blockAlign
    && a.bitsPerSample === b.bitsPerSample;
}

function canonicalPcmHeader(format: PcmWavFormat, dataBytes: number): Buffer {
  const pad = dataBytes % 2;
  const riffSize = 36 + dataBytes + pad;
  if (riffSize > 0xffffffff) throw new Error('combined WAV exceeds the RIFF 4 GiB limit');

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(riffSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(format.audioFormat, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.byteRate, 28);
  header.writeUInt16LE(format.blockAlign, 32);
  header.writeUInt16LE(format.bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten === 0) throw new Error('unable to write combined WAV');
    offset += bytesWritten;
  }
}

async function copyDataChunk(
  source: InspectedPcmWav,
  destination: FileHandle,
  signal?: AbortSignal,
): Promise<void> {
  const input = await open(source.path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let remaining = source.dataBytes;
    let position = source.dataOffset;
    while (remaining > 0) {
      throwIfAborted(signal);
      const wanted = Math.min(buffer.length, remaining);
      const { bytesRead } = await input.read(buffer, 0, wanted, position);
      if (bytesRead === 0) throw new Error(`unexpected end of PCM data: ${source.path}`);
      await writeAll(destination, buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
      position += bytesRead;
    }
  } finally {
    await input.close();
  }
}

/** Assemble compatible PCM WAV files without invoking ffmpeg or a shell. */
export async function concatenatePcmWavFiles(
  inputPaths: string[],
  outPath: string,
  signal?: AbortSignal,
): Promise<PcmWavInfo> {
  throwIfAborted(signal);
  if (!inputPaths.length) throw new Error('at least one WAV input is required');
  const resolvedOut = resolve(outPath);
  if (inputPaths.some((input) => resolve(input) === resolvedOut)) {
    throw new Error('combined WAV output must differ from every input path');
  }

  const inputs: InspectedPcmWav[] = [];
  for (const inputPath of inputPaths) inputs.push(await inspectPcmWav(inputPath));
  const format = inputs[0];
  for (const input of inputs.slice(1)) {
    if (!sameFormat(format, input)) {
      throw new Error(`incompatible PCM WAV format: ${input.path}`);
    }
  }

  const dataBytes = inputs.reduce((sum, input) => sum + input.dataBytes, 0);
  if (!Number.isSafeInteger(dataBytes)) throw new Error('combined WAV is too large');
  const header = canonicalPcmHeader(format, dataBytes);

  await mkdir(dirname(resolvedOut), { recursive: true });
  const partialPath = join(
    dirname(resolvedOut),
    `.${basename(resolvedOut)}.${randomUUID()}.part`,
  );
  const destination = await open(partialPath, 'wx');
  try {
    await writeAll(destination, header);
    for (const input of inputs) await copyDataChunk(input, destination, signal);
    if (dataBytes % 2) await writeAll(destination, Buffer.from([0]));
    await destination.sync();
  } catch (err) {
    await destination.close().catch(() => undefined);
    await rm(partialPath, { force: true }).catch(() => undefined);
    throw err;
  }
  await destination.close();
  try {
    await rename(partialPath, resolvedOut);
  } catch (err) {
    await rm(partialPath, { force: true }).catch(() => undefined);
    throw err;
  }

  return {
    audioFormat: 1,
    channels: format.channels,
    sampleRate: format.sampleRate,
    byteRate: format.byteRate,
    blockAlign: format.blockAlign,
    bitsPerSample: format.bitsPerSample,
    dataBytes,
    durationSec: dataBytes / format.byteRate,
  };
}

async function defaultSynthesizer(
  text: string,
  request: LongformSynthesisRequest,
  options: RenderLongformTtsOptions,
): Promise<string> {
  const tts = await import('./tts.js');
  return tts.speak(text, {
    kind: 'longform',
    outPath: request.outPath,
    persona: options.persona,
    allowFallback: options.allowFallback ?? false,
    applyFades: false,
    signal: options.signal,
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Long-form TTS render was aborted');
  error.name = 'AbortError';
  throw error;
}

/**
 * Render a complete spoken chapter. Calls the synthesizer strictly serially,
 * concatenates the resulting PCM WAVs, reports measured duration, and removes
 * its private chunk directory whether the render succeeds or fails.
 */
export async function renderLongformTts(
  text: string,
  options: RenderLongformTtsOptions,
): Promise<LongformTtsResult> {
  if (!text || !text.trim()) throw new Error('long-form TTS text is empty');
  if (!options?.outPath) throw new Error('long-form TTS outPath is required');
  const wordBudget = options.wordBudget ?? DEFAULT_LONGFORM_WORD_BUDGET;
  throwIfAborted(options.signal);
  const chunks = splitLongformText(text, { wordBudget });
  const chunkWordCounts = chunks.map(longformWordCount);
  const parent = resolve(options.tempDir ?? dirname(options.outPath));
  await mkdir(parent, { recursive: true });
  const workDir = await mkdtemp(join(parent, 'subwave-longform-tts-'));
  let outputCommitted = false;

  try {
    const renderedPaths: string[] = [];
    for (let index = 0; index < chunks.length; index++) {
      throwIfAborted(options.signal);
      const requestedPath = join(workDir, `chunk-${String(index).padStart(4, '0')}.wav`);
      const request: LongformSynthesisRequest = {
        outPath: requestedPath,
        index,
        total: chunks.length,
        wordCount: chunkWordCounts[index],
      };
      const returnedPath = options.synthesize
        ? await options.synthesize(chunks[index], request)
        : await defaultSynthesizer(chunks[index], request, options);
      throwIfAborted(options.signal);
      const actualPath = typeof returnedPath === 'string' && returnedPath.trim()
        ? returnedPath
        : requestedPath;
      if (resolve(actualPath) !== resolve(requestedPath)) {
        await copyFile(actualPath, requestedPath);
      }
      renderedPaths.push(requestedPath);
    }

    throwIfAborted(options.signal);
    const info = await concatenatePcmWavFiles(renderedPaths, options.outPath, options.signal);
    outputCommitted = true;
    throwIfAborted(options.signal);
    const edgeFadeMs = options.edgeFadeMs ?? 40;
    if (edgeFadeMs > 0) await applyEdgeFades(options.outPath, edgeFadeMs);
    throwIfAborted(options.signal);
    return {
      ...info,
      path: options.outPath,
      chunkCount: chunks.length,
      wordCount: chunkWordCounts.reduce((sum, count) => sum + count, 0),
      chunkWordCounts,
    };
  } catch (error) {
    // An abort/fade failure after the atomic concatenation must not leave an
    // unreferenced file at the same attempt path. Listener-driven retries may
    // reuse that attempt number, especially on Windows where rename-over-open
    // behavior is less forgiving.
    if (outputCommitted) await rm(options.outPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    // `workDir` is the exact path returned by mkdtemp under the resolved parent,
    // never a caller-provided broad directory. Cleanup is intentionally best-
    // effort so a successfully assembled chapter is not discarded because an
    // antivirus scanner briefly holds a chunk file open on Windows.
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
