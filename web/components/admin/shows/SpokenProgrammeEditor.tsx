'use client';

import type { ChangeEvent } from 'react';
import { Input } from '../../ui/input';
import { Textarea } from '../../ui/textarea';
import { Label } from '../../ui/label';
import { Field } from '../../ui/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../ui/select';
import { Toggle } from '../ui';
import type { Show, SpokenFormat } from './types';

interface SpokenProgrammeEditorProps {
  show: Show;
  update: (patch: Partial<Show>) => void;
}

const SPOKEN_TARGET_MINUTES_MIN = 1;
const SPOKEN_TARGET_MINUTES_MAX = 180;
const SPOKEN_MUSIC_BREAKS_MAX = 12;
const ASSUMED_SONG_MINUTES = 4;
const MINIMUM_SPOKEN_ACT_MINUTES = 1;

function integerInRange(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function minimumTargetMinutes(musicBreaks: number): number {
  return musicBreaks * ASSUMED_SONG_MINUTES
    + (musicBreaks + 1) * MINIMUM_SPOKEN_ACT_MINUTES;
}

/** Editor for a listener-triggered long-form block. This deliberately edits
 * one compact nested value on the show: the runtime producer owns chapter
 * sizing and buffering, while the operator describes editorial intent. */
export function SpokenProgrammeEditor({ show, update }: SpokenProgrammeEditorProps) {
  const spoken = show.spoken;
  const patch = (next: Partial<Show['spoken']>) => update({ spoken: { ...spoken, ...next } });
  const minimumTarget = minimumTargetMinutes(spoken.musicBreaks);

  return (
    <Field>
      <div className="flex items-start gap-3">
        <div className="pt-0.5">
          <Toggle
            on={spoken.enabled}
            onClick={() => update({
              // These are alternative episode directors. Long-form owns its
              // complete talk arc, so enabling it retires the legacy timed
              // intro/feature/outro beats for this show.
              programme: spoken.enabled ? show.programme : false,
              spoken: { ...spoken, enabled: !spoken.enabled },
            })}
            ariaLabel="Long-form spoken section"
          />
        </div>
        <div className="grid gap-0.5">
          <Label>Long-form spoken section</Label>
          <span className="field-hint">
            Produce this block just in time when somebody tunes in. Music remains
            on air while the LLM and voice service warm up, and fills any gap if
            production falls behind.
          </span>
        </div>
      </div>

      {spoken.enabled && (
        <div className="mt-3 grid gap-3 border-l border-separator-strong pl-3">
          <div className="grid gap-1">
            <Label>spoken format</Label>
            <Select
              value={spoken.format}
              onValueChange={value => patch({
                format: value as SpokenFormat,
                useWeb: value === 'current-events' ? true : spoken.useWeb,
              })}
            >
              <SelectTrigger aria-label="Spoken format"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="custom">Custom brief</SelectItem>
                  <SelectItem value="current-events">Current-events roundup</SelectItem>
                  <SelectItem value="stories">Several short stories</SelectItem>
                  <SelectItem value="dj-story">The DJ tells a story</SelectItem>
                  <SelectItem value="dj-diary">The DJ talks about their day</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <Label htmlFor="spoken-target-minutes">total minutes</Label>
              <Input
                id="spoken-target-minutes"
                type="number" min={minimumTarget} max={SPOKEN_TARGET_MINUTES_MAX} step={1}
                value={spoken.targetMinutes}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const requested = integerInRange(
                    e.target.value,
                    SPOKEN_TARGET_MINUTES_MIN,
                    SPOKEN_TARGET_MINUTES_MAX,
                  );
                  patch({ targetMinutes: Math.max(minimumTarget, requested) });
                }}
              />
              <span className="field-hint">
                Includes song breaks. With {spoken.musicBreaks} song break{spoken.musicBreaks === 1 ? '' : 's'}, the minimum is {minimumTarget} minutes.
              </span>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="spoken-music-breaks">song breaks</Label>
              <Input
                id="spoken-music-breaks"
                type="number" min={0} max={SPOKEN_MUSIC_BREAKS_MAX} step={1}
                value={spoken.musicBreaks}
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  const musicBreaks = integerInRange(e.target.value, 0, SPOKEN_MUSIC_BREAKS_MAX);
                  patch({
                    musicBreaks,
                    targetMinutes: Math.max(spoken.targetMinutes, minimumTargetMinutes(musicBreaks)),
                  });
                }}
              />
              <span className="field-hint">
                The producer chooses placement; each complete song is budgeted at about 4 minutes.
              </span>
            </div>
          </div>

          <div className="grid gap-1">
            <Label htmlFor="spoken-brief">section brief</Label>
            <Textarea
              id="spoken-brief"
              value={spoken.prompt}
              maxLength={4000}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => patch({ prompt: e.target.value })}
              placeholder="What should the DJ explore, how should it feel, and what should the listener take away?"
              rows={5}
            />
            <span className="field-hint">{spoken.prompt.length}/4000 · the show topic is supplied too</span>
          </div>

          <div className="flex items-start gap-3">
            <div className="pt-0.5">
              <Toggle
                on={spoken.useWeb || spoken.format === 'current-events'}
                disabled={spoken.format === 'current-events'}
                onClick={() => patch({ useWeb: !spoken.useWeb })}
                ariaLabel="Use web research"
              />
            </div>
            <div className="grid gap-0.5">
              <Label>Use web research</Label>
              <span className="field-hint">
                Research is fetched before each relevant chapter and kept outside
                the single LLM inference lane.
              </span>
            </div>
          </div>
        </div>
      )}
    </Field>
  );
}
