// Deterministic tests for sentence-aware long-form chunking and the pure PCM
// WAV assembler. No model, TTS provider, ffmpeg, or shell process is involved.
// Run: `tsx scripts/longform-tts.test.ts`.

import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  concatenatePcmWavFiles,
  longformWordCount,
  readPcmWavInfo,
  renderLongformTts,
  splitLongformText,
} from '../src/audio/longform-tts.js';

function pcm16Wav(samples: number[], sampleRate = 8_000): Buffer {
  const dataBytes = samples.length * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => wav.writeInt16LE(sample, 44 + index * 2));
  return wav;
}

const prose = [
  'First sentence has exactly six useful words. ',
  'Second sentence is deliberately longer, with a clause; it still keeps every word in order.\n\n',
  'A final paragraph closes the piece cleanly.',
].join('');
const chunks = splitLongformText(prose, { wordBudget: 8 });
assert.equal(chunks.join(''), prose, 'chunking preserves the original text byte-for-byte');
assert.ok(chunks.length >= 3, 'prose is divided into provider-sized calls');
assert.ok(
  chunks.every((chunk) => longformWordCount(chunk) <= 8),
  'every chunk respects the configured word budget',
);
assert.deepEqual(splitLongformText('', { wordBudget: 8 }), [], 'empty input has no chunks');
assert.throws(
  () => splitLongformText('hello', { wordBudget: 0 }),
  /positive integer/,
  'invalid budgets fail clearly',
);

const testDir = await mkdtemp(join(tmpdir(), 'subwave-longform-tts-test-'));
try {
  const first = join(testDir, 'first.wav');
  const second = join(testDir, 'second.wav');
  const mismatched = join(testDir, 'mismatched.wav');
  const combined = join(testDir, 'combined.wav');
  await writeFile(first, pcm16Wav([10, 11, 12]));
  await writeFile(second, pcm16Wav([20, 21]));
  await writeFile(mismatched, pcm16Wav([30], 16_000));

  const combinedInfo = await concatenatePcmWavFiles([first, second], combined);
  assert.equal(combinedInfo.dataBytes, 10, 'assembler sums the source PCM bytes');
  assert.equal(combinedInfo.durationSec, 5 / 8_000, 'duration comes from frames/sample rate');
  assert.deepEqual(await readPcmWavInfo(combined), combinedInfo, 'written canonical WAV parses cleanly');
  const combinedBytes = await readFile(combined);
  assert.equal(combinedBytes.length, 54, 'canonical output is one 44-byte header plus PCM');
  assert.deepEqual(
    Array.from({ length: 5 }, (_, index) => combinedBytes.readInt16LE(44 + index * 2)),
    [10, 11, 12, 20, 21],
    'PCM samples retain source order',
  );
  await assert.rejects(
    concatenatePcmWavFiles([first, mismatched], join(testDir, 'bad.wav')),
    /incompatible PCM WAV format/,
    'format drift between provider calls is rejected',
  );

  const rendered = join(testDir, 'rendered.wav');
  const touchedChunkPaths: string[] = [];
  const seenTexts: string[] = [];
  let active = 0;
  let peakActive = 0;
  const result = await renderLongformTts(
    'One two three four. Five six seven eight. Nine ten eleven twelve.',
    {
      outPath: rendered,
      tempDir: testDir,
      wordBudget: 4,
      edgeFadeMs: 0,
      synthesize: async (text, request) => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        touchedChunkPaths.push(request.outPath);
        seenTexts.push(text);
        // Yield once so an accidental Promise.all implementation would expose
        // itself through peakActive.
        await Promise.resolve();
        await writeFile(request.outPath, pcm16Wav([100 + request.index]));
        active -= 1;
      },
    },
  );
  assert.equal(peakActive, 1, 'provider calls are strictly sequential');
  assert.equal(result.chunkCount, 3);
  assert.equal(result.durationSec, 3 / 8_000, 'renderer reports assembled WAV duration');
  assert.equal(seenTexts.join(''), 'One two three four. Five six seven eight. Nine ten eleven twelve.');
  const renderedBytes = await readFile(rendered);
  assert.deepEqual(
    [0, 1, 2].map((index) => renderedBytes.readInt16LE(44 + index * 2)),
    [100, 101, 102],
    'rendered chunks are assembled in script order',
  );
  for (const chunkPath of touchedChunkPaths) {
    await assert.rejects(access(chunkPath), 'temporary chunk WAVs are removed after success');
  }

  const abortController = new AbortController();
  const abortedOutput = join(testDir, 'aborted.wav');
  let abortedWorkDir = '';
  await assert.rejects(
    renderLongformTts('One two. Three four.', {
      outPath: abortedOutput,
      tempDir: testDir,
      wordBudget: 2,
      signal: abortController.signal,
      synthesize: async (_text, request) => {
        abortedWorkDir = join(request.outPath, '..');
        await writeFile(request.outPath, pcm16Wav([1]));
        abortController.abort(new DOMException('listener left', 'AbortError'));
      },
    }),
    (error: unknown) => (error as Error)?.name === 'AbortError',
    'listener cancellation stops a chunked render',
  );
  await assert.rejects(access(abortedOutput), 'an aborted render leaves no final WAV');
  await assert.rejects(access(abortedWorkDir), 'an aborted render removes its private work directory');

  let failedWorkDir = '';
  await assert.rejects(
    renderLongformTts('One two. Three four.', {
      outPath: join(testDir, 'never-written.wav'),
      tempDir: testDir,
      wordBudget: 2,
      synthesize: async (_text, request) => {
        failedWorkDir = join(request.outPath, '..');
        throw new Error('synthetic provider failure');
      },
    }),
    /synthetic provider failure/,
  );
  await assert.rejects(access(failedWorkDir), 'temporary directory is removed after failure');
} finally {
  await rm(testDir, { recursive: true, force: true });
}

console.log('longform-tts.test.ts: all assertions passed');
