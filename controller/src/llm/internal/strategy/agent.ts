// djAgent — conversational tool-loop with structured output. The primitive
// behind the session DJ agent (broadcast/dj-agent.js) and the segment director
// (skills/_agent.js): a ToolLoopAgent is given the discovery tools and a step
// cap, fed a `messages` array (the session chat window) instead of a single
// prompt, and returns a schema-validated final object. Throws on failure so the
// caller can fall back to a stateless path.
//
// STRATEGY (resolved per leg by agentPlan() below):
//   1. Native-first (non-Ollama tool-using agents): native Output.object with
//      AUTO tool_choice. Needs no forced tool_choice, so it sidesteps the whole
//      "thinking mode does not support this tool_choice" class (Anthropic +
//      DeepSeek reject forced tools while thinking). Verified 5/5 across openai
//      (gpt-4.1-mini), anthropic (claude-haiku-4.5), google (gemini-3.5-flash),
//      openrouter (kimi-k2.6); deepseek needs thinking off (5/5 off vs 1/5 on —
//      forceNoThink handles it). On any miss it falls through to (2), so worst
//      case is the prior behaviour, never a regression. Older models still fail
//      native (gemini-2.5-flash, llama-3.3-70b → 0/n) — the fall-through covers them.
//   2. Done-tool (Ollama always; everyone else on a native miss): the forced
//      tool-calling pattern below. Ollama is excluded from native because its
//      tool-loop Output.object returns schema-valid-but-EMPTY JSON WITHOUT ever
//      calling discovery (verified 0/3 on glm-5.1/qwen3.5/nemotron:cloud), so the
//      done-tool path is the only one that works there.
//
// The done-tool pattern (the AI SDK's documented "Forced Tool Calling"): a
// synthetic `done` tool whose inputSchema IS the schema is added alongside the
// discovery tools, `toolChoice:'required'` forces a tool call every step, and
// prepareStep corners the model into discovery-then-done.
//
// When the model declines `done` anyway, the cascade is:
//   main run → done-only recovery (carrying the trail) → single-turn terminal
//   collapse (issue #1157: the trail flattened into ONE user prompt + a forced
//   `emit` tool, leaving the multi-turn shape behind — see renderTerminalPrompt
//   in core/pure.ts) → text salvage → throw, and the caller falls back to its
//   stateless path. Every leg draws on ONE shared deadline, so the leg count
//   here is a budget decision as much as a correctness one.

import { Output, isStepCount, hasToolCall, ToolLoopAgent, tool } from 'ai';
import type { ModelMessage, ToolSet } from 'ai';
import { z } from 'zod';
import { withLlmAdmission } from '../core/admission.js';
import { withFailover } from '../core/failover.js';
import { withTransientRetry, withDeadline } from '../core/retry.js';
import { stripThinking, extractJson, usageOf, perfOf, warningsOf, flattenToolCalls, failureDiagnostics, renderTerminalPrompt } from '../core/pure.js';
import type { StepLike, ToolCallLike, ToolCallSummary, TokenUsage } from '../core/pure.js';
import { needsToolCallObject, reasoningFor, samplingWithLocalKnobs, forcedToolChoice } from '../provider/capabilities.js';
import type { Leg } from '../provider/legs.js';
import { objectViaToolCall } from './object-via-tool.js';
import { agentPlan } from './plan.js';
import { resolveMaxOutputTokens } from '../../../settings.js';
import { recordAgentRetry } from '../telemetry/log.js';

// Loose views of an AI SDK ToolLoopAgent generate result — only the fields the
// cascade below reads. The provider-varying tool-call / output shapes stay
// `unknown`; a real GenerateTextResult is assignable to `AgentGenerateResult`
// (verified where runDeadlined drives the agent). `AgentLike` is the minimal
// surface runDeadlined needs, which a ToolLoopAgent satisfies.
interface AgentGenerateResult {
  output?: unknown;
  text: string;
  finishReason?: unknown;
  usage?: TokenUsage;
  totalUsage?: TokenUsage;
  steps?: StepLike[];
  staticToolCalls?: ToolCallLike[];
  response?: { messages?: ModelMessage[] };
}
interface AgentLike {
  generate(options: { messages: ModelMessage[]; abortSignal?: AbortSignal }): Promise<AgentGenerateResult>;
}

