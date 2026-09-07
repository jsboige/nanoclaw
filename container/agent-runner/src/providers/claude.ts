import { query as sdkQuery, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/container-state.js';
import { touchHeartbeat } from '../heartbeat.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import type { ResolvedRuntimeConfiguration } from '../provider-contracts/registry.js';
// The execution-policy, inference, MCP, and memory derivations live in
// claude-config.ts. The runtime contract (provider-contracts/claude.ts)
// declares them; core calls them and hands the results to this provider's
// constructor and registerMemorySessionHook. This module never imports the
// contract — registration is two-step so it compiles on a core without one.
import {
  SDK_DISALLOWED_TOOLS,
  type resolveClaudeExecutionPolicy,
  type resolveClaudeInference,
  type resolveClaudeMcpServers,
  type resolveClaudeMemoryRuntime,
} from './claude-config.js';
// Transcript archiving and rotation are this provider's own concern: both
// read the SDK's on-disk .jsonl, which no other provider has.
import { archiveClaudeTranscript, rotateClaudeContinuation } from './claude-history.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

export interface SdkRateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  errorCode?: string;
  overageDisabledReason?: string;
}

/**
 * Map an SDK `rate_limit_event` to a provider event — or to NOTHING.
 *
 * The SDK emits this "when rate limit info changes": it is TELEMETRY, and
 * `status` is usually 'allowed' (here's your remaining headroom). We used to
 * treat every one as a terminal quota error: on a stock install that logged a
 * spurious "Rate limit (retryable: false, quota)" on perfectly healthy turns
 * (#3016), and any consumer acting on the classification aborted those turns
 * outright. **Only 'rejected' is an actual block.**
 *
 * When it IS rejected the SDK tells us WHY, so we distinguish properly instead
 * of guessing: `errorCode: 'credits_required'` / `overageDisabledReason:
 * 'out_of_credits'` means genuinely out of credits (billing); anything else is a
 * transient window limit that resets (`resetsAt`, `rateLimitType`).
 *
 * Returns null when the event is informational (do not disturb the turn).
 */
export function classifyRateLimitEvent(
  info: SdkRateLimitInfo | undefined,
): { message: string; classification: 'rate_limit' | 'quota' } | null {
  if (info?.status !== 'rejected') return null;
  const outOfCredits = info.errorCode === 'credits_required' || info.overageDisabledReason === 'out_of_credits';
  let detail = '';
  if (typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)) {
    const ms = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
    detail = ` (resets ${new Date(ms).toISOString()})`;
  }
  const window = info.rateLimitType ? ` [${info.rateLimitType}]` : '';
  return {
    message: `${outOfCredits ? 'Out of credits' : 'Rate limit'}${window}${detail}`,
    classification: outOfCredits ? 'quota' : 'rate_limit',
  };
}

export { SDK_DISALLOWED_TOOLS, TOOL_ALLOWLIST } from './claude-config.js';

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

/**
 * PreToolUse hook factory: record the current tool + its declared timeout so
 * the host sweep can widen its stuck tolerance while a long tool runs. The
 * declared timeout is read from `tool_input.timeout` for Bash, and from the
 * MCP server config for `mcp__<server>__*` tools — without it, an MCP that
 * legitimately takes >30 min racing against the absolute-ceiling kill (see
 * incident 2026-04-26: sk-agent.list_agents hung in mcp-remote bridge,
 * heartbeat stalled, host killed at the same instant the SDK would have
 * timed out internally). Also touches the heartbeat so the kill clock starts
 * fresh from tool start. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips
 * through somehow, block the call here instead of letting the agent hang.
 */
function createPreToolUseHook(mcpServers: Record<string, McpServerConfig>): HookCallback {
  return async (input) => {
    const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
    const toolName = i.tool_name ?? '';
    if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
      return {
        decision: 'block',
        stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
      } as unknown as ReturnType<HookCallback>;
    }
    let declaredTimeoutMs: number | null = null;
    if (toolName === 'Bash' && typeof i.tool_input?.timeout === 'number') {
      declaredTimeoutMs = i.tool_input.timeout as number;
    } else if (toolName.startsWith('mcp__')) {
      const serverName = toolName.split('__')[1];
      const serverCfg = serverName ? mcpServers[serverName] : undefined;
      const cfgTimeout = (serverCfg as { timeout?: number } | undefined)?.timeout;
      if (typeof cfgTimeout === 'number') declaredTimeoutMs = cfgTimeout * 1000;
    }
    try {
      setContainerToolInFlight(toolName, declaredTimeoutMs);
      touchHeartbeat();
    } catch (err) {
      log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { continue: true };
  };
}

