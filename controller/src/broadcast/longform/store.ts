import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LongformManifest } from './types.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface ActivePointer {
  schemaVersion: 1;
  episodeId: string | null;
}

function transientRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

// Windows virus scanners/indexers can briefly hold the destination between
// write and rename. Retry the SAME adjacent temp file so every attempt remains
// an atomic replace and no abandoned random temp files accumulate.
async function writeAtomic(path: string, contents: string): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, contents);
  const delays = [0, 5, 20, 50, 100];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    try {
      await rename(tmp, path);
      return;
    } catch (error) {
      lastError = error;
      if (!transientRenameError(error)) break;
    }
  }
  try { await unlink(tmp); } catch {}
  throw lastError;
}

function parseJson<T>(contents: string, label: string): T {
  try {
    return JSON.parse(contents) as T;
  } catch (error) {
    throw new Error(`Invalid longform ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function assertSafeEpisodeId(id: string): void {
  if (!SAFE_ID.test(id)) {
    throw new Error('Longform episode id must be 1-128 filesystem-safe characters');
  }
}

/**
 * Durable episode storage. Writes are serialised in invocation order so two
 * concurrently finishing production stages cannot let an older snapshot land
 * after a newer one. Each individual file is replaced atomically.
 */
export class LongformEpisodeStore {
  readonly programmesDir: string;
  readonly activeFile: string;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(readonly stateDir: string) {
    this.programmesDir = join(stateDir, 'programmes');
    this.activeFile = join(this.programmesDir, 'active.json');
  }

  episodeDir(id: string): string {
    assertSafeEpisodeId(id);
    return join(this.programmesDir, id);
  }

  manifestFile(id: string): string {
    return join(this.episodeDir(id), 'episode.json');
  }

  async save(manifest: LongformManifest): Promise<void> {
    assertSafeEpisodeId(manifest.id);
    // Serialise now, while this exact revision is current. The queued writes
    // then preserve the same revision ordering on disk.
    const body = JSON.stringify(manifest, null, 2);
    const pointer = JSON.stringify({ schemaVersion: 1, episodeId: manifest.id } satisfies ActivePointer, null, 2);
    const episodeDir = this.episodeDir(manifest.id);
    const manifestFile = this.manifestFile(manifest.id);

    const write = this.writeTail.then(async () => {
      await mkdir(episodeDir, { recursive: true });
      await writeAtomic(manifestFile, body);
      await writeAtomic(this.activeFile, pointer);
    });
    // Keep the queue usable after a failed write while still returning the
    // original rejection to the caller that owns it.
    this.writeTail = write.catch(() => {});
    return write;
  }

  async load(id: string): Promise<LongformManifest | null> {
    assertSafeEpisodeId(id);
    try {
      const parsed = parseJson<LongformManifest>(await readFile(this.manifestFile(id), 'utf8'), `manifest ${id}`);
      if (parsed?.schemaVersion !== 1 || parsed.id !== id || !Array.isArray(parsed.chapters)) {
        throw new Error(`Invalid longform manifest ${id}: unsupported shape`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async loadActive(): Promise<LongformManifest | null> {
    let pointer: ActivePointer;
    try {
      pointer = parseJson<ActivePointer>(await readFile(this.activeFile, 'utf8'), 'active pointer');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    }
    if (pointer?.schemaVersion !== 1) throw new Error('Invalid longform active pointer: unsupported shape');
    if (pointer.episodeId === null) return null;
    assertSafeEpisodeId(pointer.episodeId);
    const manifest = await this.load(pointer.episodeId);
    if (!manifest) throw new Error(`Longform active manifest ${pointer.episodeId} is missing`);
    return manifest;
  }

  async flush(): Promise<void> {
    await this.writeTail;
  }
}
