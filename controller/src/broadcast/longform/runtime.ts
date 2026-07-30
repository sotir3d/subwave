// Runtime integration for listener-triggered long-form programmes.
//
// The durable coordinator owns state and backpressure. This module adapts its
// provider-neutral seams to Subwave's schedule/session, LLM, web search, TTS,
// queue and Liquidsoap acknowledgement primitives.

import { existsSync } from 'node:fs';
import { config } from '../../config.js';
import * as settings from '../../settings.js';
import { coerceSpokenProgramme, type NormalizedShow, type SpokenProgrammeConfig } from '../../settings/vocab.js';
import { djObject, djText, getLlmAdmissionStatus, LLM_ADMISSION_PRIORITY } from '../../llm/sdk.js';
import { fallbackLeg, primaryLeg, probeLegReachable } from '../../llm/provider.js';
import { searchReady, searchWeb } from '../../skills/web-search.js';
import { renderLongformTts } from '../../audio/longform-tts.js';
import {
  capabilities as remoteTtsCapabilities,
  refresh as refreshRemoteTts,
  renderQueueStatus,
} from '../../audio/remoteTts.js';
import { ttsRouteReadiness, voiceGainDb } from '../../audio/tts.js';
import { logEvent } from '../../observability/events.js';
import { getListenerCount, onListenerCountChange } from '../listeners.js';
import { optionalSegmentsAllowed } from '../dj-budget.js';
import { queue } from '../queue.js';
import * as session from '../session.js';
import {
  setExclusiveTimelineVoiceOwner,
  voiceEnabled,
} from '../voice-policy.js';
import {
  createLongformCoordinator,
  type JsonObject,
  type JsonValue,
  type LongformCoordinator,
  type LongformDependencies,
  type LongformManifest,
  type LongformPlayoutReceipt,
  type LongformProviderAvailability,
} from './index.js';
import {
  buildLongformPlanPrompt,
  buildLongformScriptPrompt,
  longformChapterLayout,
  materializeLongformPlan,
  researchQueriesOf,
  type LongformPromptContext,
} from './prompts.js';
import { longformAudioAssetRef, resolveLongformAsset } from './assets.js';

const LOW_WATERMARK_SECONDS = 90;
const HIGH_WATERMARK_SECONDS = 240;
const RUNTIME_REFRESH_MS = 5_000;
const MARKER_POLL_MS = 1_500;
const LLM_PROBE_TIMEOUT_MS = 1_500;
const TERMINAL_EPISODE_STATES = new Set(['COMPLETE', 'FAILED']);

function isTerminal(manifest: LongformManifest | null): boolean {
  return !!manifest && TERMINAL_EPISODE_STATES.has(manifest.state);
}

function liveListenerCount(): number {
  const listeners = getListenerCount();
  return typeof listeners === 'number' && listeners > 0 ? listeners : 0;
}

interface DesiredEpisode {
  id: string;
  show: NormalizedShow;
  spoken: SpokenProgrammeConfig;
  sessionId: string;
  personaId: string | null;
}

interface RuntimeView {
  running: boolean;
  desiredEpisodeId: string | null;
  manifest: LongformManifest | null;
  providers: LongformProviderAvailability;
  llmAdmission: ReturnType<typeof getLlmAdmissionStatus>;
  ttsQueue: ReturnType<typeof renderQueueStatus>;
  ttsRoute: ReturnType<typeof ttsRouteReadiness>;
  remoteTts: ReturnType<typeof remoteTtsCapabilities>;
  lastError: string | null;
}

function asJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function textMeta(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return '';
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' ? found : '';
}

function spokenFrom(manifest: LongformManifest): SpokenProgrammeConfig {
  const metadata = manifest.spec.metadata as Record<string, unknown>;
  return coerceSpokenProgramme(metadata.spoken);
}

function personaFor(manifest: LongformManifest): any {
  const id = textMeta(manifest.spec.metadata, 'personaId');
  return (id && settings.resolvePersonaById(id)) || session.onAirPersona();
}

function promptContext(manifest: LongformManifest): LongformPromptContext {
  const persona = personaFor(manifest);
  const stored = settings.get();
  return {
    showName: textMeta(manifest.spec.metadata, 'showName') || manifest.spec.title,
    showTopic: textMeta(manifest.spec.metadata, 'showTopic'),
    hostName: persona?.name || textMeta(manifest.spec.metadata, 'hostName') || 'the DJ',
    stationName: stored.station || 'SUB/WAVE',
    language: String(persona?.language || 'English'),
    nowIso: new Date().toISOString(),
    location: settings.resolveOnAirLocation(stored),
  };
}