/**
 * Clear in-flight tool on PostToolUse / PostToolUseFailure. Refreshes the
 * heartbeat so the next tool/turn gets a fresh kill window.
 */
const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
    touchHeartbeat();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/** The real clock for archive names and rotation stamps; tests hand the history functions a fixed one. */
const REAL_CLOCK = { now: () => Date.now() };

// The PreCompact hook is provider-originated: the SDK raises it from inside
// the query, and the archive it triggers reads the SDK's own transcript.
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    archiveClaudeTranscript(
      {
        transcriptPath: preCompact.transcript_path,
        sessionId: preCompact.session_id,
        assistantName,
        log,
      },
      REAL_CLOCK,
    );
    return {};
  };
}

// ── Provider ──

/**
 * Claude Code auto-compacts context at this window (tokens). Kept here so
 * the generic bootstrap doesn't need to know about Claude-specific env vars.
 *
 * Operator override: set CLAUDE_CODE_AUTO_COMPACT_WINDOW in the host env to
 * raise or lower the threshold without editing source — useful when running
 * with a 1M-context model variant or when emergency-tuning a deployment.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000';

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc. Also matches the synthetic "MCP servers not connected"
 * error from translateEvents — when init reports a required MCP as
 * failed/missing, the safest recovery is to drop the continuation so the
 * next attempt starts a fresh session (the broken init might be tied to
 * the resumed transcript's stored tool registry). Also matches the
 * "MCP registry lost mid-session" synthetic error (issue #27 branch 2)
 * for the same reason — the broken registry is bound to this resumed
 * transcript, only a fresh session restores tool visibility.
 */
// [PATCH-myia #42] "autocompact is thrashing" is surfaced by the SDK as a
// result error (not a thrown error) when the resumed transcript is too large
// to compact within the configured window — small-window models (glm-5.2
// @ 250k) reach this at ~5-6MB, below the 12MB cold-start rotate cap. Adding
// it here lets the poll-loop's result path (which already clears the
// continuation on isSessionInvalid) recover a thrashing session in one turn
// instead of looping forever. See poll-loop.ts result-path handler.
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found|MCP servers not connected at init|MCP registry lost mid-session|autocompact is thrashing/i;

/**
 * Match the synthetic tool_result text the SDK injects when the model
 * calls a tool that isn't in its registry. Captures: full tool name +
 * server name. We deliberately match the "mcp__<server>__<tool>" shape
 * so non-MCP fake tool names (e.g. the model hallucinating a builtin)
 * don't trigger session resets.
 */
const NO_SUCH_MCP_TOOL_RE = /No such tool available:\s*(mcp__([A-Za-z0-9_.-]+)__[A-Za-z0-9_.-]+)/;

/**
 * Extract a missing required MCP tool from a synthetic SDK user message
 * carrying a tool_result with is_error=true. Returns null when the
 * message isn't a tool-error, the error isn't an "unknown tool" error,
 * or the missing tool doesn't belong to a required server (so we don't
 * reset the session because the model hallucinated `Bashh` or similar).
 *
 * Exported for testability — the SDK message format is opaque, this
 * keeps the regex/structural assumptions in one auditable place.
 */
export function detectMissingMcpTool(
  userMessage: { message?: { content?: unknown } },
  requiredServers: ReadonlySet<string>,
): { toolName: string; serverName: string } | null {
  const content = userMessage?.message?.content;
  if (!Array.isArray(content)) return null;

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; is_error?: boolean; content?: unknown };
    if (b.type !== 'tool_result' || b.is_error !== true) continue;

    // tool_result.content is either a string or an array of {type:"text",text}
    let text = '';
    if (typeof b.content === 'string') {
      text = b.content;
    } else if (Array.isArray(b.content)) {
      for (const sub of b.content) {
        if (sub && typeof sub === 'object' && (sub as { type?: string }).type === 'text') {
          const t = (sub as { text?: unknown }).text;
          if (typeof t === 'string') text += t;
        }
      }
    } else {
      continue;
    }

    const m = NO_SUCH_MCP_TOOL_RE.exec(text);
    if (!m) continue;
    const serverName = m[2];
    if (!requiredServers.has(serverName)) continue;
    return { toolName: m[1], serverName };
  }
  return null;
}

