'use client';

// Show definitions — /admin/shows. A show is a reusable definition (name,
// topic, owner persona, music moods). When the scheduled hour has a show, its
// persona goes on air, its moods (when set — empty means Any/auto) override
// the autonomous mood, and its topic feeds the DJ.
// An empty hour = the station runs autonomously, as it does today.
//
// Shows are created/edited through an in-page editor (ShowEditor, below the
// show list) — the personas pattern: click a show to open it, edit it in place.
// The weekly plan itself lives on its own full-screen page now — The Rundown
// at /admin/shows/schedule (components/admin/schedule/) — which owns the
// board, the on-air listing, and PUT /schedule. This page still loads the
// schedule read-only for the per-show hours-a-week counts. Putting a show on
// the air RIGHT NOW is a takeover, and that lives on the dash.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Users, Share2 } from 'lucide-react';
import { useAdminAuth } from '../../lib/adminAuth';
import { notify, errorMessage } from '../../lib/notify';
import { Button } from '../ui/button';
import { Card, Btn, Pill, Eyebrow, Metric } from './ui';
import RosterViewToggle from './RosterViewToggle';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { V3AlertDialog } from '../ui/alert-dialog';
import { Modal } from '../ui/modal';
import ShowsTable from './shows/ShowsTable';
import { useRosterView } from '../../lib/adminView';
import { showSubmitUrl } from '../../lib/repo';
import { ShowDefRow } from './shows/ShowDefRow';
import { ShowEditor } from './shows/ShowEditor';
import { clientMintId, emptyWeek, hydrateShow, showPayload, showRow, showValid } from './shows/lib';
import type {
  CommunityShow,
  FormState,
  Persona,
  Schedule,
  SettingsResponse,
  Show,
  SkillOption,
  ThemeOption,
} from './shows/types';
import { SHOWS_MAX } from './shows/types';

