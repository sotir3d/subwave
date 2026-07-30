// Relocatable long-form asset references must survive a state-volume move
// without allowing a manifest to name files outside its episode directory.
// Run: npm test -- longform-assets

import assert from 'node:assert/strict';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import {
  longformAudioAssetRef,
  resolveLongformAsset,
} from '../src/broadcast/longform/assets.js';

const stateDir = resolve('tmp', 'portable-state');
const episodeRoot = join(stateDir, 'programmes', 'episode-1');

assert.equal(
  longformAudioAssetRef('chapter 1 / cold-open', 2.9),
  'audio/chapter-1---cold-open-attempt-2.wav',
  'stored refs are portable, sanitised, forward-slash paths',
);
assert.equal(
  longformAudioAssetRef('chapter', 0),
  'audio/chapter-attempt-1.wav',
  'attempt numbers have a stable positive floor',
);

assert.equal(
  resolveLongformAsset(stateDir, 'episode-1', 'audio/chapter-1.wav'),
  join(episodeRoot, 'audio', 'chapter-1.wav'),
  'relative refs resolve below the active state root',
);

for (const escaped of [
  '..',
  '../outside.wav',
  'audio/../../outside.wav',
  '.',
  '',
]) {
  assert.throws(
    () => resolveLongformAsset(stateDir, 'episode-1', escaped),
    /empty|must name a file|escapes its episode directory/,
    `unsafe asset ref is rejected: ${JSON.stringify(escaped)}`,
  );
}

// Old manifests used absolute controller-local paths. They remain readable so
// the runtime can notice a missing Windows render after a Docker migration and
// demote only that chapter back to TTS rather than regenerating its script.
const nativeAbsolute = resolve(stateDir, 'old-render.wav');
assert.equal(resolveLongformAsset(stateDir, 'episode-1', nativeAbsolute), nativeAbsolute);

const legacyWindowsAbsolute = 'D:\\Subwave State\\programmes\\episode-1\\audio\\old.wav';
assert.equal(win32.isAbsolute(legacyWindowsAbsolute), true, 'fixture is a Windows absolute path');
assert.equal(
  resolveLongformAsset(stateDir, 'episode-1', legacyWindowsAbsolute),
  legacyWindowsAbsolute,
  'a Linux controller can still recognise a legacy Windows absolute reference',
);
assert.equal(isAbsolute(resolveLongformAsset(stateDir, 'episode-1', 'audio/chapter-1.wav')), true);

console.log('\x1b[32m✓ long-form relocatable asset contract\x1b[0m');
