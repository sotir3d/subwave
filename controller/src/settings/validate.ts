// Strict update() validators. Unlike the lenient normalizers in normalize.ts,
// these throw on invalid input — an operator saving from the admin UI gets a
// real error rather than silently clamped values.
//
// Part of the settings/ split — see ../settings.ts for the public barrel.

import {
  AVATAR_FILENAME_RE,
  CHATTERBOX_VOICE_RE,
  DJ_PROMPT_LIMIT,
  DJ_PROMPT_NAME_MAX,
  DJ_PROMPT_TEXT_MAX,
  DJ_PROMPT_TEXT_MIN,
  EXCLUDED_PLAYLISTS_PER_SHOW,
  EraWindow,
  FREQUENCIES,
  GUESTS_PER_SHOW,
  ID_RE,
  KOKORO_VOICE_RE,
  MOODS_LIMIT,
  MOOD_NAME_MAX,
  MOOD_PERIODS,
  MOOD_PROMPT_MAX,
  OVERRIDE_MAX_MINUTES,
  PERSONA_LIMIT,
  PIPER_VOICE_RE,
  PLAYLISTS_PER_SHOW,
  POCKET_TTS_VOICE_RE,
  SCRIPT_LENGTHS,
  SHOWS_LIMIT,
  SHOW_ENERGY,
  SHOW_FILTER_VALUES_MAX,
  SHOW_MOODS,
  SPOKEN_FORMATS,
  SPOKEN_MUSIC_BREAKS_MAX,
  SPOKEN_PROMPT_MAX,
  SPOKEN_TARGET_MINUTES_MAX,
  SPOKEN_TARGET_MINUTES_MIN,
  SpokenFormat,
  SKILLS_PER_PERSONA_LIMIT,
  SKILL_SLUG_RE,
  SOUL_MAX,
  ScheduleOverride,
  TTS_CLOUD_PROVIDERS,
  TTS_ENGINES,
  WEATHER_CONDITIONS,
  WEBHOOKS_LIMIT,
  WEBHOOK_EVENTS,
  Webhook,
  clampTtsGain,
  clampTtsSpeed,
  coerceExcludedPlaylistIds,
  coerceGuestPersonaIds,
  coercePlaylistIds,
  coerceShowEnergies,
  coerceShowGenres,
  coerceShowMoods,
  emptyWeek,
  minimumSpokenTargetMinutes,
  mintId,
  normalizeDial,
  normalizeMoodName,
} from './vocab.js';
import { BOUNDS, rawMaxTrackSec } from './defaults.js';
import { minTrackSeconds } from './store.js';

function validateTtsBlock(raw, where) {
  const t = raw || {};
  if (!TTS_ENGINES.includes(t.engine)) {
    throw new Error(`${where}.tts.engine must be one of: ${TTS_ENGINES.join(', ')}`);
  }
  if (!TTS_CLOUD_PROVIDERS.includes(t.cloudProvider)) {
    throw new Error(`${where}.tts.cloudProvider must be one of: ${TTS_CLOUD_PROVIDERS.join(', ')}`);
  }
  let voice = String(t.voice ?? '').trim();
  if (t.engine === 'kokoro') {
    if (!KOKORO_VOICE_RE.test(voice)) {
      throw new Error(
        `${where}.tts.voice must match <lang><gender>_<name> for kokoro, e.g. bf_isabella`,
      );
    }
  } else if (t.engine === 'chatterbox') {
    // Empty = use built-in default voice. Otherwise the value must be a plain
    // .wav filename — no path separators — referencing a file the operator has
    // uploaded into config.chatterbox.voiceDir.
    if (voice && !CHATTERBOX_VOICE_RE.test(voice)) {
      throw new Error(
        `${where}.tts.voice for chatterbox must be a .wav filename (no path), or empty for the default voice`,
      );
    }
  } else if (t.engine === 'pocket-tts') {
    // Two accepted forms (issue #213):
    //   - A built-in voice id (alba, anna, charles, …). Curated set lives in
    //     POCKET_TTS_VOICES; anything passing POCKET_TTS_VOICE_RE is also
    //     accepted (the worker falls back to the default for unknown ids).
    //   - A `.wav` filename in the shared voice folder → zero-shot cloning.
    //     Same shape as the chatterbox value.
    if (!voice) voice = 'alba';
    if (!POCKET_TTS_VOICE_RE.test(voice) && !CHATTERBOX_VOICE_RE.test(voice)) {
      throw new Error(
        `${where}.tts.voice for pocket-tts must be a built-in voice id (e.g. alba) or a .wav filename`,
      );
    }
  } else if (t.engine === 'cloud') {
    // openai-compatible voices are server-specific; an empty voice lets the
    // server use its own default. openai/elevenlabs both require a voice id.
    if (t.cloudProvider === 'openai-compatible') {
      if (voice.length > 100) throw new Error(`${where}.tts.voice must be 0-100 chars`);
    } else if (voice.length < 1 || voice.length > 100) {
      throw new Error(`${where}.tts.voice must be 1-100 chars`);
    }
  } else if (t.engine === 'remote') {
    // Remote engine voices are server-specific — the sidecar interprets them
    // (built-in id, reference-wav filename, or VoiceDesign prompt). Empty is
    // valid: the sidecar picks its own default.
    if (voice.length > 100) throw new Error(`${where}.tts.voice must be 0-100 chars`);
  } else {
    // piper: empty = use the baked-in default voice. Otherwise the value must
    // be an .onnx filename (no path separators) referencing a model the operator
    // dropped into the shared voice folder (issue #230). A Kokoro-shaped id is
    // also accepted: the seed roster carries a distinct Kokoro voice per persona
    // under the piper engine so switching to Kokoro yields different-sounding
    // DJs with no extra editing (see SEED_PERSONAS). resolvePiperVoice() falls
    // back to the default for it at render time, so it is harmless under piper
    // and must not block saving the shipped roster (issue #454).
    if (voice && !PIPER_VOICE_RE.test(voice) && !KOKORO_VOICE_RE.test(voice)) {
      throw new Error(
        `${where}.tts.voice for piper must be an .onnx filename (no path), or empty for the default voice`,
      );
    }
  }
  return { engine: t.engine, cloudProvider: t.cloudProvider, voice, gainDb: clampTtsGain(t.gainDb), speed: clampTtsSpeed(t.speed) };
}