// The synthetic "did not call done" failure and the djAgent options bag.
interface AgentFailureError extends Error {
  text?: string;
  finishReason?: unknown;
  usage?: unknown;
  steps?: unknown;
}
interface DjAgentOptions {
  system: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  schema?: z.ZodTypeAny;
  maxSteps?: number;
  temperature?: number;
  maxOutputTokens?: number;
  kind?: string;
  timeoutMs?: number;
  validate?: (object: unknown) => boolean;
  priority?: number;
  neededBy?: number | Date;
  dropIfLate?: boolean;
  signal?: AbortSignal;
}

// Operator-overridable via settings.llm.maxOutputTokens (issue #712); 0 keeps
// this default. Resolved here and threaded down to objectViaToolCall and the
// ToolLoopAgent, so the cap is uniform across the agent's sub-paths.
const MAX_TOKENS_AGENT = 8000;

// Per-tool execution timeout (AI SDK `timeout.toolMs`) on the tool-running
// agents. A hung discovery call — Navidrome mid-restart, a stalled web search —
// otherwise burns the WHOLE shared deadline before the model gets a say. The
// SDK aborts the tool and feeds the model a tool-error result instead, so the
// loop keeps moving (no throw — deliberately invisible to the transient/failover
// classifiers, unlike stepMs/totalMs; see withDeadline's comment in
// core/retry.ts). Segment tools keep their own graceful 8s internal timeout;
// this is the backstop above it.
const TOOL_TIMEOUT_MS = 10_000;

// prepareStep pins activeTools so EVERY step is a cornered single-purpose
// request — step 0 = discovery only, step >= COMMIT_AFTER_STEPS = `done` only.
// Both restrict activeTools at the request level, the only lever cloud Ollama
// models actually honour (they ignore a plain `toolChoice:'required'` when
// several tools are visible and just emit prose — ending the loop with no `done`
// call). COMMIT_AFTER_STEPS = 1 leaves NO free middle step, so that failure
// window is closed: the model gets exactly one discovery call, then must emit
// `done`. One targeted, session-aware discovery call still yields ~8 candidates.
// Raising this re-opens the middle-step failure window on cloud Ollama; don't,
// unless the provider honours `toolChoice`.
const COMMIT_AFTER_STEPS = 1;

function buildDoneTool(schema: z.ZodTypeAny) {
  return tool({
    description: 'Call this exactly once when you have your final answer. Pass the answer as input. Calling this tool IS how you respond — do not emit text after.',
    inputSchema: schema,
  });
}

// Step 0 forces a discovery tool — never `done` — so the model can't commit a
// hallucinated id before seeing any library results. Step >= COMMIT_AFTER_STEPS
// forces `done`: with only `done` active the model cannot keep exploring and
// must emit its final answer, guaranteeing a `done` call before the step cap.
// `toolChoice` is the leg's forced value ('required', or 'auto' when the operator
// downgrades it for a crash-prone server — issue #570); the activeTools pinning
// holds either way, so on 'auto' the single visible tool is still the strong nudge.
function gatedDiscoveryPrepareStep(discoveryToolNames: string[], toolChoice: 'required' | 'auto') {
  return async ({ stepNumber }: { stepNumber: number }) => {
    if (stepNumber === 0) {
      return { activeTools: discoveryToolNames, toolChoice };
    }
    if (stepNumber >= COMMIT_AFTER_STEPS) {
      return { activeTools: ['done'], toolChoice };
    }
    return {};
  };
}

