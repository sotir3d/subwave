// Contract tests for first-class longform talk playout.
// Run: npm test -- talk-playout

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseTalkMixerEpoch,
  parseTalkPlaybackMarker,
  TALK_EDGE_SEC,
  talkTimelineUri,
  talkTrackId,
} from '../src/broadcast/queue/talk.js';

{
  const uri = talkTimelineUri({
    id: 'episode-1/chapter-2',
    wavPath: '/state/programmes/e1/ch2.wav',
    title: 'Today: "The difficult bit"',
    speaker: 'DJ \\ One',
    durationSec: 125,
    gainDb: -2.5,
  });
  assert.ok(uri.startsWith('annotate:subwave_kind="talk"'), 'typed as a talk timeline item');
  assert.ok(uri.includes('talk_id="episode-1/chapter-2"'), 'stable manifest id rides the URI');
  assert.ok(uri.includes(`subsonic_id="${talkTrackId('episode-1/chapter-2')}"`), 'queue reconciliation id rides the URI');
  assert.ok(uri.includes('title="Today: \\"The difficult bit\\""'), 'metadata quotes are escaped');
  assert.ok(uri.includes('artist="DJ \\\\ One"'), 'metadata backslashes are escaped');
  assert.ok(uri.includes(`liq_cross_duration="${TALK_EDGE_SEC.toFixed(2)}"`), 'talk owns a short exit canvas');
  assert.ok(uri.includes('liq_amplify="-2.5 dB"'), 'optional voice gain rides the timeline item');
  assert.ok(uri.endsWith(':/state/programmes/e1/ch2.wav'), 'rendered WAV is the playable URI');
}

assert.throws(
  () => talkTimelineUri({ id: '', wavPath: '/x.wav', title: 'x' }),
  /talk id is required/,
  'empty correlation ids are rejected',
);

{
  const started = parseTalkPlaybackMarker(JSON.stringify({
    id: 'e1:c1', title: 'Chapter one', speaker: 'Ari', filename: '/x.wav',
    status: 'started', startedAt: 100.25,
  }));
  assert.deepEqual(started, {
    id: 'e1:c1', title: 'Chapter one', speaker: 'Ari', filename: '/x.wav',
    status: 'started', startedAt: 100.25,
  });
  const finished = parseTalkPlaybackMarker(JSON.stringify({
    ...started, status: 'finished', finishedAt: 220.5,
  }));
  assert.equal(finished?.status, 'finished');
  assert.equal(finished?.finishedAt, 220.5);
  assert.equal(parseTalkPlaybackMarker('{broken'), null, 'torn/invalid JSON is ignored');
  assert.equal(parseTalkPlaybackMarker(JSON.stringify({
    ...started, status: 'finished', finishedAt: 99,
  })), null, 'finish cannot precede start');
  const epochMarker = parseTalkPlaybackMarker(JSON.stringify({
    ...started, mixerEpoch: 'mixer-2026-07-30',
  }));
  assert.equal(epochMarker?.mixerEpoch, 'mixer-2026-07-30', 'playback receipts identify their mixer instance');
}

assert.deepEqual(
  parseTalkMixerEpoch(JSON.stringify({ epoch: 'mixer-1', startedAt: 100.5 })),
  { epoch: 'mixer-1', startedAt: 100.5 },
  'valid mixer-instance receipts are accepted',
);
assert.equal(parseTalkMixerEpoch('{broken'), null);
assert.equal(parseTalkMixerEpoch(JSON.stringify({ epoch: '', startedAt: 100 })), null);
assert.equal(parseTalkMixerEpoch(JSON.stringify({ epoch: 'mixer-1', startedAt: 0 })), null);

