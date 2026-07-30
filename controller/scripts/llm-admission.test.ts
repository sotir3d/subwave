// Deterministic unit tests for the station-wide LLM admission queue. No model,
// provider, timers, or controller state is involved.

import assert from 'node:assert/strict';
import {
  LLM_ADMISSION_PRIORITY,
  LlmAdmissionDroppedError,
  LlmAdmissionQueue,
  defaultLlmAdmissionPriority,
  resolveLlmAdmissionPriority,
  staleProcessLeaseReason,
} from '../src/llm/internal/core/admission.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function testSingleFlight(): Promise<void> {
  const queue = new LlmAdmissionQueue(() => 100);
  const gate = deferred<void>();
  const starts: string[] = [];
  let active = 0;
  let maxActive = 0;

  const first = queue.run({ kind: 'generateLink' }, async () => {
    starts.push('first');
    active++;
    maxActive = Math.max(maxActive, active);
    await gate.promise;
    active--;
    return 'first-result';
  });
  const second = queue.run({ kind: 'generateHourlyTime' }, async () => {
    starts.push('second');
    active++;
    maxActive = Math.max(maxActive, active);
    active--;
    return 'second-result';
  });

  await flush();
  assert.deepEqual(starts, ['first']);
  assert.equal(queue.status().active?.kind, 'generateLink');
  assert.equal(queue.status().queued, 1);

  gate.resolve();
  assert.equal(await first, 'first-result');
  await flush();
  assert.equal(await second, 'second-result');
  assert.deepEqual(starts, ['first', 'second']);
  assert.equal(maxActive, 1);
  assert.deepEqual(queue.status(), { active: null, queued: 0, waiting: [] });
}

async function testPriorityAndFifo(): Promise<void> {
  const queue = new LlmAdmissionQueue(() => 100);
  const gate = deferred<void>();
  const starts: string[] = [];
  const blocker = queue.run({ kind: 'blocker' }, async () => gate.promise);
  await flush();

  const low = queue.run({ kind: 'low', priority: 80 }, async () => { starts.push('low'); });
  const highOne = queue.run({ kind: 'high-one', priority: 10 }, async () => { starts.push('high-one'); });
  const highTwo = queue.run({ kind: 'high-two', priority: 10 }, async () => { starts.push('high-two'); });
  const middle = queue.run({ kind: 'middle', priority: 40 }, async () => { starts.push('middle'); });

  assert.deepEqual(queue.status().waiting.map((entry) => entry.kind), [
    'high-one', 'high-two', 'middle', 'low',
  ]);

  gate.resolve();
  await blocker;
  await Promise.all([low, highOne, highTwo, middle]);
  assert.deepEqual(starts, ['high-one', 'high-two', 'middle', 'low']);
}

async function testRejectedTaskReleasesLease(): Promise<void> {
  const queue = new LlmAdmissionQueue(() => 100);
  const expected = new Error('model failed after retries');
  const starts: string[] = [];
  const failed = queue.run({ kind: 'failing-call' }, async () => {
    starts.push('failing-call');
    throw expected;
  }).then(() => null, (err) => err);
  const next = queue.run({ kind: 'next-call' }, async () => {
    starts.push('next-call');
    return 'ok';
  });

  assert.equal(await failed, expected);
  assert.equal(await next, 'ok');
  assert.deepEqual(starts, ['failing-call', 'next-call']);
  assert.deepEqual(queue.status(), { active: null, queued: 0, waiting: [] });
}

async function testDeadlineDrop(): Promise<void> {
  let now = 100;
  const queue = new LlmAdmissionQueue(() => now);
  const gate = deferred<void>();
  const starts: string[] = [];
  const blocker = queue.run({ kind: 'blocker' }, async () => gate.promise);
  await flush();

  const dropped = queue.run({
    kind: 'stale-longform',
    priority: 10,
    neededBy: new Date(150),
    dropIfLate: true,
  }, async () => { starts.push('stale'); }).then(() => null, (err) => err);
  const kept = queue.run({
    kind: 'informational-deadline',
    neededBy: 150,
    dropIfLate: false,
  }, async () => { starts.push('kept'); });

  now = 200;
  gate.resolve();
  await blocker;
  const err = await dropped;
  await kept;
  assert.ok(err instanceof LlmAdmissionDroppedError);
  assert.equal(err.kind, 'stale-longform');
  assert.equal(err.neededBy, 150);
  assert.deepEqual(starts, ['kept']);

  const neverStarted = queue.run({
    kind: 'already-late',
    neededBy: 199,
    dropIfLate: true,
  }, async () => { starts.push('already-late'); }).then(() => null, (lateErr) => lateErr);
  assert.ok(await neverStarted instanceof LlmAdmissionDroppedError);
  assert.deepEqual(starts, ['kept']);
}