// Strict update-time path for the prompt-template library — any bad entry
// rejects the whole patch so the operator sees the error instead of silently
// losing a prompt.
export function validateDjPromptsStrict(raw) {
  if (!Array.isArray(raw) || raw.length > DJ_PROMPT_LIMIT) {
    throw new Error(`djPrompts must be an array of 0-${DJ_PROMPT_LIMIT} entries`);
  }
  const seen = new Set();
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`djPrompts[${i}] must be an object`);
    const name = String(item.name ?? '').trim();
    if (name.length < 1 || name.length > DJ_PROMPT_NAME_MAX) {
      throw new Error(`djPrompts[${i}].name must be 1-${DJ_PROMPT_NAME_MAX} chars`);
    }
    const text = String(item.text ?? '').trim();
    if (text.length < DJ_PROMPT_TEXT_MIN || text.length > DJ_PROMPT_TEXT_MAX) {
      throw new Error(
        `djPrompts[${i}].text must be ${DJ_PROMPT_TEXT_MIN}-${DJ_PROMPT_TEXT_MAX} chars`,
      );
    }
    if (!text.includes('{name}')) {
      throw new Error(`djPrompts[${i}].text must contain the {name} placeholder`);
    }
    let id = typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : mintId('dp_');
    if (seen.has(id)) id = mintId('dp_');
    seen.add(id);
    return { id, name, text };
  });
}

