import assert from 'node:assert/strict';
import { coerceSpokenProgramme, minimumSpokenTargetMinutes } from '../src/settings/vocab.js';
import { validateShowsStrict } from '../src/settings/validate.js';

const baseShow = {
  id: 's_spoken',
  name: 'The Spoken Hour',
  topic: 'A thoughtful late-night programme',
  personaId: 'p_host',
  moods: [],
};

assert.deepEqual(coerceSpokenProgramme(undefined), {
  enabled: false,
  format: 'custom',
  prompt: '',
  targetMinutes: 30,
  useWeb: false,
  musicBreaks: 1,
});

assert.deepEqual(coerceSpokenProgramme({
  enabled: true,
  format: 'current-events',
  prompt: '  the day in context  ',
  targetMinutes: 999,
  useWeb: false,
  musicBreaks: -4,
}), {
  enabled: true,
  format: 'current-events',
  prompt: 'the day in context',
  targetMinutes: 180,
  useWeb: true,
  musicBreaks: 0,
});

assert.equal(minimumSpokenTargetMinutes(0), 1);
assert.equal(minimumSpokenTargetMinutes(2), 11);
assert.equal(minimumSpokenTargetMinutes(12), 61);
assert.equal(coerceSpokenProgramme({ targetMinutes: 10, musicBreaks: 2 }).musicBreaks, 1);
const fractional = coerceSpokenProgramme({ targetMinutes: 10.9, musicBreaks: 1.9 });
assert.deepEqual(
  { targetMinutes: fractional.targetMinutes, musicBreaks: fractional.musicBreaks },
  { targetMinutes: 10, musicBreaks: 1 },
);

const [saved] = validateShowsStrict([
  {
    ...baseShow,
    spoken: {
      enabled: true,
      format: 'stories',
      prompt: 'Three connected stories about unexpected kindness.',
      targetMinutes: 30,
      useWeb: false,
      musicBreaks: 2,
    },
  },
], [{ id: 'p_host' }], new Set());

assert.equal(saved.spoken.enabled, true);
assert.equal(saved.spoken.format, 'stories');
assert.equal(saved.spoken.targetMinutes, 30);
assert.equal(saved.spoken.musicBreaks, 2);

assert.throws(() => validateShowsStrict([
  { ...baseShow, spoken: { enabled: true, format: 'unknown', targetMinutes: 30, musicBreaks: 0 } },
], [{ id: 'p_host' }], new Set()), /spoken\.format/);

assert.throws(() => validateShowsStrict([
  { ...baseShow, spoken: { enabled: true, format: 'custom', targetMinutes: 0, musicBreaks: 0 } },
], [{ id: 'p_host' }], new Set()), /spoken\.targetMinutes/);

assert.throws(() => validateShowsStrict([
  { ...baseShow, spoken: { enabled: true, format: 'custom', targetMinutes: 30.5, musicBreaks: 0 } },
], [{ id: 'p_host' }], new Set()), /spoken\.targetMinutes must be an integer/);

assert.throws(() => validateShowsStrict([
  { ...baseShow, spoken: { enabled: true, format: 'custom', targetMinutes: 10, musicBreaks: 2 } },
], [{ id: 'p_host' }], new Set()), /targetMinutes must be at least 11 with 2 planned song breaks/);

assert.throws(() => validateShowsStrict([
  {
    ...baseShow,
    programme: true,
    spoken: { enabled: true, format: 'custom', targetMinutes: 30, musicBreaks: 0 },
  },
], [{ id: 'p_host' }], new Set()), /cannot enable programme and spoken/);

console.log('spoken settings tests passed');