async function testQueuedAbort(): Promise<void> {
  const queue = new LlmAdmissionQueue(() => 100);
  const gate = deferred<void>();
  const starts: string[] = [];
  const blocker = queue.run({ kind: 'blocker' }, async () => gate.promise);
  await flush();

  const controller = new AbortController();
  const aborted = queue.run({ kind: 'queued', signal: controller.signal }, async () => {
    starts.push('queued');
  }).then(() => null, (err) => err);
  assert.equal(queue.status().queued, 1);
  controller.abort(new Error('no longer needed'));
  const err = await aborted;
  assert.equal(err.name, 'AbortError');
  assert.match(err.message, /no longer needed/);
  assert.equal(queue.status().queued, 0);

  gate.resolve();
  await blocker;
  assert.deepEqual(starts, []);

  const preAbortedController = new AbortController();
  preAbortedController.abort();
  const preAborted = await queue.run({
    kind: 'pre-aborted',
    signal: preAbortedController.signal,
  }, async () => starts.push('pre-aborted')).then(() => null, (abortErr) => abortErr);
  assert.equal(preAborted.name, 'AbortError');
  assert.deepEqual(starts, []);
}

async function testActiveAbortRetainsLease(): Promise<void> {
  const queue = new LlmAdmissionQueue(() => 100);
  const gate = deferred<void>();
  const controller = new AbortController();
  const starts: string[] = [];

  const active = queue.run({ kind: 'active', signal: controller.signal }, async () => {
    starts.push('active');
    // Deliberately ignore the signal: admission must not release the slot until
    // the logical model operation itself has settled.
    await gate.promise;
  });
  const next = queue.run({ kind: 'next' }, async () => { starts.push('next'); });
  await flush();
  controller.abort();
  await flush();

  assert.deepEqual(starts, ['active']);
  assert.equal(queue.status().active?.kind, 'active');
  assert.equal(queue.status().queued, 1);

  gate.resolve();
  await active;
  await next;
  assert.deepEqual(starts, ['active', 'next']);
}

function testDefaultPriorities(): void {
  assert.equal(defaultLlmAdmissionPriority('djAgentRequest'), LLM_ADMISSION_PRIORITY.listener);
  assert.equal(defaultLlmAdmissionPriority('pickNextTrack'), LLM_ADMISSION_PRIORITY.playout);
  assert.equal(defaultLlmAdmissionPriority('generateSegment'), LLM_ADMISSION_PRIORITY.live);
  assert.equal(defaultLlmAdmissionPriority('sdk.djObject'), LLM_ADMISSION_PRIORITY.normal);
  assert.equal(defaultLlmAdmissionPriority('generateProgrammePlan'), LLM_ADMISSION_PRIORITY.longform);
  assert.equal(defaultLlmAdmissionPriority('tag-library-batch'), LLM_ADMISSION_PRIORITY.background);
  assert.equal(resolveLlmAdmissionPriority('tag-library-batch', -5), -5);
  assert.equal(resolveLlmAdmissionPriority('djAgentRequest', Number.NaN), LLM_ADMISSION_PRIORITY.listener);
}

function testProcessLeaseRecoveryPolicy(): void {
  const now = 10_000;
  const currentPid = 42;
  const currentInstance = 'current-instance';
  const baseOwner = {
    token: 'lease-token',
    pid: 99,
    instanceToken: 'other-instance',
    kind: 'test-call',
    acquiredAt: 1_000,
  };

  assert.equal(staleProcessLeaseReason(
    baseOwner,
    now,
    currentPid,
    currentInstance,
    false,
    1_000,
  ), 'dead-owner');
  assert.equal(staleProcessLeaseReason(
    { ...baseOwner, acquiredAt: 9_500 },
    now,
    currentPid,
    currentInstance,
    false,
    1_000,
  ), null, 'a newly-created dead-owner lease keeps its recovery grace');
  assert.equal(staleProcessLeaseReason(
    { ...baseOwner, pid: currentPid },
    now,
    currentPid,
    currentInstance,
    true,
    1_000,
  ), 'previous-process-instance', 'PID reuse is detected by the instance token');
  assert.equal(staleProcessLeaseReason(
    { ...baseOwner, pid: currentPid, instanceToken: undefined },
    now,
    currentPid,
    currentInstance,
    true,
    1_000,
  ), 'previous-process-instance', 'pre-token leases remain recoverable after upgrade');
  assert.equal(staleProcessLeaseReason(
    { ...baseOwner, pid: currentPid, instanceToken: currentInstance, acquiredAt: 0 },
    Number.MAX_SAFE_INTEGER,
    currentPid,
    currentInstance,
    true,
    1_000,
  ), null, 'a healthy current owner is never reaped based on age alone');
  assert.equal(staleProcessLeaseReason(
    { ...baseOwner, pid: 99, acquiredAt: 0 },
    Number.MAX_SAFE_INTEGER,
    currentPid,
    currentInstance,
    true,
    1_000,
  ), null, 'a healthy foreign owner is never reaped based on age alone');
}

async function main(): Promise<void> {
  await testSingleFlight();
  await testPriorityAndFifo();
  await testRejectedTaskReleasesLease();
  await testDeadlineDrop();
  await testQueuedAbort();
  await testActiveAbortRetainsLease();
  testDefaultPriorities();
  testProcessLeaseRecoveryPolicy();
  console.log('All LLM admission tests passed.');
}

main();
