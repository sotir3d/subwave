// Shapes and caps the shows panel and its editor share. The caps mirror the
// controller's own limits in settings.ts - keep them in lockstep.
//
// Part of the shows/ split - see ../ShowsPanel.tsx.


export const NAME_MAX = 60;
export const TOPIC_MAX = 1000;
export const SHOWS_MAX = 64;
// Mirrors the controller's GUESTS_PER_SHOW cap (settings.ts).
export const GUESTS_MAX = 3;

export type SpokenFormat = 'custom' | 'current-events' | 'stories' | 'dj-story' | 'dj-diary';

export interface SpokenProgrammeConfig {
  enabled: boolean;
  format: SpokenFormat;
  /** Additional creative/editorial brief. The show's topic remains the
   *  programme-wide brief and is supplied alongside this text. */
  prompt: string;
  /** Total block length, including any planned song breaks. */
  targetMinutes: number;
  useWeb: boolean;
  musicBreaks: number;
}

export interface Show {
  id: string;
  name: string;
  topic: string;
  personaId: string;
  /** Guest co-host persona ids (max 3, host excluded). While the show is on
   *  air the speaker rotation hands some standalone talk breaks (station IDs,
   *  hourly checks, weather/news segments) to a guest, in their own voice.
   *  Empty = solo show, exactly today's behaviour. */
  guestPersonaIds: string[];
  /** Scripted banter breaks: short multi-voice exchanges between the host and
   *  guests, aired up to twice an hour. Only meaningful with guests set. */
  banter: boolean;
  /** [] = Any — the show pins no mood; the autonomous mood (festival >
   *  weather > time of day) applies while it's on air. Multi-value (#929):
   *  any selected mood satisfies the filter, all weighted equally. */
  moods: string[];
  /** Optional theme override — empty string means "fall back to the station
   *  default while this show is on air". Validated against the live theme
   *  registry by the controller; a stale id silently falls back too. */
  themeId: string;
  /** Optional music-steering filters — soft leans applied at pick time, each a
   *  multi-value list (#929): OR within the attribute, AND across attributes.
   *  Empty list means "no constraint". Genres are free text resolved fuzzily
   *  against the library; eras are decade/year windows; energies come from
   *  low|medium|high. */
  genres: string[];
  eras: EraWindow[];
  energies: string[];
  /** When true (and ≥1 music filter is set) EVERY set filter — mood, genre,
   *  era, energy — becomes a HARD filter on the pick pool instead of a soft
   *  lean; off-filter tracks only play as a last resort to avoid silence.
   *  Defaults off. (Replaces the genre-only `genreStrict`; the controller does
   *  NOT auto-migrate legacy strict shows — they load soft, opt back in here.) */
  filtersStrict: boolean;
  /** Per-show track-length cap (seconds). null = inherit the station default;
   *  0 = unlimited (opt this show out of the cap so it can air long mixes);
   *  >0 = this show's own cap. */
  maxTrackSeconds: number | null;
  /** Navidrome playlist anchor — the union of these playlists becomes the show's
   *  candidate pool. Empty = no anchor (behaves as before). */
  playlistIds: string[];
  /** When true (and ≥1 playlist is pinned) the playlist is the show's ENTIRE
   *  universe; off-playlist tracks only play as a never-starve fallback. When
   *  false, the playlist just dominates the pool. Defaults off. */
  playlistStrict: boolean;
  /** Navidrome playlist blocklist — tracks from these playlists are excluded
   *  from the candidate pool regardless of other filters. Empty = no exclusions. */
  excludedPlaylistIds: string[];
  /** Programme mode: the show airs as a produced episode — intro at the top,
   *  a planned feature segment mid-hour, a sign-off in the final minutes —
   *  all driven by the topic brief via a per-episode producer plan. */
  programme: boolean;
  /** Optional: pin the feature segment to one skill (e.g. news for a morning
   *  roundup). Empty = the producer picks per episode. Only used with
   *  programme on. */
  segmentSkill: string;
  /** Listener-triggered, rolling long-form production. Nothing is generated
   *  while the station has no audience; music covers provider cold starts and
   *  any runtime underrun. */
  spoken: SpokenProgrammeConfig;
}