export function validatePersonasStrict(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > PERSONA_LIMIT) {
    throw new Error(`personas must be an array of 1-${PERSONA_LIMIT} entries`);
  }
  const seen = new Set();
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`personas[${i}] must be an object`);
    const name = String(item.name ?? '').trim();
    if (name.length < 1 || name.length > 40)
      throw new Error(`personas[${i}].name must be 1-40 chars`);
    const soul = String(item.soul ?? '').trim();
    if (soul.length < 1 || soul.length > SOUL_MAX)
      throw new Error(`personas[${i}].soul must be 1-${SOUL_MAX} chars`);
    const tagline = String(item.tagline ?? '').trim();
    if (tagline.length > 80) throw new Error(`personas[${i}].tagline must be 0-80 chars`);
    // language — optional free text ("Turkish", "Türkçe", …). Absent/empty →
    // '' (English, no directive injected — the historical behaviour).
    let language = '';
    if (item.language !== undefined && item.language !== null) {
      if (typeof item.language !== 'string') {
        throw new Error(`personas[${i}].language must be a string`);
      }
      language = item.language.trim();
      if (language.length > 60) throw new Error(`personas[${i}].language must be 0-60 chars`);
    }
    if (!FREQUENCIES.includes(item.frequency)) {
      throw new Error(`personas[${i}].frequency must be one of: ${FREQUENCIES.join(', ')}`);
    }
    // scriptLength — optional. Absent → 'concise' (the default and the
    // historical behaviour); present must be a known value.
    let scriptLength = 'concise';
    if (item.scriptLength !== undefined && item.scriptLength !== null) {
      if (!SCRIPT_LENGTHS.includes(item.scriptLength)) {
        throw new Error(`personas[${i}].scriptLength must be one of: ${SCRIPT_LENGTHS.join(', ')}`);
      }
      scriptLength = item.scriptLength;
    }
    // djMode — optional boolean. Absent → false (a plain narrator persona, the
    // historical behaviour). When true the persona behaves like a working DJ
    // (forward-tease, callbacks, more presence) — see effectiveFrequency above.
    let djMode = false;
    if (item.djMode !== undefined && item.djMode !== null) {
      if (typeof item.djMode !== 'boolean') {
        throw new Error(`personas[${i}].djMode must be a boolean`);
      }
      djMode = item.djMode;
    }
    const tts = validateTtsBlock(item.tts, `personas[${i}]`);
    // skills — optional. Absent → null ("all skills", legacy/default). Present
    // → an explicit slug array (the UI always sends one once edited).
    let skills: string[] | null = null;
    if (item.skills !== undefined && item.skills !== null) {
      if (!Array.isArray(item.skills)) {
        throw new Error(`personas[${i}].skills must be an array of skill names`);
      }
      if (item.skills.length > SKILLS_PER_PERSONA_LIMIT) {
        throw new Error(
          `personas[${i}].skills must be at most ${SKILLS_PER_PERSONA_LIMIT} entries`,
        );
      }
      const seenSk = new Set<string>();
      skills = [];
      for (const s of item.skills) {
        const v = String(s ?? '').trim();
        if (!SKILL_SLUG_RE.test(v)) {
          throw new Error(`personas[${i}].skills entries must be slug strings`);
        }
        if (!seenSk.has(v)) {
          seenSk.add(v);
          skills.push(v);
        }
      }
    }
    let id = typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : mintId('p_');
    if (seen.has(id)) id = mintId('p_');
    seen.add(id);
    // Avatar — optional. Absent/empty → '' (no avatar). Present must be a
    // bare basename matching AVATAR_FILENAME_RE. The dedicated upload route
    // is the only writer that creates the file on disk; this validator just
    // checks the persisted string. The post-patch sweep below garbage-
    // collects orphaned files when the persona itself is removed.
    let avatar = '';
    if (item.avatar !== undefined && item.avatar !== null && item.avatar !== '') {
      const a = String(item.avatar).trim();
      if (!AVATAR_FILENAME_RE.test(a)) {
        throw new Error(
          `personas[${i}].avatar must be a basename like <id>.png|jpg|jpeg|webp`,
        );
      }
      avatar = a;
    }
    return {
      id,
      name,
      tagline,
      frequency: item.frequency,
      scriptLength,
      djMode,
      humour: normalizeDial(item.humour),
      localColour: normalizeDial(item.localColour),
      warmth: normalizeDial(item.warmth),
      soul,
      language,
      avatar,
      tts,
      skills,
    };
  });
}

