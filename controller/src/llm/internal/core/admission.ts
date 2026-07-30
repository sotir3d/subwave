// Station-wide LLM admission control.
//
// The controller has several independently scheduled model consumers (track
// picks, listener requests, spoken segments, programmes, and the library
// tagger). Provider-side concurrency limits alone cannot decide which of those
// should run next, and a local llama.cpp server is most predictable with one
// request in flight. Every public LLM primitive therefore takes one lease from
// this queue around its WHOLE logical operation, including recovery, transient
// retries, and primary -> fallback failover.

import { readFileSync, unlinkSync } from 'node:fs';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../../../config.js';

export const LLM_ADMISSION_PRIORITY = Object.freeze({
  listener: 0,
  playout: 10,
  live: 30,
  normal: 50,
  longform: 70,
  background: 90,
});

export interface LlmAdmissionMetadata {
  kind: string;
  // Lower values run first. Calls with the same priority remain FIFO.
  priority?: number;
  // Absolute wall-clock deadline (Date.now() milliseconds or a Date). It is
  // informational unless dropIfLate is true.
  neededBy?: number | Date;
  dropIfLate?: boolean;
  // Aborting while queued removes the call without consuming the inference
  // slot. Once active, the strategy owns propagation to the model transport;
  // admission keeps the lease until that logical call actually settles.
  signal?: AbortSignal;
}

export interface LlmAdmissionEntryStatus {
  id: number;
  kind: string;
  priority: number;
  enqueuedAt: number;
  neededBy?: number;
  dropIfLate: boolean;
  startedAt?: number;
}

export interface LlmAdmissionStatus {
  active: LlmAdmissionEntryStatus | null;
  queued: number;
  waiting: LlmAdmissionEntryStatus[];
}

interface QueueEntry extends LlmAdmissionEntryStatus {
  sequence: number;
  signal?: AbortSignal;
  task: () => Promise<unknown> | unknown;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  onAbort?: () => void;
  settled: boolean;
}

const REQUEST_KINDS = /request/i;
const PLAYOUT_KINDS = /(?:pick|playlistcurate)/i;
const LIVE_KINDS = /(?:link|intro|outro|hourly|station.?id|handoff|signoff|adlib|banter|segment)/i;
const LONGFORM_KINDS = /(?:longform|programme)/i;
const BACKGROUND_KINDS = /(?:tag.?library|batch|generatepersona|generateshow|generatetheme|generatesaysuggestions)/i;

export function defaultLlmAdmissionPriority(kind: string): number {
  const value = String(kind || '');
  if (REQUEST_KINDS.test(value)) return LLM_ADMISSION_PRIORITY.listener;
  if (PLAYOUT_KINDS.test(value)) return LLM_ADMISSION_PRIORITY.playout;
  if (LIVE_KINDS.test(value)) return LLM_ADMISSION_PRIORITY.live;
  if (LONGFORM_KINDS.test(value)) return LLM_ADMISSION_PRIORITY.longform;
  if (BACKGROUND_KINDS.test(value)) return LLM_ADMISSION_PRIORITY.background;
  return LLM_ADMISSION_PRIORITY.normal;
}

export function resolveLlmAdmissionPriority(kind: string, override?: number): number {
  return Number.isFinite(override) ? Number(override) : defaultLlmAdmissionPriority(kind);
}

export class LlmAdmissionDroppedError extends Error {
  readonly kind: string;
  readonly neededBy: number;

  constructor(kind: string, neededBy: number) {
    super(`LLM call "${kind}" missed its ${new Date(neededBy).toISOString()} admission deadline`);
    this.name = 'LlmAdmissionDroppedError';
    this.kind = kind;
    this.neededBy = neededBy;
  }
}

function queuedAbortError(kind: string, signal?: AbortSignal): Error {
  const reason = signal?.reason;
  const detail = reason instanceof Error && reason.message ? `: ${reason.message}` : '';
  const err = new Error(`LLM call "${kind}" was aborted while waiting for admission${detail}`);
  err.name = 'AbortError';
  return err;
}

