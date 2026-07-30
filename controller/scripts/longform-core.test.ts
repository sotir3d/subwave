// Deterministic tests for the listener-driven longform coordinator.
// Run: `tsx scripts/longform-core.test.ts` (also auto-discovered by npm test).

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLongformCoordinator,
  type JsonValue,
  type LongformDependencies,
  type LongformPlanResult,
  type LongformProviderAvailability,
} from '../src/broadcast/longform/index.js';

const AVAILABLE: LongformProviderAvailability = {
  llm: true,
  research: true,
  tts: true,
  playout: true,
};

class FakeClock {
  value = 1_800_000_000_000;
  now = () => this.value;
  advance(ms: number) { this.value += ms; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

async function eventually(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function plan(count: number, targetSeconds = 60, researchRequired = true): LongformPlanResult {
  return {
    title: 'Produced episode',
    chapters: Array.from({ length: count }, (_, index) => ({
      id: `chapter-${index + 1}`,
      title: `Chapter ${index + 1}`,
      brief: `Tell semantic chapter ${index + 1}`,
      targetSeconds,
      researchRequired,
    })),
  };
}

function dependencies(overrides: Partial<LongformDependencies> = {}): LongformDependencies {
  const base: LongformDependencies = {
    plan: async () => plan(1),
    research: async () => ({ facts: ['one'] }),
    script: async (chapter) => `Script for ${chapter.title}`,
    tts: async (chapter) => ({ assetRef: `audio/${chapter.id}.wav`, durationSeconds: 60 }),
    playout: {
      arm: async (chapter) => ({ id: `armed-${chapter.id}` }),
      requestMusicFallback: async () => {},
    },
  };
  return {
    ...base,
    ...overrides,
    playout: { ...base.playout, ...(overrides.playout || {}) },
  };
}

async function inTemp(fn: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'subwave-longform-'));
  let bodyError: unknown;
  try {
    await fn(stateDir);
  } catch (error) {
    bodyError = error;
  } finally {
    // Failed assertions can unwind while a deliberately gated dependency's
    // completion reaction is still flushing its final atomic snapshot.
    for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await rm(stateDir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 19 && !bodyError) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
  }
  if (bodyError) throw bodyError;
}

let failures = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}\n      ${error instanceof Error ? error.stack : error}`);
  }
}

async function main() {
  console.log('longform coordinator:');

  await test('stays dormant and performs no work with zero listeners', () => inTemp(async (stateDir) => {
    let planCalls = 0;
    const coordinator = await createLongformCoordinator({
      stateDir,
      clock: new FakeClock(),
      config: { lowWatermarkSeconds: 60, highWatermarkSeconds: 120, retryDelayMs: 0 },
      dependencies: dependencies({ plan: async () => { planCalls++; return plan(2); } }),
    });
    await coordinator.startEpisode({ id: 'dormant', title: 'Dormant', brief: 'Do nothing yet' });
    await coordinator.updateRuntime({ listenerCount: 0, providers: AVAILABLE });
    await coordinator.waitForIdle();
    assert.equal(coordinator.state(), 'DORMANT');
    assert.equal(planCalls, 0);
  }));

  await test('waits for providers, then JIT-produces only the high-watermark horizon', () => inTemp(async (stateDir) => {
    const calls = { plan: 0, research: 0, script: 0, tts: 0, arm: 0 };
    const coordinator = await createLongformCoordinator({
      stateDir,
      clock: new FakeClock(),
      config: { lowWatermarkSeconds: 120, highWatermarkSeconds: 120, retryDelayMs: 0 },
      dependencies: dependencies({
        plan: async () => { calls.plan++; return plan(3); },
        research: async () => { calls.research++; return { current: true }; },
        script: async (chapter) => { calls.script++; return `Script ${chapter.id}`; },
        tts: async (chapter) => {
          calls.tts++;
          return { assetRef: `audio/${chapter.id}.wav`, durationSeconds: 60 };
        },
        playout: {
          arm: async (chapter) => { calls.arm++; return { id: `queue-${chapter.id}` }; },
          requestMusicFallback: async () => {},
        },
      }),
    });
    await coordinator.startEpisode({ id: 'jit', title: 'JIT', brief: 'No advance production window' });
    await coordinator.updateRuntime({
      listenerCount: 1,
      providers: { llm: false, research: false, tts: false, playout: true },
    });
    assert.equal(coordinator.state(), 'WAITING_PROVIDER');
    assert.deepEqual(calls, { plan: 0, research: 0, script: 0, tts: 0, arm: 0 });

    await coordinator.updateRuntime({ listenerCount: 1, providers: AVAILABLE });
    await coordinator.waitForIdle();
    assert.equal(coordinator.state(), 'ARMED');
    assert.equal(coordinator.bufferedSeconds(), 120);
    assert.deepEqual(calls, { plan: 1, research: 2, script: 2, tts: 2, arm: 1 });
    assert.equal(coordinator.snapshot()!.chapters[2]!.state, 'PLANNED', 'chapter outside horizon stays untouched');

    await coordinator.playbackStarted('chapter-1');
    await coordinator.waitForIdle();
    assert.equal(coordinator.state(), 'PLAYING');
    assert.equal(calls.tts, 3, 'playhead advance opens the next production-horizon slot');

    await coordinator.playbackFinished('chapter-1');
    await coordinator.waitForIdle();
    assert.equal(coordinator.state(), 'ARMED');
    assert.equal(coordinator.snapshot()!.chapters[1]!.state, 'ARMED');
  }));

  await test('allows at most one research work item and pauses its follow-up at listener zero', () => inTemp(async (stateDir) => {
    const gate = deferred<JsonValue>();
    let researchCalls = 0;
    let activeResearch = 0;
    let maxActiveResearch = 0;
    let scriptCalls = 0;
    const coordinator = await createLongformCoordinator({
      stateDir,
      clock: new FakeClock(),
      config: { lowWatermarkSeconds: 60, highWatermarkSeconds: 180, retryDelayMs: 0 },
      dependencies: dependencies({
        plan: async () => plan(3),
        research: async () => {
          researchCalls++;
          activeResearch++;
          maxActiveResearch = Math.max(maxActiveResearch, activeResearch);
          if (researchCalls === 1) await gate.promise;
          activeResearch--;
          return { call: researchCalls };
        },
        script: async (chapter) => { scriptCalls++; return `Script ${chapter.id}`; },
      }),
    });
    await coordinator.startEpisode({ id: 'single-flight', title: 'Single flight', brief: 'Bound every stage' });
    await coordinator.updateRuntime({ listenerCount: 1, providers: AVAILABLE });
    await eventually(() => researchCalls === 1, 'first research call');
    await Promise.all(Array.from({ length: 5 }, () => (
      coordinator.updateRuntime({ listenerCount: 1, providers: AVAILABLE })
    )));
    assert.equal(researchCalls, 1, 'ticks do not duplicate an in-flight stage');
    assert.deepEqual(coordinator.activeWorkStages().filter((stage) => stage === 'research'), ['research']);

    await coordinator.updateRuntime({ listenerCount: 0, providers: AVAILABLE });
    gate.resolve({ first: true });
    await eventually(() => coordinator.activeWorkStages().length === 0, 'first work item to settle');
    assert.equal(coordinator.state(), 'PAUSED');
    assert.equal(researchCalls, 1, 'no next research item is scheduled while empty');
    assert.equal(scriptCalls, 0, 'no downstream script is scheduled while empty');
    assert.equal(maxActiveResearch, 1);

    await coordinator.updateRuntime({ listenerCount: 1, providers: AVAILABLE });
    await coordinator.waitForIdle();
    assert.equal(maxActiveResearch, 1);
    assert.equal(researchCalls, 3, 'production resumes from persisted semantic state');
  }));

  await test('requests one music fallback on underrun and resumes after refilling', () => inTemp(async (stateDir) => {
    const secondTts = deferred<{ assetRef: string; durationSeconds: number }>();
    let ttsCalls = 0;
    let fallbackCalls = 0;
    let armCalls = 0;
    const coordinator = await createLongformCoordinator({
      stateDir,
      clock: new FakeClock(),
      config: { lowWatermarkSeconds: 60, highWatermarkSeconds: 120, retryDelayMs: 0 },
      dependencies: dependencies({
        plan: async () => plan(2, 60, false),
        tts: async (chapter) => {
          ttsCalls++;
          if (ttsCalls === 2) return secondTts.promise;
          return { assetRef: `audio/${chapter.id}.wav`, durationSeconds: 60 };
        },
        playout: {
          arm: async (chapter) => { armCalls++; return { id: `arm-${chapter.id}-${armCalls}` }; },
          requestMusicFallback: async () => { fallbackCalls++; },
        },
      }),
    });
    await coordinator.startEpisode({ id: 'underrun', title: 'Underrun', brief: 'Music buys render time' });
    await coordinator.updateRuntime({ listenerCount: 1, providers: AVAILABLE });
    await eventually(() => coordinator.state() === 'ARMED', 'first chapter to arm');
    await coordinator.playbackStarted('chapter-1');
    await coordinator.playbackFinished('chapter-1');
    await eventually(() => fallbackCalls === 1, 'music fallback request');
    assert.equal(coordinator.snapshot()!.playback.waitingForRefill, true);

    await Promise.all(Array.from({ length: 4 }, () => (
      coordinator.updateRuntime({ listenerCount: 1, providers: AVAILABLE })
    )));
    assert.equal(fallbackCalls, 1, 'one gap produces one fallback request');

    secondTts.resolve({ assetRef: 'audio/chapter-2.wav', durationSeconds: 60 });
    await coordinator.waitForIdle();
    assert.equal(coordinator.state(), 'ARMED');
    assert.equal(coordinator.snapshot()!.chapters[1]!.state, 'ARMED');
    assert.equal(armCalls, 2);
  }));

  await test('prefetches continuous talk but holds successors at planned music breaks', () => inTemp(async (stateDir) => {
    const armed: string[] = [];
    const coordinator = await createLongformCoordinator({
      stateDir,
      clock: new FakeClock(),
      config: { lowWatermarkSeconds: 60, highWatermarkSeconds: 240, retryDelayMs: 0 },
      dependencies: dependencies({
        plan: async () => ({
          title: 'Selective breaks',
          chapters: [
            { id: 'chapter-1', title: 'One', brief: 'Open', targetSeconds: 60, researchRequired: false, metadata: { musicAfter: false } },
            { id: 'chapter-2', title: 'Two', brief: 'Continue', targetSeconds: 60, researchRequired: false, metadata: { musicAfter: true } },
            { id: 'chapter-3', title: 'Three', brief: 'Close', targetSeconds: 60, researchRequired: false, metadata: { musicAfter: false } },
          ],
        }),
        playout: {
          arm: async (chapter) => {
            armed.push(chapter.id);
            return { id: `arm-${chapter.id}` };
          },
          requestMusicFallback: async () => {},
        },
      }),
    });
    await coordinator.startEpisode({ id: 'selective-breaks', title: 'Breaks', brief: 'Only where planned' });
    await coordinator.updateRuntime({ listenerCount: 1, providers: AVAILABLE });
    await coordinator.waitForIdle();
    assert.deepEqual(armed, ['chapter-1']);

    await coordinator.playbackStarted('chapter-1');
    await coordinator.waitForIdle();
    assert.deepEqual(armed, ['chapter-1', 'chapter-2'], 'continuous successor is prefetched');
    assert.equal(coordinator.snapshot()!.chapters[1]!.state, 'ARMED');

    await coordinator.playbackFinished('chapter-1');
    await coordinator.playbackStarted('chapter-2');
    await coordinator.waitForIdle();
    assert.deepEqual(armed, ['chapter-1', 'chapter-2'], 'musicAfter prevents prefetch');

    await coordinator.playbackFinished('chapter-2');
    await coordinator.waitForIdle();
    assert.deepEqual(armed, ['chapter-1', 'chapter-2', 'chapter-3'], 'successor arms after music has begun');
  }));

  await test('atomically recovers transient work and reconciles playout before re-arming', () => inTemp(async (stateDir) => {
    const stuckResearch = deferred<JsonValue>();
    let firstResearchCalls = 0;
    const clock = new FakeClock();
    const first = await createLongformCoordinator({
      stateDir,
      clock,
      config: { lowWatermarkSeconds: 60, highWatermarkSeconds: 60, retryDelayMs: 0 },
      dependencies: dependencies({
        plan: async () => plan(1),
        research: async () => { firstResearchCalls++; return stuckResearch.promise; },
      }),
    });
    await first.startEpisode({ id: 'recoverable', title: 'Recoverable', brief: 'Resume after a crash' });
    await first.updateRuntime({ listenerCount: 1, providers: AVAILABLE });
    await eventually(() => firstResearchCalls === 1, 'persisted in-flight research');
    await first.store.flush();

    const active = JSON.parse(await readFile(join(stateDir, 'programmes', 'active.json'), 'utf8'));
    const onDisk = JSON.parse(await readFile(join(stateDir, 'programmes', 'recoverable', 'episode.json'), 'utf8'));
    assert.equal(active.episodeId, 'recoverable');
    assert.equal(onDisk.chapters[0].state, 'RESEARCHING');
    const names = [
      ...await readdir(join(stateDir, 'programmes')),
      ...await readdir(join(stateDir, 'programmes', 'recoverable')),
    ];
    assert.equal(names.some((name) => name.endsWith('.tmp')), false, 'atomic temp files do not remain');

    let armCalls = 0;
    const recovered = await createLongformCoordinator({
      stateDir,
      clock,
      config: { lowWatermarkSeconds: 60, highWatermarkSeconds: 60, retryDelayMs: 0 },
      dependencies: dependencies({
        plan: async () => { throw new Error('persisted plan must be reused'); },
        research: async () => ({ recovered: true }),
        playout: {
          arm: async (chapter) => { armCalls++; return { id: `recovered-${chapter.id}-${armCalls}` }; },
          requestMusicFallback: async () => {},
        },
      }),
    });
    assert.equal(recovered.snapshot()!.chapters[0]!.state, 'PLANNED', 'transient stage rolls back safely');
    assert.equal(recovered.state(), 'PAUSED');
    await recovered.updateRuntime({ listenerCount: 1, providers: AVAILABLE });
    await recovered.waitForIdle();
    assert.equal(recovered.state(), 'ARMED');
    assert.equal(armCalls, 1);

    const afterSecondRestart = await createLongformCoordinator({
      stateDir,
      clock,
      config: { lowWatermarkSeconds: 60, highWatermarkSeconds: 60, retryDelayMs: 0 },
      dependencies: dependencies({
        playout: {
          arm: async (chapter) => { armCalls++; return { id: `again-${chapter.id}-${armCalls}` }; },
          requestMusicFallback: async () => {},
        },
      }),
    });
    assert.equal(afterSecondRestart.state(), 'PAUSED');
    assert.equal(afterSecondRestart.snapshot()!.pauseReason, 'restart');
    await afterSecondRestart.updateRuntime({ listenerCount: 1, providers: AVAILABLE });
    await afterSecondRestart.waitForIdle();
    assert.equal(armCalls, 1, 'recovered ARMED audio is never duplicated before reconciliation');
    await afterSecondRestart.reconcileRecoveredPlayback('chapter-1', 'armed');
    await afterSecondRestart.waitForIdle();
    assert.equal(afterSecondRestart.state(), 'ARMED');
    assert.equal(armCalls, 1, 'a recovered queue receipt can be retained without duplication');

    const missingAfterRestart = await createLongformCoordinator({
      stateDir,
      clock,
      config: { lowWatermarkSeconds: 60, highWatermarkSeconds: 60, retryDelayMs: 0 },
      dependencies: dependencies({
        playout: {
          arm: async (chapter) => { armCalls++; return { id: `missing-${chapter.id}-${armCalls}` }; },
          requestMusicFallback: async () => {},
        },
      }),
    });
    await missingAfterRestart.updateRuntime({ listenerCount: 1, providers: AVAILABLE });
    await missingAfterRestart.reconcileRecoveredPlayback('chapter-1', 'missing');
    await missingAfterRestart.waitForIdle();
    assert.equal(missingAfterRestart.state(), 'ARMED');
    assert.equal(armCalls, 2);
  }));

  await test('reconciles recovered PLAYING and prefetched ARMED chapters as one batch', () => inTemp(async (stateDir) => {
    let armCalls = 0;
    const clock = new FakeClock();
    const beforeRestart = await createLongformCoordinator({
      stateDir,
      clock,
      config: { lowWatermarkSeconds: 60, highWatermarkSeconds: 120, retryDelayMs: 0 },
      dependencies: dependencies({
        plan: async () => plan(2, 60, false),
        playout: {
          arm: async (chapter) => {
            armCalls++;
            return { id: `before-restart-${chapter.id}` };
          },
          requestMusicFallback: async () => {},
        },
      }),
    });
    await beforeRestart.startEpisode({
      id: 'batch-recovery',
      title: 'Batch recovery',
      brief: 'Keep the on-air chapter and its prefetched successor',
    });
    await beforeRestart.updateRuntime({ listenerCount: 1, providers: AVAILABLE });
    await beforeRestart.waitForIdle();
    await beforeRestart.playbackStarted('chapter-1');
    await beforeRestart.waitForIdle();
    assert.equal(beforeRestart.snapshot()!.chapters[0]!.state, 'PLAYING');
    assert.equal(beforeRestart.snapshot()!.chapters[1]!.state, 'ARMED');
    assert.equal(armCalls, 2);
    await beforeRestart.store.flush();

    const recovered = await createLongformCoordinator({
      stateDir,
      clock,
      config: { lowWatermarkSeconds: 60, highWatermarkSeconds: 120, retryDelayMs: 0 },
      dependencies: dependencies({
        playout: {
          arm: async (chapter) => {
            armCalls++;
            return { id: `duplicate-${chapter.id}` };
          },
          requestMusicFallback: async () => {},
        },
      }),
    });
    assert.equal(recovered.snapshot()!.pauseReason, 'restart');
    assert.deepEqual(
      recovered.snapshot()!.chapters.map((chapter) => chapter.state),
      ['PLAYING', 'ARMED'],
      'both ambiguous receipts survive recovery until the mixer is inspected',
    );
    await recovered.updateRuntime({ listenerCount: 1, providers: AVAILABLE });
    await recovered.reconcileRecoveredPlaybackBatch([
      { chapterId: 'chapter-1', status: 'playing' },
      { chapterId: 'chapter-2', status: 'armed' },
    ]);
    await recovered.waitForIdle();
    assert.equal(recovered.state(), 'PLAYING');
    assert.equal(recovered.snapshot()!.playback.currentChapterId, 'chapter-1');
    assert.deepEqual(
      recovered.snapshot()!.chapters.map((chapter) => chapter.state),
      ['PLAYING', 'ARMED'],
    );
    assert.equal(armCalls, 2, 'one batch cannot transiently re-arm either receipt');
  }));

  await test('aborts active generation when the last listener leaves and resumes cleanly', () => inTemp(async (stateDir) => {
    let scriptCalls = 0;
    let observedAbort = false;
    const coordinator = await createLongformCoordinator({
      stateDir,
      clock: new FakeClock(),
      config: { lowWatermarkSeconds: 60, highWatermarkSeconds: 60, retryDelayMs: 0 },
      dependencies: dependencies({
        plan: async () => plan(1, 60, false),
        script: async (chapter, context) => {
          scriptCalls++;
          if (scriptCalls > 1) return `Resumed script for ${chapter.title}`;
          return new Promise<string>((_resolve, reject) => {
            const abort = () => {
              observedAbort = true;
              reject(context.signal.reason);
            };
            if (context.signal.aborted) abort();
            else context.signal.addEventListener('abort', abort, { once: true });
          });
        },
      }),
    });
    await coordinator.startEpisode({
      id: 'listener-abort',
      title: 'Listener abort',
      brief: 'Do not burn local GPU time for an empty station',
    });
    await coordinator.updateRuntime({ listenerCount: 1, providers: AVAILABLE });
    await eventually(() => scriptCalls === 1, 'script generation to begin');
    await coordinator.updateRuntime({ listenerCount: 0, providers: AVAILABLE });
    await coordinator.waitForIdle();

    const paused = coordinator.snapshot()!;
    assert.equal(observedAbort, true, 'the in-flight dependency receives an AbortSignal');
    assert.equal(paused.state, 'PAUSED');
    assert.equal(paused.pauseReason, 'no-listeners');
    assert.equal(paused.chapters[0]!.state, 'RESEARCHED', 'aborted script rolls back to a reusable boundary');
    assert.equal(paused.chapters[0]!.attempts.script, 0, 'cancellation does not consume a retry');
    assert.equal(paused.chapters[0]!.errors.length, 0, 'expected cancellation is not recorded as a failure');

    await coordinator.updateRuntime({ listenerCount: 1, providers: AVAILABLE });
    await coordinator.waitForIdle();
    assert.equal(scriptCalls, 2, 'generation resumes with a fresh signal when listening resumes');
    assert.equal(coordinator.state(), 'ARMED');
  }));

  await test('reaches PLAYING/COMPLETE and fails terminally after bounded plan attempts', () => inTemp(async (stateDir) => {
    const complete = await createLongformCoordinator({
      stateDir,
      clock: new FakeClock(),
      config: { lowWatermarkSeconds: 60, highWatermarkSeconds: 60, retryDelayMs: 0 },
      dependencies: dependencies({ plan: async () => plan(1, 60, false) }),
    });
    await complete.startEpisode({ id: 'complete', title: 'Complete', brief: 'One chapter' });
    await complete.updateRuntime({ listenerCount: 1, providers: AVAILABLE });
    await complete.waitForIdle();
    await complete.playbackStarted('chapter-1');
    assert.equal(complete.state(), 'PLAYING');
    await complete.playbackFinished('chapter-1');
    assert.equal(complete.state(), 'COMPLETE');

    const scheduled = await createLongformCoordinator({
      stateDir: join(stateDir, 'scheduled-station'),
      clock: new FakeClock(),
      config: { lowWatermarkSeconds: 60, highWatermarkSeconds: 60, retryDelayMs: 0 },
      dependencies: dependencies(),
    });
    await scheduled.startEpisode({ id: 'scheduled', title: 'Scheduled', brief: 'Ends at its boundary' });
    await scheduled.endEpisode('show-changed');
    assert.equal(scheduled.state(), 'COMPLETE');
    assert.equal(scheduled.snapshot()!.spec.metadata.endReason, 'show-changed');
    await scheduled.startEpisode({ id: 'next-show', title: 'Next', brief: 'May start immediately' });
    assert.equal(scheduled.snapshot()!.id, 'next-show');

    const failed = await createLongformCoordinator({
      stateDir: join(stateDir, 'failed-station'),
      clock: new FakeClock(),
      config: {
        lowWatermarkSeconds: 60,
        highWatermarkSeconds: 60,
        retryDelayMs: 0,
        maxAttemptsPerStage: 1,
      },
      dependencies: dependencies({ plan: async () => { throw new Error('provider rejected plan'); } }),
    });
    await failed.startEpisode({ id: 'failed', title: 'Failed', brief: 'Bound retries' });
    await failed.updateRuntime({ listenerCount: 1, providers: AVAILABLE });
    await failed.waitForIdle();
    assert.equal(failed.state(), 'FAILED');
    assert.match(failed.snapshot()!.failure || '', /Planning failed/);
  }));

  process.exit(failures ? 1 : 0);
}

void main();