/**
 * [PATCH-myia #43] Detect the SDK's autocompact-thrash notice inside an
 * ASSISTANT message. The SDK surfaces "Autocompact is thrashing: the context
 * refilled to the limit within 3 turns of the previous compact, 3 times in a
 * row..." as an assistant text block (verified firsthand in transcript
 * 6b55129b, 2026-07-19) — NOT as a `result` event with is_error=true. PATCH
 * #42's self-heal only checked the result branch, so it never fired for the
 * real event shape: the bloated session re-thrashed every turn, silently
 * eating every inbound message (the owner's week-long "nanoclaw is basically
 * broken" complaint).
 *
 * The signature is matched with the trailing colon ("thrashing:") so an agent
 * casually discussing this very bug in its own reply doesn't trip a false
 * session reset — the SDK always formats the notice with the colon.
 *
 * Exported for testability, mirroring detectMissingMcpTool.
 */
export function detectAutocompactThrash(assistantMessage: {
  message?: { content?: unknown };
}): string | null {
  const content = assistantMessage?.message?.content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: unknown };
    if (b.type !== 'text' || typeof b.text !== 'string') continue;
    if (/autocompact is thrashing:/i.test(b.text)) return b.text;
  }
  return null;
}

export class ClaudeProvider implements AgentProvider {
  private assistantName?: string;
  private mcp: ReturnType<typeof resolveClaudeMcpServers>;
  private inference: ReturnType<typeof resolveClaudeInference>;
  private executionPolicy: ReturnType<typeof resolveClaudeExecutionPolicy>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  private memorySessionHook?: MemorySessionHookRegistration;

  /**
   * `configuration` is the contract's configuration as resolved by core
   * (createProvider): execution policy, inference, and MCP servers. This
   * provider does not call the resolves itself.
   */
  constructor(options: ProviderOptions, configuration: ResolvedRuntimeConfiguration) {
    this.assistantName = options.assistantName;
    this.mcp = configuration.mcpServers as ReturnType<typeof resolveClaudeMcpServers>;
    this.additionalDirectories = options.additionalDirectories;
    this.inference = configuration.inference as ReturnType<typeof resolveClaudeInference>;
    this.executionPolicy = configuration.executionPolicy as ReturnType<typeof resolveClaudeExecutionPolicy>;
    this.env = {
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    };
  }