function neededByMs(value: number | Date | undefined): number | undefined {
  const n = value instanceof Date ? value.getTime() : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function statusOf(entry: QueueEntry): LlmAdmissionEntryStatus {
  return {
    id: entry.id,
    kind: entry.kind,
    priority: entry.priority,
    enqueuedAt: entry.enqueuedAt,
    ...(entry.neededBy != null ? { neededBy: entry.neededBy } : {}),
    dropIfLate: entry.dropIfLate,
    ...(entry.startedAt != null ? { startedAt: entry.startedAt } : {}),
  };
}

/**
 * A deterministic priority queue with a concurrency of one.
 *
 * The clock is injectable so ordering/deadline behavior can be tested without
 * timers or a real model. A deadline is checked at enqueue and immediately
 * before task start; an active logical call is never preempted by the queue.
 */
export class LlmAdmissionQueue {
  private readonly now: () => number;
  private nextId = 1;
  private nextSequence = 1;
  private active: QueueEntry | null = null;
  private waiting: QueueEntry[] = [];

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  run<T>(metadata: LlmAdmissionMetadata, task: () => Promise<T> | T): Promise<T> {
    const kind = String(metadata.kind || 'sdk.llm');
    const enqueuedAt = this.now();
    const deadline = neededByMs(metadata.neededBy);
    const dropIfLate = metadata.dropIfLate === true;

    if (metadata.signal?.aborted) {
      return Promise.reject(queuedAbortError(kind, metadata.signal));
    }
    if (dropIfLate && deadline != null && deadline <= enqueuedAt) {
      return Promise.reject(new LlmAdmissionDroppedError(kind, deadline));
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        id: this.nextId++,
        sequence: this.nextSequence++,
        kind,
        priority: resolveLlmAdmissionPriority(kind, metadata.priority),
        enqueuedAt,
        ...(deadline != null ? { neededBy: deadline } : {}),
        dropIfLate,
        signal: metadata.signal,
        task,
        resolve: (value) => resolve(value as T),
        reject,
        settled: false,
      };

      if (entry.signal) {
        entry.onAbort = () => {
          // Active work owns cancellation and keeps its lease until its model
          // promise settles. Only a queued entry can be removed here.
          if (this.active === entry || entry.settled) return;
          const index = this.waiting.indexOf(entry);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          this.settleRejected(entry, queuedAbortError(kind, entry.signal));
        };
        entry.signal.addEventListener('abort', entry.onAbort, { once: true });
      }

      this.waiting.push(entry);
      this.waiting.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
      this.drain();
    });
  }

  status(): LlmAdmissionStatus {
    return {
      active: this.active ? statusOf(this.active) : null,
      queued: this.waiting.length,
      waiting: this.waiting.map(statusOf),
    };
  }

  private drain(): void {
    if (this.active) return;

    while (this.waiting.length > 0) {
      const entry = this.waiting.shift()!;
      if (entry.signal?.aborted) {
        this.settleRejected(entry, queuedAbortError(entry.kind, entry.signal));
        continue;
      }
      if (entry.dropIfLate && entry.neededBy != null && entry.neededBy <= this.now()) {
        this.settleRejected(entry, new LlmAdmissionDroppedError(entry.kind, entry.neededBy));
        continue;
      }

      entry.startedAt = this.now();
      this.active = entry;

      // Start in a microtask so run() always returns its promise before a
      // synchronous task can settle it. Re-check queue metadata in that
      // microtask to close the abort/deadline gap between dequeue and start.
      Promise.resolve()
        .then(() => {
          if (entry.signal?.aborted) throw queuedAbortError(entry.kind, entry.signal);
          if (entry.dropIfLate && entry.neededBy != null && entry.neededBy <= this.now()) {
            throw new LlmAdmissionDroppedError(entry.kind, entry.neededBy);
          }
          return entry.task();
        })
        .then(
          (value) => {
            this.settleResolved(entry, value);
            this.release(entry);
          },
          (err) => {
            this.settleRejected(entry, err);
            this.release(entry);
          },
        );
      return;
    }
  }

  private cleanup(entry: QueueEntry): void {
    if (entry.onAbort && entry.signal) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
  }

  private release(entry: QueueEntry): void {
    if (this.active === entry) this.active = null;
    this.drain();
  }

  private settleResolved(entry: QueueEntry, value: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    this.cleanup(entry);
    entry.resolve(value);
  }

  private settleRejected(entry: QueueEntry, reason: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    this.cleanup(entry);
    entry.reject(reason);
  }
}

