// Relocatable episode assets. Manifests store forward-slash references below
// their own episode directory; the runtime resolves them against the active
// station state root. Legacy absolute references remain readable so an
// in-progress episode can rerender itself after a Windows -> Docker move.

import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';

export function longformAudioAssetRef(chapterId: string, attempt: number): string {
  const safeChapter = String(chapterId).replace(/[^A-Za-z0-9._-]/g, '-');
  const safeAttempt = Math.max(1, Math.trunc(attempt));
  return `audio/${safeChapter}-attempt-${safeAttempt}.wav`;
}

export function resolveLongformAsset(
  stateDir: string,
  episodeId: string,
  assetRef: string,
): string {
  const ref = String(assetRef || '').trim();
  if (!ref) throw new Error('Long-form asset reference is empty');

  // Preserve old manifests long enough to detect the missing file and demote
  // the chapter to SCRIPTED. win32.isAbsolute is needed when a Linux container
  // opens a manifest produced on D:\ before the state volume was relocated.
  if (isAbsolute(ref) || win32.isAbsolute(ref)) return ref;

  const root = resolve(stateDir, 'programmes', episodeId);
  const full = resolve(root, ref.replaceAll('/', sep));
  const fromRoot = relative(root, full);
  if (!fromRoot || fromRoot === '.') throw new Error('Long-form asset must name a file below its episode');
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Long-form asset escapes its episode directory: ${assetRef}`);
  }
  return full;
}