export function validateShowsStrict(raw, personas, allowedThemeIds: Set<string>, moodNames: string[] = SHOW_MOODS) {
  if (!Array.isArray(raw)) throw new Error('shows must be an array');
  if (raw.length > SHOWS_LIMIT) throw new Error(`shows must be at most ${SHOWS_LIMIT} entries`);
  const personaIds = personas.map(p => p.id);
  const seen = new Set();
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`shows[${i}] must be an object`);
    const name = String(item.name ?? '').trim();
    if (name.length < 1 || name.length > 60) throw new Error(`shows[${i}].name must be 1-60 chars`);
    const topic = String(item.topic ?? '').trim();
    if (topic.length > 1000) throw new Error(`shows[${i}].topic must be 0-1000 chars`);
    if (!personaIds.includes(item.personaId)) {
      throw new Error(`shows[${i}].personaId must reference an existing persona`);
    }
    // Empty/missing moods means "Any": the show pins no mood and the autonomous
    // dominantMood chain (festival > weather > time) applies while it's on air.
    // Multi-value (#929): the plural array is canonical; a legacy singular
    // `mood` from an older client still validates and becomes a one-element
    // list. Every entry must come from the canonical vocabulary.
    const rawMoods = Array.isArray(item.moods)
      ? item.moods
      : item.mood == null || item.mood === '' ? [] : [item.mood];
    if (rawMoods.length > SHOW_FILTER_VALUES_MAX) {
      throw new Error(`shows[${i}].moods must have at most ${SHOW_FILTER_VALUES_MAX} entries`);
    }
    for (const m of rawMoods) {
      if (typeof m !== 'string' || !moodNames.includes(m)) {
        throw new Error(`shows[${i}].moods entries must be one of: ${moodNames.join(', ')}`);
      }
    }
    const moods = coerceShowMoods({ moods: rawMoods });
    // Optional per-show theme override. Empty/missing means "fall back to the
    // station default while this show is on air". The allow-set is built once
    // by update() so we stay sync here.
    //
    // A stale id (a retired built-in like the old "sunset"/"neon" palettes,
    // renamed in 58c3782b, or a custom theme file deleted under our feet) is
    // DROPPED to "" rather than throwing — same tolerance as the lenient load
    // path and the serve-time getTheme() fallback. Throwing here bricked EVERY
    // shows/schedule save and full restore for any install still carrying one
    // retired id on one show, because update() re-validates the whole array
    // (issue #917 is the theme.active twin of this). Self-heals: the dead id
    // is gone the next time the array is persisted. This never discards a fresh
    // operator pick — those come from the live theme list — only a dead one.
    let themeId = '';
    if (item.themeId !== undefined && item.themeId !== null && item.themeId !== '') {
      const v = String(item.themeId).trim();
      if (allowedThemeIds.has(v)) {
        themeId = v;
      } else {
        console.warn(`[shows] dropping unknown themeId "${v}" from "${name}" — falling back to the station theme`);
      }
    }
    // Optional music-steering filters — all default to "no constraint" and all
    // multi-value lists (#929, legacy singular fields still accepted). Genres
    // are free text resolved fuzzily at pick time, so they aren't checked
    // against the live library here.
    // Legacy singular `genre` splits on commas — same rule as the load-path
    // migration (operators crammed "funk, soul" into the one field).
    const rawGenres = Array.isArray(item.genres)
      ? item.genres
      : item.genre == null || String(item.genre).trim() === '' ? [] : String(item.genre).split(',');
    // Cap-check only the explicit plural form; a legacy comma-crammed string
    // is silently capped by the coercer instead of failing an old client.
    if (Array.isArray(item.genres) && item.genres.length > SHOW_FILTER_VALUES_MAX) {
      throw new Error(`shows[${i}].genres must have at most ${SHOW_FILTER_VALUES_MAX} entries`);
    }
    for (const g of rawGenres) {
      if (typeof g !== 'string') throw new Error(`shows[${i}].genres entries must be strings`);
      if (g.trim().length > 64) throw new Error(`shows[${i}].genres entries must be 0-64 chars`);
    }
    const genres = coerceShowGenres({ genres: rawGenres });
    const rawEnergies = Array.isArray(item.energies)
      ? item.energies
      : item.energy == null || item.energy === '' ? [] : [item.energy];
    for (const e of rawEnergies) {
      if (typeof e !== 'string' || !SHOW_ENERGY.includes(e)) {
        throw new Error(`shows[${i}].energies entries must be one of: ${SHOW_ENERGY.join(', ')}`);
      }
    }
    const energies = coerceShowEnergies({ energies: rawEnergies });
    // Opt-in hard filter across every set music constraint — mood, genre, era,
    // energy (vs the default soft leans). Boolean, defaults OFF. The legacy
    // genre-only `genreStrict` is deliberately NOT carried over (see the load
    // path): the toggle now spans every filter, so migrating it would silently
    // harden mood/era/energy an old show never opted into.
    const filtersStrict = item.filtersStrict === true;
    const parseYear = (v, field) => {
      if (v == null || v === '') return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1900 || n > 2100) {
        throw new Error(`shows[${i}].${field} must be an integer between 1900 and 2100`);
      }
      return n;
    };
    // Era windows: `eras` is a list of { fromYear, toYear } windows (#929);
    // legacy top-level fromYear/toYear still validate as a one-window list.
    // Each window needs at least one bound; both-null entries are dropped.
    const rawEras = Array.isArray(item.eras)
      ? item.eras
      : item.fromYear == null && item.toYear == null ? [] : [{ fromYear: item.fromYear, toYear: item.toYear }];
    if (rawEras.length > SHOW_FILTER_VALUES_MAX) {
      throw new Error(`shows[${i}].eras must have at most ${SHOW_FILTER_VALUES_MAX} entries`);
    }
    const eras: EraWindow[] = [];
    for (const [j, w] of rawEras.entries()) {
      if (!w || typeof w !== 'object') throw new Error(`shows[${i}].eras[${j}] must be an object`);
      const fromYear = parseYear((w as Record<string, unknown>).fromYear, `eras[${j}].fromYear`);
      const toYear = parseYear((w as Record<string, unknown>).toYear, `eras[${j}].toYear`);
      if (fromYear == null && toYear == null) continue;
      if (fromYear != null && toYear != null && fromYear > toYear) {
        throw new Error(`shows[${i}].eras[${j}].fromYear must be <= toYear`);
      }
      if (!eras.some(e => e.fromYear === fromYear && e.toYear === toYear)) {
        eras.push({ fromYear, toYear });
      }
    }
    // Per-show track-length override (seconds): null = inherit station default,
    // 0 = unlimited, >0 = own cap. Empty/missing → inherit. A legacy minutes
    // value from a stale client is migrated (×60) before bounds-checking.
    let maxTrackSeconds: number | null = null;
    const rawSec = rawMaxTrackSec(item);
    if (rawSec != null && rawSec !== '') {
      const n = Number(rawSec);
      if (!Number.isInteger(n) || n < BOUNDS.maxTrackSeconds.min || n > BOUNDS.maxTrackSeconds.max) {
        throw new Error(
          `shows[${i}].maxTrackSeconds must be an integer between ${BOUNDS.maxTrackSeconds.min} and ${BOUNDS.maxTrackSeconds.max}`,
        );
      }
      // Same crossfade-relative floor as the station cap (0 = inherit/unlimited
      // stays allowed). Shows have no own crossfade, so it's the station value.
      const floor = minTrackSeconds();
      if (n !== 0 && n < floor) {
        throw new Error(
          `shows[${i}].maxTrackSeconds must be 0 (inherit/unlimited) or at least ${floor}s`,
        );
      }
      maxTrackSeconds = n;
    }
    // Optional Navidrome playlist anchor. Shape-checked only (array of strings,
    // capped) — ids are resolved against the live Navidrome at pick time, never
    // here, so a stale id is tolerated. playlistStrict is a plain boolean.
    let playlistIds: string[] = [];
    if (item.playlistIds !== undefined && item.playlistIds !== null) {
      if (!Array.isArray(item.playlistIds)) {
        throw new Error(`shows[${i}].playlistIds must be an array of strings`);
      }
      if (item.playlistIds.length > PLAYLISTS_PER_SHOW) {
        throw new Error(`shows[${i}].playlistIds must have at most ${PLAYLISTS_PER_SHOW} entries`);
      }
      for (const v of item.playlistIds) {
        if (typeof v !== 'string') throw new Error(`shows[${i}].playlistIds entries must be strings`);
      }
      playlistIds = coercePlaylistIds(item.playlistIds);
    }
    const playlistStrict = item.playlistStrict === true;
    // Optional Navidrome playlist blocklist. Shape-checked only — same rules as
    // playlistIds; stale ids contribute nothing at pick time.
    let excludedPlaylistIds: string[] = [];
    if (item.excludedPlaylistIds !== undefined && item.excludedPlaylistIds !== null) {
      if (!Array.isArray(item.excludedPlaylistIds)) {
        throw new Error(`shows[${i}].excludedPlaylistIds must be an array of strings`);
      }
      if (item.excludedPlaylistIds.length > EXCLUDED_PLAYLISTS_PER_SHOW) {
        throw new Error(`shows[${i}].excludedPlaylistIds must have at most ${EXCLUDED_PLAYLISTS_PER_SHOW} entries`);
      }
      for (const v of item.excludedPlaylistIds) {
        if (typeof v !== 'string') throw new Error(`shows[${i}].excludedPlaylistIds entries must be strings`);
      }
      excludedPlaylistIds = coerceExcludedPlaylistIds(item.excludedPlaylistIds);
    }
    // Optional guest co-hosts. Strict path: unknown personas and a guest that
    // duplicates the host are operator mistakes worth surfacing, not dropping.
    let guestPersonaIds: string[] = [];
    if (item.guestPersonaIds !== undefined && item.guestPersonaIds !== null) {
      if (!Array.isArray(item.guestPersonaIds)) {
        throw new Error(`shows[${i}].guestPersonaIds must be an array of persona ids`);
      }
      if (item.guestPersonaIds.length > GUESTS_PER_SHOW) {
        throw new Error(`shows[${i}].guestPersonaIds must have at most ${GUESTS_PER_SHOW} entries`);
      }
      for (const v of item.guestPersonaIds) {
        if (typeof v !== 'string' || !personaIds.includes(v)) {
          throw new Error(`shows[${i}].guestPersonaIds must reference existing personas`);
        }
        if (v === item.personaId) {
          throw new Error(`shows[${i}].guestPersonaIds must not include the show's host persona`);
        }
      }
      guestPersonaIds = coerceGuestPersonaIds(item.guestPersonaIds, item.personaId, personaIds);
    }
    // Banter without guests is inert, not an error — the tick re-checks the
    // live roster anyway, so a stale true can't air a one-person "exchange".
    const banter = item.banter === true;
    // Programme mode + optional feature-beat capability pin. The kind is
    // shape-checked only — resolved against the live skill catalog at air time,
    // so a stale/misspelled kind degrades instead of blocking a settings save.
    const programme = item.programme === true;
    const segmentSkill = String(item.segmentSkill ?? '').trim();
    if (segmentSkill.length > 64) throw new Error(`shows[${i}].segmentSkill must be 0-64 chars`);
    const spokenRaw = item.spoken ?? {};
    if (!spokenRaw || typeof spokenRaw !== 'object' || Array.isArray(spokenRaw)) {
      throw new Error(`shows[${i}].spoken must be an object`);
    }
    const spokenFormat = String(spokenRaw.format ?? 'custom') as SpokenFormat;
    if (!SPOKEN_FORMATS.includes(spokenFormat)) {
      throw new Error(`shows[${i}].spoken.format must be one of: ${SPOKEN_FORMATS.join(', ')}`);
    }
    const spokenPrompt = String(spokenRaw.prompt ?? '').trim();
    if (spokenPrompt.length > SPOKEN_PROMPT_MAX) {
      throw new Error(`shows[${i}].spoken.prompt must be 0-${SPOKEN_PROMPT_MAX} chars`);
    }
    const spokenTarget = Number(spokenRaw.targetMinutes ?? 30);
    if (!Number.isInteger(spokenTarget)
      || spokenTarget < SPOKEN_TARGET_MINUTES_MIN
      || spokenTarget > SPOKEN_TARGET_MINUTES_MAX) {
      throw new Error(
        `shows[${i}].spoken.targetMinutes must be an integer from ${SPOKEN_TARGET_MINUTES_MIN}-${SPOKEN_TARGET_MINUTES_MAX}`,
      );
    }
    const spokenBreaks = Number(spokenRaw.musicBreaks ?? 1);
    if (!Number.isInteger(spokenBreaks) || spokenBreaks < 0 || spokenBreaks > SPOKEN_MUSIC_BREAKS_MAX) {
      throw new Error(`shows[${i}].spoken.musicBreaks must be an integer from 0-${SPOKEN_MUSIC_BREAKS_MAX}`);
    }
    const minimumTarget = minimumSpokenTargetMinutes(spokenBreaks);
    if (spokenTarget < minimumTarget) {
      throw new Error(
        `shows[${i}].spoken.targetMinutes must be at least ${minimumTarget} with ${spokenBreaks} planned song break${spokenBreaks === 1 ? '' : 's'}`,
      );
    }
    const spoken = {
      enabled: spokenRaw.enabled === true,
      format: spokenFormat,
      prompt: spokenPrompt,
      targetMinutes: spokenTarget,
      useWeb: spokenRaw.useWeb === true || spokenFormat === 'current-events',
      musicBreaks: spokenBreaks,
    };
    if (spoken.enabled && programme) {
      throw new Error(`shows[${i}] cannot enable programme and spoken long-form modes together`);
    }
    let id = typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : mintId('s_');
    if (seen.has(id)) id = mintId('s_');
    seen.add(id);
    return { id, name, topic, personaId: item.personaId, guestPersonaIds, banter, programme, segmentSkill, spoken, moods, themeId, genres, eras, energies, filtersStrict, maxTrackSeconds, playlistIds, playlistStrict, excludedPlaylistIds };
  });
}

