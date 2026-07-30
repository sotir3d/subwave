import {
  assertSafeEpisodeId,
  LongformEpisodeStore,
} from './store.js';
import type {
  JsonValue,
  LongformAudioArtifact,
  LongformChapter,
  LongformChapterState,
  LongformCoordinatorOptions,
  LongformDependencies,
  LongformEpisodeSpec,
  LongformEpisodeState,
  LongformGenerationStage,
  LongformManifest,
  LongformPlanResult,
  LongformProviderAvailability,
  LongformRuntimeUpdate,
  LongformWorkStage,
  RecoveredPlaybackStatus,
} from './types.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const TERMINAL_CHAPTER_STATES = new Set<LongformChapterState>(['PLAYED', 'FAILED']);
const TERMINAL_EPISODE_STATES = new Set<LongformEpisodeState>(['COMPLETE', 'FAILED']);
const ALL_PROVIDERS_OFF: LongformProviderAvailability = {
  llm: false,
  research: false,
  tts: false,
  playout: false,
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonValue(value: JsonValue): JsonValue {
  if (value === undefined) throw new Error('Research returned undefined');
  return clone(value);
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1_000);
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}

function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be greater than zero`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function normalisePlan(result: LongformPlanResult): LongformPlanResult {
  if (!result || !Array.isArray(result.chapters) || result.chapters.length === 0) {
    throw new Error('Longform plan must contain at least one chapter');
  }
  const ids = new Set<string>();
  const chapters = result.chapters.map((chapter, ordinal) => {
    const id = String(chapter?.id || '').trim();
    if (!id) throw new Error(`Longform chapter ${ordinal + 1} has no id`);
    if (ids.has(id)) throw new Error(`Longform plan contains duplicate chapter id: ${id}`);
    ids.add(id);
    const title = String(chapter?.title || '').trim();
    const brief = String(chapter?.brief || '').trim();
    if (!title || !brief) throw new Error(`Longform chapter ${id} needs a title and brief`);
    return {
      id,
      title,
      brief,
      targetSeconds: positiveNumber(chapter.targetSeconds, `targetSeconds for ${id}`),
      researchRequired: chapter.researchRequired !== false,
      metadata: clone(chapter.metadata || {}),
    };
  });
  return {
    title: result.title ? String(result.title) : undefined,
    summary: result.summary ? String(result.summary) : undefined,
    chapters,
    metadata: clone(result.metadata || {}),
  };
}

function normaliseAudio(result: LongformAudioArtifact): LongformAudioArtifact {
  const assetRef = String(result?.assetRef || '').trim();
  if (!assetRef) throw new Error('TTS returned no assetRef');
  return {
    assetRef,
    durationSeconds: positiveNumber(result.durationSeconds, 'TTS durationSeconds'),
    metadata: clone(result.metadata || {}),
  };
}

function changedState(manifest: LongformManifest, state: LongformEpisodeState, nowIso: string): void {
  if (manifest.state === state) return;
  manifest.state = state;
  manifest.stateChangedAt = nowIso;
}

function hasProgress(manifest: LongformManifest): boolean {
  return manifest.plan.attempts > 0 || manifest.chapters.length > 0 || manifest.playback.hasStarted;
}

function chapterDuration(chapter: LongformChapter): number {
  return chapter.audio?.durationSeconds || chapter.targetSeconds;
}

/**
 * Listener-driven, rolling-buffer producer for one active longform episode.
 * It owns orchestration and persistence only; model/search/TTS/playout policy
 * remains in injected adapters.
 */
export class LongformCoordinator {
  readonly store: LongformEpisodeStore;
  private readonly dependencies: LongformDependencies;
  private readonly clock: { now(): number };
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly lowWatermarkSeconds: number;
  private readonly highWatermarkSeconds: number;
  private manifest: LongformManifest | null = null;
  private readonly inFlight = new Map<LongformWorkStage, Promise<void>>();
  private pumping: Promise<void> | null = null;
  private pumpAgain = false;
  private activityRevision = 0;
  private workAbortController = new AbortController();

  constructor(options: LongformCoordinatorOptions) {
    this.store = new LongformEpisodeStore(options.stateDir);
    this.dependencies = options.dependencies;
    this.clock = options.clock || { now: () => Date.now() };
    this.lowWatermarkSeconds = positiveNumber(options.config.lowWatermarkSeconds, 'lowWatermarkSeconds');
    this.highWatermarkSeconds = positiveNumber(options.config.highWatermarkSeconds, 'highWatermarkSeconds');
    if (this.highWatermarkSeconds < this.lowWatermarkSeconds) {
      throw new Error('highWatermarkSeconds must be greater than or equal to lowWatermarkSeconds');
    }
    this.maxAttempts = Math.max(1, Math.floor(options.config.maxAttemptsPerStage || DEFAULT_MAX_ATTEMPTS));
    this.retryDelayMs = Math.max(0, Math.floor(options.config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
  }

  async recover(): Promise<LongformManifest | null> {
    const manifest = await this.store.loadActive();
    if (!manifest) return null;
    this.manifest = manifest;
    if (TERMINAL_EPISODE_STATES.has(manifest.state)) return this.snapshot();
    this.workAbortController.abort(new DOMException('Long-form recovery is paused', 'AbortError'));

    // Never assume listeners or remote providers survived a controller restart.
    // A fresh listener sample is what wakes production again.
    manifest.runtime = {
      listenerCount: 0,
      providers: { ...ALL_PROVIDERS_OFF },
      observedAt: this.isoNow(),
    };
    manifest.lowWatermarkSeconds = this.lowWatermarkSeconds;
    manifest.highWatermarkSeconds = this.highWatermarkSeconds;
    manifest.recoveredAt = this.isoNow();

    if (manifest.plan.state === 'PLANNING') {
      manifest.plan.state = 'PENDING';
      manifest.plan.retryAt = null;
    }
    let ambiguousPlayback = false;
    for (const chapter of manifest.chapters) {
      if (chapter.state === 'RESEARCHING') chapter.state = 'PLANNED';
      else if (chapter.state === 'SCRIPTING') chapter.state = 'RESEARCHED';
      else if (chapter.state === 'SYNTHESIZING') chapter.state = 'SCRIPTED';
      else if (chapter.state === 'ARMING') {
        chapter.state = 'READY';
        chapter.playout = null;
      } else if (chapter.state === 'ARMED' || chapter.state === 'PLAYING') {
        ambiguousPlayback = true;
        if (chapter.state === 'PLAYING') manifest.playback.currentChapterId = chapter.id;
      }
      chapter.retryAt = null;
    }
    manifest.playback.fallbackRequestPending = false;
    manifest.pauseReason = ambiguousPlayback ? 'restart' : (hasProgress(manifest) ? 'no-listeners' : null);
    changedState(manifest, hasProgress(manifest) ? 'PAUSED' : 'DORMANT', this.isoNow());
    this.touch();
    await this.persist();
    return this.snapshot();
  }

  async startEpisode(spec: LongformEpisodeSpec): Promise<LongformManifest> {
    assertSafeEpisodeId(spec.id);
    if (!String(spec.title || '').trim() || !String(spec.brief || '').trim()) {
      throw new Error('Longform episode needs a title and brief');
    }
    if (this.manifest && !TERMINAL_EPISODE_STATES.has(this.manifest.state)) {
      if (this.manifest.id === spec.id) return this.snapshot()!;
      throw new Error(`Longform episode ${this.manifest.id} is still active`);
    }
    const now = this.isoNow();
    this.workAbortController = new AbortController();
    this.manifest = {
      schemaVersion: 1,
      id: spec.id,
      spec: {
        id: spec.id,
        title: String(spec.title).trim(),
        brief: String(spec.brief).trim(),
        metadata: clone(spec.metadata || {}),
      },
      state: 'DORMANT',
      pauseReason: null,
      createdAt: now,
      updatedAt: now,
      stateChangedAt: now,
      completedAt: null,
      recoveredAt: null,
      lowWatermarkSeconds: this.lowWatermarkSeconds,
      highWatermarkSeconds: this.highWatermarkSeconds,
      runtime: {
        listenerCount: 0,
        providers: { ...ALL_PROVIDERS_OFF },
        observedAt: now,
      },
      plan: {
        state: 'PENDING',
        attempts: 0,
        retryAt: null,
        title: null,
        summary: null,
        metadata: {},
        error: null,
      },
      chapters: [],
      playback: {
        currentChapterId: null,
        hasStarted: false,
        waitingForRefill: false,
        fallbackRequestPending: false,
        underrunCount: 0,
        lastCompletedChapterId: null,
      },
      failure: null,
      errors: [],
    };
    await this.persist();
    return this.snapshot()!;
  }

  /**
   * Close a scheduled block without deleting its durable manifest. A show can
   * end while later chapters are still buffered; that is a normal schedule
   * transition, not a production failure. The next startEpisode call replaces
   * only the active pointer and leaves this completed snapshot inspectable.
   */
  async endEpisode(reason = 'schedule-ended'): Promise<LongformManifest | null> {
    if (!this.manifest) return null;
    this.cancelActiveWork(`Long-form episode ended: ${reason}`);
    if (!TERMINAL_EPISODE_STATES.has(this.manifest.state)) {
      this.manifest.spec.metadata.endReason = String(reason).slice(0, 240);
      this.manifest.completedAt ||= this.isoNow();
      this.manifest.pauseReason = null;
      changedState(this.manifest, 'COMPLETE', this.isoNow());
      this.touch();
      await this.persist();
    }
    return this.snapshot();
  }

  async updateRuntime(update: LongformRuntimeUpdate): Promise<LongformManifest | null> {
    if (!this.manifest) return null;
    const listenerCount = nonNegativeInteger(update.listenerCount, 'listenerCount');
    this.manifest.runtime = {
      listenerCount,
      providers: {
        llm: update.providers.llm === true,
        research: update.providers.research === true,
        tts: update.providers.tts === true,
        playout: update.providers.playout === true,
      },
      observedAt: this.isoNow(),
    };
    if (listenerCount === 0) {
      this.cancelActiveWork('Long-form production paused because no listener is present');
    } else if (this.workAbortController.signal.aborted) {
      this.workAbortController = new AbortController();
    }
    if (listenerCount === 0 && !TERMINAL_EPISODE_STATES.has(this.manifest.state)) {
      if (hasProgress(this.manifest) && this.manifest.pauseReason !== 'restart') {
        this.manifest.pauseReason = 'no-listeners';
      }
    } else if (this.manifest.pauseReason === 'no-listeners') {
      this.manifest.pauseReason = null;
    }
    this.recomputeState();
    this.touch();
    await this.persist();
    await this.requestPump();
    return this.snapshot();
  }

  async playbackStarted(chapterId: string): Promise<LongformManifest> {
    const manifest = this.requireManifest();
    const chapter = this.requireChapter(chapterId);
    if (chapter.state !== 'ARMED' && chapter.state !== 'PLAYING') {
      throw new Error(`Cannot start chapter ${chapterId} from ${chapter.state}`);
    }
    for (const other of manifest.chapters) {
      if (other.id !== chapterId && other.state === 'PLAYING') {
        throw new Error(`Chapter ${other.id} is already playing`);
      }
    }
    chapter.state = 'PLAYING';
    chapter.startedAt ||= this.isoNow();
    manifest.playback.currentChapterId = chapterId;
    manifest.playback.hasStarted = true;
    manifest.pauseReason = null;
    this.recomputeState();
    this.touch();
    await this.persist();
    await this.requestPump();
    return this.snapshot()!;
  }

  async playbackFinished(chapterId: string): Promise<LongformManifest> {
    const manifest = this.requireManifest();
    const chapter = this.requireChapter(chapterId);
    if (chapter.state !== 'PLAYING' && chapter.state !== 'ARMED') {
      if (chapter.state === 'PLAYED') return this.snapshot()!;
      throw new Error(`Cannot finish chapter ${chapterId} from ${chapter.state}`);
    }
    chapter.state = 'PLAYED';
    chapter.completedAt = this.isoNow();
    if (manifest.playback.currentChapterId === chapterId) manifest.playback.currentChapterId = null;
    manifest.playback.hasStarted = true;
    manifest.playback.lastCompletedChapterId = chapterId;
    this.recomputeTerminal();
    this.recomputeState();
    this.touch();
    await this.persist();
    await this.requestPump();
    return this.snapshot()!;
  }

  /**
   * A recovered ARMED/PLAYING item is never guessed at: the integration layer
   * reconciles it against Liquidsoap's durable marker/timeline before the core
   * can enqueue it again.
   */
  async reconcileRecoveredPlaybackBatch(
    reconciliations: { chapterId: string; status: RecoveredPlaybackStatus }[],
  ): Promise<LongformManifest> {
    const manifest = this.requireManifest();
    if (manifest.pauseReason !== 'restart') throw new Error('No recovered playback needs reconciliation');
    const seen = new Set<string>();
    for (const { chapterId, status } of reconciliations) {
      if (seen.has(chapterId)) throw new Error(`Duplicate recovered chapter: ${chapterId}`);
      seen.add(chapterId);
      const chapter = this.requireChapter(chapterId);
      if (chapter.state !== 'ARMED' && chapter.state !== 'PLAYING') {
        throw new Error(`Chapter ${chapterId} is not recovered playback`);
      }
      if (status === 'armed') {
        chapter.state = 'ARMED';
      } else if (status === 'playing') {
        chapter.state = 'PLAYING';
        chapter.startedAt ||= this.isoNow();
        manifest.playback.hasStarted = true;
      } else if (status === 'finished') {
        chapter.state = 'PLAYED';
        chapter.completedAt = this.isoNow();
        manifest.playback.hasStarted = true;
        manifest.playback.lastCompletedChapterId = chapterId;
      } else {
        chapter.state = 'READY';
        chapter.playout = null;
        manifest.playback.waitingForRefill = true;
      }
    }
    manifest.playback.currentChapterId = manifest.chapters.find((chapter) => chapter.state === 'PLAYING')?.id || null;
    manifest.pauseReason = manifest.runtime.listenerCount === 0 ? 'no-listeners' : null;
    this.recomputeTerminal();
    this.recomputeState();
    this.touch();
    await this.persist();
    await this.requestPump();
    return this.snapshot()!;
  }

  async reconcileRecoveredPlayback(
    chapterId: string,
    status: RecoveredPlaybackStatus,
  ): Promise<LongformManifest> {
    return this.reconcileRecoveredPlaybackBatch([{ chapterId, status }]);
  }

  /** Demote a relocatable/missing render to the last reusable production
   * boundary. The script is kept, so moving state between Windows and Docker
   * costs only TTS work rather than another model call. */
  async invalidateAudio(chapterId: string, reason = 'rendered audio is unavailable'): Promise<LongformManifest> {
    const manifest = this.requireManifest();
    const chapter = this.requireChapter(chapterId);
    if (chapter.state === 'PLAYED' || chapter.state === 'PLAYING') return this.snapshot()!;
    chapter.state = chapter.script ? 'SCRIPTED' : 'RESEARCHED';
    chapter.audio = null;
    chapter.playout = null;
    chapter.retryAt = null;
    chapter.errors.push({ stage: 'tts', message: String(reason).slice(0, 1_000), at: this.isoNow() });
    if (manifest.playback.currentChapterId === chapterId) manifest.playback.currentChapterId = null;
    manifest.playback.waitingForRefill = true;
    this.recomputeState();
    this.touch();
    await this.persist();
    await this.requestPump();
    return this.snapshot()!;
  }

  async playbackLost(chapterIds: string[], reason = 'playout receipt was lost'): Promise<LongformManifest> {
    const manifest = this.requireManifest();
    for (const chapterId of new Set(chapterIds)) {
      const chapter = this.requireChapter(chapterId);
      if (chapter.state !== 'ARMED' && chapter.state !== 'PLAYING' && chapter.state !== 'ARMING') continue;
      chapter.state = 'READY';
      chapter.playout = null;
      chapter.retryAt = null;
      chapter.errors.push({ stage: 'playout', message: String(reason).slice(0, 1_000), at: this.isoNow() });
    }
    manifest.playback.currentChapterId = null;
    manifest.playback.waitingForRefill = true;
    if (manifest.pauseReason === 'restart') {
      manifest.pauseReason = manifest.runtime.listenerCount === 0 ? 'no-listeners' : null;
    }
    this.recomputeState();
    this.touch();
    await this.persist();
    await this.requestPump();
    return this.snapshot()!;
  }

  snapshot(): LongformManifest | null {
    return this.manifest ? clone(this.manifest) : null;
  }

  state(): LongformEpisodeState {
    return this.manifest?.state || 'DORMANT';
  }

  cancelActiveWork(reason = 'Long-form production cancelled'): void {
    if (!this.workAbortController.signal.aborted) {
      this.workAbortController.abort(new DOMException(reason, 'AbortError'));
    }
  }

  bufferedSeconds(): number {
    if (!this.manifest) return 0;
    let total = 0;
    for (const chapter of this.remainingChapters()) {
      if (chapter.state === 'PLAYING') continue;
      if (chapter.state !== 'READY' && chapter.state !== 'ARMED') break;
      total += chapterDuration(chapter);
    }
    return total;
  }

  activeWorkStages(): LongformWorkStage[] {
    return [...this.inFlight.keys()];
  }

  /** Wait for the currently possible production wave(s), useful at shutdown/tests. */
  async waitForIdle(): Promise<LongformManifest | null> {
    let stableRevision = -1;
    while (true) {
      if (this.pumping) await this.pumping;
      const jobs = [...this.inFlight.values()];
      if (jobs.length > 0) {
        await Promise.all(jobs);
        stableRevision = -1;
        continue;
      }
      await this.store.flush();
      // A completed work promise removes itself and requests the next pump in
      // a promise reaction. Give that reaction one event-loop turn, then only
      // report idle after the activity revision stays unchanged twice. This is
      // also what makes graceful shutdown safe on Windows, where deleting the
      // state directory while a late atomic rename is queued fails with EPERM.
      if (this.pumping || this.inFlight.size > 0) continue;
      if (stableRevision === this.activityRevision) return this.snapshot();
      stableRevision = this.activityRevision;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private async requestPump(): Promise<void> {
    this.activityRevision++;
    this.pumpAgain = true;
    if (!this.pumping) {
      this.pumping = (async () => {
        while (this.pumpAgain) {
          this.pumpAgain = false;
          await this.pumpOnce();
        }
      })().finally(() => { this.pumping = null; });
    }
    await this.pumping;
  }

  private async pumpOnce(): Promise<void> {
    const manifest = this.manifest;
    if (!manifest || TERMINAL_EPISODE_STATES.has(manifest.state)) return;
    this.recomputeTerminal();
    if (TERMINAL_EPISODE_STATES.has(manifest.state)) {
      await this.persist();
      return;
    }
    if (manifest.runtime.listenerCount === 0 || manifest.pauseReason === 'restart') {
      this.recomputeState();
      await this.persist();
      return;
    }

    if (manifest.plan.state === 'PENDING') this.schedulePlan();
    if (manifest.plan.state === 'READY') {
      const horizon = this.productionHorizonIds();
      this.scheduleResearch(horizon);
      this.scheduleScript(horizon);
      this.scheduleTts(horizon);
      this.schedulePlayout();
    }
    this.recomputeState();
    this.touch();
    await this.persist();
  }

  private schedulePlan(): void {
    const manifest = this.requireManifest();
    if (this.inFlight.has('plan') || !manifest.runtime.providers.llm) return;
    if (manifest.plan.retryAt != null && manifest.plan.retryAt > this.clock.now()) return;
    manifest.plan.state = 'PLANNING';
    manifest.plan.attempts++;
    manifest.plan.retryAt = null;
    this.launch('plan', async () => {
      try {
        const result = normalisePlan(await this.dependencies.plan(clone(manifest.spec), this.context()));
        manifest.plan.state = 'READY';
        manifest.plan.title = result.title || manifest.spec.title;
        manifest.plan.summary = result.summary || null;
        manifest.plan.metadata = clone(result.metadata || {});
        manifest.plan.error = null;
        manifest.chapters = result.chapters.map((chapter, ordinal): LongformChapter => ({
          id: chapter.id,
          ordinal,
          title: chapter.title,
          brief: chapter.brief,
          targetSeconds: chapter.targetSeconds,
          researchRequired: chapter.researchRequired !== false,
          metadata: clone(chapter.metadata || {}),
          state: chapter.researchRequired === false ? 'RESEARCHED' : 'PLANNED',
          attempts: { research: 0, script: 0, tts: 0, playout: 0 },
          retryAt: null,
          research: null,
          script: null,
          audio: null,
          playout: null,
          startedAt: null,
          completedAt: null,
          errors: [],
        }));
      } catch (error) {
        if (isAbortError(error)) {
          manifest.plan.state = 'PENDING';
          manifest.plan.attempts = Math.max(0, manifest.plan.attempts - 1);
          manifest.plan.retryAt = null;
          manifest.plan.error = null;
          return;
        }
        const message = messageOf(error);
        manifest.plan.error = message;
        this.recordEpisodeError('plan', message);
        if (manifest.plan.attempts >= this.maxAttempts) {
          manifest.plan.state = 'FAILED';
          manifest.failure = `Planning failed: ${message}`;
          manifest.completedAt = this.isoNow();
          changedState(manifest, 'FAILED', this.isoNow());
        } else {
          manifest.plan.state = 'PENDING';
          manifest.plan.retryAt = this.clock.now() + this.retryDelayMs;
        }
      }
    });
  }

  private scheduleResearch(horizon: Set<string>): void {
    const manifest = this.requireManifest();
    if (this.inFlight.has('research') || !manifest.runtime.providers.research) return;
    const chapter = manifest.chapters.find((item) => (
      horizon.has(item.id) && item.state === 'PLANNED' && this.retryDue(item)
    ));
    if (!chapter) return;
    chapter.state = 'RESEARCHING';
    chapter.attempts.research++;
    chapter.retryAt = null;
    this.launch('research', async () => {
      try {
        chapter.research = jsonValue(await this.dependencies.research(clone(chapter), this.context()));
        chapter.state = 'RESEARCHED';
      } catch (error) {
        this.failChapterStage(chapter, 'research', error, 'PLANNED');
      }
    });
  }

  private scheduleScript(horizon: Set<string>): void {
    const manifest = this.requireManifest();
    if (this.inFlight.has('script') || !manifest.runtime.providers.llm) return;
    const chapter = manifest.chapters.find((item) => (
      horizon.has(item.id) && item.state === 'RESEARCHED' && this.retryDue(item)
    ));
    if (!chapter) return;
    chapter.state = 'SCRIPTING';
    chapter.attempts.script++;
    chapter.retryAt = null;
    this.launch('script', async () => {
      try {
        const script = String(await this.dependencies.script(clone(chapter), this.context())).trim();
        if (!script) throw new Error('Script generation returned empty text');
        chapter.script = script;
        chapter.state = 'SCRIPTED';
      } catch (error) {
        this.failChapterStage(chapter, 'script', error, 'RESEARCHED');
      }
    });
  }

  private scheduleTts(horizon: Set<string>): void {
    const manifest = this.requireManifest();
    if (this.inFlight.has('tts') || !manifest.runtime.providers.tts) return;
    const chapter = manifest.chapters.find((item) => (
      horizon.has(item.id) && item.state === 'SCRIPTED' && this.retryDue(item)
    ));
    if (!chapter) return;
    chapter.state = 'SYNTHESIZING';
    chapter.attempts.tts++;
    chapter.retryAt = null;
    this.launch('tts', async () => {
      try {
        chapter.audio = normaliseAudio(await this.dependencies.tts(clone(chapter), this.context()));
        chapter.state = 'READY';
      } catch (error) {
        this.failChapterStage(chapter, 'tts', error, 'SCRIPTED');
      }
    });
  }

  private schedulePlayout(): void {
    const manifest = this.requireManifest();
    if (this.inFlight.has('playout') || !manifest.runtime.providers.playout) return;
    // Keep at most one prefetched chapter behind the one currently speaking.
    // This is what lets semantic production units run back-to-back without
    // forcing an auto.m3u song between every ~2 minute TTS artifact. A planned
    // musicAfter boundary deliberately leaves the successor unarmed until the
    // current talk has finished and Liquidsoap has moved onto music.
    if (manifest.chapters.some((chapter) => chapter.state === 'ARMED')) return;
    const playing = manifest.playback.currentChapterId
      ? manifest.chapters.find((chapter) => chapter.id === manifest.playback.currentChapterId) || null
      : null;
    if (playing?.metadata?.musicAfter === true) return;
    const next = this.nextPlaybackChapter();
    if (!next) return;

    if (next.state === 'READY' && this.shouldArmNext()) {
      next.state = 'ARMING';
      next.attempts.playout++;
      next.retryAt = null;
      this.launch('playout', async () => {
        try {
          const receipt = await this.dependencies.playout.arm(clone(next), this.context());
          const id = String(receipt?.id || '').trim();
          if (!id) throw new Error('Playout returned no receipt id');
          next.playout = { id, metadata: clone(receipt.metadata || {}) };
          next.state = 'ARMED';
          manifest.playback.waitingForRefill = false;
        } catch (error) {
          this.failChapterStage(next, 'playout', error, 'READY');
        }
      });
      return;
    }

    // Cold start already has the normal music playlist beneath it. A fallback
    // is only an explicit action after spoken playout has begun and then runs
    // out of ready chapters.
    if (manifest.playback.hasStarted
        && !playing
        && !manifest.playback.waitingForRefill
        && next.state !== 'READY') {
      manifest.playback.waitingForRefill = true;
      manifest.playback.fallbackRequestPending = true;
      this.launch('playout', async () => {
        try {
          await this.dependencies.playout.requestMusicFallback({
            episodeId: manifest.id,
            afterChapterId: manifest.playback.lastCompletedChapterId,
            reason: 'underrun',
          }, this.context());
          manifest.playback.underrunCount++;
        } catch (error) {
          this.recordEpisodeError('playout', `Music fallback: ${messageOf(error)}`);
        } finally {
          manifest.playback.fallbackRequestPending = false;
        }
      });
    }
  }

  private shouldArmNext(): boolean {
    const manifest = this.requireManifest();
    if (manifest.playback.hasStarted && !manifest.playback.waitingForRefill) return true;
    return this.bufferedSeconds() >= this.lowWatermarkSeconds || this.allRemainingAudioReady();
  }

  private allRemainingAudioReady(): boolean {
    const remaining = this.remainingChapters();
    return remaining.length > 0 && remaining.every((chapter) => (
      chapter.state === 'READY'
      || chapter.state === 'ARMED'
      || chapter.state === 'PLAYING'
    ));
  }

  private productionHorizonIds(): Set<string> {
    const ids = new Set<string>();
    let seconds = 0;
    for (const chapter of this.remainingChapters()) {
      if (chapter.state === 'PLAYING') continue;
      if (seconds >= this.highWatermarkSeconds) break;
      ids.add(chapter.id);
      seconds += chapterDuration(chapter);
    }
    return ids;
  }

  private remainingChapters(): LongformChapter[] {
    const manifest = this.requireManifest();
    return manifest.chapters.filter((chapter) => !TERMINAL_CHAPTER_STATES.has(chapter.state));
  }

  private nextPlaybackChapter(): LongformChapter | null {
    return this.remainingChapters().find((chapter) => chapter.state !== 'PLAYING') || null;
  }

  private failChapterStage(
    chapter: LongformChapter,
    stage: 'research' | 'script' | 'tts' | 'playout',
    error: unknown,
    retryState: LongformChapterState,
  ): void {
    const manifest = this.requireManifest();
    if (isAbortError(error)) {
      chapter.state = retryState;
      chapter.attempts[stage] = Math.max(0, chapter.attempts[stage] - 1);
      chapter.retryAt = null;
      return;
    }
    const message = messageOf(error);
    chapter.errors.push({ stage, message, at: this.isoNow() });
    const attempts = stage === 'playout' ? chapter.attempts.playout : chapter.attempts[stage];
    if (attempts >= this.maxAttempts) {
      chapter.state = 'FAILED';
      chapter.retryAt = null;
    } else {
      chapter.state = retryState;
      chapter.retryAt = this.clock.now() + this.retryDelayMs;
    }
    this.recomputeTerminal();
    if (manifest.state === 'FAILED') manifest.failure ||= `No playable chapters: ${message}`;
  }

  private retryDue(chapter: LongformChapter): boolean {
    return chapter.retryAt == null || chapter.retryAt <= this.clock.now();
  }

  private launch(stage: LongformWorkStage, work: () => Promise<void>): void {
    if (this.inFlight.has(stage)) throw new Error(`Longform ${stage} work is already running`);
    this.activityRevision++;
    const promise = (async () => {
      // Persist the transient state before crossing the side-effect boundary;
      // recovery can then roll it back deterministically after a crash.
      await this.persist();
      try {
        await work();
      } catch (error) {
        const manifest = this.manifest;
        if (manifest && !TERMINAL_EPISODE_STATES.has(manifest.state)) {
          const message = `Internal ${stage} failure: ${messageOf(error)}`;
          this.recordEpisodeError(stage === 'playout' ? 'playout' : stage, message);
          manifest.failure = message;
          manifest.completedAt = this.isoNow();
          changedState(manifest, 'FAILED', this.isoNow());
        }
      } finally {
        this.touch();
        await this.persist();
      }
    })();
    this.inFlight.set(stage, promise);
    const settled = () => {
      this.inFlight.delete(stage);
      void this.requestPump();
    };
    // Attach both branches directly; `promise.finally(...)` would create a
    // second rejected promise on a persistence error and surface it as an
    // unhandled rejection before waitForIdle can report the original failure.
    void promise.then(settled, settled);
  }

  private providerBlocked(): boolean {
    const manifest = this.requireManifest();
    const providers = manifest.runtime.providers;
    if (manifest.plan.state === 'PENDING') return !providers.llm;
    if (manifest.plan.state !== 'READY') return false;
    const horizon = this.productionHorizonIds();
    const research = manifest.chapters.some((c) => horizon.has(c.id) && c.state === 'PLANNED' && this.retryDue(c));
    const script = manifest.chapters.some((c) => horizon.has(c.id) && c.state === 'RESEARCHED' && this.retryDue(c));
    const tts = manifest.chapters.some((c) => horizon.has(c.id) && c.state === 'SCRIPTED' && this.retryDue(c));
    const next = this.nextPlaybackChapter();
    const playout = Boolean(next && (
      (next.state === 'READY' && this.shouldArmNext())
      || (manifest.playback.hasStarted && !manifest.playback.waitingForRefill && next.state !== 'READY')
    ));
    return (research && !providers.research)
      || (script && !providers.llm)
      || (tts && !providers.tts)
      || (playout && !providers.playout);
  }

  private recomputeTerminal(): void {
    const manifest = this.requireManifest();
    if (manifest.plan.state === 'FAILED') {
      changedState(manifest, 'FAILED', this.isoNow());
      manifest.completedAt ||= this.isoNow();
      return;
    }
    if (manifest.plan.state !== 'READY' || manifest.chapters.length === 0) return;
    if (!manifest.chapters.every((chapter) => TERMINAL_CHAPTER_STATES.has(chapter.state))) return;
    manifest.completedAt ||= this.isoNow();
    if (manifest.chapters.some((chapter) => chapter.state === 'PLAYED')) {
      changedState(manifest, 'COMPLETE', this.isoNow());
    } else {
      manifest.failure ||= 'Every longform chapter failed';
      changedState(manifest, 'FAILED', this.isoNow());
    }
  }

  private recomputeState(): void {
    const manifest = this.requireManifest();
    this.recomputeTerminal();
    if (TERMINAL_EPISODE_STATES.has(manifest.state)) return;
    const now = this.isoNow();
    if (manifest.runtime.listenerCount === 0) {
      changedState(manifest, hasProgress(manifest) ? 'PAUSED' : 'DORMANT', now);
      return;
    }
    if (manifest.pauseReason === 'restart') {
      changedState(manifest, 'PAUSED', now);
      return;
    }
    if (manifest.chapters.some((chapter) => chapter.state === 'PLAYING')) {
      changedState(manifest, 'PLAYING', now);
      return;
    }
    if (manifest.chapters.some((chapter) => chapter.state === 'ARMED')) {
      changedState(manifest, 'ARMED', now);
      return;
    }
    if (this.inFlight.size === 0 && this.providerBlocked()) {
      changedState(manifest, 'WAITING_PROVIDER', now);
      return;
    }
    changedState(manifest, 'BUFFERING', now);
  }

  private recordEpisodeError(stage: LongformGenerationStage | 'playout', message: string): void {
    this.requireManifest().errors.push({ stage, message, at: this.isoNow() });
  }

  private context() {
    return {
      manifest: this.snapshot()!,
      now: this.clock.now(),
      signal: this.workAbortController.signal,
    };
  }

  private requireManifest(): LongformManifest {
    if (!this.manifest) throw new Error('No active longform episode');
    return this.manifest;
  }

  private requireChapter(id: string): LongformChapter {
    const chapter = this.requireManifest().chapters.find((item) => item.id === id);
    if (!chapter) throw new Error(`Unknown longform chapter: ${id}`);
    return chapter;
  }

  private isoNow(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private touch(): void {
    if (this.manifest) this.manifest.updatedAt = this.isoNow();
  }

  private async persist(): Promise<void> {
    if (this.manifest) await this.store.save(this.manifest);
  }
}

export async function createLongformCoordinator(
  options: LongformCoordinatorOptions,
): Promise<LongformCoordinator> {
  const coordinator = new LongformCoordinator(options);
  await coordinator.recover();
  return coordinator;
}