export default function ShowsPanel() {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Community show catalog + install state (best-effort; null = still loading).
  const [community, setCommunity] = useState<CommunityShow[] | null>(null);
  const [communityOpen, setCommunityOpen] = useState(false);          // catalog modal open?
  // Show definitions as cards (default) or a dense table. Per-surface pref.
  const [view, setView] = useRosterView('shows');
  const [installing, setInstalling] = useState<string | null>(null);  // community slug installing, or null

  // Inline editor: `focusIdx` is the show open in the editor below the list
  // (null = none open). Shows are edited in place — no modal, no draft copy;
  // edits land straight on `form.shows[focusIdx]` and persist on Save show.
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  // id of a freshly-added show — the AI-draft field shows only while creating.
  const [creatingId, setCreatingId] = useState<string | null>(null);
  // The editor block, scrolled into view when a show is opened (add / edit) so
  // the operator actually sees it — it stacks below the list and would else be
  // off-screen. The flag gates the scroll to deliberate opens (not re-renders).
  const editorRef = useRef<HTMLDivElement | null>(null);
  const scrollToEditorRef = useRef(false);
  // Index of the show pending a delete-confirm (null = no dialog open). Both the
  // list ✕ and the editor's Remove route through it so deletes need confirming.
  const [confirmDeleteIdx, setConfirmDeleteIdx] = useState<number | null>(null);
  // Theme list for the per-show override dropdown. Public endpoint, no auth
  // needed — same source the player ThemeProvider reads.
  const [themes, setThemes] = useState<ThemeOption[]>([]);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [activeThemeId, setActiveThemeId] = useState('');
  // Library genres for the show genre autocomplete. Admin-gated endpoint, so it
  // runs after sign-in; failures are silent (the field still accepts free text).
  const [genres, setGenres] = useState<string[]>([]);
  // Navidrome playlists for the per-show playlist-anchor picker. Admin-gated;
  // failures are silent (the picker just shows no options to choose from).
  const [playlists, setPlaylists] = useState<{ id: string; name: string; songCount: number | null }[]>([]);
  // When a show is opened (add / Edit click sets the flag), bring the editor
  // into view. Guarded by scrollToEditorRef so unrelated re-renders don't yank.
  useEffect(() => {
    if (!scrollToEditorRef.current) return;
    scrollToEditorRef.current = false;
    editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focusIdx]);

  const load = async (): Promise<SettingsResponse | null> => {
    try {
      const r = await adminFetch('/settings');
      if (!r.ok) return null;
      const j = (await r.json()) as SettingsResponse;
      setData(j); setErr(null);
      return j;
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return null; }
  };

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    (async () => {
      const j = await load();
      if (j?.values) {
        const week = emptyWeek();
        const sched: Schedule | Record<string, (string | null)[]> = j.values.schedule || {};
        for (let d = 0; d < 7; d++) {
          const day = (sched as Record<number, (string | null)[] | undefined>)[d];
          if (Array.isArray(day)) for (let h = 0; h < 24; h++) week[d]![h] = day[h] ?? null;
        }
        const shows: Show[] = (j.values.shows || []).map(hydrateShow);
        setForm({ shows, schedule: week });
      }
    })();
  }, [hydrated, needsAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the skill catalogue once for the programme feature-segment pin.
  // Admin endpoint, so it waits for sign-in. Failures are silent: the picker
  // just shows "Producer's choice" with no pin options.
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/dj/skills');
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { skills?: SkillOption[] };
        if (Array.isArray(j.skills)) setSkills(j.skills.filter(s => s.enabled !== false));
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [hydrated, needsAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the theme list once for the per-show override dropdown. Public
  // endpoint — runs even before sign-in. Failures are silent: the picker
  // just shows "Station default" with no override choices.
  useEffect(() => {
    if (!hydrated) return;
    const API = (process.env.NEXT_PUBLIC_API_URL as string | undefined) || '/api';
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API}/themes`);
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { themes?: ThemeOption[]; active?: string };
        if (Array.isArray(j.themes)) setThemes(j.themes);
        if (typeof j.active === 'string') setActiveThemeId(j.active);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [hydrated]);

  // Fetch library genres once for the show genre autocomplete (admin-gated).
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/library/genres');
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { genres?: { value: string }[] };
        if (Array.isArray(j.genres)) setGenres(j.genres.map(g => g.value).filter(Boolean));
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [hydrated, needsAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch Navidrome playlists once for the show playlist-anchor picker (admin-gated).
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/dj/playlists');
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { results?: { id: string; name: string; songCount: number | null }[] };
        if (Array.isArray(j.results)) setPlaylists(j.results);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [hydrated, needsAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the community show catalog once for the browse-and-install modal.
  // Best-effort like the other catalogs — any failure just leaves it empty so
  // the Community button stays enabled and shows the empty state.
  useEffect(() => {
    if (!hydrated || needsAuth) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch('/shows/community');
        if (!r.ok) throw new Error(`failed (${r.status})`);
        const j = (await r.json()) as { community?: CommunityShow[] };
        if (!cancelled) setCommunity(Array.isArray(j.community) ? j.community : []);
      } catch {
        if (!cancelled) setCommunity([]);
      }
    })();
    return () => { cancelled = true; };
  }, [hydrated, needsAuth]); // eslint-disable-line react-hooks/exhaustive-deps

  const personas: Persona[] = data?.values?.personas || [];
  const moods: string[] = data?.tts?.moods || [];
  const apiBase = (process.env.NEXT_PUBLIC_API_URL as string | undefined) || '/api';
  const personaName = (id: string): string => personas.find(p => p.id === id)?.name || '—';

  // ── inline show editor ─────────────────────────────────────────────────
  // Edits land straight on the show in form state (no draft) — same live-edit
  // model as PersonasPanel. Trimming/cleaning happens once, at Save show.
  const setShow = (i: number, patch: Partial<Show>) =>
    setForm(f => f ? ({ ...f, shows: f.shows.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) }) : f);

  // Open an existing show in the editor below the list, scrolling it into view.
  const focusShow = (i: number) => { scrollToEditorRef.current = true; setCreatingId(null); setFocusIdx(i); };

  // Append a fresh show (persona + mood pre-filled, name blank so it reads as
  // incomplete until named) and open it for editing.
  const addShow = () => {
    if (!form || form.shows.length >= SHOWS_MAX || personas.length === 0) return;
    const id = clientMintId();
    const newIdx = form.shows.length;
    setForm(f => {
      if (!f) return f;
      if (f.shows.length >= SHOWS_MAX) return f;
      return {
        ...f,
        shows: [...f.shows, {
          id, name: '', topic: '',
          personaId: personas[0]?.id || '', guestPersonaIds: [], banter: false, moods: [],
          themeId: '', genres: [], eras: [], energies: [],
          filtersStrict: false, maxTrackSeconds: null,
          playlistIds: [], playlistStrict: false, excludedPlaylistIds: [],
          programme: false, segmentSkill: '',
          spoken: {
            enabled: false, format: 'custom', prompt: '', targetMinutes: 30,
            useWeb: false, musicBreaks: 1,
          },
        }],
      };
    });
    scrollToEditorRef.current = true;
    setCreatingId(id);
    setFocusIdx(newIdx);
    notify.ok('New show added — give it a name and a persona, then Save show.');
  };

  const removeShow = async (i: number) => {
    if (!form) return;
    const target = form.shows[i];
    if (!target) return;
    // Persist the delete immediately — on its own, not waiting for Save schedule.
    // The server removes the show and unschedules it from the grid in one update.
    // A 404 means it's a locally-added show never saved server-side, so the local
    // splice below is all that's needed.
    try {
      const r = await adminFetch(`/shows/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || `failed (${r.status})`);
      }
    } catch (e) {
      notify.err(`Delete failed: ${errorMessage(e)}`);
      return;
    }
    // Remove locally + clear the show from the grid, preserving any unsaved edits
    // to other shows. Splice by id (not index) since the await may have elapsed.
    setForm(f => {
      if (!f) return f;
      const week: Schedule = JSON.parse(JSON.stringify(f.schedule));
      for (let d = 0; d < 7; d++)
        for (let h = 0; h < 24; h++)
          if (week[d]![h] === target.id) week[d]![h] = null;
      return { ...f, shows: f.shows.filter(sh => sh.id !== target.id), schedule: week };
    });
    // Keep the editor focus aligned with the shifted list: close it if the open
    // show was removed, decrement if an earlier one was.
    setFocusIdx(cur => (cur == null ? cur : cur === i ? null : cur > i ? cur - 1 : cur));
    notify.ok(`Deleted “${target.name.trim() || 'show'}”.`);
  };

  // Install a community show: the controller appends it to the persisted show
  // list (unscheduled, owned by the active persona) and returns { shows, show }.
  // We append the returned show to the local form — mapped through the same
  // hydrateShow as the initial load — so any unsaved edits to other shows
  // survive, then arm it as the paint brush and nudge the operator to schedule.
  const install = async (slug: string) => {
    setInstalling(slug);
    try {
      const r = await adminFetch(`/shows/community/${encodeURIComponent(slug)}/install`, { method: 'POST' });
      const j = (await r.json().catch(() => ({}))) as { error?: string; shows?: Array<Partial<Show>>; show?: Partial<Show> | null };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      const added = j.show ? hydrateShow(j.show) : null;
      if (added) {
        setForm(f => f ? { ...f, shows: [...f.shows, added] } : f);
      }
      const host = added?.personaId ? personaName(added.personaId) : 'your active DJ';
      notify.ok(`Installed “${added?.name || slug}” — added unscheduled with ${host} as host. Assign a persona/guests, then schedule it on the Rundown.`);
    } catch (e) {
      notify.err(`Install failed: ${errorMessage(e)}`);
    } finally { setInstalling(null); }
  };

  // ── validation ───────────────────────────────────────────────────────────
  const scheduledHours = form
    ? Object.values(form.schedule).flat().filter(Boolean).length : 0;
  const countHours = (id: string): number => form
    ? Object.values(form.schedule).flat().filter(c => c === id).length : 0;

  // Persist ONE show (add or edit) via POST /shows — independent of any other
  // unsaved / half-finished show in the panel. Only requires THIS show to be
  // valid. On success we swap the local entry for the server's normalized copy
  // (same id — a client-minted s_ id is kept server-side), so unsaved edits to
  // other shows survive.
  const saveShow = async (s: Show): Promise<boolean> => {
    if (!showValid(s)) return false;
    setBusy(true);
    try {
      const r = await adminFetch('/shows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ show: showPayload(s) }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; show?: Partial<Show> | null };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      const saved = j.show ? hydrateShow(j.show) : null;
      if (saved) setForm(f => f ? { ...f, shows: f.shows.map(x => (x.id === s.id ? saved : x)) } : f);
      notify.ok('Show saved.');
      return true;
    } catch (e) {
      notify.err(errorMessage(e));
      return false;
    } finally { setBusy(false); }
  };

  // ── error / loading shells ───────────────────────────────────────────────
  if (err) {
    return (
      <div className="grid gap-4">
        <Card title="Shows" sub="definitions">
          <ErrorState error={err} onRetry={load} />
        </Card>
      </div>
    );
  }
  if (!form) {
    return (
      <div className="grid gap-4">
        <Card title="Shows" sub="definitions">
          <SkeletonRows rows={4} />
        </Card>
      </div>
    );
  }

  // The show open in the inline editor. focusIdx can briefly point past the end
  // after a removal — coerce an out-of-range index to "nothing open".
  const focused = focusIdx != null ? (form.shows[focusIdx] ?? null) : null;

  return (
    <div className="grid gap-4">
      {/* ── WEEKLY SCHEDULE — moved to its own page (The Rundown) ────────── */}
      <section className="card">
        <div className="stack-mobile grid grid-cols-[1fr_auto] items-center gap-4 p-4">
          <div>
            <Eyebrow className="text-vermilion">show plan · the rundown</Eyebrow>
            <div className="mt-1.5 text-[22px] font-extrabold tracking-[-0.02em]">
              Build your shows here. Put them on the air on the Rundown.
            </div>
            <div className="mt-1 max-w-[62ch] text-[11px] leading-[1.6] text-muted">
              This page is the roster — each show&apos;s name, host, brief, and
              sound. The Rundown is the week itself: the board and the on-air
              listing, hour by hour.
            </div>
          </div>
          <div className="flex flex-none flex-col items-start gap-2.5 sm:items-end">
            <div className="flex gap-4">
              <Metric n={String(scheduledHours)} l="hours scheduled" />
              <Metric n={String(168 - scheduledHours)} l="silent" accent={scheduledHours < 168} />
            </div>
            <Button asChild variant="accent" size="sm" className="min-h-9 sm:min-h-0">
              <Link href="/admin/shows/schedule">Open the schedule →</Link>
            </Button>
          </div>
        </div>
      </section>

      {personas.length === 0 && (
        <Card title="Personas required" sub="setup">
          <div className="text-[13px] text-[var(--danger)]">
            No personas defined. Create one under Personas first.
          </div>
        </Card>
      )}

      {/* ── SHOW DEFINITIONS ─────────────────────────────────────────────── */}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
        <span className="caption">show definitions · {form.shows.length}/{SHOWS_MAX} shows</span>
        {/* Own line on a phone: on one row with the caption the cluster runs
            out of width and the Cards/List toggle folds into two stacked
            icons. */}
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
          <span className="flex-none">
            <RosterViewToggle view={view} onChange={setView} />
          </span>
          <Btn
            className="min-h-9 sm:min-h-0"
            onClick={() => setCommunityOpen(true)}
            disabled={!community}
            title="Browse and install shows shared by other stations"
          >
            <Users size={14} /> Community
            {community && community.length > 0 && (
              <span className="ml-1 text-vermilion">{community.length}</span>
            )}
          </Btn>
          <Btn
            tone="accent"
            className="min-h-9 sm:min-h-0"
            onClick={addShow}
            disabled={form.shows.length >= SHOWS_MAX || personas.length === 0}
          >
            + Add show
          </Btn>
        </div>
      </div>
      {form.shows.length === 0 && (
        <EmptyState
          title="No shows scheduled"
          description="Add one to start programming the week."
        />
      )}

      {view === 'list' && form.shows.length > 0 && (
        <ShowsTable
          rows={form.shows.map((s, i) => showRow(s, i, personas, apiBase, countHours(s.id)))}
          onEdit={r => focusShow(r.index)}
        />
      )}

      {view === 'cards' && form.shows.map((s, i) => {
        const ok = showValid(s);
        const hrs = countHours(s.id);
        const host = personas.find(p => p.id === s.personaId) ?? null;
        const guests = (s.guestPersonaIds || [])
          .map(id => personas.find(p => p.id === id))
          .filter((p): p is Persona => Boolean(p));
        return (
          <ShowDefRow
            key={s.id}
            show={s}
            index={i}
            ok={ok}
            hrs={hrs}
            host={host}
            guests={guests}
            apiBase={apiBase}
            onEdit={() => focusShow(i)}
          />
        );
      })}

      {/* ── INLINE SHOW EDITOR ───────────────────────────────────────────── */}
      {focused && focusIdx != null && (
        <ShowEditor
          key={focused.id}
          show={focused}
          editorRef={editorRef}
          personas={personas}
          moods={moods}
          themes={themes}
          skills={skills}
          activeThemeId={activeThemeId}
          genres={genres}
          playlists={playlists}
          apiBase={apiBase}
          adminFetch={adminFetch}
          minTrackSeconds={data?.values?.minTrackSeconds}
          busy={busy}
          isNew={focused.id === creatingId}
          update={(patch) => setShow(focusIdx, patch)}
          onSave={async () => { if (focused && await saveShow(focused)) setFocusIdx(null); }}
          onClose={() => setFocusIdx(null)}
          onRemove={() => setConfirmDeleteIdx(focusIdx)}
        />
      )}

      {/* ── DELETE CONFIRM ───────────────────────────────────────────────── */}
      <V3AlertDialog
        open={confirmDeleteIdx !== null}
        onOpenChange={(o) => { if (!o) setConfirmDeleteIdx(null); }}
        title="Delete show"
        description={
          <>
            Remove{' '}
            <b>{confirmDeleteIdx !== null ? (form.shows[confirmDeleteIdx]?.name.trim() || 'this show') : 'this show'}</b>
            ? This deletes it right away and clears it from any scheduled hours.
            You don&apos;t need to Save schedule.
          </>
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        onConfirm={() => {
          if (confirmDeleteIdx !== null) removeShow(confirmDeleteIdx);
          setConfirmDeleteIdx(null);
        }}
      />

      {/* ── COMMUNITY CATALOG MODAL ──────────────────────────────────────── */}
      <Modal
        open={communityOpen}
        onOpenChange={setCommunityOpen}
        title="community"
        sub="shows shared by other stations"
        width={640}
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <span className="w-full text-[11px] leading-[1.5] text-muted sm:w-auto sm:flex-1">
              Made a show worth sharing? Submit it to the community catalog — a
              maintainer reviews it, then it ships to every station.
            </span>
            <Btn
              className="min-h-9 flex-none sm:min-h-0"
              onClick={() => window.open(showSubmitUrl(), '_blank', 'noopener,noreferrer')}
              title="Open a prefilled community submission on GitHub"
            >
              <Share2 size={14} /> Share a show
            </Btn>
          </div>
        }
      >
        <div className="text-[12px] leading-[1.65] text-muted">
          These shows are shared by other stations and ship with SUB/WAVE.
          <strong> Install</strong> adds one to your show list as your own
          editable show — it arrives <strong>unscheduled</strong> with your
          active persona as host, so assign a persona (and any guest co-hosts),
          then paint it into the weekly grid above.
        </div>
        <div className="mt-4 grid gap-3">
          {community && community.length > 0 ? (
            community.map(c => {
              // Shows can't be installed twice — the controller 409s on a name
              // clash — so flag ones already in your list instead of a button.
              const inShows = form.shows.some(
                s => s.name.trim().toLowerCase() === c.name.trim().toLowerCase(),
              );
              const tags = [...c.moods, ...c.genres, ...c.energies].slice(0, 6);
              return (
                <div
                  key={c.slug}
                  className="grid grid-cols-1 gap-3 border border-ink p-3 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-4"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-extrabold">{c.name}</span>
                      {c.programme && <Pill className="text-[8px]">programme</Pill>}
                      {c.banter && <Pill className="text-[8px]">banter</Pill>}
                      {c.filtersStrict && <Pill className="text-[8px]">strict filters</Pill>}
                    </div>
                    {c.topic && (
                      <div className="mt-1 line-clamp-3 text-[12px] leading-[1.6] text-muted">{c.topic}</div>
                    )}
                    {tags.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {tags.map((t, i) => (
                          <Pill key={`${t}-${i}`} className="text-[8px]">{t}</Pill>
                        ))}
                      </div>
                    )}
                    {(c.submittedBy || c.dateAdded) && (
                      <div className="mt-1.5 text-[10px] leading-[1.5] text-muted">
                        {c.submittedBy && (
                          <>
                            by{' '}
                            <a
                              href={`https://github.com/${c.submittedBy}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-bold text-vermilion underline decoration-[1.5px] underline-offset-2"
                            >
                              @{c.submittedBy}
                            </a>
                          </>
                        )}
                        {c.submittedBy && c.dateAdded && ' · '}
                        {c.dateAdded && <>added {c.dateAdded}</>}
                        {c.dateAdded && c.dateModified && c.dateModified !== c.dateAdded && (
                          <> · updated {c.dateModified}</>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-start gap-2 sm:items-end">
                    {inShows ? (
                      <Pill tone="accent" dot>in your shows</Pill>
                    ) : (
                      <Btn
                        tone="accent"
                        className="min-h-9 sm:min-h-0"
                        onClick={() => install(c.slug)}
                        disabled={installing === c.slug || form.shows.length >= SHOWS_MAX}
                        title={form.shows.length >= SHOWS_MAX ? 'The show list is full' : undefined}
                      >
                        {installing === c.slug ? 'Installing…' : 'Install'}
                      </Btn>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="py-6 text-center text-[13px] text-muted italic">
              No community shows yet.
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