// The done-only recovery agent: one re-run of the loop with `done` as the only
// legal move, fed the failed run's discovery trail. The attempt after this one
// leaves the loop behind entirely (renderTerminalPrompt + objectViaToolCall).
function buildRecoveryAgent(leg: Leg, system: string, allTools: ToolSet | undefined, temperature: number, maxOutputTokens: number, forcedChoice: 'required' | 'auto') {
  return new ToolLoopAgent({
    // Recovery forces done-only every step → no-think model (see above).
    model: leg.noThinkModel ?? leg.model,
    // Append an explicit terminal instruction at the exact point
    // gemma-class models stall (issue #555): after a negative tool
    // result (`available:false`) they tend to emit prose instead of
    // obeying toolChoice:'required', and the bare done-only re-run
    // sometimes does the same. activeTools is already pinned to
    // done-only; this plain-language line in the recovery system prompt
    // tells the model the ONLY valid move is the done call. Put in
    // `instructions` (not a trailing user turn) so it can't create two
    // consecutive user messages and trip providers that require strict
    // role alternation (Anthropic). Harmless on the picker path.
    instructions: `${system}\n\nYou now have everything you need. Respond ONLY by calling the \`done\` tool with your final answer — do not write a normal text message.`,
    tools: allTools,
    stopWhen: [isStepCount(2), hasToolCall('done')],
    temperature,
    maxOutputTokens,
    // Recovery forces done-only every step, so it has the same
    // Anthropic/DeepSeek thinking conflict as the main run — suppress here too.
    reasoning: reasoningFor(leg.cfg, { forceNoThink: true }),
    toolChoice: forcedChoice,
    prepareStep: async () => ({ activeTools: ['done'], toolChoice: forcedChoice }),
  } as any);
}

// The withDeadline(Promise.race + abort) + withTransientRetry wrapper around a
// single agent.generate(). The `timeout` generate option is NOT honoured by the
// ai-sdk-ollama transport, so the wall-clock ceiling is enforced here; the abort
// signal is forwarded so transports that DO support cancellation stop the request
// server-side.
//
// `deadlineAt` is a SHARED absolute deadline (a Date.now()-style timestamp),
// not a fresh duration per call — every attempt djAgent makes for one pick
// (native run, main run, both recovery attempts) draws down the SAME overall
// budget, computed once in djAgent below. Passing the same timeoutMs to each
// attempt independently (the prior behaviour) let a single pick run up to
// ~3x timeoutMs in the worst case before falling back to the caller's
// stateless path (Copilot review, PR #923) — a slow main run now correctly
// leaves less time for recovery instead of resetting the clock. undefined
// means no deadline at all (unlimited).
function runDeadlinedCall<T>(
  deadlineAt: number | undefined,
  kind: string,
  label: string,
  fn: (signal?: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  if (deadlineAt == null) {
    return withTransientRetry(kind, () => fn(callerSignal), callerSignal);
  }
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    const err = new Error(`${kind} ${label} — no time left on the shared deadline`);
    err.name = 'AgentDeadlineError';
    return Promise.reject(err);
  }
  return withDeadline(remaining, `${kind} ${label}`, (deadlineSignal) => {
    const signal = callerSignal && deadlineSignal
      ? AbortSignal.any([callerSignal, deadlineSignal])
      : callerSignal ?? deadlineSignal;
    return withTransientRetry(kind, () => fn(signal), signal);
  });
}

function runDeadlined(
  deadlineAt: number | undefined,
  kind: string,
  label: string,
  agent: AgentLike,
  messages: ModelMessage[],
  callerSignal?: AbortSignal,
): Promise<AgentGenerateResult> {
  return runDeadlinedCall(deadlineAt, kind, label, (signal) => agent.generate({
    messages,
    ...(signal ? { abortSignal: signal } : {}),
  }), callerSignal);
}

