// The voice-kind registry the DJ recap reads through. The fixed channels are
// declared here; skills/loader.ts registers every loaded skill kind at load
// time via registerSkillKinds(), so a new skill is recapped without editing
// this file.
//
// Part of the queue/ split - see ../queue.ts, which owns the Queue class.



// Voice kinds the DJ recap remembers. The fixed channels are always present;
// every skill kind (built-in + custom) is registered at skill-load time via
// registerSkillKinds() — so a new skill is recapped without editing this list.
// 'handoff' (the two-voice persona mic-pass) counts too, so the incoming DJ's
// next segments don't echo the greeting's opener.
export const VOICE_KINDS = new Set(['dj-speak', 'link', 'station-id', 'hourly-check', 'handoff', 'banter', 'longform']);
// The intro channels tied to a track start rather than the wall clock — the
// standalone-talk-break clock (getLastTalkBreakAt) skips them.
export const TRACK_TIED_KINDS = new Set(['dj-speak', 'link']);
// How long a boundary-deferred segment may wait for a track start before it's
// dropped as stale (its prompt context baked in the clock at generation time).
// Comfortably past a long album cut, well short of the next ident sounding odd.
export const PENDING_VOICE_MAX_AGE_MS = 20 * 60_000;
// Kinds whose recap entries are de-duped. Skills are added at load time too.
// 'handoff' is deliberately NOT deduped — its two lines (sign-off + greeting)
// are distinct utterances by different voices.
export const DEDUPE_KINDS = new Set(['station-id', 'hourly-check']);
export const KIND_LABEL: Record<string, string> = {
  'dj-speak': 'intro',
  'link': 'link',
  'station-id': 'ident',
  'hourly-check': 'hourly',
  'handoff': 'handoff',
  'banter': 'banter',
  'longform': 'longform',
};

// Register the loaded skill kinds (built-in + custom) as recap voice/dedupe
// kinds. Called by skills/loader.js after each (re)load; idempotent (Sets).
export function registerSkillKinds(kinds: string[]): void {
  for (const k of kinds) {
    if (!k) continue;
    VOICE_KINDS.add(k);
    DEDUPE_KINDS.add(k);
  }
}