const stationLlmAdmission = new LlmAdmissionQueue();

// The library tagger is a separate Node process, so its module-level queue is
// necessarily a different singleton. An atomic create in the install-level
// state root extends the lease across the controller and tagger when they see
// the same shared state and PID namespace. The in-process priority queue still
// decides which local caller gets to contend for it.
//
// This file lease is deliberately only a same-host/process-namespace safety
// net: process.kill(pid, 0) cannot prove liveness across hosts or isolated PID
// namespaces. Operators sharing one llama.cpp server across those boundaries
// should keep llama.cpp at --parallel 1 as the final concurrency backstop.
//
// Recovery is conservative. A short-lived reaper mutex prevents two waiters
// from both deleting a lease, and a healthy owner is never reaped merely for
// being old. The process-instance token handles PID reuse after a restart
// (notably Docker PID 1) without imposing a maximum duration on valid calls.
const PROCESS_LEASE_FILE = join(config.stateRoot, 'llm-admission.lock');
const PROCESS_REAPER_FILE = join(config.stateRoot, 'llm-admission.reaper.lock');
const PROCESS_LEASE_POLL_MS = 100;
const PROCESS_LEASE_DEAD_OWNER_GRACE_MS = 30_000;
const PROCESS_REAPER_DEAD_OWNER_GRACE_MS = 60_000;
const PROCESS_INSTANCE_TOKEN = randomUUID();

export interface ProcessLeaseOwner {
  token: string;
  pid: number;
  // Optional only so a stale lease written by a pre-token release can still be
  // recovered after upgrade. Every new owner always writes this field.
  instanceToken?: string;
  kind: string;
  acquiredAt: number;
}

export type StaleProcessLeaseReason = 'dead-owner' | 'previous-process-instance';

/**
 * Pure stale-owner decision used by the filesystem reaper and unit tests.
 * There is intentionally no maximum-age branch: a live inference keeps its
 * lease for however long its transport takes to settle.
 */
export function staleProcessLeaseReason(
  owner: ProcessLeaseOwner,
  now: number,
  currentPid: number,
  currentInstanceToken: string,
  ownerIsAlive: boolean,
  graceMs: number = PROCESS_LEASE_DEAD_OWNER_GRACE_MS,
): StaleProcessLeaseReason | null {
  const age = now - Number(owner.acquiredAt);
  if (!Number.isFinite(age) || age < graceMs) return null;
  if (Number(owner.pid) === currentPid && owner.instanceToken !== currentInstanceToken) {
    return 'previous-process-instance';
  }
  if (!ownerIsAlive) return 'dead-owner';
  return null;
}