export function validateScheduleStrict(raw, shows) {
  if (!raw || typeof raw !== 'object') throw new Error('schedule must be an object keyed 0-6');
  const showIds = shows.map(s => s.id);
  const week = emptyWeek();
  for (let d = 0; d < 7; d++) {
    const day = raw[d];
    if (day === undefined || day === null) continue;
    if (!Array.isArray(day) || day.length !== 24) {
      throw new Error(`schedule[${d}] must be an array of exactly 24 entries`);
    }
    for (let h = 0; h < 24; h++) {
      const v = day[h];
      if (v === null || v === undefined || v === '') {
        week[d][h] = null;
        continue;
      }
      if (typeof v !== 'string' || !showIds.includes(v)) {
        throw new Error(`schedule[${d}][${h}] references an unknown show`);
      }
      week[d][h] = v;
    }
  }
  return week;
}

// Strict takeover validator — used by update(). null clears; anything else
// must be a well-formed window over an existing show. The 12h cap is enforced
// here (not just the route) so no caller can persist an unbounded pin.
export function validateScheduleOverrideStrict(raw, shows): ScheduleOverride | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') throw new Error('scheduleOverride must be an object or null');
  const showId = typeof raw.showId === 'string' ? raw.showId : '';
  if (!shows.some(s => s.id === showId)) {
    throw new Error('scheduleOverride.showId references an unknown show');
  }
  const startedAt = raw.startedAt;
  const expiresAt = raw.expiresAt;
  if (!Number.isFinite(startedAt) || !Number.isFinite(expiresAt)) {
    throw new Error('scheduleOverride.startedAt/expiresAt must be epoch-ms numbers');
  }
  if (startedAt >= expiresAt) {
    throw new Error('scheduleOverride.expiresAt must be after startedAt');
  }
  if (expiresAt - startedAt > OVERRIDE_MAX_MINUTES * 60_000) {
    throw new Error(`scheduleOverride window must be at most ${OVERRIDE_MAX_MINUTES} minutes`);
  }
  return { showId, startedAt, expiresAt };
}

