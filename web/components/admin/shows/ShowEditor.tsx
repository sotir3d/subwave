'use client';

// The inline show editor - the former modal body, lifted to an in-page editor
// (the personas pattern). Edits write straight through `update` onto form
// state; nothing is saved here, the page's "Save schedule" persists shows and
// schedule together. Keyed by show id at the call site so switching shows
// remounts it (which resets the AiFill box).
//
// Part of the shows/ split - see ../ShowsPanel.tsx.

import type { ChangeEvent, RefObject } from 'react';
import { useMemo, useState } from 'react';
import { Input } from '../../ui/input';
import { Textarea } from '../../ui/textarea';
import { Label } from '../../ui/label';
import { Field } from '../../ui/field';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
} from '../../ui/select';
import { Card, Btn, Eyebrow, Toggle } from '../ui';
import { EditorDialog, EditorFooter } from '../../ui/editor-dialog';
import { AiFill } from '../AiFill';
import GenreSuggest from '../GenreSuggest';
import { PersonaPicker, GuestPersonaPicker, ThemePicker } from './ShowPickers';
import { cn } from '../../../lib/cn';
import {
  ANY_SENTINEL,
  DECADES,
  ENERGY_OPTIONS,
  FILTER_VALUES_MAX,
  GUESTS_MAX,
  NAME_MAX,
  TOPIC_MAX,
  eraLabelOf,
  sameEra,
} from './types';
import type { Persona, Show, SkillOption, ThemeOption } from './types';
import { hasAnyMusicFilter, showValid } from './lib';
import { ChipRow } from './ChipRow';
import { SpokenProgrammeEditor } from './SpokenProgrammeEditor';

// ── inline show editor ─────────────────────────────────────────────────────
// The former modal body, lifted to an in-page editor (the personas pattern).
// Edits are written straight through `update` onto form state; nothing is saved
// here — the page's "Save schedule" persists shows + schedule together. Keyed by
// show id at the call site so switching shows remounts it (resets the AiFill box).
interface ShowEditorProps {
  show: Show;
  editorRef: RefObject<HTMLDivElement | null>;
  personas: Persona[];
  moods: string[];
  themes: ThemeOption[];
  skills: SkillOption[];
  activeThemeId: string;
  genres: string[];
  playlists: { id: string; name: string; songCount: number | null }[];
  apiBase: string;
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  minTrackSeconds?: number;
  busy: boolean;
  isNew: boolean;       // show the AI-draft field only while creating
  update: (patch: Partial<Show>) => void;
  onSave: () => void;   // Save show — persists just this show (POST /shows)
  onClose: () => void;
  onRemove: () => void;
}