export async function djAgent({
  system,
  messages,
  tools,
  schema,
  maxSteps = 8,
  temperature = 0.6,
  maxOutputTokens = resolveMaxOutputTokens(MAX_TOKENS_AGENT),
  kind = 'sdk.djAgent',
  timeoutMs,
  priority,
  neededBy,
  dropIfLate = false,
  signal,
  // Optional caller-supplied acceptance check on the native path's object
  // (e.g. "the picked id must be one a discovery tool actually surfaced").
  // The native path is the only branch with no structural control over WHAT
  // the model emits — Output.object + auto tool choice validates the schema
  // shape, not the content — so a fabricated-but-well-formed answer sails
  // through where the done-tool harness would have cornered the model.
  // A validate miss falls through to the done-tool path instead of returning
  // an object the caller can only throw away (observed: gpt-5-mini invented
  // 7/32 pick ids after an empty tool result, each costing a pool fallback +
  // a breaker increment). Not applied to the done-tool/recovery results: the
  // caller repairs those itself with the full `seen` context.
  validate,
}: DjAgentOptions): Promise<{ object: unknown; steps: number; toolCalls: ToolCallSummary[] }> {
  return withLlmAdmission(
    { kind, priority, neededBy, dropIfLate, signal },
    () => withFailover(
      kind,
      (err) => ({ system, messages, ...failureDiagnostics(err) }),
      async (leg: Leg) => {
      const toolCount = tools ? Object.keys(tools).length : 0;
      const plan = agentPlan(leg.cfg, schema, toolCount);
      // Default to the agent path; branches override before their await. A
      // failure record always attributes to the path actually attempted.
      let lastVia = 'ai-sdk:agent';
      // One shared wall-clock ceiling for every attempt below (native run,
      // main run, both recovery attempts) — see runDeadlined's comment.
      const deadlineAt = timeoutMs ? Date.now() + timeoutMs : undefined;
      try {
        // No discovery tools + an Ollama model that ignores JSON mode: there is
        // no loop to run, and ToolLoopAgent + Output.object would throw
        // NoObjectGeneratedError. Get the structured result from a forced tool call.
        if (plan === 'object-via-tool') {
          lastVia = 'ai-sdk:tool';
          const { object, usage, perf, warnings } = await runDeadlinedCall(
            deadlineAt,
            kind,
            'object via tool',
            (runSignal) => objectViaToolCall(leg, {
              system, prompt: undefined, messages, schema, temperature, maxOutputTokens, signal: runSignal,
            }),
            signal,
          );
          return {
            value: { object, steps: 0, toolCalls: [] },
            via: lastVia,
            sampling: samplingWithLocalKnobs(leg.cfg, { temperature }),
            usage,
            perf,
            warnings,
            extra: { system, messages, toolCalls: [], steps: 0, response: JSON.stringify(object, null, 2) },
          };
        }

        // Tokens spent across every leg below (a native leg that fell through,
        // the main run, the recovery, the terminal collapse). Each leg is a
        // separate billable call and `result` is reassigned between them, so a
        // single usageOf(result) at the end only ever counted the LAST leg —
        // the same reassignment loss captureTrail guards the discovery trail
        // against. This sum is what telemetry/log.ts records and what the
        // daily token cap (llm/internal/telemetry/budget.ts) counts against.
        let spentUsage = { input: 0, output: 0, total: 0 };
        const addUsage = (u: { input: number; output: number; total: number }) => {
          spentUsage = {
            input: spentUsage.input + u.input,
            output: spentUsage.output + u.output,
            total: spentUsage.total + u.total,
          };
        };

        // ----- Native-first structured output (non-Ollama tool-using agents) -----
        // Prefer native Output.object where it now emits reliably (see header).
        // No forced tool_choice → no thinking conflict, and simpler than the
        // done-tool harness. On a miss we fall through to the done-tool path
        // below (lastVia stays ':native' so the eventual record attributes there).
        if (plan === 'native-then-done') {
          try {
            lastVia = 'ai-sdk:agent:native';
            const nativeAgent = new ToolLoopAgent({
              // Native tool-using agent forces no-think (forceNoThink:true below),
              // so use the no-think model — for OpenRouter that's the reasoning-
              // disabled instance; identical to leg.model for every other provider.
              model: leg.noThinkModel ?? leg.model,
              instructions: system,
              tools,
              stopWhen: [isStepCount(maxSteps)],
              temperature,
              maxOutputTokens,
              timeout: { toolMs: TOOL_TIMEOUT_MS },
              // Thinking off: makes deepseek reliable (5/5 vs 1/5) and is harmless
              // elsewhere — the pick is structured extraction; the DJ's free-text
              // (djText) still reasons.
              reasoning: reasoningFor(leg.cfg, { forceNoThink: true }),
              output: Output.object({ schema: schema! }),
            } as any);
            const nr = await runDeadlined(deadlineAt, kind, 'native run', nativeAgent, messages, signal);
            const nObj = nr.output;
            const nSteps = nr.steps?.length ?? 0;
            // The cross-provider failure signature is "emitted the object WITHOUT
            // calling a discovery tool" (deepseek-thinking-on, ollama). Require a
            // real discovery call so a no-explore hallucination can't slip through:
            // the caller resolves the id against `seen`, which only tool calls
            // populate, so an explored pick is also a resolvable one.
            const explored = (nr.steps || []).some((s) => (s.toolCalls || []).length > 0);
            // Caller acceptance check (see the validate param note). A throwing
            // validator counts as a miss, never as an agent failure.
            let accepted = true;
            if (nObj && explored && typeof validate === 'function') {
              try { accepted = !!validate(nObj); } catch { accepted = false; }
            }
            if (nObj && explored && accepted) {
              const toolCalls = flattenToolCalls(nr);
              return {
                value: { object: nObj, steps: nSteps, toolCalls },
                via: lastVia,
                sampling: samplingWithLocalKnobs(leg.cfg, { temperature }),
                usage: usageOf(nr),
                perf: perfOf(nr),
                warnings: warningsOf(nr),
                extra: { system, messages, toolCalls, steps: nSteps, response: JSON.stringify(nObj, null, 2) },
              };
            }
            console.log(`[${kind}] native output produced no usable pick (explored=${explored}, accepted=${accepted}) — falling back to done-tool`);
            addUsage(usageOf(nr));
          } catch (e) {
            console.log(`[${kind}] native output failed (${e?.message}) — falling back to done-tool`);
          }
        }

        // Unified main agent: done-tool (Ollama-with-tools, or any native miss),
        // native-no-tools (schema-only off Ollama → agent-level Output.object), or
        // free-text (no schema). useDoneTool is the original predicate, kept verbatim.
        const useDoneTool = schema != null && (needsToolCallObject(leg.cfg) || toolCount > 0);
        const allTools = useDoneTool ? { ...tools, done: buildDoneTool(schema!) } : tools;
        // 'required' by default; 'auto' when the operator downgrades this leg for
        // a server whose forced-tool backend crashes (issue #570). Applies to the
        // agent-level choice, the gated prepareStep, and the recovery run below.
        const forcedChoice = forcedToolChoice(leg.cfg);

        const discoveryToolNames = tools ? Object.keys(tools) : [];
        const useGatedDiscovery = useDoneTool && discoveryToolNames.length > 0;
        const prepareStep = useGatedDiscovery ? gatedDiscoveryPrepareStep(discoveryToolNames, forcedChoice) : undefined;

        const agent = new ToolLoopAgent({
          // useDoneTool legs force tool calls → no-think model; the schema-only
          // native-no-tools / free-text legs keep the operator's reasoning choice.
          model: useDoneTool ? (leg.noThinkModel ?? leg.model) : leg.model,
          instructions: system,
          tools: allTools,
          // The no-execute `done` tool already terminates the loop when called;
          // hasToolCall('done') is belt-and-suspenders, and inert on the native
          // path where no `done` tool exists.
          stopWhen: [isStepCount(maxSteps), hasToolCall('done')],
          temperature,
          maxOutputTokens,
          timeout: { toolMs: TOOL_TIMEOUT_MS },
          // useDoneTool forces tool calls every step — suppress thinking on the
          // providers that reject forced tools mid-reasoning (Anthropic/DeepSeek).
          reasoning: reasoningFor(leg.cfg, { forceNoThink: useDoneTool }),
          ...(useDoneTool ? { toolChoice: forcedChoice } : {}),
          ...(prepareStep ? { prepareStep } : {}),
          // Native path: structured output via Output.object. Done-tool path: the
          // schema lives on the `done` tool, so no agent-level output.
          ...(schema && !useDoneTool ? { output: Output.object({ schema }) } : {}),
        } as any);
        // timeoutMs (when set) is a hard ceiling — a slow/looping run throws,
        // flows through the catch below, and the caller falls back to its
        // stateless path rather than blocking on a pathological model call.
        let result = await runDeadlined(deadlineAt, kind, 'agent run', agent, messages, signal);
        let steps = result.steps?.length ?? 0;
        addUsage(usageOf(result));

        // The discovery trail belongs to the MAIN run: `result` is reassigned by
        // the recovery below, and the recovery agent is pinned done-only, so
        // reading the trail off the FINAL result loses it entirely (which is why
        // the /debug record for a recovered pick showed zero tool calls). Capture
        // it here and top it up if a later attempt manages a discovery call of its
        // own. The terminal collapse renders this into its prompt, so the trail is
        // also what stops a cornered model from inventing an id.
        let discoveryTrail = flattenToolCalls(result);
        const captureTrail = (r: AgentGenerateResult) => {
          const more = flattenToolCalls(r);
          if (more.length) discoveryTrail = [...discoveryTrail, ...more];
        };

        // Set only by the single-turn terminal collapse below.
        let terminalObject: unknown;
        let terminalPrompt: string | undefined;

        // What the model said INSTEAD of calling `done`, one entry per attempt
        // that declined — surfaced on the eventual throw below (via err.text)
        // so failureDiagnostics() in core/pure.ts picks it up into the /debug
        // record as `responseText`, and failover.ts's logFailurePreview prints
        // it to the container logs too. Without this, a "did not call the done
        // tool" failure carried no evidence of what the model actually said,
        // making it unguessable whether it declined outright, answered in
        // prose, or something else entirely.
        const declinedAttempts: string[] = [];
        const noteIfDeclined = (label: string, r: AgentGenerateResult) => {
          if (!(r.staticToolCalls || []).some((c) => c.toolName === 'done')
            && typeof r.text === 'string' && r.text.trim()) {
            declinedAttempts.push(`[${label}] ${r.text.trim()}`);
          }
        };
        noteIfDeclined('main', result);

        // Recovery for the "agent did not call the done tool" failure mode (issue
        // #140). Local/cloud Ollama models occasionally ignore toolChoice:'required'
        // at step 0 — they emit prose instead of any tool call, the loop ends with
        // zero tool calls, and we'd otherwise throw. Re-run once with prepareStep
        // pinned to `done`-only so `done` is the model's only legal move. Crucially
        // carry the first run's tool-call + tool-result messages (the discovery
        // trail) forward: that run DID surface candidates into the caller's `seen`
        // map; replaying only the bare `messages` strips them, so a cornered agent
        // could only fabricate an id (100% unknown-id). Feeding the trail back lets
        // it commit to a REAL surfaced id. Harmless for free-text recovery.
        if (useDoneTool && !(result.staticToolCalls || []).some((c) => c.toolName === 'done')) {
          console.log(`[${kind}] agent stopped without calling done — retrying with done-only`);
          recordAgentRetry();
          lastVia = 'ai-sdk:agent:recovery';
          const priorMessages = result.response?.messages || [];
          const recoveryMessages = priorMessages.length ? [...messages, ...priorMessages] : messages;
          result = await runDeadlined(deadlineAt, kind, 'agent recovery',
            buildRecoveryAgent(leg, system, allTools, temperature, maxOutputTokens, forcedChoice), recoveryMessages, signal);
          steps = result.steps?.length ?? 0;
          addUsage(usageOf(result));
          captureTrail(result);
          noteIfDeclined('recovery', result);

          // Last resort — collapse the whole loop into ONE single-turn forced-tool
          // call (issue #1157). Two failure modes land here and both are about
          // conversation SHAPE, not tool forcing:
          //   - llama.cpp / LM Studio + Hermes-class models answer the terminal
          //     `done` step in prose whatever `tool_choice` says, while calling a
          //     forced tool reliably from a single user prompt (the stateless pool
          //     picker keeps working for the same operator on the same backend).
          //   - GLM (Zhipu/Z.ai) declines the forced `done` ~1/3 of the time and
          //     tends to KEEP declining once it has in the same conversation;
          //     direct API testing showed a fresh single-turn call recovers far
          //     more reliably than a continuation of the failed trail.
          // Both want the same move, so this replaced the clean-context re-run that
          // used to sit here: that one dropped the prose but still replayed the
          // session window into a ToolLoopAgent, keeping the multi-turn shape it
          // was trying to escape (and giving up the discovery trail with it).
          // renderTerminalPrompt flattens the trail into the prompt instead, so the
          // model still commits to a REAL surfaced id rather than fabricating one.
          // Attempt count is unchanged (main → recovery → this), which matters:
          // every attempt draws on the same shared deadline, so an extra leg would
          // simply never be reached on the slow local rigs that need this most.
          if (!(result.staticToolCalls || []).some((c) => c.toolName === 'done')) {
            console.log(`[${kind}] recovery also stopped without calling done — collapsing to a single-turn terminal call`);
            recordAgentRetry();
            lastVia = 'ai-sdk:agent:terminal';
            try {
              const prompt = renderTerminalPrompt(messages, discoveryTrail);
              const t = await runDeadlinedCall(deadlineAt, kind, 'agent terminal collapse',
                (runSignal) => objectViaToolCall(leg, {
                  system, prompt, schema, temperature, maxOutputTokens, signal: runSignal,
                }), signal);
              terminalObject = t.object;
              addUsage(t.usage);
              terminalPrompt = prompt;
              // The collapse is a real model call the record should count —
              // steps otherwise reads as if the recovery's step total answered.
              steps += 1;
            } catch (e) {
              // A miss here is not the end of the road — the text salvage below
              // still gets a shot, and the caller's pool fallback after that. Log
              // and carry on rather than throwing past both. Recorded alongside
              // the declined attempts so /debug shows the whole cascade, not a
              // silent gap between the recovery and the final throw.
              const why = (e as Error)?.message || String(e);
              console.log(`[${kind}] terminal collapse failed (${why}) — falling through to text salvage`);
              declinedAttempts.push(`[terminal] ${why}`);
            }
          }
        }

        let object;
        if (useDoneTool) {
          // staticToolCalls carries the FINAL step's tool calls — the SDK surfaces
          // calls that weren't executed (like our no-execute `done`) here.
          const doneCall = (result.staticToolCalls || []).find((c) => c.toolName === 'done');
          if (doneCall) {
            object = doneCall.input;
          } else if (terminalObject !== undefined) {
            // The single-turn collapse answered. objectViaToolCall has already
            // Zod-parsed it, so it lands here schema-valid, same as a done call.
            object = terminalObject;
          } else {
            // Salvage: some models (deepseek-v4-flash) end the forced loop emitting
            // the answer as text/JSON instead of a `done` call — even after the
            // done-only recovery. Parse it from text and Zod-validate before giving
            // up, mirroring djObject's recovery. Only throw (→ caller's pool
            // fallback) when there's no usable JSON either.
            try {
              object = schema!.parse(JSON.parse(extractJson(stripThinking(result.text || ''))));
              lastVia = `${lastVia}:text`;
            } catch {
              const err = new Error('agent did not call the done tool before stopping') as AgentFailureError;
              // See declinedAttempts above — picked up by failureDiagnostics()
              // into the /debug record's responseText/toolCalls, and by
              // failover.ts's logFailurePreview into the container log line.
              err.text = declinedAttempts.length ? declinedAttempts.join('\n\n') : (result.text || '');
              err.finishReason = result.finishReason;
              // The full spend across every leg, not just the last result's —
              // in the raw TokenUsage shape failureDiagnostics feeds usageOf.
              err.usage = { inputTokens: spentUsage.input, outputTokens: spentUsage.output, totalTokens: spentUsage.total };
              err.steps = result.steps;
              throw err;
            }
          }
        } else if (schema) {
          object = result.output;
        } else {
          object = stripThinking(result.text);
        }

        // The discovery-tool trail for /debug (excludes the `done` tool), carried
        // from the main run rather than re-read off `result` — see captureTrail.
        const toolCalls = discoveryTrail;
        return {
          value: { object, steps, toolCalls },
          via: lastVia,
          sampling: samplingWithLocalKnobs(leg.cfg, { temperature }),
          // Every billable leg summed — see addUsage above.
          usage: spentUsage,
          perf: perfOf(result),
          warnings: warningsOf(result),
          // Full, untruncated — the agent's entire input and trail. When the
          // collapse answered, the flattened prompt it actually saw is what makes
          // that record readable, so it rides along beside the original messages.
          extra: {
            system, messages, toolCalls, steps,
            ...(terminalPrompt ? { terminalPrompt } : {}),
            response: schema ? JSON.stringify(object, null, 2) : String(object ?? ''),
          },
        };
      } catch (err) {
        // Attribute to the path actually attempted; withFailover writes the
        // record and decides whether a host-unreachable error tries the backup.
        (err as { __via?: string }).__via = lastVia;
        throw err;
      }
      },
      undefined,
      signal,
    ),
  );
}