// Strict validator — used by update(). `existing` is the current list, so
// the operator can keep a previously-set authHeader by sending the redacted
// sentinel back unchanged.
export function validateWebhooksStrict(raw: unknown, existing: Webhook[] = []) {
  if (!Array.isArray(raw)) throw new Error('webhooks must be an array');
  if (raw.length > WEBHOOKS_LIMIT) {
    throw new Error(`webhooks must be at most ${WEBHOOKS_LIMIT} entries`);
  }
  const byId = new Map(existing.map((h) => [h.id, h] as const));
  const seen = new Set<string>();
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`webhooks[${i}] must be an object`);
    const url = String(item.url ?? '').trim();
    if (!/^https?:\/\//.test(url)) {
      throw new Error(`webhooks[${i}].url must start with http:// or https://`);
    }
    if (url.length > 500) throw new Error(`webhooks[${i}].url too long`);
    if (!Array.isArray(item.events) || item.events.length === 0) {
      throw new Error(`webhooks[${i}].events must be a non-empty array`);
    }
    const events: string[] = [];
    for (const e of item.events) {
      if (!WEBHOOK_EVENTS.includes(e)) {
        throw new Error(
          `webhooks[${i}].events entries must be one of: ${WEBHOOK_EVENTS.join(', ')}`,
        );
      }
      if (!events.includes(e)) events.push(e);
    }
    let id = typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : mintId('wh_');
    if (seen.has(id)) id = mintId('wh_');
    seen.add(id);
    // authHeader: sentinel 'set' from getRedacted() means "keep the existing
    // value" — the UI never re-sends the actual header. Anything else replaces.
    const prior = byId.get(id);
    let authHeader = '';
    if (item.authHeader === 'set' && prior?.authHeader) {
      authHeader = prior.authHeader;
    } else if (typeof item.authHeader === 'string') {
      authHeader = item.authHeader.slice(0, 500);
    }
    return {
      id,
      url,
      events,
      enabled: item.enabled !== false,
      authHeader,
    };
  });
}

