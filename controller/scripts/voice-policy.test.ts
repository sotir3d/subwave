// Pins the station-wide voice switch (settings.tts.enabled → broadcast/voice-policy.ts).
//
// The switch makes the station music-only: every AUTONOMOUS talk moment stands
// down, while picks, listener requests, jingles and manual /dj/segment triggers
// carry on. Two properties are load-bearing and easy to regress:
//
//  - OFF is opt-in only. A settings.json written before the key existed (and a
//    non-boolean written by hand) must read as ON, or an upgrade silently gags
//    every existing station.
//  - The switch sits ABOVE the frequency ladder in dj-gate.shouldFire(). It's
//    not a cadence — an 'aggressive' persona with the voice off must still fire
//    nothing, at any minute of the hour.
//
// STATE_DIR is redirected at a throwaway dir BEFORE the first import, so
// settings.load()/update() touch nothing real — hence the dynamic imports.
// node:assert-via-tsx style, matching scripts/stations-manager.test.ts.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-voice-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const {
  voiceEnabled,
  autoVoiceAllowed,
  voiceStatus,
  setExclusiveTimelineVoiceOwner,
  exclusiveTimelineVoiceOwner,
  timelineVoiceBlocked,
} = await import('../src/broadcast/voice-policy.js');
const { shouldFire } = await import('../src/broadcast/dj-gate.js');
const { requestSchema } = await import('../src/broadcast/dj-agent/schemas.js');

// requestSchema() is now wrapped in modelTolerant (z.preprocess) — see the C1
// chat-escape work (Task 5) — so the plain ZodObject's `.shape` sits one level
// down, at `.def.out.shape`. Falls back to `.shape` so this keeps working if a
// future change ever hands back an unwrapped object again.
function shapeOf(schema: any): Record<string, unknown> {
  return schema?.def?.out?.shape ?? schema.shape;
}

// Every kind dj-gate arbitrates. All must go quiet together — a kind added to
// shouldFire() without a voice check would slip through this list, so keep it
// in sync with the `kind ===` branches there.
const KINDS = ['stationId', 'hourly', 'banter'];

// Minutes that between them hit every slot any kind fires on (:00 hourly,
// :15/:30/:45 idents, :20/:50 banter) plus a couple that fire on none.
const MINUTES = [0, 7, 15, 20, 30, 45, 50, 59];

function atMinute(m: number): Date {
  // Fixed date so the hourly gate's even/odd-hour rung is deterministic; hour 10
  // is even, so a 'quiet' persona would fire the hourly check here if allowed.
  return new Date(2026, 0, 15, 10, m, 0);
}