function parseProcessLeaseOwner(raw: string): ProcessLeaseOwner | null {
  try {
    const owner = JSON.parse(raw) as Partial<ProcessLeaseOwner>;
    if (typeof owner.token !== 'string' || !owner.token) return null;
    if (!Number.isInteger(owner.pid) || Number(owner.pid) <= 0) return null;
    if (typeof owner.kind !== 'string') return null;
    if (!Number.isFinite(owner.acquiredAt)) return null;
    if (owner.instanceToken != null && typeof owner.instanceToken !== 'string') return null;
    return owner as ProcessLeaseOwner;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.  Treat it as
    // alive; stealing that lease would violate the single-flight invariant.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function waitForLeasePoll(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(queuedAbortError('process lease', signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, PROCESS_LEASE_POLL_MS);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(queuedAbortError('process lease', signal));
    };
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

let activeProcessLeaseToken: string | null = null;
let activeProcessReaperToken: string | null = null;

async function releaseOwnedFile(file: string, token: string, label: string): Promise<void> {
  try {
    const current = parseProcessLeaseOwner(await readFile(file, 'utf8'));
    if (current?.token === token) await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error(`[llm-admission] could not release ${label}:`, error);
    }
  }
}

function releaseOwnedFileSync(file: string, token: string | null): void {
  if (!token) return;
  try {
    const current = parseProcessLeaseOwner(readFileSync(file, 'utf8'));
    if (current?.token === token) unlinkSync(file);
  } catch {
    // Best effort only. Crash recovery handles an orphan on the next request.
  }
}

// Synchronous cleanup is the only work Node permits from the exit event. It
// covers clean shutdowns; SIGKILL/power loss still rely on the conservative
// stale-owner path below.
process.once('exit', () => {
  releaseOwnedFileSync(PROCESS_LEASE_FILE, activeProcessLeaseToken);
  releaseOwnedFileSync(PROCESS_REAPER_FILE, activeProcessReaperToken);
});