// --- Strict update() validators for the mood system (the validateFestivalsStrict
// shape: whole-value replace, indexed throws, rebuilt objects strip unknown
// keys). `moodNames` is the effective vocabulary being saved, so a schedule /
// weather / festival entry may reference a mood added in the SAME patch. ---
// Exported for unit tests (scripts/moods.test.ts) — the pure validation/guard
// logic that keeps the mood system consistent on every save.
export function validateMoodsStrict(raw: any): Array<{ name: string; clapPrompt: string }> {
  if (!Array.isArray(raw)) throw new Error('moods must be an array');
  if (raw.length < 1) throw new Error('moods must have at least one entry');
  if (raw.length > MOODS_LIMIT) throw new Error(`moods must be at most ${MOODS_LIMIT} entries`);
  const seen = new Set<string>();
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`moods[${i}] must be an object`);
    const name = normalizeMoodName(item.name);
    if (name.length < 1 || name.length > MOOD_NAME_MAX) {
      throw new Error(`moods[${i}].name must be 1-${MOOD_NAME_MAX} chars (letters, digits, dashes)`);
    }
    if (seen.has(name)) throw new Error(`moods[${i}].name "${name}" is a duplicate`);
    seen.add(name);
    const clapPrompt = typeof item.clapPrompt === 'string'
      ? item.clapPrompt.trim().slice(0, MOOD_PROMPT_MAX)
      : '';
    return { name, clapPrompt };
  });
}