  /**
   * `memory` is the contract's resolved memory capability (the runtime env
   * that keeps the SDK's own auto-memory off). Core registers the hook before
   * any query, so the SDK sees the same env it always did.
   */
  registerMemorySessionHook(hook: MemorySessionHookRegistration, memory?: unknown): void {
    this.memorySessionHook = hook;
    this.env = {
      ...this.env,
      ...((memory as ReturnType<typeof resolveClaudeMemoryRuntime> | undefined) ?? {}),
    };
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  /**
   * Pre-resume maintenance: drop a transcript too large or too old to
   * cold-resume within the host's idle ceiling (see claude-history.ts).
   */
  maybeRotateContinuation(continuation: string, _cwd: string): string | null {
    return rotateClaudeContinuation({ continuation, assistantName: this.assistantName, log }, REAL_CLOCK);
  }

  query(input: QueryInput): AgentQuery {
    if (!this.memorySessionHook) throw new Error('Claude memory session hook was not registered');
    const stream = new MessageStream();
    stream.push(input.prompt);

    const instructions = input.systemContext?.instructions;

    // [PATCH-myia #28] AbortController so the tool-stuck watchdog can break
    // out of a hung SDK iteration. `abort()` alone (setting a flag + ending
    // stdin) doesn't unstick a `for await (const msg of sdkResult)` that is
    // suspended awaiting the next message — the flag check only runs when
    // a new message arrives, which never happens during a hung MCP call.
    // Passing the signal here lets the SDK tear down the CLI subprocess
    // + MCP transports when we abort, which causes the async iterator to
    // settle and the for-await to exit. Belt-and-braces: we also call
    // sdkResult.close() in abort() below — the SDK doc on Query.close()
    // says it "forcefully ends the query, cleaning up all resources
    // including pending requests, MCP transports, and the CLI subprocess."
    const abortController = new AbortController();

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        abortController,
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: instructions
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions }
          : undefined,
        allowedTools: [...this.mcp.allowedTools],
        disallowedTools: [...this.executionPolicy.disallowedTools],
        env: this.env,
        model: this.inference.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        effort: this.inference.effort as any,
        permissionMode: this.executionPolicy.permissionMode,
        allowDangerouslySkipPermissions: this.executionPolicy.allowDangerouslySkipPermissions,
        settingSources: ['project', 'user', 'local'],
        // Only sent when enabled, so an install that never turns it on passes
        // exactly the options it always did. `fastMode` is a Settings member
        // rather than a query option, which is why it rides `settings`.
        ...(this.inference.settings ? { settings: this.inference.settings } : {}),
        mcpServers: this.mcp.mcpServers,
        hooks: {
          PreToolUse: [{ hooks: [createPreToolUseHook(this.mcp.mcpServers)] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;
    const requiredMcpServers = Object.keys(this.mcp.mcpServers);
    const requiredServerSet = new Set(requiredMcpServers);
    let mcpRegistryLostEmitted = false;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      for await (const message of sdkResult) {
        if (aborted) return;
        messageCount++;

        // Yield activity for every SDK event so the poll loop knows the agent is working
        yield { type: 'activity' };

        // Issue #27 branch 2: SDK auto-injects a tool_result with
        // is_error=true and "No such tool available: mcp__<server>__*"
        // when the model calls a tool that isn't in its current registry.
        // Observed pattern: 22 occurrences in a single resumed session
        // (412a71e3) between 2026-04-24 and 2026-05-01, all post-compaction
        // on z.ai's Anthropic-pretend endpoint. Chain HTTP probe stayed
        // healthy throughout — the SDK's own registry was the broken layer.
        // We emit once per query (the loss is session-wide; the first hit
        // tells us all we need) and stop the stream so the poll-loop can
        // clear the continuation and let the host respawn fresh.
        if (!mcpRegistryLostEmitted && message.type === 'user') {
          const missing = detectMissingMcpTool(
            message as { message?: { content?: unknown } },
            requiredServerSet,
          );
          if (missing) {
            mcpRegistryLostEmitted = true;
            log(`MCP registry lost mid-session: ${missing.toolName} not in SDK registry — aborting turn for fresh respawn`);
            yield { type: 'mcp_tool_missing', toolName: missing.toolName, serverName: missing.serverName };
            return;
          }
        }

        // [PATCH-myia #43] Autocompact-thrash self-heal at the correct layer.
        // The thrash notice arrives as an ASSISTANT text message (not a result
        // error), so #42's result-branch check never fired. Throw here so the
        // outer loop's #31/#35 stale-recovery path runs: isSessionInvalid()
        // already matches "autocompact is thrashing" (STALE_SESSION_RE), which
        // (a) clears the continuation so the next turn starts a FRESH session,
        // and (b) resets the batch to pending so the user's message survives
        // into that fresh session instead of being silently markCompleted by
        // the result path. Mirrors the mcp_tool_missing abort above, but via
        // throw (not yield+return) to reach the message-preserving path.
        if (message.type === 'assistant') {
          const thrash = detectAutocompactThrash(message as { message?: { content?: unknown } });
          if (thrash) {
            log('Autocompact thrash detected in assistant message — aborting turn so the outer loop clears the continuation and preserves the batch for a fresh session');
            throw new Error(`autocompact is thrashing (session too large to compact — resetting): ${thrash.slice(0, 160)}`);
          }
        }

        if (message.type === 'system' && message.subtype === 'init') {
          // Issue #27: catch the failure mode where the SDK's MCP registry is
          // empty/broken even though the HTTP chain probe in mcp-health.ts
          // says everything is fine. We only throw on TERMINAL failure
          // states ('failed', 'needs-auth'): 'pending' is the normal
          // mid-handshake state the SDK reports while async MCP connections
          // are still completing, and rejecting it would block every
          // healthy startup. 'connected' and 'disabled' are fine.
          // A required server missing from mcp_servers[] entirely is also
          // treated as a soft warning, not fatal — the SDK may not have
          // populated that array yet at init time.
          const initMsg = message as { mcp_servers?: { name: string; status: string }[]; session_id: string };
          const reportedServers = initMsg.mcp_servers ?? [];
          const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'needs-auth']);
          const reports = requiredMcpServers.map((name) => {
            const entry = reportedServers.find((s) => s.name === name);
            return { name, status: entry?.status ?? 'missing' };
          });
          const failed = reports.filter((s) => TERMINAL_FAILURE_STATUSES.has(s.status));
          const nonConnected = reports.filter((s) => s.status !== 'connected');
          if (nonConnected.length > 0) {
            const summary = nonConnected.map((d) => `${d.name}=${d.status}`).join(', ');
            log(`MCP init status — ${summary} (session ${initMsg.session_id})`);
          }
          if (failed.length > 0) {
            const summary = failed.map((d) => `${d.name}=${d.status}`).join(', ');
            throw new Error(`MCP servers not connected at init: ${summary}`);
          }
          yield { type: 'init', continuation: message.session_id };
        } else if (message.type === 'assistant') {
          // Surface each assistant message's text as it streams in. The final
          // `result` event only carries the LAST assistant text — a wrapped
          // <message> block composed between tool calls would otherwise be
          // invisible to the poll-loop and silently lost.
          //
          // ONE text event per assistant message, joining its text blocks in
          // content order ('' separator — the blocks are adjacent output).
          // Emitting per-BLOCK events would hand the poll-loop's block parser
          // fragments: a <message> block (or an <internal> span) spanning two
          // text blocks of the same assistant message would look unterminated
          // in each event, while the turn's result text — which reports the
          // final message's text as a whole — could still contain it complete.
          // Joining pins the containment premise at the granularity the
          // result reports. Blocks split across ASSISTANT MESSAGES (a tool
          // call between them) remain unparseable mid-turn by design; the
          // poll-loop's midTurnSent===0 fallback and wrap-nudge cover that.
          const content = (message as { message?: { content?: Array<{ type?: string; text?: string }> } }).message
            ?.content;
          if (Array.isArray(content)) {
            const text = content
              .filter((block) => block.type === 'text' && block.text)
              .map((block) => block.text)
              .join('');
            if (text) yield { type: 'text', text };
          }
        } else if (message.type === 'result') {
          // `result` text exists only on subtype:"success"; error subtypes
          // (e.g. a non-retryable 403 billing_error) carry their message in
          // `errors[]` instead. Surface either so the poll-loop can deliver a
          // billing/quota notice to the user rather than dropping the turn.
          const m = message as { result?: string; is_error?: boolean; errors?: string[] };
          const text = m.result ?? (m.errors && m.errors.length > 0 ? m.errors.join('\n') : null);
          yield { type: 'result', text, isError: m.is_error === true };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
          yield { type: 'error', message: 'API retry', retryable: true };
        } else if (message.type === 'rate_limit_event') {
          // The SDK emits this "when rate limit info CHANGES" — it is telemetry,
          // not necessarily an error. `rate_limit_info.status` is usually
          // 'allowed' (here's your remaining headroom). Treating every one of
          // these as a terminal quota error logged a spurious rate-limit line
          // on healthy turns (#3016) — and aborted them outright wherever the
          // classification is acted on. ONLY 'rejected' is an actual block.
          //
          // When it IS rejected the SDK tells us WHY, so we can finally
          // distinguish the two cases properly instead of guessing:
          //   errorCode 'credits_required' / overageDisabledReason
          //   'out_of_credits'  → genuinely out of credits (billing)
          //   otherwise         → a transient window limit that resets.
          const info = (message as { rate_limit_info?: SdkRateLimitInfo }).rate_limit_info;
          const blocked = classifyRateLimitEvent(info);
          if (!blocked) {
            // Informational ('allowed' / 'allowed_warning') — never kill the turn.
            if (info?.status === 'allowed_warning') {
              log(
                `rate-limit warning: ${info.rateLimitType ?? 'window'} at ${
                  info.utilization != null ? `${Math.round(info.utilization * 100)}%` : 'high'
                } utilization`,
              );
            }
          } else {
            yield { type: 'error', message: blocked.message, retryable: false, classification: blocked.classification };
          }
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
          const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
          // Not a `result`: the poll loop treats result text as the agent's turn
          // output — a synthetic "Context compacted." result has no <message>
          // block, so it triggers the "response was not delivered — please
          // re-send" nudge and the agent duplicates its previous message.
          // Compaction is bookkeeping: log it, count it as activity only.
          log(`Context compacted${detail}.`);
          yield { type: 'activity' };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
          const tn = message as { summary?: string };
          yield { type: 'progress', message: tn.summary || 'Task notification' };
        }
      }
      log(`Query completed after ${messageCount} SDK messages`);
    }

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        // [PATCH-myia #28] Force the SDK to tear down its CLI subprocess +
        // MCP transports. Without this, a query hung in an MCP tool call
        // never wakes — the for-await in translateEvents stays suspended
        // awaiting a message that will never arrive. Calling abort on the
        // AbortController + close() on the Query both target the same
        // underlying cleanup, but covering both shields us from SDK
        // versions where one path lags.
        try {
          abortController.abort();
        } catch (err) {
          log(`abortController.abort() failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        try {
          sdkResult.close();
        } catch (err) {
          log(`sdkResult.close() failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        stream.end();
      },
    };
  }
}

// Function-form registration only; the runtime contract attaches itself from
// provider-contracts/claude.ts through the same two-step path any
// skill-installed provider uses.
registerProvider('claude', (opts, configuration) => {
  if (!configuration) {
    throw new Error('Claude provider requires its runtime contract; construct it through createProvider');
  }
  return new ClaudeProvider(opts, configuration);
});
