// Longform episode contracts.  The coordinator deliberately knows nothing
// about the concrete LLM, search, TTS or Liquidsoap implementations: every
// side effect crosses one of the dependency seams below.

export const LONGFORM_EPISODE_STATES = [
  'DORMANT',
  'WAITING_PROVIDER',
  'BUFFERING',
  'ARMED',
  'PLAYING',
  'PAUSED',
  'COMPLETE',
  'FAILED',
] as const;

export type LongformEpisodeState = typeof LONGFORM_EPISODE_STATES[number];

export const LONGFORM_CHAPTER_STATES = [
  'PLANNED',
  'RESEARCHING',
  'RESEARCHED',
  'SCRIPTING',
  'SCRIPTED',
  'SYNTHESIZING',
  'READY',
  'ARMING',
  'ARMED',
  'PLAYING',
  'PLAYED',
  'FAILED',
] as const;

export type LongformChapterState = typeof LONGFORM_CHAPTER_STATES[number];
export type LongformGenerationStage = 'plan' | 'research' | 'script' | 'tts';
export type LongformWorkStage = LongformGenerationStage | 'playout';
export type LongformPauseReason = 'no-listeners' | 'restart' | null;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface LongformEpisodeSpec {
  /** Stable, filesystem-safe id supplied by the schedule/integration layer. */
  id: string;
  title: string;
  brief: string;
  metadata?: JsonObject;
}

export interface LongformPlannedChapter {
  id: string;
  title: string;
  brief: string;
  /** Semantic target used to bound the JIT production horizon. */
  targetSeconds: number;
  /** False for fiction/diary chapters that do not need a research pass. */
  researchRequired?: boolean;
  metadata?: JsonObject;
}

export interface LongformPlanResult {
  title?: string;
  summary?: string;
  chapters: LongformPlannedChapter[];
  metadata?: JsonObject;
}

export interface LongformAudioArtifact {
  /** Opaque, relocatable reference. The playout adapter resolves it to a URI. */
  assetRef: string;
  durationSeconds: number;
  metadata?: JsonObject;
}

export interface LongformPlayoutReceipt {
  id: string;
  metadata?: JsonObject;
}

export interface LongformStageAttempts {
  research: number;
  script: number;
  tts: number;
  playout: number;
}

export interface LongformErrorRecord {
  stage: LongformGenerationStage | 'playout';
  message: string;
  at: string;
}

export interface LongformChapter {
  id: string;
  ordinal: number;
  title: string;
  brief: string;
  targetSeconds: number;
  researchRequired: boolean;
  metadata: JsonObject;
  state: LongformChapterState;
  attempts: LongformStageAttempts;
  retryAt: number | null;
  research: JsonValue | null;
  script: string | null;
  audio: LongformAudioArtifact | null;
  playout: LongformPlayoutReceipt | null;
  startedAt: string | null;
  completedAt: string | null;
  errors: LongformErrorRecord[];
}

export interface LongformProviderAvailability {
  llm: boolean;
  research: boolean;
  tts: boolean;
  playout: boolean;
}

export interface LongformRuntimeState {
  listenerCount: number;
  providers: LongformProviderAvailability;
  observedAt: string;
}

export interface LongformPlanState {
  state: 'PENDING' | 'PLANNING' | 'READY' | 'FAILED';
  attempts: number;
  retryAt: number | null;
  title: string | null;
  summary: string | null;
  metadata: JsonObject;
  error: string | null;
}

export interface LongformPlaybackState {
  currentChapterId: string | null;
  hasStarted: boolean;
  waitingForRefill: boolean;
  fallbackRequestPending: boolean;
  underrunCount: number;
  lastCompletedChapterId: string | null;
}

export interface LongformManifest {
  schemaVersion: 1;
  id: string;
  spec: LongformEpisodeSpec & { metadata: JsonObject };
  state: LongformEpisodeState;
  pauseReason: LongformPauseReason;
  createdAt: string;
  updatedAt: string;
  stateChangedAt: string;
  completedAt: string | null;
  recoveredAt: string | null;
  lowWatermarkSeconds: number;
  highWatermarkSeconds: number;
  runtime: LongformRuntimeState;
  plan: LongformPlanState;
  chapters: LongformChapter[];
  playback: LongformPlaybackState;
  failure: string | null;
  errors: LongformErrorRecord[];
}

export interface LongformDependencyContext {
  manifest: LongformManifest;
  now: number;
  /** Aborted when the room empties, the operator stops the episode, or the
   * scheduled block is superseded. Adapters should pass it to model/network
   * transports and check it between chunked operations. */
  signal: AbortSignal;
}

export interface LongformDependencies {
  plan(spec: LongformEpisodeSpec, context: LongformDependencyContext): Promise<LongformPlanResult>;
  research(chapter: LongformChapter, context: LongformDependencyContext): Promise<JsonValue>;
  script(chapter: LongformChapter, context: LongformDependencyContext): Promise<string>;
  tts(chapter: LongformChapter, context: LongformDependencyContext): Promise<LongformAudioArtifact>;
  playout: {
    arm(chapter: LongformChapter, context: LongformDependencyContext): Promise<LongformPlayoutReceipt>;
    requestMusicFallback(
      input: { episodeId: string; afterChapterId: string | null; reason: 'underrun' },
      context: LongformDependencyContext,
    ): Promise<void>;
  };
}

export interface LongformCoordinatorConfig {
  lowWatermarkSeconds: number;
  highWatermarkSeconds: number;
  maxAttemptsPerStage?: number;
  retryDelayMs?: number;
}

export interface LongformClock {
  now(): number;
}

export interface LongformCoordinatorOptions {
  stateDir: string;
  config: LongformCoordinatorConfig;
  dependencies: LongformDependencies;
  clock?: LongformClock;
}

export interface LongformRuntimeUpdate {
  listenerCount: number;
  providers: LongformProviderAvailability;
}

export type RecoveredPlaybackStatus = 'armed' | 'playing' | 'finished' | 'missing';