function talkId(episodeId: string, chapterId: string): string {
  return `${episodeId}:${chapterId}`;
}

function chapterIdFromTalk(manifest: LongformManifest, id: string): string | null {
  const prefix = `${manifest.id}:`;
  if (!id.startsWith(prefix)) return null;
  const chapterId = id.slice(prefix.length);
  return manifest.chapters.some((chapter) => chapter.id === chapterId) ? chapterId : null;
}

function desiredEpisode(): DesiredEpisode | null {
  const currentSession = session.getSession();
  if (!currentSession || currentSession.kind !== 'show') return null;
  const showId = currentSession.show?.id;
  if (!showId) return null;
  const show = (settings.get().shows || []).find((candidate) => candidate.id === showId);
  if (!show?.spoken?.enabled) return null;
  const spoken = coerceSpokenProgramme(show.spoken);
  const id = `${currentSession.id}-${show.id}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);
  return {
    id,
    show,
    spoken,
    sessionId: currentSession.id,
    personaId: currentSession.persona?.id || show.personaId || null,
  };
}

function researchJson(query: string, response: Awaited<ReturnType<typeof searchWeb>>): JsonValue {
  return {
    query,
    answer: response.answer || '',
    results: response.results.slice(0, 6).map((result) => ({
      title: result.title,
      content: result.content.slice(0, 1_200),
      url: result.url || null,
      publishedAt: result.publishedAt || null,
    })),
  };
}

function remoteWordBudget(manifest: LongformManifest): number | undefined {
  const route = ttsRouteReadiness('longform', personaFor(manifest));
  if (route.requested !== 'remote') return undefined;
  const maxSeconds = Number(remoteTtsCapabilities()?.maxSeconds);
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) return undefined;
  // Leave acoustic headroom below the provider's advertised ceiling. EchoTTS
  // typically reports ~30s; FireRedTTS2 can advertise a much longer context.
  return Math.max(20, Math.min(400, Math.floor(maxSeconds * 2.2 * 0.85)));
}

function dependencies(): LongformDependencies {
  return {
    async plan(_spec, { manifest, signal }) {
      const spoken = spokenFrom(manifest);
      const layout = longformChapterLayout(spoken);
      const request = buildLongformPlanPrompt(spoken, promptContext(manifest), layout);
      const value = await djObject({
        system: request.system,
        prompt: request.prompt,
        schema: request.schema,
        temperature: 0.5,
        maxOutputTokens: Math.max(4_000, Math.min(12_000, layout.chapterCount * 180)),
        kind: 'longform.plan',
        priority: LLM_ADMISSION_PRIORITY.longform,
        signal,
      });
      return materializeLongformPlan(value, spoken, layout);
    },

    async research(chapter) {
      const queries = researchQueriesOf(chapter);
      if (!queries.length) return { queriedAt: new Date().toISOString(), queries: [] };
      const responses = await Promise.all(queries.map(async (query) => (
        researchJson(query, await searchWeb(query, { recency: 'week' }))
      )));
      return { queriedAt: new Date().toISOString(), queries: responses };
    },

    async script(chapter, { manifest, signal }) {
      const context = promptContext(manifest);
      const persona = personaFor(manifest);
      const request = buildLongformScriptPrompt({
        chapter,
        manifest,
        context,
        personaSystem: settings.renderDjPrompt(persona, {
          station: context.stationName,
          location: context.location,
        }),
      });
      return djText({
        system: request.system,
        prompt: request.prompt,
        temperature: 0.75,
        topP: 0.92,
        maxOutputTokens: Math.max(800, Math.ceil(request.targetWords * 1.8)),
        kind: 'longform.script',
        priority: LLM_ADMISSION_PRIORITY.longform,
        signal,
      });
    },

    async tts(chapter, { manifest, signal }) {
      if (!chapter.script) throw new Error(`Chapter ${chapter.id} has no script`);
      const attempt = Math.max(1, chapter.attempts.tts);
      const assetRef = longformAudioAssetRef(chapter.id, attempt);
      const outPath = resolveLongformAsset(config.stateDir, manifest.id, assetRef);
      const result = await renderLongformTts(chapter.script, {
        outPath,
        wordBudget: remoteWordBudget(manifest),
        persona: personaFor(manifest),
        allowFallback: false,
        signal,
      });
      const route = ttsRouteReadiness('longform', personaFor(manifest));
      return {
        assetRef,
        durationSeconds: result.durationSec,
        metadata: {
          chunks: result.chunkCount,
          words: result.wordCount,
          engine: route.requested,
        },
      };
    },

    playout: {
      async arm(chapter, { manifest, signal }): Promise<LongformPlayoutReceipt> {
        if (!chapter.audio?.assetRef) throw new Error(`Chapter ${chapter.id} has no rendered audio`);
        const id = talkId(manifest.id, chapter.id);
        const persona = personaFor(manifest);
        const wavPath = resolveLongformAsset(config.stateDir, manifest.id, chapter.audio.assetRef);
        const mixerEpoch = await queue.readTalkMixerEpochFromDisk();
        const result = await queue.enqueueTalk({
          id,
          wavPath,
          title: chapter.title,
          speaker: persona?.name || 'DJ',
          durationSec: chapter.audio.durationSeconds,
          gainDb: voiceGainDb('longform', persona),
          signal,
        });
        if (!result.ok) {
          // Idempotent recovery: if the exact chapter is already pending, its
          // durable queue item is the receipt rather than a playout failure.
          if (result.reason === 'busy' && result.activeId === id) {
            return { id, metadata: { mixerEpoch: mixerEpoch || '' } };
          }
          throw new Error(`Talk playout is ${result.reason}${result.activeId ? ` (${result.activeId})` : ''}`);
        }
        return {
          id: result.id,
          metadata: { queueDepth: result.queueDepth, mixerEpoch: mixerEpoch || '' },
        };
      },

      async requestMusicFallback(input) {
        // auto.m3u is the permanent fallback beneath request.queue; deliberately
        // leaving the next talk unarmed is enough to let one or more songs play.
        queue.log('longform', `Spoken buffer underrun after ${input.afterChapterId || 'cold start'} — continuing with music`);
      },
    },
  };
}

class LongformRuntime {
  private coordinator: LongformCoordinator | null = null;
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private tickTail: Promise<void> = Promise.resolve();
  private lastRuntimeRefresh = 0;
  private lastMarkerKey = '';
  private lastMixerEpoch: string | null = null;
  private desiredId: string | null = null;
  private providers: LongformProviderAvailability = {
    llm: false,
    research: false,
    tts: false,
    playout: true,
  };
  private lastError: string | null = null;

  async start(): Promise<void> {
    if (this.coordinator) return;
    this.coordinator = await createLongformCoordinator({
      stateDir: config.stateDir,
      config: {
        lowWatermarkSeconds: LOW_WATERMARK_SECONDS,
        highWatermarkSeconds: HIGH_WATERMARK_SECONDS,
        maxAttemptsPerStage: 3,
        retryDelayMs: 15_000,
      },
      dependencies: dependencies(),
    });
    this.unsubscribe = onListenerCountChange(() => this.kick(true));
    this.timer = setInterval(() => this.kick(false), MARKER_POLL_MS);
    this.timer.unref();
    await this.refresh();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    setExclusiveTimelineVoiceOwner(null);
    this.coordinator?.cancelActiveWork('Long-form runtime stopped');
  }

  kick(forceRuntime: boolean): void {
    this.tickTail = this.tickTail
      .then(() => this.tick(forceRuntime))
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        console.error('[longform] runtime tick failed:', this.lastError);
      });
  }

  async refresh(): Promise<void> {
    const run = this.tickTail.then(() => this.tick(true));
    this.tickTail = run.catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error('[longform] runtime refresh failed:', this.lastError);
    });
    await run;
  }

  view(): RuntimeView {
    const manifest = this.coordinator?.snapshot() || null;
    return {
      running: this.coordinator != null,
      desiredEpisodeId: this.desiredId,
      manifest,
      providers: { ...this.providers },
      llmAdmission: getLlmAdmissionStatus(),
      ttsQueue: renderQueueStatus(),
      ttsRoute: ttsRouteReadiness('longform', manifest ? personaFor(manifest) : session.onAirPersona()),
      remoteTts: remoteTtsCapabilities(),
      lastError: this.lastError,
    };
  }

  async endCurrent(reason = 'operator-stopped'): Promise<LongformManifest | null> {
    const run = this.tickTail.then(async () => {
      if (!this.coordinator) {
        setExclusiveTimelineVoiceOwner(null);
        return null;
      }
      const manifest = this.coordinator.snapshot();
      if (!manifest) {
        setExclusiveTimelineVoiceOwner(null);
        return null;
      }
      // Keep overlays locked out until the current timeline item has actually
      // been removed/skipped. Clearing the owner before an aborted render
      // settles can let an hourly or ident land over the final seconds.
      setExclusiveTimelineVoiceOwner(manifest.id);
      try {
        this.coordinator.cancelActiveWork(`Long-form episode stopped: ${reason}`);
        await this.coordinator.updateRuntime({
          listenerCount: 0,
          providers: { llm: false, research: false, tts: false, playout: false },
        });
        await this.coordinator.waitForIdle();
        await queue.cancelTalksForEpisode(manifest.id, { skipPlaying: true });
        return await this.coordinator.endEpisode(reason);
      } finally {
        setExclusiveTimelineVoiceOwner(null);
      }
    });
    this.tickTail = run.then(() => undefined).catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error('[longform] runtime stop failed:', this.lastError);
    });
    return run;
  }

  private async tick(forceRuntime: boolean): Promise<void> {
    if (!this.coordinator) return;
    const desired = desiredEpisode();
    this.desiredId = desired?.id || null;
    let manifest = this.coordinator.snapshot();

    if (!desired) {
      if (manifest && !isTerminal(manifest)) {
        setExclusiveTimelineVoiceOwner(manifest.id);
        const closed = await this.closeScheduledEpisode(manifest, 'scheduled-show-ended');
        if (closed) setExclusiveTimelineVoiceOwner(null);
      } else {
        setExclusiveTimelineVoiceOwner(null);
      }
      return;
    }

    if (!manifest || manifest.id !== desired.id) {
      if (manifest && !isTerminal(manifest)) {
        setExclusiveTimelineVoiceOwner(manifest.id);
        if (!(await this.closeScheduledEpisode(manifest, 'scheduled-show-changed'))) return;
        setExclusiveTimelineVoiceOwner(null);
      }
      const persona = desired.personaId ? settings.resolvePersonaById(desired.personaId) : null;
      await this.coordinator.startEpisode({
        id: desired.id,
        title: desired.show.name,
        brief: desired.spoken.prompt || desired.show.topic || `A ${desired.spoken.format} spoken programme`,
        metadata: asJsonObject({
          showId: desired.show.id,
          showName: desired.show.name,
          showTopic: desired.show.topic,
          sessionId: desired.sessionId,
          personaId: desired.personaId || '',
          hostName: persona?.name || '',
          spoken: desired.spoken,
        }),
      });
      manifest = this.coordinator.snapshot();
      this.lastMarkerKey = '';
      logEvent('longform.start', {
        episodeId: desired.id,
        showId: desired.show.id,
        targetMinutes: desired.spoken.targetMinutes,
      });
    }

    manifest = this.coordinator.snapshot();
    if (!manifest || isTerminal(manifest)) {
      setExclusiveTimelineVoiceOwner(null);
      return;
    }
    setExclusiveTimelineVoiceOwner(desired.id);
    queue.dropPendingVoice('a long-form timeline programme owns this scheduled block');

    await this.handleMixerEpoch();
    await this.reconcileRecovery();
    await this.repairMissingAssets();
    await this.processPlaybackMarker();

    const now = Date.now();
    if (forceRuntime || now - this.lastRuntimeRefresh >= RUNTIME_REFRESH_MS) {
      this.lastRuntimeRefresh = now;
      const listenerBeforeProbe = liveListenerCount();
      const allowedBeforeProbe = voiceEnabled() && optionalSegmentsAllowed();
      const probed = listenerBeforeProbe > 0 && allowedBeforeProbe
        ? await this.probeProviders(desired.spoken)
        : null;
      // Health probes can take several seconds while a Windows service is
      // starting. Re-sample demand and policy before waking the producer so a
      // listener who disconnected during that probe cannot launch fresh work.
      const listenerCount = liveListenerCount();
      const productionAllowed = voiceEnabled() && optionalSegmentsAllowed();
      if (!productionAllowed) this.coordinator.cancelActiveWork('Long-form production is disabled by voice or token-budget policy');
      this.providers = listenerCount > 0 && productionAllowed && probed
        ? probed
        : { llm: false, research: false, tts: false, playout: productionAllowed };
      await this.coordinator.updateRuntime({ listenerCount, providers: this.providers });
      await this.processPlaybackMarker();
    }

    if (isTerminal(this.coordinator.snapshot())) setExclusiveTimelineVoiceOwner(null);
  }

  private async closeScheduledEpisode(manifest: LongformManifest, reason: string): Promise<boolean> {
    if (!this.coordinator) return true;
    this.coordinator.cancelActiveWork(`Long-form schedule changed: ${reason}`);
    await this.coordinator.updateRuntime({
      listenerCount: 0,
      providers: { llm: false, research: false, tts: false, playout: false },
    });
    if (this.coordinator.activeWorkStages().length) return false;
    await this.coordinator.waitForIdle();
    await queue.cancelTalksForEpisode(manifest.id, { skipPlaying: true });
    await this.coordinator.endEpisode(reason);
    return true;
  }

  private async probeProviders(spoken: SpokenProgrammeConfig): Promise<LongformProviderAvailability> {
    let llm = false;
    try {
      const primary = primaryLeg();
      llm = await probeLegReachable(primary, LLM_PROBE_TIMEOUT_MS);
      if (!llm) {
        const fallback = fallbackLeg();
        if (fallback) llm = await probeLegReachable(fallback, LLM_PROBE_TIMEOUT_MS);
      }
    } catch {
      llm = false;
    }
    const manifest = this.coordinator?.snapshot();
    let ttsRoute = ttsRouteReadiness('longform', manifest ? personaFor(manifest) : session.onAirPersona());
    if (ttsRoute.requested === 'remote' && !ttsRoute.ready) {
      // While somebody is waiting, probe the just-started Windows service now
      // instead of inheriting the ordinary 30-second background cache delay.
      await refreshRemoteTts().catch(() => undefined);
      ttsRoute = ttsRouteReadiness('longform', manifest ? personaFor(manifest) : session.onAirPersona());
    }
    return {
      llm,
      research: !spoken.useWeb || searchReady(),
      tts: ttsRoute.ready,
      playout: true,
    };
  }

  private async handleMixerEpoch(): Promise<void> {
    if (!this.coordinator) return;
    const epoch = await queue.readTalkMixerEpochFromDisk();
    if (!epoch) return;
    const manifest = this.coordinator.snapshot();
    if (!manifest) {
      this.lastMixerEpoch = epoch;
      return;
    }
    // ARMING is still an in-process side effect, not a durable mixer receipt.
    // If the epoch changes during that narrow window, the returned receipt
    // carries the old epoch and is safely caught on the following tick.
    const ambiguous = manifest.chapters.filter((chapter) => (
      chapter.state === 'PLAYING' || chapter.state === 'ARMED'
    ));
    const marker = queue.getTalkPlayback() || await queue.readTalkPlaybackFromDisk();
    const liveMarker = marker && (!marker.mixerEpoch || marker.mixerEpoch === epoch) ? marker : null;
    const liveChapterId = liveMarker ? chapterIdFromTalk(manifest, liveMarker.id) : null;
    const epochChanged = this.lastMixerEpoch != null && this.lastMixerEpoch !== epoch;
    const receiptMismatch = ambiguous.some((chapter) => {
      const receiptEpoch = textMeta(chapter.playout?.metadata, 'mixerEpoch');
      return receiptEpoch ? receiptEpoch !== epoch : manifest.pauseReason === 'restart' && !liveMarker;
    });
    this.lastMixerEpoch = epoch;
    if (!ambiguous.length || (!epochChanged && !receiptMismatch)) return;

    queue.invalidateTalkQueueForMixerRestart();
    this.lastMarkerKey = '';
    const lostChapterIds = ambiguous
      .filter((chapter) => chapter.id !== liveChapterId)
      .map((chapter) => chapter.id);
    if (lostChapterIds.length) {
      await this.coordinator.playbackLost(
        lostChapterIds,
        `Liquidsoap mixer epoch changed to ${epoch}; re-arming durable audio`,
      );
    }
  }

  private async repairMissingAssets(): Promise<void> {
    if (!this.coordinator) return;
    const manifest = this.coordinator.snapshot();
    if (!manifest) return;
    for (const chapter of manifest.chapters) {
      if (!chapter.audio?.assetRef || chapter.state === 'PLAYED' || chapter.state === 'PLAYING') continue;
      let path = '';
      try {
        path = resolveLongformAsset(config.stateDir, manifest.id, chapter.audio.assetRef);
      } catch {
        // Unsafe/corrupt references are handled exactly like a missing file:
        // preserve the script and synthesize a fresh station-local asset.
      }
      if (path && existsSync(path)) continue;
      await this.coordinator.invalidateAudio(
        chapter.id,
        `Rendered audio is unavailable after state relocation: ${chapter.audio.assetRef}`,
      );
    }
  }

  private async reconcileRecovery(): Promise<void> {
    if (!this.coordinator) return;
    const manifest = this.coordinator.snapshot();
    if (!manifest || manifest.pauseReason !== 'restart') return;
    const ambiguous = manifest.chapters.filter((chapter) => chapter.state === 'PLAYING' || chapter.state === 'ARMED');
    if (!ambiguous.length) return;

    const epoch = await queue.readTalkMixerEpochFromDisk();
    const rawMarker = queue.getTalkPlayback() || await queue.readTalkPlaybackFromDisk();
    const marker = rawMarker && (!epoch || !rawMarker.mixerEpoch || rawMarker.mixerEpoch === epoch)
      ? rawMarker
      : null;
    const queueState = queue.snapshot();
    const currentTalkId = queueState.current?.kind === 'talk' ? queueState.current.talkId : null;
    const pendingTalkIds = queueState.upcoming
      .filter((item) => item.kind === 'talk')
      .map((item) => item.talkId);
    const markerChapter = marker ? chapterIdFromTalk(manifest, marker.id) : null;
    const markerOrdinal = markerChapter == null
      ? null
      : manifest.chapters.find((chapter) => chapter.id === markerChapter)?.ordinal ?? null;

    const reconciliations = ambiguous.map((chapter) => {
      const id = talkId(manifest.id, chapter.id);
      let status: 'armed' | 'playing' | 'finished' | 'missing';
      if (markerChapter === chapter.id) {
        status = marker!.status === 'started' ? 'playing' : 'finished';
      } else if (markerOrdinal != null && chapter.ordinal < markerOrdinal) {
        // Any lifecycle edge for a successor proves every earlier ambiguous
        // chapter finished, even if intermediate atomic writes landed while
        // the controller was restarting.
        status = 'finished';
      } else if (currentTalkId === id) {
        status = 'playing';
      } else if (pendingTalkIds.includes(id)) {
        status = 'armed';
      } else {
        status = 'missing';
      }
      return { chapterId: chapter.id, status };
    });
    await this.coordinator.reconcileRecoveredPlaybackBatch(reconciliations);
  }

  private async processPlaybackMarker(): Promise<void> {
    if (!this.coordinator) return;
    const marker = queue.getTalkPlayback() || await queue.readTalkPlaybackFromDisk();
    if (!marker) return;
    const epoch = await queue.readTalkMixerEpochFromDisk();
    if (epoch && marker.mixerEpoch && marker.mixerEpoch !== epoch) return;
    const markerKey = `${marker.mixerEpoch || ''}:${marker.id}:${marker.status}:${marker.startedAt}:${marker.finishedAt || ''}`;
    if (markerKey === this.lastMarkerKey) return;

    let manifest = this.coordinator.snapshot();
    if (!manifest) return;
    const chapterId = chapterIdFromTalk(manifest, marker.id);
    if (!chapterId) return;
    const chapter = manifest.chapters.find((item) => item.id === chapterId)!;

    // Liquidsoap can publish its start edge milliseconds before enqueueTalk's
    // receipt is persisted. Retry this marker after ARMING settles; recording
    // it as seen now would strand an on-air chapter in ARMED forever.
    if (chapter.state === 'ARMING') return;

    if (marker.status === 'started') {
      const previous = manifest.chapters.find((item) => item.state === 'PLAYING' && item.id !== chapterId);
      if (previous) {
        await this.coordinator.playbackFinished(previous.id);
        manifest = this.coordinator.snapshot()!;
      }
      const current = manifest.chapters.find((item) => item.id === chapterId);
      if (current?.state === 'ARMED') await this.coordinator.playbackStarted(chapterId);
    } else if (chapter.state === 'PLAYING' || chapter.state === 'ARMED') {
      await this.coordinator.playbackFinished(chapterId);
    }
    this.lastMarkerKey = markerKey;
  }
}

const runtime = new LongformRuntime();

export async function startLongformRuntime(): Promise<void> {
  await runtime.start();
}

export function stopLongformRuntime(): void {
  runtime.stop();
}

export function longformRuntimeStatus(): RuntimeView {
  return runtime.view();
}

export async function refreshLongformRuntime(): Promise<void> {
  await runtime.refresh();
}

export async function endLongformEpisode(reason?: string): Promise<LongformManifest | null> {
  return runtime.endCurrent(reason);
}
