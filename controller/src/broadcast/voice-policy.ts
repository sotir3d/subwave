// Station-wide voice switch — the enforcement policy.
//
// `settings.tts.enabled: false` turns the station into music only: the DJ never
// speaks. Same split as broadcast/dj-budget.ts — call sites ask a question, this
// module answers it, and the policy lives in exactly one place rather than as
// inline `settings.get().tts.enabled` reads scattered through the broadcast path.
//
// The gate sits BEFORE generation, not at speak(). Gating the dispatcher would
// still have the LLM write every link, ident and feature first, then throw them
// away — wasted tokens and a booth log full of failures. So each autonomous
// talk site asks `autoVoiceAllowed()` at the same point it already asks
// `djCallsAllowed()` / `optionalSegmentsAllowed()`, and simply doesn't start.
//
// What stays running with voice off:
//   - Track picks. The stream needs a next track; only the LINK is dropped
//     (dj-agent.runTrackEvent forces wantLink=false, so the agent path is told
//     to stay silent and the pool path skips generateLink).
//   - Listener requests. The track is still found and queued and the listener
//     still gets their text ack — there's just no spoken intro over it, and
//     the request agent's schema drops the intro field (requestSchema) so no
//     tokens are spent writing one.
//   - Jingles. Pre-rendered WAVs on Liquidsoap's own rotate, nothing to do with
//     TTS at runtime. Silence those with `jingleRatio: 0` (needs a mixer restart).
//   - Manual /dj/segment triggers. An explicit operator action always fires —
//     the same exemption those runners already have from the frequency gate and
//     the LLM hard cap. They call the gate-free `run*` cores directly.
//
// Read live on every call, so the toggle applies to the next tick with no
// restart and no mixer bounce.

import * as settings from '../settings.js';

// A scheduled long-form episode is a real timeline programme, not another
// ducked voice clip. While it owns the microphone, autonomous links, idents,
// skills and banter must not be generated or queued: they would otherwise
// remain eligible to play over the narration (or turn into stale speech after
// it). The runtime sets/clears this process-local lease at show boundaries.
let exclusiveTimelineOwner: string | null = null;

export function setExclusiveTimelineVoiceOwner(owner: string | null): void {
  exclusiveTimelineOwner = owner && owner.trim() ? owner.trim() : null;
}

export function exclusiveTimelineVoiceOwner(): string | null {
  return exclusiveTimelineOwner;
}

export function timelineVoiceBlocked(): boolean {
  return exclusiveTimelineOwner !== null;
}

// The raw switch. Absent/non-boolean (any settings.json written before the key
// existed) reads as ON, so an upgrade changes nothing.
export function voiceEnabled(): boolean {
  return settings.get()?.tts?.enabled !== false;
}

// May an AUTONOMOUS talk moment start? The question every cron tick, boundary
// hook and pick cycle asks. Manual runners must NOT call this.
export function autoVoiceAllowed(): boolean {
  return voiceEnabled() && !timelineVoiceBlocked();
}

// Snapshot for the admin /debug surface, alongside budgetStatus().
export function voiceStatus() {
  return {
    enabled: voiceEnabled(),
    timelineOwner: exclusiveTimelineOwner,
    autonomousAllowed: autoVoiceAllowed(),
  };
}