export function validateMoodScheduleStrict(raw: any, moodNames: string[]): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('moodSchedule must be an object');
  }
  const names = new Set(moodNames);
  const out: Record<string, string> = {};
  for (const period of MOOD_PERIODS) {
    const v = String(raw[period] ?? '').trim();
    if (!names.has(v)) {
      throw new Error(`moodSchedule.${period} must be one of: ${moodNames.join(', ')}`);
    }
    out[period] = v;
  }
  return out;
}

export function validateWeatherMoodsStrict(raw: any, moodNames: string[]): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('weatherMoods must be an object');
  }
  const names = new Set(moodNames);
  const out: Record<string, string> = {};
  for (const cond of WEATHER_CONDITIONS) {
    const v = String(raw[cond] ?? '').trim();
    if (v && !names.has(v)) {
      throw new Error(`weatherMoods.${cond} must be a mood (${moodNames.join(', ')}) or empty`);
    }
    out[cond] = v;
  }
  return out;
}

// Reject a vocabulary edit that would orphan a mood still referenced by the
// festival calendar, either mood map, or a scheduled show. Renames are a
// two-step (add the new name, repoint the referrers, remove the old) — this is
// the guard that names exactly what still points at a removed mood.
export function assertNoOrphanMoods(next: any): void {
  const names = new Set<string>((next.moods || []).map((m: any) => m.name));
  const refs: string[] = [];
  for (const [period, mood] of Object.entries(next.moodSchedule || {})) {
    if (mood && !names.has(mood as string)) refs.push(`the ${period} time-of-day slot`);
  }
  for (const [cond, mood] of Object.entries(next.weatherMoods || {})) {
    if (mood && !names.has(mood as string)) refs.push(`the ${cond} weather slot`);
  }
  for (const f of next.festivals || []) {
    if (f.mood && !names.has(f.mood)) refs.push(`festival "${f.name}"`);
  }
  for (const s of next.shows || []) {
    for (const m of s.moods || []) {
      if (!names.has(m)) refs.push(`show "${s.name}"`);
    }
  }
  if (refs.length) {
    const uniq = [...new Set(refs)];
    throw new Error(`can't remove that mood — still used by ${uniq.join(', ')}. Reassign those first.`);
  }
}

const FESTIVALS_LIMIT = 50;

export function validateFestivalsStrict(raw, moodNames: string[] = SHOW_MOODS) {
  if (!Array.isArray(raw)) throw new Error('festivals must be an array');
  if (raw.length > FESTIVALS_LIMIT) {
    throw new Error(`festivals must be at most ${FESTIVALS_LIMIT} entries`);
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`festivals[${i}] must be an object`);
    const name = String(item.name ?? '').trim();
    if (name.length < 1 || name.length > 80) throw new Error(`festivals[${i}].name must be 1-80 chars`);
    const month = Number(item.month);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error(`festivals[${i}].month must be an integer 1-12`);
    }
    const day = Number(item.day);
    // Feb allows 29 — in common years a leap-day festival fires Mar 1
    // (Date.UTC rolls the date over in getFestivalContext).
    const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    if (!Number.isInteger(day) || day < 1 || day > daysInMonth) {
      throw new Error(`festivals[${i}].day must be an integer 1-${daysInMonth} for month ${month}`);
    }
    const mood = String(item.mood ?? '').trim();
    if (!moodNames.includes(mood)) {
      throw new Error(`festivals[${i}].mood must be one of: ${moodNames.join(', ')}`);
    }
    const description = typeof item.description === 'string' ? item.description.trim().slice(0, 200) : '';
    const windowDays = Number(item.windowDays ?? 0);
    if (!Number.isInteger(windowDays) || windowDays < 0 || windowDays > 14) {
      throw new Error(`festivals[${i}].windowDays must be an integer 0-14`);
    }
    return { month, day, name, mood, description, windowDays };
  });
}

// Validate + persist. Returns { saved, requiresRestart } so the UI can react.

