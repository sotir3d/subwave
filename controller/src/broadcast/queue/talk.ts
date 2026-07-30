// First-class spoken-word timeline items.
//
// A talk clip is deliberately not sent through say.txt/intro.txt: those are
// overlay buses.  It is annotated and pushed through next.txt, so Liquidsoap's
// request.queue plays it between music tracks as an ordinary timeline item.
// The URI builder is kept pure so the controller/Liquidsoap contract can be
// pinned without starting either process.

import { dirname, join } from 'node:path';
import { config } from '../../config.js';
import { escAnnotate } from '../../music/subsonic.js';

// Talk exits are pause-then-play, not a music crossfade.  radio.liq recognises
// either side of a talk edge and sequences the sources; this small canvas only
// bounds how much of the talk Liquidsoap has to pre-buffer at its own exit.
export const TALK_EDGE_SEC = 0.15;

export interface TalkTimelineInput {
  id: string;
  wavPath: string;
  title: string;
  speaker?: string | null;
  durationSec?: number | null;
  gainDb?: number;
}

export interface TalkPlaybackMarker {
  id: string;
  title: string;
  speaker: string | null;
  filename: string;
  status: 'started' | 'finished';
  startedAt: number;
  finishedAt?: number;
  mixerEpoch?: string;
}

export interface TalkMixerEpoch {
  epoch: string;
  startedAt: number;
}

export function talkTrackId(id: string): string {
  return `talk:${id}`;
}

export function talkTimelineUri(input: TalkTimelineInput): string {
  const id = input.id.trim();
  const title = input.title.trim();
  if (!id) throw new Error('talk id is required');
  if (!title) throw new Error('talk title is required');
  if (!input.wavPath.trim()) throw new Error('talk WAV path is required');

  const fields = [
    'subwave_kind="talk"',
    `talk_id="${escAnnotate(id)}"`,
    `title="${escAnnotate(title)}"`,
    `artist="${escAnnotate(input.speaker || '')}"`,
    'album="Spoken word"',
    `subsonic_id="${escAnnotate(talkTrackId(id))}"`,
    `liq_cross_duration="${TALK_EDGE_SEC.toFixed(2)}"`,
  ];
  if (input.gainDb && Number.isFinite(input.gainDb)) {
    fields.push(`liq_amplify="${escAnnotate(`${input.gainDb} dB`)}"`);
  }
  return `annotate:${fields.join(',')}:${input.wavPath}`;
}

// Derive the marker from the configured state-backed now-playing file.  This
// keeps native Windows, Docker, AIO, and multi-station profiles on the same
// state volume without another hard-coded /var/sub-wave path.
export function talkPlayingFile(): string {
  return join(dirname(config.liquidsoap.nowPlayingFile), 'talk-playing.json');
}

export function talkMixerEpochFile(): string {
  return join(dirname(config.liquidsoap.nowPlayingFile), 'talk-mixer-epoch.json');
}

export function parseTalkMixerEpoch(raw: string): TalkMixerEpoch | null {
  try {
    const value = JSON.parse(raw);
    const epoch = typeof value?.epoch === 'string' ? value.epoch.trim() : '';
    const startedAt = Number(value?.startedAt);
    if (!epoch || !Number.isFinite(startedAt) || startedAt <= 0) return null;
    return { epoch, startedAt };
  } catch {
    return null;
  }
}

export function parseTalkPlaybackMarker(raw: string): TalkPlaybackMarker | null {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value.id !== 'string' || !value.id.trim()) return null;
    if (value.status !== 'started' && value.status !== 'finished') return null;
    const startedAt = Number(value.startedAt);
    if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
    const finishedAt = value.finishedAt == null ? undefined : Number(value.finishedAt);
    if (value.status === 'finished' && (!Number.isFinite(finishedAt) || finishedAt! < startedAt)) {
      return null;
    }
    return {
      id: value.id,
      title: typeof value.title === 'string' ? value.title : 'Spoken word',
      speaker: typeof value.speaker === 'string' && value.speaker ? value.speaker : null,
      filename: typeof value.filename === 'string' ? value.filename : '',
      status: value.status,
      startedAt,
      ...(finishedAt == null ? {} : { finishedAt }),
      ...(typeof value.mixerEpoch === 'string' && value.mixerEpoch.trim()
        ? { mixerEpoch: value.mixerEpoch.trim() }
        : {}),
    };
  } catch {
    return null;
  }
}
