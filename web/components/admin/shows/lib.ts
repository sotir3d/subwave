// Pure show helpers: hydrating a stored/partial show into a fully-defaulted
// one, validating it, and projecting it to the payload and table-row shapes.
// hydrateShow is the single place the legacy singular -> plural coercion (#929)
// lives, so the initial load and a community install can't drift apart.
//
// Part of the shows/ split - see ../ShowsPanel.tsx (mirrors schedule/lib.ts).

import type { ShowFacet, ShowRow } from './ShowsTable';
import { SHOW_COLORS } from '../schedule/lib';
import { NAME_MAX, TOPIC_MAX, eraLabelOf } from './types';
import type { Persona, Schedule, Show } from './types';


export function clientMintId() {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return 's_' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Hydrate a raw/partial show (from GET /settings or a community install
// response) into a fully-defaulted Show. Kept in one place so the initial load
// and the community install share the exact same legacy-field coercion (#929).
export function hydrateShow(s: Partial<Show>): Show {
  return {
    id: s.id ?? clientMintId(),
    name: s.name ?? '',
    topic: s.topic ?? '',
    personaId: s.personaId ?? '',
    guestPersonaIds: Array.isArray(s.guestPersonaIds) ? s.guestPersonaIds : [],
    banter: s.banter ?? false,
    // Plural lists are canonical (#929); a legacy singular field from a stale
    // response still hydrates as a one-element list.
    moods: Array.isArray(s.moods) ? s.moods : (s as { mood?: string }).mood ? [(s as { mood?: string }).mood!] : [],
    themeId: s.themeId ?? '',
    genres: Array.isArray(s.genres) ? s.genres : (s as { genre?: string }).genre ? [(s as { genre?: string }).genre!] : [],
    eras: Array.isArray(s.eras) ? s.eras : (() => {
      const { fromYear = null, toYear = null } = s as { fromYear?: number | null; toYear?: number | null };
      return fromYear != null || toYear != null ? [{ fromYear, toYear }] : [];
    })(),
    energies: Array.isArray(s.energies) ? s.energies : (s as { energy?: string }).energy ? [(s as { energy?: string }).energy!] : [],
    filtersStrict: s.filtersStrict ?? false,
    maxTrackSeconds: s.maxTrackSeconds ?? null,
    playlistIds: Array.isArray(s.playlistIds) ? s.playlistIds : [],
    playlistStrict: s.playlistStrict ?? false,
    excludedPlaylistIds: Array.isArray(s.excludedPlaylistIds) ? s.excludedPlaylistIds : [],
    programme: s.spoken?.enabled ? false : (s.programme ?? false),
    segmentSkill: s.segmentSkill ?? '',
    spoken: {
      enabled: s.spoken?.enabled ?? false,
      format: s.spoken?.format ?? 'custom',
      prompt: s.spoken?.prompt ?? '',
      targetMinutes: s.spoken?.targetMinutes ?? 30,
      useWeb: s.spoken?.useWeb ?? false,
      musicBreaks: s.spoken?.musicBreaks ?? 1,
    },
  };
}

export function emptyWeek(): Schedule {
  const w: Schedule = {};
  for (let d = 0; d < 7; d++) w[d] = Array(24).fill(null);
  return w;
}

export function abbrev(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 2).map(w => w[0]).join('').toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
}

export function showValid(s: Show): boolean {
  // mood is deliberately not required — '' means "Any" (autonomous mood).
  return s.name.trim().length >= 1 && s.name.trim().length <= NAME_MAX
    && !!s.personaId && s.topic.trim().length <= TOPIC_MAX;
}

// At least one music filter set — the Strict filter toggle only means
// something when there's a filter for it to harden.
export function hasAnyMusicFilter(s: Show): boolean {
  return !!(s.moods.length || s.genres.length || s.energies.length || s.eras.length);
}

// The wire shape for one show — trimmed + the "only-means-something-with"
// conditionals the server also enforces. Shared by the editor's Save show
// (POST /shows) and the community install path so they stay identical.
export function showPayload(s: Show) {
  return {
    id: s.id,
    name: s.name.trim(),
    topic: s.topic.trim(),
    personaId: s.personaId,
    // The host can be switched after guests were picked; the server rejects a
    // guest that duplicates the host, so filter it here too.
    guestPersonaIds: (s.guestPersonaIds || []).filter(id => id !== s.personaId),
    // Banter only means something with guests in the studio.
    banter: (s.guestPersonaIds?.length ?? 0) > 0 && s.banter,
    moods: s.moods,
    themeId: s.themeId || '',
    genres: s.genres.map(g => g.trim()).filter(Boolean),
    eras: s.eras,
    energies: s.energies,
    // Strict only means something with at least one music filter set.
    filtersStrict: hasAnyMusicFilter(s) && s.filtersStrict,
    maxTrackSeconds: s.maxTrackSeconds,
    playlistIds: s.playlistIds || [],
    // Strict only means something with at least one playlist pinned.
    playlistStrict: (s.playlistIds?.length ?? 0) > 0 && s.playlistStrict,
    excludedPlaylistIds: s.excludedPlaylistIds || [],
    programme: s.spoken?.enabled ? false : (s.programme ?? false),
    // A skill pin only means something in programme mode.
    segmentSkill: s.programme && !s.spoken.enabled ? (s.segmentSkill || '') : '',
    spoken: {
      ...s.spoken,
      enabled: !!s.spoken?.enabled,
      prompt: s.spoken?.prompt?.trim() || '',
      useWeb: s.spoken?.format === 'current-events' || !!s.spoken?.useWeb,
    },
  };
}


// "What it plays" facets — moods, genres, eras, energies as chips, plus the
// hard-lock / playlist / length flags. The visual counterpart to the text
// showFilterSummary() the strip cards still use. Shared by the slate card and
// the table row so the two views can't drift.
export function showFacets(s: Show): ShowFacet[] {
  const facets: ShowFacet[] = [];
  if (s.moods.length) s.moods.forEach(m => facets.push({ key: `mood-${m}`, label: m }));
  else facets.push({ key: 'mood-any', label: 'any mood' });
  s.genres.forEach(g => facets.push({ key: `genre-${g}`, label: g }));
  s.eras.forEach((e, idx) => facets.push({ key: `era-${idx}`, label: eraLabelOf(e) }));
  s.energies.forEach(en => facets.push({ key: `energy-${en}`, label: en }));
  if (s.filtersStrict && hasAnyMusicFilter(s)) facets.push({ key: 'strict', label: 'strict', accent: true });
  const nPl = s.playlistIds?.length ?? 0;
  if (nPl) facets.push({ key: 'playlists', label: `${nPl} playlist${nPl > 1 ? 's' : ''}${s.playlistStrict ? ' · strict' : ''}` });
  const nEx = s.excludedPlaylistIds?.length ?? 0;
  if (nEx) facets.push({ key: 'excluded', label: `${nEx} excluded` });
  if (s.maxTrackSeconds != null) {
    facets.push({ key: 'length', label: s.maxTrackSeconds === 0 ? 'any length' : `≤${s.maxTrackSeconds}s` });
  }
  return facets;
}

// Grammatical name join: "Kai", "Kai & Rae", "Kai, Rae & Sol".
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

// A persona as a table face — resolved avatar URL plus the initials to fall
// back to. `index` is carried on the row because the panel keys colour and
// editing off the show's position in the array.
function faceOf(p: Persona, apiBase: string) {
  return {
    key: p.id,
    initials: abbrev(p.name?.trim() || ''),
    src: p.avatar ? `${apiBase}/persona-avatar/${encodeURIComponent(p.id)}` : null,
  };
}

// Flatten one show into the table's view-model. Everything the row needs is
// derived here, so ShowsTable never has to know the `Show` shape.
export function showRow(s: Show, index: number, personas: Persona[], apiBase: string, hrs: number): ShowRow {
  const host = personas.find(p => p.id === s.personaId) ?? null;
  const guests = (s.guestPersonaIds || [])
    .map(id => personas.find(p => p.id === id))
    .filter((p): p is Persona => Boolean(p));
  return {
    id: s.id,
    index,
    name: s.name.trim(),
    colour: SHOW_COLORS[index % SHOW_COLORS.length] ?? '#000',
    programme: !!s.programme,
    spokenMinutes: s.spoken?.enabled ? s.spoken.targetMinutes : null,
    skillPin: s.programme && s.segmentSkill ? s.segmentSkill : '',
    banter: !!s.banter,
    host: host ? faceOf(host, apiBase) : null,
    hostName: host ? (host.name?.trim() || 'Unnamed') : (s.personaId ? 'Unnamed' : ''),
    guests: guests.map(g => faceOf(g, apiBase)),
    guestNames: joinNames(guests.map(g => g.name?.trim() || 'Unnamed')),
    facets: showFacets(s),
    hrs,
    ok: showValid(s),
  };
}