try {
  // ── Default: absent key reads as ON ────────────────────────────────────────
  await settings.load();
  assert.equal(voiceEnabled(), true, 'fresh install defaults to voice ON');
  assert.equal(autoVoiceAllowed(), true, 'fresh install allows autonomous voice');
  assert.deepEqual(voiceStatus(), {
    enabled: true,
    timelineOwner: null,
    autonomousAllowed: true,
  }, 'status snapshot mirrors both voice gates');

  // A persona loud enough that every slot is live — the baseline the OFF case
  // is measured against. Without this the "nothing fires" assertions below
  // could pass for the wrong reason (a quiet persona firing nothing anyway).
  await settings.update({
    personas: settings.get().personas.map((p: { id: string }, i: number) =>
      (i === 0 ? { ...p, frequency: 'aggressive', djMode: false } : p)),
  });
  const liveSlots = MINUTES.flatMap(m => KINDS.map(k => ({ k, m })))
    .filter(({ k, m }) => shouldFire(k, atMinute(m)));
  assert.ok(
    liveSlots.length > 0,
    'baseline: an aggressive persona fires SOMETHING, else the OFF assertions are vacuous',
  );

  // ── OFF: nothing autonomous fires, at any minute, for any kind ─────────────
  setExclusiveTimelineVoiceOwner('episode:morning-story');
  assert.equal(exclusiveTimelineVoiceOwner(), 'episode:morning-story');
  assert.equal(timelineVoiceBlocked(), true);
  assert.equal(voiceEnabled(), true, 'exclusive ownership does not rewrite the operator switch');
  assert.equal(autoVoiceAllowed(), false, 'autonomous voice stands down while long-form owns the mic');
  assert.deepEqual(voiceStatus(), {
    enabled: true,
    timelineOwner: 'episode:morning-story',
    autonomousAllowed: false,
  });
  for (const m of MINUTES) {
    for (const k of KINDS) {
      assert.equal(shouldFire(k, atMinute(m)), false, `timeline owner gags ${k} at :${m}`);
    }
  }
  assert.ok(
    !('intro' in shapeOf(requestSchema())),
    'request-agent contract cannot generate a ducked intro over timeline narration',
  );

  setExclusiveTimelineVoiceOwner('   ');
  assert.equal(exclusiveTimelineVoiceOwner(), null, 'blank owner releases the lease');
  assert.equal(timelineVoiceBlocked(), false);
  assert.equal(autoVoiceAllowed(), true);
  assert.ok('intro' in shapeOf(requestSchema()), 'releasing the timeline restores voice contracts');
  const afterExclusive = MINUTES.flatMap(m => KINDS.map(k => ({ k, m })))
    .filter(({ k, m }) => shouldFire(k, atMinute(m)));
  assert.deepEqual(afterExclusive, liveSlots, 'exclusive ownership is fully reversible');

  await settings.update({ tts: { enabled: false } });
  assert.equal(voiceEnabled(), false, 'update({tts:{enabled:false}}) takes effect');
  assert.equal(autoVoiceAllowed(), false, 'autonomous voice is refused');
  assert.deepEqual(voiceStatus(), {
    enabled: false,
    timelineOwner: null,
    autonomousAllowed: false,
  }, 'status snapshot follows');

  for (const m of MINUTES) {
    for (const k of KINDS) {
      assert.equal(
        shouldFire(k, atMinute(m)),
        false,
        `voice off must gag ${k} at :${String(m).padStart(2, '0')} even on an aggressive persona`,
      );
    }
  }

  // The request agent's contract follows the switch: voice off removes the
  // intro field entirely, so no tokens are ever spent writing a line that
  // can't air (the pick-path counterpart is wantLink=false).
  assert.ok(!('intro' in shapeOf(requestSchema())), 'voice off: requestSchema drops the intro field');

  // ── Back ON: the ladder resumes exactly as before ──────────────────────────
  await settings.update({ tts: { enabled: true } });
  assert.equal(voiceEnabled(), true, 'the switch is reversible');
  assert.ok('intro' in shapeOf(requestSchema()), 'voice on: requestSchema offers the intro field again');
  const resumed = MINUTES.flatMap(m => KINDS.map(k => ({ k, m })))
    .filter(({ k, m }) => shouldFire(k, atMinute(m)));
  assert.deepEqual(resumed, liveSlots, 'flipping back restores the exact same slots');

  // ── Validation: only a boolean is accepted ─────────────────────────────────
  await assert.rejects(
    () => settings.update({ tts: { enabled: 'no' } } as never),
    /tts\.enabled must be a boolean/,
    'a non-boolean is rejected rather than coerced to falsy (an accidental gag)',
  );
  assert.equal(voiceEnabled(), true, 'the rejected write left the switch untouched');

  // ── Migration: a settings.json with no `enabled` key loads as ON ───────────
  // The upgrade path. Written straight to disk, since update() would add the key.
  const stored = JSON.parse(
    (await import('node:fs')).readFileSync(join(root, 'settings.json'), 'utf8'),
  );
  delete stored.tts.enabled;
  writeFileSync(join(root, 'settings.json'), JSON.stringify(stored));
  await settings.load();
  assert.equal(voiceEnabled(), true, 'a pre-upgrade settings.json reads as voice ON');

  // Hand-edited garbage is coerced the same way, not treated as falsy.
  stored.tts.enabled = 'false';
  writeFileSync(join(root, 'settings.json'), JSON.stringify(stored));
  await settings.load();
  assert.equal(voiceEnabled(), true, 'a non-boolean on disk coerces to ON, never OFF');

  console.log('voice-policy.test.ts — all assertions passed');
} finally {
  setExclusiveTimelineVoiceOwner(null);
  rmSync(root, { recursive: true, force: true });
}