export function ShowEditor({
  show, editorRef, personas, moods, themes, skills, activeThemeId, genres, playlists, apiBase,
  adminFetch, minTrackSeconds, busy, isNew,
  update, onSave, onClose, onRemove,
}: ShowEditorProps) {
  // Save show gates on THIS show only — other unsaved shows don't block it.
  const valid = showValid(show);
  // Free-text genre being typed before it's added as a chip. The editor is
  // remounted per show (keyed at the call site), so this resets on switch.
  const [genreDraft, setGenreDraft] = useState('');
  const addGenre = (g: string) => {
    const v = g.trim().slice(0, 64);
    if (!v || show.genres.length >= FILTER_VALUES_MAX) return;
    if (show.genres.some(x => x.toLowerCase() === v.toLowerCase())) { setGenreDraft(''); return; }
    update({ genres: [...show.genres, v] });
    setGenreDraft('');
  };
  // Genres this show asks for that no track actually carries. The controller
  // resolves a free-text genre onto the nearest library tag, which silently
  // broadens the show ("Pop Punk" → "Pop") or drops the filter altogether when
  // nothing is close — invisible on air unless we say it here, at the moment
  // the operator is looking at the field. Mirrors show-filter.normGenre so the
  // UI and the station agree on what counts as "the same tag". Only meaningful
  // once the library list has loaded (empty = not fetched yet, or the endpoint
  // failed — never warn on a fetch failure).
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const knownGenres = useMemo(() => new Set(genres.map(norm)), [genres]);
  const unknownGenres = genres.length
    ? show.genres.filter(g => !knownGenres.has(norm(g)))
    : [];
  return (
    <EditorDialog
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={<Eyebrow className="text-vermilion">{isNew ? 'New show' : 'Edit show'}</Eyebrow>}
      sub={<span className="caption truncate">{show.name.trim() || 'define a show'}</span>}
      footer={
        <EditorFooter
          status={(
            <>
              <span
                className={cn(
                  'size-1.5 flex-none rounded-full',
                  valid ? 'bg-[var(--accent)]' : 'bg-[var(--danger)]',
                )}
              />
              <span className="min-w-0">
                {!valid
                  ? <span className="text-[var(--danger)]">this show needs a name and a persona</span>
                  : 'saves this show · schedule it on the grid, then Save schedule'}
              </span>
            </>
          )}
          actions={[
            { id: 'remove', label: 'Remove', tone: 'danger', onClick: onRemove },
          ]}
          primary={[
            { id: 'close', label: 'Close', onClick: onClose },
            {
              id: 'save',
              label: busy ? 'Saving…' : 'Save show',
              tone: 'accent',
              onClick: onSave,
              disabled: busy || !valid,
            },
          ]}
        />
      }
    >
      <div ref={editorRef} className="grid">
        <Card flat title="Identity" bodyClass="grid gap-3.5">
          {isNew && (
            <AiFill<Partial<Omit<Show, 'personaId' | 'themeId'>> & { personaId?: string | null; themeId?: string | null }>
              endpoint="/generate/show"
              resultKey="show"
              adminFetch={adminFetch}
              placeholder="e.g. a Sunday-morning gospel hour, warm and uplifting"
              onApply={(s) => update({
                ...s,
                personaId: s.personaId ?? show.personaId ?? '',
                themeId: s.themeId ?? '',
              })}
            />
          )}
          <Field>
            <Label htmlFor="show-name">show name</Label>
            <Input
              id="show-name"
              type="text" value={show.name} maxLength={NAME_MAX}
              onChange={(e: ChangeEvent<HTMLInputElement>) => update({ name: e.target.value })}
              placeholder="e.g. The Late Shift"
              className="text-[15px] font-bold"
            />
            <span className="field-hint">{show.name.trim().length}/{NAME_MAX}</span>
          </Field>

          <Field>
            <Label>persona owner</Label>
            <PersonaPicker
              personas={personas}
              value={show.personaId}
              onChange={id => update({
                personaId: id,
                // The new host can't also sit in the guest chairs.
                guestPersonaIds: (show.guestPersonaIds || []).filter(g => g !== id),
              })}
              apiBase={apiBase}
            />
          </Field>

          {personas.length > 1 && (
            <Field>
              <Label>guest co-hosts</Label>
              <GuestPersonaPicker
                personas={personas.filter(p => p.id !== show.personaId)}
                value={show.guestPersonaIds || []}
                onChange={ids => update({ guestPersonaIds: ids })}
                apiBase={apiBase}
                max={GUESTS_MAX}
              />
              <span className="field-hint">
                Optional, up to {GUESTS_MAX}. While this show airs, guests take
                some of the talk breaks (station IDs, time checks, weather and
                news) in their own voice. The host still drives the music and
                track intros.
              </span>

              <div className="mt-1 flex items-start gap-3">
                <div className="pt-0.5">
                  <Toggle
                    on={show.banter && (show.guestPersonaIds?.length ?? 0) > 0}
                    disabled={(show.guestPersonaIds?.length ?? 0) === 0}
                    onClick={() => update({ banter: !show.banter })}
                    ariaLabel="Banter breaks"
                  />
                </div>
                <div className="grid gap-0.5">
                  <Label className={(show.guestPersonaIds?.length ?? 0) === 0 ? 'opacity-40' : undefined}>
                    Banter breaks
                  </Label>
                  <span className="field-hint">
                    Short scripted back-and-forth between the host and guests,
                    each voice rendered separately. Up to twice an hour,
                    depending on the persona&apos;s talk frequency. Needs at
                    least one guest.
                  </span>
                </div>
              </div>
            </Field>
          )}

          <Field>
            <div className="flex items-start gap-3">
              <div className="pt-0.5">
                <Toggle
                  on={show.programme}
                  onClick={() => update({
                    programme: !show.programme,
                    // The two directors share the same talk boundaries. Turning
                    // this legacy arc on makes the choice explicit and disables
                    // long-form rather than running both over one another.
                    spoken: !show.programme && show.spoken.enabled
                      ? { ...show.spoken, enabled: false }
                      : show.spoken,
                  })}
                  ariaLabel="Programme (produced episode)"
                />
              </div>
              <div className="grid gap-0.5">
                <Label>Programme (produced episode)</Label>
                <span className="field-hint">
                  The DJ produces each airing as a full episode from the topic
                  brief: an intro up top, a planned feature mid-hour, and a
                  sign-off in the closing minutes. Fresh angle every episode.
                </span>
              </div>
            </div>
            {show.programme && (
              <div className="mt-2 grid gap-1">
                <Label>feature segment skill</Label>
                <Select
                  value={show.segmentSkill || ANY_SENTINEL}
                  onValueChange={val => update({ segmentSkill: val === ANY_SENTINEL ? '' : val })}
                >
                  <SelectTrigger aria-label="Feature segment skill">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={ANY_SENTINEL}>Producer&apos;s choice</SelectItem>
                      {skills.map(s => (
                        <SelectItem key={s.kind} value={s.kind}>{s.label || s.name || s.kind}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <span className="field-hint">
                  Optional. Pin the mid-hour feature to one skill, like news for
                  a morning roundup. Producer&apos;s choice lets each episode
                  decide.
                </span>
              </div>
            )}
          </Field>

          <SpokenProgrammeEditor show={show} update={update} />

          <Field>
            <Label>theme override (applied while this show is on air)</Label>
            <ThemePicker
              themes={themes}
              activeThemeId={activeThemeId}
              value={show.themeId}
              onChange={id => update({ themeId: id })}
            />
            <span className="field-hint">
              Optional. The player switches to this palette while the show airs,
              then back to the station default. Manage themes in
              Settings → Theme.
            </span>
          </Field>
        </Card>

        <Card flat title="Music" bodyClass="grid gap-3.5">
          <Field>
            <Label>music moods</Label>
            <ChipRow
              options={moods.map(m => ({ key: m, label: m }))}
              selected={show.moods}
              onToggle={m => update({
                moods: show.moods.includes(m)
                  ? show.moods.filter(x => x !== m)
                  : [...show.moods, m],
              })}
            />
            <span className="field-hint">
              Pick any that fit; a track matching any of them qualifies. None
              selected = Any (auto), following the station&apos;s own mood.
            </span>
          </Field>

          <Field>
            <Label>eras</Label>
            <ChipRow
              options={DECADES.map(d => ({ key: d.key, label: d.label }))}
              selected={DECADES.filter(d => show.eras.some(e => sameEra(e, d))).map(d => d.key)}
              onToggle={key => {
                const d = DECADES.find(x => x.key === key)!;
                const existing = show.eras.find(e => sameEra(e, d));
                update({
                  eras: existing
                    ? show.eras.filter(e => e !== existing)
                    : [...show.eras, { fromYear: d.from, toYear: d.to }],
                });
              }}
            />
            {/* Custom windows (set via the API — no preset matches) stay
                visible and removable so they can't silently constrain picks. */}
            {show.eras.some(e => !DECADES.some(d => sameEra(e, d))) && (
              <div className="flex flex-wrap gap-1">
                {show.eras.filter(e => !DECADES.some(d => sameEra(e, d))).map((e, i) => (
                  <button
                    key={`${e.fromYear ?? ''}-${e.toYear ?? ''}-${i}`}
                    type="button"
                    onClick={() => update({ eras: show.eras.filter(x => x !== e) })}
                    className="min-h-9 border border-ink bg-ink px-2 py-0.5 text-[12px] text-bg sm:min-h-0"
                    title="Remove this custom era window"
                  >
                    {eraLabelOf(e)} ×
                  </button>
                ))}
              </div>
            )}
            <span className="field-hint">
              Pick any decades, even non-adjacent ones ({'"'}90s + 2010s{'"'}).
              None selected = any era.
            </span>
          </Field>

          <Field>
            <Label>energy</Label>
            <ChipRow
              options={ENERGY_OPTIONS.map(e => ({ key: e, label: e }))}
              selected={show.energies}
              onToggle={e => update({
                energies: show.energies.includes(e)
                  ? show.energies.filter(x => x !== e)
                  : [...show.energies, e],
              })}
              cap={ENERGY_OPTIONS.length}
            />
          </Field>

          <Field>
            <Label htmlFor="show-genre">genre leans</Label>
            {show.genres.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {show.genres.map(g => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => update({ genres: show.genres.filter(x => x !== g) })}
                    className="min-h-9 border border-ink bg-ink px-2 py-0.5 text-[12px] text-bg sm:min-h-0"
                    title="Remove this genre"
                  >
                    {g} ×
                  </button>
                ))}
              </div>
            )}
            <div className="flex min-w-0 gap-2">
              <Input
                id="show-genre"
                type="text" value={genreDraft} maxLength={64}
                list="show-genre-options"
                onChange={(e: ChangeEvent<HTMLInputElement>) => setGenreDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addGenre(genreDraft); } }}
                placeholder={show.genres.length ? 'add another genre' : 'e.g. Jazz (optional)'}
                disabled={show.genres.length >= FILTER_VALUES_MAX}
              />
              <Btn
                className="min-h-9 flex-none sm:min-h-0"
                onClick={() => addGenre(genreDraft)}
                disabled={!genreDraft.trim() || show.genres.length >= FILTER_VALUES_MAX}
              >
                Add
              </Btn>
            </div>
            <datalist id="show-genre-options">
              {[...genres].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })).map(g => <option key={g} value={g} />)}
            </datalist>
            <span className="field-hint">
              Up to {FILTER_VALUES_MAX}; a track matching any of them qualifies.
            </span>
            {unknownGenres.length > 0 && (
              <span role="alert" className="field-hint text-vermilion">
                No track in your library is tagged{' '}
                {unknownGenres.map((g, i) => (
                  <span key={g}>{i > 0 ? ', ' : ''}&ldquo;{g}&rdquo;</span>
                ))}
                . The station falls back to the closest tag it can find, so this show
                will air broader results than you asked for — or, if nothing is close,
                the genre filter switches off entirely. Pick a genre from the
                suggestions, or re-tag the tracks in Navidrome.
              </span>
            )}
          </Field>

          <GenreSuggest
            adminFetch={adminFetch}
            value={genreDraft}
            onSelect={addGenre}
          />

          <div className="flex items-start gap-3">
            <div className="pt-0.5">
              <Toggle
                on={show.filtersStrict}
                disabled={!hasAnyMusicFilter(show)}
                onClick={() => update({ filtersStrict: !show.filtersStrict })}
                ariaLabel="Strict filter"
              />
            </div>
            <div className="grid gap-0.5">
              <Label className={!hasAnyMusicFilter(show) ? 'opacity-40' : undefined}>
                Strict filter
              </Label>
              <span className="field-hint">
                Hard-enforces every filter set above (mood, era, energy,
                genre); off-filter tracks play only as a last resort. When off,
                they&apos;re soft leans the DJ can break for flow. Needs at
                least one filter set.
              </span>
            </div>
          </div>

          <span className="field-hint -mt-1.5">
            Optional steer for this show: mood, genre, era, energy, or any mix.
            Soft by default, so the DJ leans toward them but can break them for
            flow; Strict filter above makes them hard rules. Mood set to Any
            (auto) follows the station&apos;s own mood instead of pinning one.
          </span>

          <Field>
            <Label>playlist anchor</Label>
            <span className="field-hint">
              Pin one or more Navidrome playlists and their combined tracks
              become this show&apos;s pool. The AI DJ still sequences and talks
              over them. Pick none to let genre/era/mood drive selection
              (up to 10).
            </span>
            {playlists.length === 0 ? (
              <span className="field-hint opacity-60">
                No Navidrome playlists found yet. Create some in Navidrome, then
                reopen this panel.
              </span>
            ) : (
              <div className="grid max-h-44 gap-1 overflow-y-auto border border-ink bg-[var(--ink-softer)] p-2">
                {playlists.map(pl => {
                  const checked = show.playlistIds.includes(pl.id);
                  const atCap = !checked && show.playlistIds.length >= 10;
                  return (
                    <label
                      key={pl.id}
                      className={`flex items-center gap-2 text-sm ${atCap ? 'opacity-40' : 'cursor-pointer'}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={atCap}
                        onChange={() => update({
                          playlistIds: checked
                            ? show.playlistIds.filter(id => id !== pl.id)
                            : [...show.playlistIds, pl.id],
                        })}
                      />
                      <span className="truncate">{pl.name}</span>
                      {pl.songCount != null && (
                        <span className="field-hint">({pl.songCount})</span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </Field>

          {show.playlistIds.length > 0 && (
            <div className="flex items-start gap-3">
              <div className="pt-0.5">
                <Toggle
                  on={show.playlistStrict}
                  onClick={() => update({ playlistStrict: !show.playlistStrict })}
                  ariaLabel="Playlist only (strict)"
                />
              </div>
              <div className="grid gap-0.5">
                <Label>Playlist only (strict)</Label>
                <span className="field-hint">
                  On: play only the pinned playlist(s); off-playlist tracks air
                  only as a last resort. Off: the playlist dominates but the DJ
                  can still wander for variety. Listener requests always get
                  through, either way.
                </span>
              </div>
            </div>
          )}

          <Field>
            <Label>excluded playlists</Label>
            <span className="field-hint">
              Tracks from these playlists never play during this show, whatever
              the other filters say. Handy for blocking genres or moods that
              don&apos;t fit: gather them in a Navidrome playlist and exclude it
              here (up to 10).
            </span>
            {playlists.length === 0 ? (
              <span className="field-hint opacity-60">
                No Navidrome playlists found yet. Create some in Navidrome, then
                reopen this panel.
              </span>
            ) : (
              <div className="grid max-h-44 gap-1 overflow-y-auto border border-ink bg-[var(--ink-softer)] p-2">
                {playlists.map(pl => {
                  const checked = show.excludedPlaylistIds.includes(pl.id);
                  const atCap = !checked && show.excludedPlaylistIds.length >= 10;
                  return (
                    <label
                      key={pl.id}
                      className={`flex items-center gap-2 text-sm ${atCap ? 'opacity-40' : 'cursor-pointer'}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={atCap}
                        onChange={() => update({
                          excludedPlaylistIds: checked
                            ? show.excludedPlaylistIds.filter(id => id !== pl.id)
                            : [...show.excludedPlaylistIds, pl.id],
                        })}
                      />
                      <span className="truncate">{pl.name}</span>
                      {pl.songCount != null && (
                        <span className="field-hint">({pl.songCount})</span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </Field>
        </Card>

        <Card flat title="Brief" bodyClass="grid gap-3.5">
          <Field>
            <Label htmlFor="show-topic">topic (fed to the DJ as the show theme)</Label>
            <span className="field-hint">
              The brief the AI DJ works from. The more you describe, the better
              it picks music and writes links: genres, eras, moods, artists to
              lean into or avoid, time of day, the listener, how the host should
              sound. Write it like you&apos;re briefing a real DJ before their
              slot.
            </span>
            <Textarea
              id="show-topic"
              rows={7} value={show.topic} maxLength={TOPIC_MAX}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => update({ topic: e.target.value })}
              placeholder="e.g. Slow ambient, modern classical and downtempo for the late shift. Think Nils Frahm, Hammock, Bonobo's quieter side, nothing with a hard beat. Keep the host calm and unhurried, like a friend talking you down at 1am."
            />
            <span className="field-hint">{show.topic.trim().length}/{TOPIC_MAX}</span>
          </Field>

          <Field>
            <Label htmlFor="show-maxlen">max track length (seconds)</Label>
            <Input
              id="show-maxlen"
              type="number"
              min={0}
              max={36000}
              placeholder="inherit"
              value={show.maxTrackSeconds ?? ''}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const raw = e.target.value.trim();
                update({ maxTrackSeconds: raw === '' ? null : Math.max(0, parseInt(raw, 10) || 0) });
              }}
            />
            <span className="field-hint">
              The longest a single track plays during this show; anything longer
              fades out at the limit. Blank uses the station limit, 0 means no
              limit (good for long mixes or DJ sets), or set at
              least {minTrackSeconds ?? 30}s to cap it here.
            </span>
          </Field>
        </Card>
      </div>
    </EditorDialog>
  );
}