async function reapMalformedFile(
  file: string,
  raw: string,
  now: number,
  graceMs: number,
): Promise<boolean> {
  try {
    const before = await stat(file);
    if (now - before.mtimeMs < graceMs) return false;
    const currentRaw = await readFile(file, 'utf8');
    const current = await stat(file);
    if (currentRaw !== raw || current.mtimeMs !== before.mtimeMs || current.size !== before.size) {
      return false;
    }
    await unlink(file);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
}

async function reapAbandonedProcessReaper(now: number): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(PROCESS_REAPER_FILE, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
  const owner = parseProcessLeaseOwner(raw);
  if (!owner) {
    return reapMalformedFile(
      PROCESS_REAPER_FILE,
      raw,
      now,
      PROCESS_REAPER_DEAD_OWNER_GRACE_MS,
    );
  }
  const reason = staleProcessLeaseReason(
    owner,
    now,
    process.pid,
    PROCESS_INSTANCE_TOKEN,
    processAlive(owner.pid),
    PROCESS_REAPER_DEAD_OWNER_GRACE_MS,
  );
  if (!reason) return false;
  try {
    const current = parseProcessLeaseOwner(await readFile(PROCESS_REAPER_FILE, 'utf8'));
    if (current?.token !== owner.token) return false;
    await unlink(PROCESS_REAPER_FILE);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
}

async function acquireProcessReaper(now: number): Promise<string | null> {
  const token = randomUUID();
  const owner: ProcessLeaseOwner = {
    token,
    pid: process.pid,
    instanceToken: PROCESS_INSTANCE_TOKEN,
    kind: 'lease-reaper',
    acquiredAt: now,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(PROCESS_REAPER_FILE, 'wx');
      try {
        await handle.writeFile(JSON.stringify(owner));
      } finally {
        await handle.close();
      }
      activeProcessReaperToken = token;
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      if (attempt > 0 || !(await reapAbandonedProcessReaper(now))) return null;
    }
  }
  return null;
}

async function inspectAndReapProcessLease(now: number): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(PROCESS_LEASE_FILE, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
  const owner = parseProcessLeaseOwner(raw);
  if (!owner) {
    // A process can die between atomic creation and writing its owner JSON.
    // Never steal a fresh/torn record, but reap an unchanged malformed file
    // after the grace period so one crash cannot wedge inference forever.
    return reapMalformedFile(
      PROCESS_LEASE_FILE,
      raw,
      now,
      PROCESS_LEASE_DEAD_OWNER_GRACE_MS,
    );
  }
  const reason = staleProcessLeaseReason(
    owner,
    now,
    process.pid,
    PROCESS_INSTANCE_TOKEN,
    processAlive(owner.pid),
  );
  if (!reason) return false;
  try {
    // The reaper mutex makes this token check + unlink an exclusive critical
    // section among contenders. A replacement owner therefore cannot be
    // removed by a second waiter acting on the stale snapshot.
    const current = parseProcessLeaseOwner(await readFile(PROCESS_LEASE_FILE, 'utf8'));
    if (current?.token !== owner.token) return false;
    await unlink(PROCESS_LEASE_FILE);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
}

async function processLeaseReapCandidate(
  now: number,
): Promise<'missing' | 'candidate' | 'healthy'> {
  let raw: string;
  try {
    raw = await readFile(PROCESS_LEASE_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 'missing';
    throw error;
  }
  const owner = parseProcessLeaseOwner(raw);
  if (!owner) {
    try {
      const info = await stat(PROCESS_LEASE_FILE);
      return now - info.mtimeMs >= PROCESS_LEASE_DEAD_OWNER_GRACE_MS
        ? 'candidate'
        : 'healthy';
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 'missing';
      throw error;
    }
  }
  return staleProcessLeaseReason(
    owner,
    now,
    process.pid,
    PROCESS_INSTANCE_TOKEN,
    processAlive(owner.pid),
  ) ? 'candidate' : 'healthy';
}

async function reapStaleProcessLease(now: number): Promise<boolean> {
  // Do the cheap read-only check first. Otherwise every waiting process would
  // create/delete the reaper file ten times per second throughout a long,
  // perfectly healthy model call.
  const candidate = await processLeaseReapCandidate(now);
  if (candidate === 'missing') return true;
  if (candidate === 'healthy') return false;
  const reaperToken = await acquireProcessReaper(now);
  if (!reaperToken) return false;
  try {
    return await inspectAndReapProcessLease(now);
  } finally {
    await releaseOwnedFile(PROCESS_REAPER_FILE, reaperToken, 'process reaper lease');
    if (activeProcessReaperToken === reaperToken) activeProcessReaperToken = null;
  }
}

async function withProcessLease<T>(
  metadata: LlmAdmissionMetadata,
  task: () => Promise<T> | T,
): Promise<T> {
  await mkdir(config.stateRoot, { recursive: true });
  const kind = String(metadata.kind || 'sdk.llm');
  const token = randomUUID();
  const owner: ProcessLeaseOwner = {
    token,
    pid: process.pid,
    instanceToken: PROCESS_INSTANCE_TOKEN,
    kind,
    acquiredAt: Date.now(),
  };
  const deadline = neededByMs(metadata.neededBy);

  while (true) {
    if (metadata.signal?.aborted) throw queuedAbortError(kind, metadata.signal);
    if (metadata.dropIfLate && deadline != null && deadline <= Date.now()) {
      throw new LlmAdmissionDroppedError(kind, deadline);
    }
    try {
      const handle = await open(PROCESS_LEASE_FILE, 'wx');
      try {
        await handle.writeFile(JSON.stringify(owner));
      } finally {
        await handle.close();
      }
      activeProcessLeaseToken = token;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      if (!(await reapStaleProcessLease(Date.now()))) {
        await waitForLeasePoll(metadata.signal);
      }
    }
  }

  try {
    return await task();
  } finally {
    await releaseOwnedFile(PROCESS_LEASE_FILE, token, 'process lease');
    if (activeProcessLeaseToken === token) activeProcessLeaseToken = null;
  }
}

export function withLlmAdmission<T>(
  metadata: LlmAdmissionMetadata,
  task: () => Promise<T> | T,
): Promise<T> {
  return stationLlmAdmission.run(metadata, () => withProcessLease(metadata, task));
}

export function getLlmAdmissionStatus(): LlmAdmissionStatus {
  return stationLlmAdmission.status();
}