/** One era window (mirrors the controller's EraWindow). Multiple windows let a
 *  show span non-adjacent decades ("90s + 2010s"). */
export interface EraWindow { fromYear: number | null; toYear: number | null }

// One entry in the shipped community show catalog (GET /shows/community). A
// portable, persona-agnostic show definition: no owner, no schedule — Install
// drops it in as a fresh unscheduled show owned by the active persona.
export interface CommunityShow {
  slug: string;
  name: string;
  topic: string;
  moods: string[];
  genres: string[];
  eras: EraWindow[];
  energies: string[];
  filtersStrict: boolean;
  banter: boolean;
  programme: boolean;
  segmentSkill: string;
  maxTrackSeconds: number | null;
  submittedBy?: string;   // GitHub login of the contributor who submitted it
  dateAdded?: string;     // ISO date (YYYY-MM-DD) it first entered the catalog
  dateModified?: string;  // ISO date (YYYY-MM-DD) of the last catalog change
}

// Decade presets for the era chips → one EraWindow each. Empty selection = any era.
export const DECADES: { key: string; label: string; from: number; to: number }[] = [
  { key: '2020', label: '2020s', from: 2020, to: 2029 },
  { key: '2010', label: '2010s', from: 2010, to: 2019 },
  { key: '2000', label: '2000s', from: 2000, to: 2009 },
  { key: '1990', label: '90s', from: 1990, to: 1999 },
  { key: '1980', label: '80s', from: 1980, to: 1989 },
  { key: '1970', label: '70s', from: 1970, to: 1979 },
  { key: '1960', label: '60s', from: 1960, to: 1969 },
  { key: '1950', label: '50s', from: 1950, to: 1959 },
];
export const ENERGY_OPTIONS = ['low', 'medium', 'high'];
export const ANY_SENTINEL = '__any__';
// Mirrors the controller's SHOW_FILTER_VALUES_MAX cap (settings.ts).
export const FILTER_VALUES_MAX = 6;

export function sameEra(a: EraWindow, b: { from: number | null; to: number | null } | EraWindow): boolean {
  const bf = 'from' in b ? b.from : b.fromYear;
  const bt = 'to' in b ? b.to : b.toYear;
  return a.fromYear === bf && a.toYear === bt;
}
/** Preset label ("90s") or the raw window ("1975–1984") for a custom one set via API. */
export function eraLabelOf(e: EraWindow): string {
  const hit = DECADES.find(d => sameEra(e, d));
  if (hit) return hit.label;
  if (e.fromYear != null && e.toYear != null) return `${e.fromYear}–${e.toYear}`;
  return e.fromYear != null ? `${e.fromYear}+` : `≤${e.toYear}`;
}

// View of a theme returned by GET /themes. We keep the token map here so the
// theme picker can render real colour swatches (see ShowPickers.ThemePicker).
export interface ThemeOption {
  id: string;
  name: string;
  mode?: string;
  description?: string;
  tokens?: Record<string, string>;
}

/** One entry of the /dj/skills catalogue — the programme feature-segment pin
 *  only needs the kind + a label; disabled skills are filtered on fetch. */
export interface SkillOption {
  kind: string;
  label?: string;
  name?: string;
  enabled?: boolean;
}

export interface Persona {
  id: string;
  name?: string;
  tagline?: string;
  avatar?: string;
  tts?: { engine?: string; voice?: string };
}

export interface Schedule {
  [day: number]: (string | null)[];
}

export interface FormState {
  shows: Show[];
  schedule: Schedule;
}

export interface SettingsResponse {
  values?: {
    shows?: Array<Partial<Show>>;
    schedule?: Schedule;
    personas?: Persona[];
    /** Crossfade-relative floor for a non-zero per-show cap (server-computed). */
    minTrackSeconds?: number;
  };
  tts?: { moods?: string[] };
}