// Pin the file-IPC and mixer side of the contract. This intentionally checks
// the source text: bringing up Liquidsoap is an image-level smoke test, while
// these invariants should fail fast in the normal controller test suite.
const liq = readFileSync(resolve('..', 'liquidsoap', 'radio.liq'), 'utf8');
assert.ok(liq.includes('talk_edge = a.metadata["subwave_kind"] == "talk"'), 'talk edges are detected in cross()');
assert.ok(liq.includes('sequence(merge=false'), 'talk edges are sequenced with a real lifecycle boundary');
assert.ok(
  !liq.slice(liq.indexOf('if talk_edge then'), liq.indexOf('else', liq.indexOf('if talk_edge then')))
    .includes('sequence(merge=true'),
  'talk transition must not merge speech into the outgoing song lifecycle',
);
assert.ok(liq.includes('talk_timeline_meta = music'), 'post-cross lifecycle observation exists');
assert.ok(liq.includes('status = "started"') && liq.includes('status = "finished"'), 'both acknowledgements are emitted');
assert.ok(
  liq.indexOf('publish_talk_finish(m)', liq.indexOf('def on_talk_timeline_meta'))
    < liq.indexOf('publish_talk_start(m)', liq.indexOf('def on_talk_timeline_meta')),
  'a back-to-back talk closes its predecessor before starting the successor',
);
assert.ok(liq.includes('atomic=true') && liq.includes('temp_dir=talk_tmp_dir'), 'talk marker writes are atomic on the state volume');
assert.ok(liq.includes('"#{state_dir}/talk-playing.json"'), 'marker follows configured state_dir');
assert.ok(!liq.includes('"/var/sub-wave/talk-playing.json"'), 'no hard-coded marker path');
assert.ok(liq.includes('not bed_on_air() and not talk_on_air()'), 'jingles cannot split a talk edge');
assert.ok(
  liq.includes('talk_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/talk")')
    && liq.includes('talk_np_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/talk-now-playing")')
    && liq.includes('talk_epoch_tmp_dir = ensure_tmp_dir("#{state_dir}/tmp/talk-epoch")'),
  'each independently-writing talk marker has its own state-volume temp directory',
);
assert.ok(
  liq.includes('temp_dir=talk_np_tmp_dir, "#{state_dir}/now-playing.json"'),
  'talk now-playing writes do not share the ordinary now-playing atomic temp file',
);
assert.ok(
  liq.includes('temp_dir=talk_epoch_tmp_dir,')
    && liq.includes('"#{state_dir}/talk-mixer-epoch.json"'),
  'mixer boot publishes an atomic epoch receipt',
);
assert.ok(
  liq.indexOf('file.remove("#{state_dir}/talk-playing.json")')
    < liq.indexOf('"#{state_dir}/talk-mixer-epoch.json"'),
  'a new mixer removes the prior instance\'s stale on-air marker before publishing its epoch',
);
assert.ok(
  liq.match(/mixerEpoch = mixer_epoch/g)?.length === 2,
  'both start and finish receipts are tied to the current mixer epoch',
);

const queueSource = readFileSync(resolve('src', 'broadcast', 'queue.ts'), 'utf8');
const enqueueStart = queueSource.indexOf('async enqueueTalk(');
const enqueueEnd = queueSource.indexOf('\n  // Drop now-blocked tracks', enqueueStart);
const enqueueBody = queueSource.slice(enqueueStart, enqueueEnd);
assert.ok(enqueueStart >= 0 && enqueueEnd > enqueueStart, 'enqueueTalk API exists');
assert.ok(enqueueBody.includes('await waitForVoiceIdle(input.signal)'), 'timeline talk waits for an existing overlay to clear');
assert.ok(enqueueBody.includes("this.upcoming.find(i => i.kind === 'talk')"), 'only one prefetched talk is accepted');
assert.ok(!enqueueBody.includes("this.current?.kind === 'talk'"), 'an on-air talk may prefetch one successor');
assert.ok(!enqueueBody.includes('airVoice('), 'enqueueTalk never uses the voice overlay');

const announceStart = queueSource.indexOf('async announce(text');
const announceEnd = queueSource.indexOf('\n  // Air a short multi-voice exchange', announceStart);
const announceBody = queueSource.slice(announceStart, announceEnd);
assert.ok(announceStart >= 0 && announceEnd > announceStart, 'autonomous announce backstop exists');
assert.ok(
  (announceBody.match(/timelineVoiceBlocked\(\)/g) || []).length >= 2,
  'announce checks exclusive ownership before render and again before handoff',
);
assert.ok(
  queueSource.includes("this.dropPendingVoice('a long-form timeline programme owns the microphone')"),
  'an already-rendered deferred voice clip is discarded when timeline ownership begins',
);

const talkDrainStart = queueSource.indexOf("if (item.kind === 'talk')");
const talkDrainEnd = queueSource.indexOf('\n        // Render the track', talkDrainStart);
const talkDrain = queueSource.slice(talkDrainStart, talkDrainEnd);
assert.ok(talkDrain.includes('talkTimelineUri('), 'talk receives a typed annotated URI');
assert.ok(talkDrain.includes('writeHandoff(config.liquidsoap.queueFile'), 'talk uses the single next.txt writer');
assert.ok(!talkDrain.includes('sayFile') && !talkDrain.includes('introFile'), 'talk never enters a ducked handoff');

console.log('\x1b[32m✓ longform talk playout contract\x1b[0m');
