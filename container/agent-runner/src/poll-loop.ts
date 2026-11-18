import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import {
  getPendingMessages,
  markProcessing,
  markCompleted,
  resetProcessingAcks, // [PATCH-myia #18]
  markScriptSkipped,
  type MessageInRow,
} from './db/messages-in.js';
import { getUndeliveredMessages, writeMessageOut, type MessageOutRow } from './db/messages-out.js';
import { clearContainerToolInFlight, clearStaleProcessingAcks } from './db/container-state.js';
// [PATCH-myia #28] tool-in-flight read side — sqlite impl, see connection.ts.
import { getContainerToolInFlight } from './mailbox/sqlite/connection.js';
import { resolveDestinationThread } from './db/session-routing.js';
import { touchHeartbeat } from './heartbeat.js';
import { getAgentMailbox } from './mailbox/index.js';
import { recordTaskRun } from './db/task-run-logs.js'; // [PATCH-myia #9]
import { getDeliveredTaskIds } from './db/task-delivery-ledger.js'; // [PATCH-myia #51]
import {
  clearContinuation,
  migrateLegacyContinuation,
  setContinuation,
  setCurrentReplyRoute,
  resetBatchSendCount, // [PATCH-myia #37]
  setCurrentTaskExec, // [PATCH-myia #51]
} from './db/session-state.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  FAILURE_NOTICE_FIELD,
  GENERIC_FAILURE_NOTICE,
  isClearCommand,
  isRunnerCommand,
  isSessionEcho,
  stripInternalTags,
  stripLeakedMcpToolcalls, // [PATCH-myia #16]
  type RoutingContext,
} from './formatter.js';
// [PATCH-myia #8] mcp-health probe
import { formatFailures, probeMcpRemoteCached, type RequiredRemote } from './mcp-health.js';
import { stripHarnessTagArtifacts } from './harness-tag-strip.js';
import { isUploadTraceCommand, uploadTrace } from './upload-trace.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderExchange } from './providers/types.js';
import type { ProviderRuntimeContract } from './provider-contracts/registry.js';

/** Publish `routing` as the reply stamp the MCP tools read (null route clears it).
 * Adopted from upstream v2.4.0 (renamed API) — same intent as the old
 * setCurrentInReplyTo stamp this fork shipped. */
function publishReplyRoute(routing: RoutingContext): void {
  setCurrentReplyRoute(
    routing.inReplyTo
      ? {
          inReplyTo: routing.inReplyTo,
          channelType: routing.channelType,
          platformId: routing.platformId,
          threadId: routing.threadId,
        }
      : null,
  );
}

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

// [PATCH-myia #18] Push-mode stall watchdog. If we push a follow-up batch into
// an active SDK query and don't see a `result` event within this window, we
// treat the query as stalled, reset the pushed messages back to pending (so
// the next poll iteration re-picks them) and abort the query. Without this,
// pushes that the SDK silently fails to address are lost (the messages were
// being marked `completed` immediately after `query.push()`).
//
// 240s chosen as: long enough to ride out a mid-turn auto-compaction on a
// large context. The SDK can go fully silent for >90s while it compacts a
// ~167k-token transcript; the original 90s budget only covered ~10-30s tool
// calls / 60s slow MCP and false-tripped on heavy cron review turns, aborting
// the query mid-compaction -> reset-to-pending -> re-fire loop. Still far
// below the genuine-hang backstops: the heartbeat tickle (PATCH #24), the
// tool-stuck watchdog (PATCH #28, 5min) and the host absolute-ceiling (30min)
// all still catch a truly wedged query.
const STALL_TIMEOUT_MS = 240_000;
const STALL_CHECK_INTERVAL_MS = 5_000;

// [PATCH-myia #18b] Periodic SDK query refresh. After this much wall-clock
// time on a single push-mode query, end gracefully after the next `result`
// event so the outer loop spawns a fresh query (continuation token preserved
// — the SDK resumes the same conversation, just with a clean stream + module
// state). Belt-and-braces against long-lived SDK sessions accumulating state
// that increases the rate of push-mode stalls (the precipitating bug for
// PATCH #18 was a 12-hour-old single SDK query). 2h chosen as: long enough
// that a single user conversation rarely hits it; short enough that a busy
// always-on agent (cron tasks) recycles a few times per day.
const QUERY_REFRESH_AFTER_MS = 2 * 60 * 60 * 1000;

// [PATCH-myia #24] Heartbeat keep-alive cadence during an active SDK query.
// The host-sweep claim-stuck rule kills a container when a `processing_ack`
// row has been claimed for >60s AND the heartbeat file hasn't been touched
// since the claim (see src/host-sweep.ts CLAIM_STUCK_MS). Upstream only
// touches heartbeat on SDK events — so any legitimate SDK silence longer
// than 60s (context auto-compaction before the first event of a new turn,
// slow MCP probe, model first-token latency under load) trips the kill
// even though the container's event loop is alive and waiting. The tickle
// interval below proves liveness from the container side at a cadence
// well under the host's threshold. A truly-frozen process can't run the
// callback, so this doesn't mask hard hangs.
const HEARTBEAT_TICKLE_INTERVAL_MS = 15_000;

// [PATCH-myia #27] Idle-with-pending watchdog. Catches the failure mode
// where a turn finished (`awaitingResult=false`) but new inbound messages
// aren't being pushed into the live SDK query — either because pollHandle
// is stuck (e.g. its IIFE hung in `applyPreTaskScripts`, latched
// `pollInFlight=true`), `query.push()` silently no-ops because the SDK
// subprocess has died, or the SDK accepted the push but never emits any
// event for it.
//
// PATCH #26 (stall watchdog) gates on `awaitingResult === true` — it only
// fires while we are expecting a result. This watchdog covers the
// complementary gate: `awaitingResult === false` while trigger=1 messages
// are piling up in `messages_in` unprocessed. Action is to force
// `query.end()` so the outer poll loop spawns a fresh query (the
// persisted continuation token resumes the same conversation) and
// processes the backlog.
//
// 45s chosen: long enough that a normal 500ms pollHandle cycle + worst-
// case pre-task script + push always completes within the window; short
// enough that the user retrying after the bot's silence sees a recovered
// response while they're still in front of the screen.
const IDLE_WITH_PENDING_TIMEOUT_MS = 45_000;
const IDLE_CHECK_INTERVAL_MS = 5_000;

// [PATCH-myia #28] Tool-stuck watchdog. The complementary failure mode to
// #26 (which gates on SDK silence): the SDK is still emitting events
// (thinking deltas, partial assistant deltas, stream keepalives) but a
// specific tool call has been pending far longer than reasonable. The
// 2026-05-18 incident: `mcp__roo-state-manager__roosync_dashboard` stuck
// for 22h because the MCP server (TBXark/sparfenyuk/roo-state-manager
// chain) never returned a response. The Claude Agent SDK doesn't expose
// per-tool timeouts (`McpStdioServerConfig` has none); a hung MCP call
// dangles indefinitely. Meanwhile #24's heartbeat tickle suppresses the
// host's kill, #26's `lastSdkEventAt` keeps getting bumped by other SDK
// events while the tool awaits, and `container_state.tool_started_at`
// (populated by claude.ts's PreToolUse hook) was tracked but never
// consulted by any watchdog. Result: 18 user messages silently swallowed,
// recovered only by manual `Stop-Service` + DELETE on processing_ack.
//
// Action: every TOOL_STUCK_CHECK_INTERVAL_MS read container_state. If a
// tool is in flight beyond its budget, force `query.abort()` and reset
// claims so the outer loop respawns. Source of truth = the DB row, not
// SDK events — independent of whatever keepalive traffic the stream
// carries during the stall.
//
// Budget: `max(declared_timeout_ms * 1.5, TOOL_STUCK_DEFAULT_MS)`. Bash
// declares a per-call timeout via tool_input.timeout (claude.ts:178); MCP
// servers declare it via the per-server `timeout` config (claude.ts:182).
// For tools with no declaration, 5 min default covers legitimate slow
// calls (Whisper batch transcribe ≤90s, large dashboard reads ≤60s) with
// a wide margin; 30s check cadence keeps user-visible silence under
// ~6 min worst case + fresh-query startup.
const TOOL_STUCK_DEFAULT_MS = 5 * 60 * 1000;
const TOOL_STUCK_CHECK_INTERVAL_MS = 30_000;

// [PATCH-myia #30] Idle heartbeat keep-alive window. The host-sweep absolute
// ceiling (src/host-sweep.ts ABSOLUTE_CEILING_MS) kills any container whose
// heartbeat file is older than 30 min — INCLUDING idle ones, because the idle
// branch of this loop never touched the heartbeat. The result was hourly cold
// churn: an always-on agent (cron tasks, an always-warm bot) gets reaped at
// the 30-min mark, then respawned on the next inbound, and the cold-restart
// startup window (first roosync_dashboard call / pre-turn MCP probe racing the
// proxy) is exactly where the "lost MCPs" symptom shows up. Tickling the
// heartbeat while idle keeps a healthy container warm so it isn't paying that
// restart tax every hour.
//
// Bounded so a genuinely-abandoned container still dies: after this much
// continuous idle we STOP tickling, the heartbeat goes stale, and the next
// sweep reaps it on the normal ceiling rule. The budget resets to 0 every
// time a real (trigger=1) batch is processed, so an active agent never hits
// it. 2h chosen: longer than any plausible quiet stretch for an always-on
// agent between cron fires, short enough that an orphaned container frees its
// resources the same afternoon.
const IDLE_KEEPALIVE_MS = 2 * 60 * 60 * 1000;

// [PATCH-myia #41] How often, while idle, to re-evaluate the provider's
// continuation-rotation guard (transcript size/age cold-resume cap). The guard
// is otherwise only checked once at container startup; a container that stays
// up for hours never re-checks, so a transcript that grows past the cap
// *between* tours rides an ever-growing .jsonl into the cold-resume/thrash
// wedge (#2177 zombie — wedge #7 reached 21MB before the SDK query died).
// 60s is far finer than the multi-hour growth that produced the wedge, and the
// probe (findTranscriptPath + statSync) is cheap, so this adds no meaningful
// idle cost while closing the mid-life gap.
const ROTATE_CHECK_INTERVAL_MS = 60_000;

// [PATCH-myia #29] Fail-fast gate softening. The per-turn required-MCP gate
// (further down) previously, on a probe failure, wrote a 🛑 BLOCKED chat
// message AND `markCompleted`'d the user's message — permanently dropping it.
// Combined with the 60s probe-failure cache, a single sub-second proxy blip
// (e.g. the MCP chain mid-restart) turned into a 60s window during which every
// inbound was answered with 🛑 and then discarded. The bot looked like it had
// "lost its MCPs" when the chain was actually fine seconds later.
//
// New behavior: on a blocked turn we RESET the claim (resetProcessingAcks) so
// the message stays pending and is retried once the chain recovers; we THROTTLE
// the user-visible 🛑 notice to at most once per BLOCKED_NOTICE_THROTTLE_MS so a
// flapping chain doesn't spam the channel; and we sleep BLOCKED_RETRY_BACKOFF_MS
// before the next iteration so the retry loop doesn't hot-spin on the proxy.
// Paired with mcp-health caching successes only, so a recovered chain unblocks
// within one retry window instead of waiting out a cached failure.
//
// [PATCH-myia #31] extends the same softening to the reactive catch path
// (SDK init throws "MCP servers not connected at init" after the proactive
// probe passed). Both constants are reused there.
const BLOCKED_NOTICE_THROTTLE_MS = 5 * 60 * 1000;
const BLOCKED_RETRY_BACKOFF_MS = 10_000;

// [PATCH-myia #42] Autocompact-thrash result signature. The SDK emits this as
// a result error when the resumed transcript is too large to compact within
// the configured window. Matched in processQuery's result path so the
// continuation can be dropped and the next turn starts fresh — breaking the
// infinite thrash loop. Mirrored in providers/claude.ts STALE_SESSION_RE so
// the catch path (thrown variant) recovers too.
const THRASH_RE = /autocompact is thrashing/i;

// [PATCH-myia #35] Cap consecutive isSessionInvalid retries on the same
// processingIds set so the reactive PATCH #31 path can't loop forever when
// the failure is persistent (not transient). PATCH #31 was designed for a
// brief MCP-init handshake blip that the next iteration would clear; the
// 2026-05-28 cert SAN gap exposed a persistent failure mode (TLS workaround
// makes the proactive `mcp-health` probe pass while the SDK's own MCP init
// still rejects). Without an upper bound, a single cron firing emitted one
// "Review cycle :30 starting" PING per retry until the host killed the
// container. Cap chosen as 3: enough to cover a transient init handshake
// (1-2 retries typical), tight enough to keep per-cycle Telegram noise
// within the user's "<=3 lines per cycle" directive (2026-05-27). On cap
// exhaustion, batchError records 'stale_retry_cap_exhausted' so
// task_run_logs reflects the failure truthfully; markCompleted fires so the
// host's syncProcessingAcks + handleRecurrence advance the cron series at
// the next sweep tick instead of looping the same dead message.
const STALE_RETRY_CAP = 3;

/**
 * [PATCH-myia #35] Pure decision: increment the per-message-id stale-retry
 * counters for this batch and report whether any has reached the cap.
 *
 * Exported as a pure helper so the test doesn't have to spin up the whole
 * poll loop. The caller owns the Map; this function mutates it in place
 * (caller controls lifetime — typically scoped to one `runPollLoop`
 * invocation, cleared on successful or surrendered batches).
 *
 * Returns `{ exhausted: true }` once any id in `processingIds` has been
 * seen `cap` consecutive times without a clearing event. The caller's
 * responsibility on `exhausted`: delete the counter entries for these ids
 * and fall through to `markCompleted` so the host's `handleRecurrence`
 * advances the cron series at the next sweep tick.
 */
export function evaluateStaleRetryCap(
  counter: Map<string, number>,
  processingIds: string[],
  cap: number = STALE_RETRY_CAP,
): { exhausted: boolean; maxRetries: number } {
  let maxRetries = 0;
  for (const id of processingIds) {
    const next = (counter.get(id) ?? 0) + 1;
    counter.set(id, next);
    if (next > maxRetries) maxRetries = next;
  }
  return { exhausted: maxRetries >= cap, maxRetries };
}

/**
 * [PATCH-myia #28] Pure decision: should we abort because a tool has been
 * pending too long? Exported so unit tests don't have to spin up an SDK.
 *
 * Budget = `max(declared_timeout_ms * 1.5, defaultBudgetMs)`. The 1.5x slack
 * on a declared timeout covers the SDK's own jitter — if a tool has its own
 * deadline, we trust it to self-cancel within that window and only fire
 * when it has clearly missed.
 */
export function evaluateToolStuckBudget(
  state: {
    current_tool: string | null;
    tool_declared_timeout_ms: number | null;
    tool_started_at: string | null;
  } | null,
  nowMs: number,
  defaultBudgetMs: number = TOOL_STUCK_DEFAULT_MS,
): { abort: false } | { abort: true; tool: string; elapsedMs: number; budgetMs: number; declaredMs: number | null } {
  if (!state || !state.current_tool || !state.tool_started_at) return { abort: false };
  const startedMs = Date.parse(state.tool_started_at);
  if (Number.isNaN(startedMs)) return { abort: false };
  const declared = state.tool_declared_timeout_ms;
  const budget =
    declared && declared > 0 ? Math.max(declared * 1.5, defaultBudgetMs) : defaultBudgetMs;
  const elapsed = nowMs - startedMs;
  if (elapsed < budget) return { abort: false };
  return { abort: true, tool: state.current_tool, elapsedMs: elapsed, budgetMs: budget, declaredMs: declared };
}

/**
 * Number of consecutive `database disk image is malformed` errors after which
 * the follow-up poll gives up and exits the process. At ACTIVE_POLL_INTERVAL_MS
 * = 500ms this is roughly 5 seconds — long enough to dodge a transient torn
 * read during a host write, short enough to recover quickly from a poisoned
 * page cache (host-sweep then respawns with a fresh mount).
 */
const CORRUPTION_STREAK_EXIT = 10;

/**
 * True for SQLite errors that indicate a corrupt READ view — almost always a
 * cross-mount page-cache coherency issue on Docker Desktop macOS rather than
 * actual file damage (host-side integrity_check passes). Reopening the DB
 * handle inside this process does NOT recover; only a fresh container mount
 * does. Caller's job is to exit so host-sweep respawns the container.
 */
export function isCorruptionError(msg: string): boolean {
  return (
    msg.includes('database disk image is malformed') ||
    msg.includes('SQLITE_CORRUPT') ||
    msg.includes('file is not a database')
  );
}

/** Consecutive driver-classified failures before a fresh runner is required. */
const MAILBOX_FAILURE_STREAK_EXIT = 10;

/**
 * [PATCH-myia #41] Mid-life continuation-rotation policy.
 *
 * The provider's `maybeRotateContinuation` guard (transcript size/age
 * cold-resume cap) is evaluated once at startup — see the call just before the
 * poll loop. A long-lived container never re-checks it, so a transcript that
 * grows past the cap between tours rides an ever-growing .jsonl into the
 * cold-resume/thrash wedge (#2177 zombie; wedge #7 reached 21MB before the SDK
 * query died). The idle branch calls this to decide whether to re-probe now.
 *
 * Pure — the probe is injected — so the throttle policy is unit-testable
 * without driving the loop or touching the filesystem. `checked` reports
 * whether the probe ran (caller advances its throttle clock on true); `reason`
 * is the non-null rotate reason when a rotation should fire.
 *
 * Only re-checks while genuinely idle: the probe renames the live .jsonl aside
 * as a side effect, which is only safe when no query holds it.
 */
export function evaluateMidLifeRotation(args: {
  continuation: string | undefined;
  nowMs: number;
  lastCheckMs: number;
  intervalMs: number;
  probe: ((continuation: string) => string | null) | undefined;
}): { checked: boolean; reason: string | null } {
  const { continuation, nowMs, lastCheckMs, intervalMs, probe } = args;
  if (!continuation || !probe) return { checked: false, reason: null };
  if (nowMs - lastCheckMs < intervalMs) return { checked: false, reason: null };
  return { checked: true, reason: probe(continuation) };
}

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /** Declared provider runtime behavior. Contractless providers keep legacy defaults. */
  providerContract?: Pick<ProviderRuntimeContract, 'textDelivery' | 'commands'>;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
  /**
   * MCP remotes that must be reachable before each turn. If any are down,
   * the turn is blocked with an explicit 🛑 message (no silent partial
   * operation). Cached 60s to avoid hammering the proxy.
   */
  requiredRemotes?: RequiredRemote[];
  /**
   * Optional stop signal. In production the loop runs until the container
   * dies; tests pass a signal so an abandoned loop actually exits instead of
   * polling forever and stealing messages from the next test's DB.
   */
  signal?: AbortSignal;
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll the mailbox for pending messages
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write outbound messages
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Contract providers declare these; a contractless (legacy payload)
  // provider keeps declaring them as instance flags, exactly as before.
  const legacy = config.provider as { supportsNativeSlashCommands?: boolean; emitsMidTurnText?: boolean };
  const nativeSlashCommands = config.providerContract
    ? config.providerContract.commands.formatting === 'native'
    : (legacy.supportsNativeSlashCommands ?? false);
  const midTurnCompleteDelivery = config.providerContract
    ? config.providerContract.textDelivery === 'mid-turn-complete'
    : (legacy.emitsMidTurnText ?? false);

  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  // Before resuming, drop a session whose on-disk transcript has grown too
  // large/old to cold-resume within the host's idle ceiling. Without this a
  // long-lived hub keeps trying to reload an ever-growing .jsonl, hangs the
  // first turn, and gets killed before it can reply (then repeats forever).
  if (continuation) {
    const rotateReason = config.provider.maybeRotateContinuation?.(continuation, config.cwd);
    if (rotateReason) {
      log(`Rotating session — ${rotateReason}; starting fresh`);
      clearContinuation(config.providerName);
      continuation = undefined;
    }
  }

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  // [PATCH-myia #28] Clear any stale in-flight tool marker from a previous
  // container that was killed mid-tool. PostToolUse never fires for a
  // killed tool call, so `container_state` keeps a non-NULL `tool_started_at`
  // pointing at the dead container's clock. Without this, the tool-stuck
  // watchdog reads that stale row on the very first check of the new
  // container and can abort a brand-new query for a tool that isn't running.
  // (This is the 7qx60e-zombie failure mode: a `roosync_dashboard` row left
  // in flight survived the restart and tripped #28.)
  clearContainerToolInFlight();

  // [PATCH-myia #51] Clear any leftover task-exec attribution from a
  // container killed mid-batch (same rationale as the reply-route stamp):
  // a fresh container attributes nothing until its first batch publishes.
  setCurrentTaskExec(null);

  let pollCount = 0;
  // [PATCH-myia #30] Idle keep-alive bookkeeping. Timestamp of when the
  // current uninterrupted idle stretch began (0 = not currently idle).
  let idleSince = 0;
  // [PATCH-myia #41] Last time the idle branch re-evaluated the continuation
  // rotation guard (0 = never this container). Throttled by
  // ROTATE_CHECK_INTERVAL_MS.
  let lastRotateCheckAt = 0;
  // [PATCH-myia #29] When we last posted a 🛑 BLOCKED notice (0 = never).
  // Throttles the user-visible message while the MCP chain is flapping.
  let lastBlockedNoticeAt = 0;
  // [PATCH-myia #35] Per-message-id counter of consecutive
  // isSessionInvalid retries since the last successful (or surrendered)
  // batch. Reset on success; entries for ids that get markCompleted
  // (success OR cap exhaustion) are removed so future re-queued rows start
  // fresh. Container respawn on next cron also clears this.
  const staleRetryCount = new Map<string, number>();
  let isFirstPoll = true;
  while (true) {
    if (config.signal?.aborted) return;
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages(isFirstPoll).filter((m) => m.kind !== 'system');
    isFirstPoll = false;
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      // [PATCH-myia #30] Bounded idle heartbeat keep-alive. While genuinely
      // idle, prove liveness to the host so the absolute-ceiling sweep
      // doesn't reap a healthy container at 30 min (avoiding the hourly cold
      // churn that triggers the rough-startup "lost MCPs" window). Stop after
      // IDLE_KEEPALIVE_MS of continuous idle so an abandoned container still
      // goes stale and gets reaped.
      const nowIdle = Date.now();
      if (idleSince === 0) idleSince = nowIdle;
      if (nowIdle - idleSince < IDLE_KEEPALIVE_MS) touchHeartbeat();

      // [PATCH-myia #41] Mid-life continuation rotation. Re-evaluate the
      // provider's transcript-size/age guard here — idle is the only point
      // with no active query holding the .jsonl, so the probe's rename-aside
      // is safe. Without this, the guard runs only at startup and a container
      // up for hours grows its transcript past the cap into a cold-resume/
      // thrash wedge (#2177; wedge #7 hit 21MB). On a hit, drop the
      // continuation so the next turn starts a fresh transcript — the same
      // reset the manual zombie recovery performs, done pre-emptively.
      const rot = evaluateMidLifeRotation({
        continuation,
        nowMs: nowIdle,
        lastCheckMs: lastRotateCheckAt,
        intervalMs: ROTATE_CHECK_INTERVAL_MS,
        probe: config.provider.maybeRotateContinuation
          ? (c) => config.provider.maybeRotateContinuation!(c, config.cwd)
          : undefined,
      });
      if (rot.checked) lastRotateCheckAt = nowIdle;
      if (rot.reason) {
        log(`Rotating session mid-life — ${rot.reason}; next turn starts fresh`);
        clearContinuation(config.providerName);
        continuation = undefined;
      }

      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold through countDueMessages().
    if (!messages.some((m) => m.trigger === 1)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // [PATCH-myia #30] Real work this iteration — reset the idle keep-alive
    // budget so the next quiet stretch gets the full IDLE_KEEPALIVE_MS window.
    idleSince = 0;

    const ids = messages.map((m) => m.id);
    markProcessing(ids);
    // [PATCH-myia #24] Stamp heartbeat at claim time so the host's
    // claim-stuck rule starts ticking from a known-fresh state. The
    // setInterval inside processQuery picks up from here.
    touchHeartbeat();

    const routing = extractRouting(messages);

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(config.providerName);
        await writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      // isSessionEcho guard: a copied "/upload-trace" from another session is
      // ambient context, never a runner command (isClearCommand self-guards).
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && !isSessionEcho(msg) && isUploadTraceCommand(msg)) {
        log('Uploading session trace to Hugging Face');
        await writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: uploadTrace(config.providerName) }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Snapshot tasks before pre-task scripts run so we can attribute the
    // skipped/completed/failed status correctly to each task row in the
    // task_run_logs table afterwards.
    const tasksInBatch = normalMessages.filter((m) => m.kind === 'task');

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: Array<{ id: string; reason: string }> = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markScriptSkipped(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.map((s) => s.id).join(', ')}`);
      // [PATCH-myia #9] Log skipped tasks for after-the-fact observability.
      const skippedIds = new Set(skipped.map((s) => s.id));
      for (const task of tasksInBatch.filter((t) => skippedIds.has(t.id))) {
        recordTaskRun({
          task_id: task.id,
          series_id: task.series_id,
          run_at: new Date().toISOString(),
          duration_ms: 0,
          status: 'skipped',
        });
      }
    }
    // MODULE-HOOK:scheduling-pre-task:end

    // [PATCH-myia #51] Claim-time idempotence guard (roo-extensions#3350
    // class b). A task row whose id already has a delivery-ledger row was
    // delivered by a previous execution — the run died after publishing, the
    // host reset the claim to pending, and this is a re-claim. Never re-
    // execute it: skip the row (ack completed, like the script gate), log a
    // 'skipped' run, publish nothing. Legitimate re-runs are unaffected:
    // a host retry of a run that failed BEFORE publishing has no ledger row,
    // `ncl tasks run` and recurrence both mint fresh ids.
    {
      const keptTasks = keep.filter((m) => m.kind === 'task');
      if (keptTasks.length > 0) {
        const delivered = new Set(getDeliveredTaskIds(keptTasks.map((t) => t.id)));
        if (delivered.size > 0) {
          const dupes = keptTasks.filter((t) => delivered.has(t.id));
          const dupeSkips = dupes.map((t) => ({ id: t.id, reason: 'already-delivered' }));
          markScriptSkipped(dupeSkips);
          skipped.push(...dupeSkips);
          for (const task of dupes) {
            recordTaskRun({
              task_id: task.id,
              series_id: task.series_id,
              run_at: new Date().toISOString(),
              duration_ms: 0,
              status: 'skipped',
              result: JSON.stringify({ skipped: 'already-delivered' }),
            });
          }
          log(`[PATCH #51] Skipped ${dupes.length} already-delivered task(s): ${dupes.map((t) => t.id).join(', ')}`);
          keep = keep.filter((m) => !delivered.has(m.id));
        }
      }
    }

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    // Per-turn fail-fast: refuse to call the provider when a required MCP
    // remote is down. Better to surface an explicit 🛑 than to let the
    // agent reply with sk-agent still working while roo-state-manager 404s
    // — partial degraded operation is the failure mode this guards against.
    // Cached 60s in mcp-health so this isn't a per-batch hot path.
    if (config.requiredRemotes && config.requiredRemotes.length > 0) {
      const healthResults = await Promise.all(
        config.requiredRemotes.map(async (r) => ({
          name: r.name,
          result: await probeMcpRemoteCached(r.parsed),
        })),
      );
      const failed = healthResults.filter((h) => !h.result.ok);
      if (failed.length > 0) {
        const failList = formatFailures(failed);
        log(`BLOCKED: required MCP remote(s) DOWN — ${failList}`);
        const blockedIds = keep.map((m) => m.id);
        // [PATCH-myia #29] Throttle the user-visible 🛑 notice so a flapping
        // chain doesn't spam the channel. Only post once per window.
        const nowBlocked = Date.now();
        if (
          routing.platformId &&
          routing.channelType &&
          nowBlocked - lastBlockedNoticeAt >= BLOCKED_NOTICE_THROTTLE_MS
        ) {
          lastBlockedNoticeAt = nowBlocked;
          writeMessageOut({
            id: generateId(),
            kind: 'chat',
            platform_id: routing.platformId,
            channel_type: routing.channelType,
            thread_id: routing.threadId,
            content: JSON.stringify({
              text: `🛑 BLOCKED: required MCP server(s) unreachable: ${failList}\n\nHolding your message — I'll process it once the chain recovers.`,
            }),
          });
        }
        // [PATCH-myia #29] Reset the claim instead of completing it, so the
        // message stays pending and is retried on a later iteration once the
        // chain is back. Back off before retrying so we don't hot-spin the
        // proxy. mcp-health caches successes only, so the next probe sees the
        // recovered chain immediately rather than a stale cached failure.
        resetProcessingAcks(blockedIds);
        await sleep(BLOCKED_RETRY_BACKOFF_MS);
        continue;
      }
    }

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    const prompt = formatMessagesWithCommands(keep, nativeSlashCommands, config.providerName);

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    const query = config.provider.query({
      prompt,
      continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
    });
    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped.map((s) => s.id));
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    // [PATCH-myia #9] task_run_logs observability
    const tasksKept = tasksInBatch.filter((t) => !skippedSet.has(t.id));
    const batchStartedAt = Date.now();
    let batchError: string | null = null;
    let stalledAborted = false; // [PATCH-myia #26]
    // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
    // can stamp it on outbound rows — needed for a2a return-path routing.
    // (Upstream v2.4.0 renamed the API to a full ReplyRoute stamp; the
    // helper below carries the same intent.)
    publishReplyRoute(routing);
    // [PATCH-myia #37] Reset the per-batch send_message counter at batch start.
    // The counter is DB-backed now (session-state) because send_message runs in
    // a separate stdio MCP subprocess; reset here bounds it to one batch.
    resetBatchSendCount();
    // [PATCH-myia #51] Publish this batch's task ids + a fresh exec token so
    // writeMessageOut can attribute chat deliveries to THIS execution in the
    // task_delivery_ledger. Non-task batches publish null — a chat turn must
    // not mark surrounding tasks as delivered. Re-published at every
    // follow-up push (see processQuery), unlike the reply-route stamp which
    // freezes on the leading batch — in_reply_to cannot serve as attribution.
    setCurrentTaskExec(
      tasksKept.length > 0
        ? {
            token: `exec-${batchStartedAt}-${Math.random().toString(36).slice(2, 8)}`,
            taskIds: tasksKept.map((t) => t.id),
          }
        : null,
    );
    // Forward a loop stop to the ACTIVE query. The stream deliberately stays
    // open between turns, so the loop can be parked inside processQuery when
    // config.signal fires; without this, the "stopped" loop's query — and its
    // 500ms follow-up poller — outlives the stop and keeps polling (and
    // claiming) messages from whatever inbound DB the process points at. In
    // tests that leaked one immortal poller per loop-driven test, which could
    // steal a later test's follow-up message into a dead query.
    const abortActiveQuery = () => query.abort();
    if (config.signal?.aborted) abortActiveQuery();
    else config.signal?.addEventListener('abort', abortActiveQuery, { once: true });
    try {
      const result = await processQuery(
        query,
        routing,
        processingIds,
        config.providerName,
        config.provider.onExchangeComplete?.bind(config.provider),
        prompt,
        continuation,
        midTurnCompleteDelivery,
      );
      stalledAborted = !!result.stalledAborted; // [PATCH-myia #26]
      if (stalledAborted) {
        // Record the stalled attempt as a failed task run; the retry on the
        // next iteration gets its own record. Without this, the task_run_logs
        // table would carry a status='completed' row for a turn the agent
        // never actually answered.
        batchError = 'stalled';
      }
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
      }
      if (result.mcpRegistryLost) {
        // Drop the broken continuation so the next inbound triggers a fresh
        // SDK init. We deliberately do NOT retry inside this batch — the
        // SDK can't re-register MCP servers on an already-resumed session,
        // and we'd just be paying for tokens to get the same failure. The
        // host respawns the container on the next inbound, init picks up
        // a clean registry, and the user's next message lands in a
        // working session. Tradeoff: we lose the conversation thread (the
        // user is told). Better than the previous behavior where the bot
        // would reply "Dashboard MCP down" 5+ times before someone
        // noticed and killed the container manually.
        const { toolName, serverName } = result.mcpRegistryLost;
        log(`Clearing continuation due to MCP registry loss (server=${serverName}, tool=${toolName})`);
        continuation = undefined;
        clearContinuation(config.providerName);
        if (routing.platformId && routing.channelType) {
          writeMessageOut({
            id: generateId(),
            kind: 'chat',
            platform_id: routing.platformId,
            channel_type: routing.channelType,
            thread_id: routing.threadId,
            content: JSON.stringify({
              text: `🔄 MCP tool registry was lost mid-session (${serverName}). Starting a fresh session — please resend your last message.`,
            }),
          });
        }
        batchError = `mcp_registry_lost:${serverName}`;
      }
      // [PATCH-myia #42] Autocompact-thrash self-heal: processQuery detected
      // the thrash signature on a result error and asks us to drop the
      // continuation so the next turn starts a fresh session. No extra user
      // message — the thrash text itself is telemetry (#40 suppresses it from
      // the channel) — just clear + flag so the batch is archived as an error
      // and the cron/host-sweep advances the recurrence.
      if (result.thrashCleared) {
        log(`Clearing continuation due to autocompact thrash — next turn starts fresh`);
        continuation = undefined;
        clearContinuation(config.providerName);
        batchError = 'autocompact_thrash';
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      batchError = errMsg;

      // Stale/corrupt continuation recovery: ask the provider whether
      // this error means the stored continuation is unusable, and clear
      // it so the next attempt starts fresh.
      const isStale = config.provider.isSessionInvalid(err);
      if (continuation && isStale) {
        log(`Stale session detected (${continuation}) — clearing for next retry`);
        continuation = undefined;
        clearContinuation(config.providerName);
      }

      if (isStale) {
        // [PATCH-myia #31] Soft fail-fast for transient SDK init failures.
        // The catch path previously wrote `Error: ${errMsg}` to the user
        // AND `markCompleted`'d the batch (default branch below at the
        // `if (!stalledAborted)` check) — permanently losing the message
        // on every transient MCP-init blip. The classic symptom was the
        // overnight wave of `Error: MCP servers not connected at init`
        // messages posted to Telegram (2026-05-25/26: 5+ across cron +
        // hermes sessions, each one a sub-minute init handshake that the
        // next iteration would have completed cleanly).
        //
        // PATCH #29 already implements this softening for the requiredRemotes
        // probe path (the proactive gate above provider.query()). This
        // extends the same shape to the reactive path: throttle the user
        // notice (reuse BLOCKED_NOTICE_THROTTLE_MS so a flapping chain
        // doesn't spam the channel), reset the claim so the message stays
        // pending and is retried on the next iteration, sleep
        // BLOCKED_RETRY_BACKOFF_MS before retrying so we don't hot-spin
        // the SDK, and re-route through the `stalledAborted` skip-
        // markCompleted branch below so the batch isn't finalized.
        //
        // `isSessionInvalid` matches the STALE_SESSION_RE in
        // providers/claude.ts — currently: "no conversation found",
        // "ENOENT.*\.jsonl", "session.*not found", "MCP servers not
        // connected at init", "MCP registry lost mid-session".
        //
        // [PATCH-myia #35] Bound the retry loop. Without a cap, a
        // persistent failure (e.g. cert SAN gap making MCP init reject on
        // every attempt) creates a hot loop: PATCH #31 resets the ack,
        // sleeps BLOCKED_RETRY_BACKOFF_MS, the next iteration re-picks the
        // same processingIds and re-spawns a fresh agent → fresh "starting"
        // PING → same SDK error → loop forever. The user-visible system
        // notice is throttled, but the agent-emitted PINGs are not. After
        // STALE_RETRY_CAP consecutive failures on this id set, surrender:
        // fall through to markCompleted so the host's syncProcessingAcks
        // marks messages_in.status='completed', and host-sweep's
        // handleRecurrence advances the cron series at the next tick
        // (functionally equivalent to PATCH #34's MAX_TRIES path).
        const capDecision = evaluateStaleRetryCap(staleRetryCount, processingIds, STALE_RETRY_CAP);
        if (capDecision.exhausted) {
          log(
            `Stale retry cap (${STALE_RETRY_CAP}) reached for ${processingIds.length} message(s) — surrendering, markCompleted will let host advance recurrence`,
          );
          for (const id of processingIds) staleRetryCount.delete(id);
          batchError = 'stale_retry_cap_exhausted';
          // Fall through: stalledAborted stays false → markCompleted runs.
        } else {
          // Upstream v2.4.0 owns the failure notice: processQuery's catch
          // already wrote one safe GENERIC_FAILURE_NOTICE per abandoned route
          // before rethrowing, so this retry branch must NOT write its own 🛑
          // — that produced two notices for one input. #31 keeps only the
          // retry half: release the claim, skip markCompleted, back off.
          resetProcessingAcks(processingIds);
          stalledAborted = true;
          await sleep(BLOCKED_RETRY_BACKOFF_MS);
        }
      } else if (isProviderStatusNoise(errMsg)) {
        // [PATCH-myia #40] Don't leak auto-compaction telemetry ("Autocompact
        // is thrashing…" / "Claude Code returned an error result: …") to the
        // channel — log only. Genuine errors still fall through to the write
        // below (incident 2026-07-15).
        log(`Suppressed provider status noise from query-error channel write: ${errMsg.slice(0, 80)}`);
      } else {
        // Upstream v2.4.0 semantics (adopted 2026-11 sync): processQuery owns
        // failure notices — it knows which active and queued turns the throw
        // abandoned, and writes one safe GENERIC_FAILURE_NOTICE per route.
        // Writing `Error: ${errMsg}` here as well delivered a SECOND notice
        // for the same input and leaked the raw diagnostic to the channel.
        // This path only records the batch outcome in the runner log.
        log(`Errored batch will be acked completed — ${processingIds.length} message(s), no redelivery`);
      }
    } finally {
      setCurrentReplyRoute(null); // clears the stamp (was clearCurrentInReplyTo)
      setCurrentTaskExec(null); // [PATCH-myia #51] end of batch — stop ledger attribution
      config.signal?.removeEventListener('abort', abortActiveQuery);
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    //
    // [PATCH-myia #26] Skip when the stall watchdog already reset the initial
    // batch back to pending — otherwise we'd clobber the reset and the
    // un-answered messages would be finalized instead of retried on the next
    // iteration.
    if (!stalledAborted) {
      markCompleted(processingIds);
      // [PATCH-myia #35] Counter cleanup. Whether the batch succeeded or
      // we surrendered after the cap, the message is now finalized — clear
      // the counter so any subsequently re-queued row with the same id
      // (none expected today, but defensive against future retry policies)
      // starts with a fresh budget.
      for (const id of processingIds) staleRetryCount.delete(id);
      log(`Completed ${ids.length} message(s)`);
    } else {
      log(`Stall-aborted batch — skipping markCompleted so reset-to-pending sticks`);
    }

    // [PATCH-myia #47] Orphan-claim sweep after every query death. #26's
    // stall-abort resets the claims it captured at abort time, but the
    // 500ms follow-up poller can re-claim a just-reset message in the ~2s
    // between that reset and the query's actual end (observed 2026-08-16
    // 11:20:45.7Z reset → 11:20:46.3Z re-claim → 11:20:47.9Z query end).
    // The re-claimed ack matches no live query yet is never drained,
    // which excludes the message from getPendingMessages forever — the
    // review recurrence chain froze for 17.5h on exactly this. At this
    // point the query is dead and this batch's ids are finalized or
    // reset, so any remaining 'processing' row belongs to no one: purge
    // it exactly like container boot does.
    clearStaleProcessingAcks();

    // Log task runs for any task messages that went through the agent.
    // Duration is the batch processing time — when several tasks ride
    // along in one prompt, they share that time, which is a faithful
    // record of "this is how long the agent spent producing the reply
    // covering this task."
    if (tasksKept.length > 0) {
      const runAt = new Date(batchStartedAt).toISOString();
      const durationMs = Date.now() - batchStartedAt;
      for (const task of tasksKept) {
        recordTaskRun({
          task_id: task.id,
          series_id: task.series_id,
          run_at: runAt,
          duration_ms: durationMs,
          status: batchError ? 'failed' : 'completed',
          error: batchError,
        });
      }
    }
  }
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(
  messages: MessageInRow[],
  nativeSlashCommands: boolean,
  providerName: string,
): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg, providerName);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
  /**
   * Set when the SDK lost its MCP registry mid-session (issue #27 branch 2).
   * Signals the outer loop to clear continuation so the next inbound starts
   * a fresh session. Also tells it to skip the generic "Error: ..." reply
   * since this code path writes its own user-visible message.
   */
  mcpRegistryLost?: { toolName: string; serverName: string };
  /**
   * [PATCH-myia #26] Set when the stall watchdog reset all claims and aborted
   * the query. The outer loop must NOT run its post-call markCompleted, since
   * the watchdog has already reset the initial batch back to pending so the
   * next iteration re-picks those messages with a fresh query.
   */
  stalledAborted?: boolean;
  /**
   * [PATCH-myia #42] Set when a result error carried the autocompact-thrash
   * signature — the resumed transcript is too large to compact. Signals the
   * outer loop to clear continuation so the next inbound starts a fresh
   * session instead of resuming the bloated one and re-thrashing forever.
   * The thrash error text is still delivered to the user this turn, so no
   * extra message is needed (unlike mcpRegistryLost).
   */
  thrashCleared?: boolean;
}

export async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  onExchangeComplete: ((exchange: ProviderExchange) => void) | undefined,
  initialPrompt: string,
  initialContinuation: string | undefined,
  /**
   * The provider contract's `textDelivery: 'mid-turn-complete'`. True →
   * mid-turn streaming is the single content
   * door: complete <message> blocks deliver exactly once, at parse time from
   * streamed 'text' events (with cross-segment assembly of split blocks),
   * and the final result never delivers content — it only surfaces error
   * results and decides the wrap-nudge. False → text events are
   * delivery-inert and the final result stays the single delivery door.
   */
  midTurnCompleteDelivery = false,
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let mcpRegistryLost: { toolName: string; serverName: string } | undefined;
  let thrashCleared = false; // [PATCH-myia #42]
  let done = false;
  let unwrappedNudged = false;
  // Once-per-turn guard for the task-run "<message> block was not delivered"
  // nudge — mirrors unwrappedNudged for chat turns.
  let taskBlockNudged = false;
  // How many <message> blocks were delivered from 'text' events this turn
  // (chat runs, mid-turn delivery providers only). A frame-local count, never
  // keyed by content: it feeds the result door's nudge decision ("did this
  // turn deliver anything?"). Reset at the turn boundary (the 'result'
  // event) — NOT at the follow-up push seam: query.push() does not end the
  // in-flight turn, and its result's nudge decision still describes the
  // turn that is streaming.
  let midTurnSent = 0;
  // The subset of midTurnSent that counts as the reply: blocks to another
  // agent are left out (see answersBatch).
  let midTurnReplied = 0;
  // Outbound seq high-water mark at the turn boundary — a frame-local NUMBER,
  // not a content record. Two uses: (1) the mid-turn door recognizes a block
  // that is a verbatim repeat of a message already written to outbound.db
  // EARLIER THIS TURN by a previous streamed segment (live-observed: the
  // model re-emits the identical block as its final text after a trailing
  // tool call; delivering both copies is the double-send this design must
  // not reintroduce); (2) the result-door nudge decision asks "did ANYTHING
  // user-visible go out this turn?" — which must also see MCP send_message
  // rows the frame-local midTurnSent count never observes. The "have we sent
  // this?" truth lives in the outbound DB the door already writes to — no
  // in-process delivery ledger. Reset alongside midTurnSent at each result.
  let turnStartSeq = maxOutboundSeq();
  // Cross-segment assembly buffer: the unresolved TAIL of the previous text
  // event — an unclosed <message …> block (or a bare open-tag prefix like
  // "<mess" literally split mid-token), or an unclosed <internal span. Frame-
  // local and turn-local: it carries a fragment forward so a block opened in
  // one assistant message and closed in a later one delivers ONCE, mid-turn,
  // when its close arrives. Only the unresolved tail is ever carried —
  // settled text is consumed exactly once, so already-delivered blocks are
  // never re-matched. Dropped at the turn boundary: a block that never
  // closes anywhere is the wrap-nudge's job, not the buffer's.
  let midTurnTail = '';
  // Prompt queue for the exchange hook — each result event consumes the
  // oldest unanswered prompt. Retries append the original user prompt at
  // their position in the provider input queue.
  const archivePrompts: string[] = initialPrompt ? [initialPrompt] : [];
  // Where replies go is a property of the TURN, not the query. The query
  // stays open across turns (below), so a message pushed after the previous
  // answer finished is a new turn and replies go to ITS thread; a message
  // pushed while an answer is still streaming waits its turn — the in-flight
  // answer keeps the destination it started with. Pushed routes queue in
  // push order (including retries) and advance at every result, mirroring
  // archivePrompts. An empty initial prompt (a pre-warmed query) starts idle.
  let answering = initialPrompt !== '';
  type QueuedTurn = {
    routing: RoutingContext;
    unwrappedNudged: boolean;
    taskBlockNudged: boolean;
    nudgedWindow?: SeqWindow;
  };
  const queuedTurns: QueuedTurn[] = [];
  // On a wrap-nudge retry: the rows the nudged turn wrote. The turn boundary
  // moved past them, so both doors check retry blocks against this window and
  // skip exact repeats. Follow-ups queued in between keep their own window.
  let nudgedWindow: SeqWindow | undefined;
  const adoptTurn = (next: QueuedTurn): void => {
    Object.assign(routing, next.routing);
    unwrappedNudged = next.unwrappedNudged;
    taskBlockNudged = next.taskBlockNudged;
    nudgedWindow = next.nudgedWindow;
    publishReplyRoute(routing);
    answering = true;
  };
  // A retry is another provider input, behind any follow-ups already pushed.
  // Preserve its original route, prompt and retry guards until it is answered.
  const pushRetry = (prompt: string, retryOf?: SeqWindow): void => {
    query.push(prompt);
    queuedTurns.push({ routing: { ...routing }, unwrappedNudged, taskBlockNudged, nudgedWindow: retryOf });
    archivePrompts.push(archivePrompts[0] ?? initialPrompt);
  };

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let pollInFlight = false;
  let endedForCommand = false;
  let corruptionStreak = 0;

  // [PATCH-myia #18] Push-mode stall recovery state.
  // - pendingFollowUpAcks: follow-up message IDs whose markCompleted is deferred
  //   until a `result` event arrives. Empty when the query is idle / fully drained.
  // - stalledAborted: latched once the watchdog fired, prevents racy double-aborts.
  //   (PATCH #26 dropped lastPushAt — the watchdog now uses lastSdkEventAt
  //   and awaitingResult as its gate, both declared below.)
  const pendingFollowUpAcks: string[] = [];
  let stalledAborted = false;

  // [PATCH-myia #51] Run-log substrate for pushed follow-ups. Task rows are
  // stashed here at push time so their execution gets a task_run_logs row
  // when the batch drains (or a 'failed' row when it is reset). Without
  // this, only the leading batch's tasks ever get rows — recordTaskRun sits
  // in the outer loop's end-of-batch block, which never sees follow-ups
  // (measured 2026-11-06: run-logs stopped at the leading task at 15:15Z
  // while publications continued to 17:16Z inside the same query).
  const followUpTasks = new Map<string, { series_id: string | null; pushedAt: number }>();
  const recordFollowUpRuns = (ids: string[], status: 'completed' | 'failed', error: string | null): void => {
    for (const id of ids) {
      const meta = followUpTasks.get(id);
      if (!meta) continue;
      followUpTasks.delete(id);
      recordTaskRun({
        task_id: id,
        series_id: meta.series_id,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - meta.pushedAt,
        status,
        error,
      });
    }
  };

  // `awaitingResult` tracks whether a pushed prompt (initial batch or a
  // follow-up) is still waiting for its `result` event. It gates the stall
  // watchdog (#26) and the idle-with-pending watchdog (#27). Starts true
  // because the initial prompt was already injected by
  // config.provider.query() before this function was called.
  //
  // [PATCH-myia #25 — RETIRED at v2.3.0] This used to queue follow-ups until
  // the current turn's result and drain them into a fresh turn (the z.ai SDK
  // merged N pushed inputs into one result, swallowing N-1 replies under the
  // result-only delivery model). Upstream's mid-turn-complete provider
  // contract makes replies stream at parse time, so a merged turn still
  // delivers each reply — the loss mode is structurally gone and follow-ups
  // push immediately (upstream behavior). See PATCHES.md.
  let awaitingResult = true;

  // [PATCH-myia #26] Last-SDK-event timestamp. The stall watchdog uses this
  // (rather than PATCH #18's lastPushAt) as the elapsed reference so it
  // covers BOTH the initial batch and follow-up pushes. Updated on every
  // SDK event in the for-await below. Initialized to processQuery entry
  // time — that's also when `awaitingResult` starts true (initial prompt
  // was already injected by config.provider.query before this call), so
  // an SDK that never emits a single event is detectable from the start.
  //
  // Subsumes PATCH #18: with #24's heartbeat tickle suppressing the host's
  // claim-stuck rule, an SDK that silently freezes on the initial turn
  // (no follow-ups, no `result`) would hang forever under #18's
  // lastPushAt-only gate (skipped on null). The user-visible symptom was
  // the bot going silent mid-conversation with the host showing healthy
  // heartbeats. Combined with #25's `awaitingResult` flag as the watchdog
  // gate, this fires whenever we're expecting an SDK response and the
  // event stream has gone quiet for STALL_TIMEOUT_MS.
  let lastSdkEventAt: number = Date.now();

  // [PATCH-myia #27] Last `result` event timestamp. The idle-with-pending
  // watchdog uses this as the elapsed reference. Initialized to entry
  // time so a query that never receives a single result (initial-batch
  // stall) is not double-flagged by both #26 and #27 — that case stays
  // covered by #26 alone (gated on `awaitingResult === true`).
  let lastResultAt: number = Date.now();

  // [PATCH-myia #18b] Periodic SDK query refresh — wall-clock time when this
  // query started serving requests. After QUERY_REFRESH_AFTER_MS, we end the
  // stream gracefully on the next `result` event so the outer loop spawns a
  // fresh query (continuation token preserves the conversation).
  const queryStartedAt = Date.now();

  let mailboxFailureStreak = 0;
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand) return;
    pollInFlight = true;

    void (async () => {
      try {
        const pending = getPendingMessages();

        // Slash commands need a fresh query: /clear resets the SDK's
        // resume id (fixed at sdkQuery() time); admin/passthrough commands
        // (/compact, /cost, …) only dispatch when they're the first input
        // of a query — pushed mid-stream they arrive as plain text and
        // the SDK never runs them. Abort the active stream and leave the
        // rows pending; the outer loop handles them on next iteration via
        // the canonical command path + formatMessagesWithCommands. Abort,
        // not end: end() lets an in-flight turn run to completion, which
        // can block the command (e.g. /clear during a long task) for as
        // long as the turn takes.
        if (pending.some((m) => isRunnerCommand(m, providerName))) {
          log('Pending slash command — aborting active stream so outer loop can process');
          endedForCommand = true;
          query.abort();
          return;
        }

        // Skip system messages (MCP tool responses).
        // Thread routing is the router's concern — if a message landed in this
        // session, the agent should see it. Per-thread sessions already isolate
        // threads into separate containers; shared sessions intentionally merge
        // everything. Filtering on thread_id here caused deadlocks when the
        // initial batch and follow-ups had mismatched thread_ids (e.g. a
        // host-generated welcome trigger with null thread vs a Discord DM reply).
        // Accumulated trigger=0 context rows must never be pushed into a live
        // turn on their own — the agent would answer ambient context that was
        // not addressed to it. They ride along only when a real trigger=1
        // follow-up is also pending; otherwise they stay pending for a future
        // batch (mirrors the two-phase initial-batch selection in
        // db/messages-in.ts).
        const hasFollowUpTrigger = pending.some((m) => m.kind !== 'system' && m.trigger === 1);
        const newMessages = pending.filter((m) => m.kind !== 'system' && (m.trigger === 1 || hasFollowUpTrigger));
        if (newMessages.length === 0) return;

        // Accumulated context must not engage a warm query by itself.
        if (!newMessages.some((m) => m.trigger === 1)) return;

        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        // Mirrors the initial-batch hook above.
        let keep = newMessages;
        let skipped: Array<{ id: string; reason: string }> = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markScriptSkipped(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.map((s) => s.id).join(', ')}`);
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        // [PATCH-myia #51] Same claim-time guard on follow-ups: an already-
        // delivered task pushed into a live query would re-execute and
        // re-publish for nothing. The rows were claimed by markProcessing
        // above; markScriptSkipped finalizes the guarded ones instead.
        {
          const pushedTasks = keep.filter((m) => m.kind === 'task');
          if (pushedTasks.length > 0) {
            const delivered = new Set(getDeliveredTaskIds(pushedTasks.map((t) => t.id)));
            if (delivered.size > 0) {
              const dupes = pushedTasks.filter((t) => delivered.has(t.id));
              markScriptSkipped(dupes.map((t) => ({ id: t.id, reason: 'already-delivered' })));
              for (const task of dupes) {
                recordTaskRun({
                  task_id: task.id,
                  series_id: task.series_id,
                  run_at: new Date().toISOString(),
                  duration_ms: 0,
                  status: 'skipped',
                  result: JSON.stringify({ skipped: 'already-delivered' }),
                });
              }
              log(
                `[PATCH #51] Skipped ${dupes.length} already-delivered follow-up task(s): ` +
                  dupes.map((t) => t.id).join(', '),
              );
              keep = keep.filter((m) => !delivered.has(m.id));
            }
          }
        }

        if (keep.length === 0) return;
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work; the
        // claimed messages get released by the host's processing-claim sweep.
        if (done) return;

        const keptIds = keep.map((m) => m.id);
        const prompt = formatMessages(keep);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        query.push(prompt);
        const next: QueuedTurn = {
          routing: extractRouting(keep),
          unwrappedNudged: false,
          taskBlockNudged: false,
        };
        if (answering) queuedTurns.push(next);
        else adoptTurn(next);
        // [PATCH-myia #18] Defer markCompleted until a `result` event arrives.
        // The previous behavior marked these completed immediately after push,
        // which silently lost messages whenever the SDK failed to emit a
        // matching result event (push-mode stall). Now they stay in
        // `processing` state and are either drained on the next result event,
        // or reset+retried by the stall watchdog below.
        pendingFollowUpAcks.push(...keptIds);
        // [PATCH-myia #51] Re-publish exec attribution for THIS push: chat
        // rows written during this turn belong to these task ids, not the
        // query's leading batch. A pure-chat push publishes null so the
        // interleave cannot mark surrounding tasks as delivered. Stash the
        // task rows for the drain-time run-log (followUpTasks above).
        {
          const pushedTasks = keep.filter((m) => m.kind === 'task');
          setCurrentTaskExec(
            pushedTasks.length > 0
              ? {
                  token: `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  taskIds: pushedTasks.map((t) => t.id),
                }
              : null,
          );
          for (const task of pushedTasks) {
            followUpTasks.set(task.id, { series_id: task.series_id, pushedAt: Date.now() });
          }
        }
        // Track the follow-up prompt for the exchange-archive hook
        // (upstream onExchangeComplete); the matching shift() fires when its
        // result event lands. This replaces upstream's immediate
        // markCompleted(keptIds) — that ack is deferred by #18 above.
        archivePrompts.push(prompt);
        awaitingResult = true;
        // [PATCH-myia #26] If the query was idle (no events) for a while
        // before this push, lastSdkEventAt is stale. Reset so the stall
        // watchdog gives this new turn the full STALL_TIMEOUT_MS budget.
        lastSdkEventAt = Date.now();
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);

        if (getAgentMailbox().shouldRestartAfter?.(err)) {
          mailboxFailureStreak += 1;
          if (mailboxFailureStreak >= MAILBOX_FAILURE_STREAK_EXIT) {
            log(
              `Follow-up poll: ${mailboxFailureStreak} consecutive '${errMsg}' errors — ` +
                `mailbox driver requested a fresh runner. Exiting so the host respawns it.`,
            );
            // Stop touching the heartbeat so host-sweep stale detection fires
            // promptly even if exit() races with in-flight async work.
            done = true;
            clearInterval(pollHandle);
            // Defer exit one tick so this log line flushes through Docker's
            // log driver before the process dies.
            setTimeout(() => process.exit(75), 100);
          }
        } else {
          mailboxFailureStreak = 0;
        }
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  // [PATCH-myia #24] Heartbeat tickle — keep the host's claim-stuck rule
  // from killing us during legitimate SDK silence (auto-compaction, slow
  // first token, MCP probe). Touches the file every 15s while this query
  // is alive. Cleared in the finally below so the tickle stops the moment
  // the stream ends — after that the host's normal liveness rules apply.
  const heartbeatHandle = setInterval(() => {
    try {
      touchHeartbeat();
    } catch {
      // touchHeartbeat already swallows fs errors; defensive double-catch
      // so an unexpected throw never escapes the interval and kills the
      // process via unhandled-rejection.
    }
  }, HEARTBEAT_TICKLE_INTERVAL_MS);

  // [PATCH-myia #26] Stall watchdog (subsumes #18). Every
  // STALL_CHECK_INTERVAL_MS, check whether the SDK has gone silent while we
  // were expecting a result. If so, reset all claimed messages back to
  // pending (initial batch + pushed follow-ups + queued-but-not-yet-pushed
  // follow-ups) and abort the active query so the outer loop spawns a
  // fresh one. The `awaitingResult` gate (from #25) ensures we don't
  // misfire during legitimate idle: a query that finished its result and
  // is just held open for future pushes has `awaitingResult === false`.
  // The elapsed reference is `lastSdkEventAt` rather than `lastPushAt`, so
  // the watchdog covers stalls during the INITIAL turn too (the
  // precipitating bug for this patch — see PATCH #26 in PATCHES.md).
  const stallHandle = setInterval(() => {
    if (done || stalledAborted) return;
    if (!awaitingResult) return;
    const elapsed = Date.now() - lastSdkEventAt;
    if (elapsed < STALL_TIMEOUT_MS) return;

    log(
      `STALL DETECTED: SDK silent for ${Math.round(elapsed / 1000)}s while awaiting result ` +
        `(initial=${initialBatchIds.length}, pending-follow-ups=${pendingFollowUpAcks.length}). ` +
        `Resetting claims and aborting query.`,
    );
    stalledAborted = true;

    // Reset the initial batch: those rows were marked `processing` by the
    // outer loop before processQuery was called, but never reached a
    // `result` event, so they need to go back to `pending` instead of
    // being finalized by the outer markCompleted at function exit. The
    // outer loop checks `result.stalledAborted` and skips its
    // markCompleted to avoid clobbering this reset.
    if (initialBatchIds.length > 0) {
      try {
        resetProcessingAcks(initialBatchIds);
      } catch (err) {
        log(
          `Failed to reset initial-batch acks during stall: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (pendingFollowUpAcks.length > 0) {
      try {
        resetProcessingAcks(pendingFollowUpAcks);
      } catch (err) {
        log(`Failed to reset processing acks during stall: ${err instanceof Error ? err.message : String(err)}`);
      }
      recordFollowUpRuns(pendingFollowUpAcks, 'failed', 'stall-aborted'); // [PATCH-myia #51]
      pendingFollowUpAcks.length = 0;
    }
    try {
      query.abort();
    } catch (err) {
      log(`Failed to abort stalled query: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, STALL_CHECK_INTERVAL_MS);

  // [PATCH-myia #27] Idle-with-pending watchdog. Complementary to #26: that
  // watchdog fires when we are awaiting a result and the SDK goes silent;
  // this one fires when we are NOT awaiting a result (turn done) but
  // trigger=1 messages are accumulating in `messages_in` without being
  // claimed and pushed. Causes the SDK query to end gracefully — the
  // outer poll loop respawns a fresh query (continuation preserved) and
  // re-picks the pending messages on its next iteration.
  const idleHandle = setInterval(() => {
    if (done || stalledAborted || endedForCommand) return;
    // PATCH #26's domain — don't double-fire while a turn is in flight.
    if (awaitingResult) return;

    let pendingTriggerCount = 0;
    try {
      const rows = getPendingMessages();
      for (const m of rows) {
        if (m.kind !== 'system' && m.trigger === 1) {
          pendingTriggerCount++;
          break; // we only need to know there's at least one
        }
      }
    } catch (err) {
      log(`Idle watchdog DB read failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (pendingTriggerCount === 0) return;

    const elapsed = Date.now() - lastResultAt;
    if (elapsed < IDLE_WITH_PENDING_TIMEOUT_MS) return;

    log(
      `IDLE WITH PENDING: pending trigger=1 message(s) in inbound.db but query has been idle ${Math.round(
        elapsed / 1000,
      )}s after last result with no push — ending stream so outer loop spawns a fresh query.`,
    );
    try {
      query.end();
    } catch (err) {
      log(`Failed to end idle query: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, IDLE_CHECK_INTERVAL_MS);

  // [PATCH-myia #28] Tool-stuck watchdog. See header comment near
  // TOOL_STUCK_DEFAULT_MS for rationale. Fires independently of SDK
  // event traffic — reads container_state row populated by claude.ts's
  // PreToolUse hook. Reuses `stalledAborted` so the outer loop's
  // skip-markCompleted branch covers this case too.
  const toolStuckHandle = setInterval(() => {
    if (done || stalledAborted || endedForCommand) return;
    let state: ReturnType<typeof getContainerToolInFlight>;
    try {
      state = getContainerToolInFlight();
    } catch (err) {
      log(`Tool-stuck watchdog DB read failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const decision = evaluateToolStuckBudget(state, Date.now());
    if (!decision.abort) return;

    log(
      `TOOL STUCK: ${decision.tool} in flight for ${Math.round(decision.elapsedMs / 1000)}s ` +
        `(budget=${Math.round(decision.budgetMs / 1000)}s, declared=${decision.declaredMs ?? 'none'}). ` +
        `Aborting query so outer loop respawns.`,
    );
    stalledAborted = true;

    // Clear stale container_state — the next container spawn shouldn't
    // inherit our "tool in flight" flag from the aborted call. PostToolUse
    // won't fire for an aborted tool, so we clear it explicitly here.
    try {
      clearContainerToolInFlight();
    } catch (err) {
      log(`Failed to clear container_state during tool-stuck abort: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (initialBatchIds.length > 0) {
      try {
        resetProcessingAcks(initialBatchIds);
      } catch (err) {
        log(`Failed to reset initial-batch acks during tool-stuck: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (pendingFollowUpAcks.length > 0) {
      try {
        resetProcessingAcks(pendingFollowUpAcks);
      } catch (err) {
        log(`Failed to reset processing acks during tool-stuck: ${err instanceof Error ? err.message : String(err)}`);
      }
      recordFollowUpRuns(pendingFollowUpAcks, 'failed', 'tool-stuck-aborted'); // [PATCH-myia #51]
      pendingFollowUpAcks.length = 0;
    }
    try {
      query.abort();
    } catch (err) {
      log(`Failed to abort tool-stuck query: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, TOOL_STUCK_CHECK_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      touchHeartbeat();
      lastSdkEventAt = Date.now(); // [PATCH-myia #26]

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        setContinuation(providerName, event.continuation);
      } else if (event.type === 'text') {
        // Assistant text emitted mid-turn (e.g. between tool calls). The
        // final result only carries the LAST assistant text, so complete
        // <message> blocks composed here would otherwise be lost — deliver
        // them now (chat runs only; task runs stay one-door). Gated on the
        // provider contract: for a provider that does not declare mid-turn
        // delivery the result stays the only delivery door, so a stray text
        // event must not open a second one.
        if (midTurnCompleteDelivery) {
          const scan = await deliverMidTurnBlocks(event.text, routing, turnStartSeq, midTurnTail, nudgedWindow);
          midTurnSent += scan.delivered;
          midTurnReplied += scan.replied;
          midTurnTail = scan.tail;
        }
      } else if (event.type === 'result') {
        // [PATCH-myia #42] Autocompact-thrash self-heal. The SDK surfaces
        // "Autocompact is thrashing" as a result error (isError=true) when
        // the resumed transcript is too large to compact within the
        // configured window — small-window models (glm-5.2 @ 250k) hit this
        // at ~5-6MB, below the 12MB cold-start rotate cap. The result path
        // previously preserved the continuation, so every subsequent turn
        // resumed the same bloated session and re-thrashed — an infinite
        // loop leaving the bot "alive but producing no work" for hours
        // (2026-07-17 incident). processQuery can't clear the outer-loop
        // continuation itself (not in scope, and it has no provider ref to
        // call isSessionInvalid), so it signals via the thrashCleared flag
        // on QueryResult — runPollLoop then drops the continuation, same
        // shape as the mcpRegistryLost signal. The error text still flows to
        // deliverErrorResult below, where #40's telemetry guard suppresses
        // it from the channel; the NEXT turn starts a fresh session.
        if (event.isError === true && THRASH_RE.test(event.text ?? event.error ?? '')) {
          log(`Autocompact thrash detected — dropping continuation so the next turn starts a fresh session`);
          queryContinuation = undefined;
          thrashCleared = true;
        }
        // A result — with or without text — means the turn is done. Mark
        // the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for
        // follow-up pushes. The agent may have responded via MCP
        // (send_message) mid-turn, or the message may not need a response
        // at all — either way the turn is finished.
        markCompleted(initialBatchIds);
        // [PATCH-myia #18] Drain deferred follow-up acks. Any follow-up
        // pushed since the last result is considered acknowledged by THIS
        // result event. With PATCH #25 push serialization, a result now
        // matches the most recent single push (initial batch or one
        // follow-up batch); the SDK no longer collapses N pushes into one
        // result.
        if (pendingFollowUpAcks.length > 0) {
          markCompleted(pendingFollowUpAcks);
          // [PATCH-myia #51] Run-log rows for the drained follow-up tasks.
          recordFollowUpRuns(pendingFollowUpAcks, 'completed', null);
          pendingFollowUpAcks.length = 0;
        }
        awaitingResult = false;
        lastResultAt = Date.now(); // [PATCH-myia #27]
        // [PATCH-myia #50] Upstream's provider carries non-retryable error
        // notices (403 billing_error et al.) in the dedicated `error` field
        // with `text` null — read both through the same paths so the notice
        // is delivered (chat) or logged (task runs), never silently dropped.
        const resultText = event.text ?? (event.isError === true ? (event.error ?? '') : '');
        const failed = event.isError === true;
        if (resultText || failed) {
          const { hasUnwrapped, taskBlocks, undelivered } = await dispatchResultText(resultText, routing, failed, {
            midTurnSent,
            midTurnReplied,
            turnStartSeq,
            nudgedWindow,
            // For mid-turn delivery providers the result door NEVER delivers
            // content: mid-turn streaming is the single content door. The
            // result door's remaining job is the nudge decision.
            suppressDelivery: midTurnCompleteDelivery,
          });
          // Completed partial output remains deliverable, but an explicit
          // provider failure must keep its status and never trigger a retry.
          const willRetryTaskBlocks = !failed && shouldNudgeTaskBlocks(routing.taskRun, taskBlocks, taskBlockNudged);
          // One-door task delivery: the final text becomes the run log entry
          // while explicit append-log calls remain optional additive notes.
          // Errors included: a failed run's text belongs in its log, not chat.
          // A corrective retry handles delivery only; its result is not a
          // second run summary.
          const archivedResult = [resultText, failed && resultText !== event.error ? event.error : undefined]
            .filter(Boolean)
            .join('\n');
          if (routing.taskRun && !taskBlockNudged) await autoAppendTaskLog(archivedResult);
          if (failed) {
            // A failed turn needs a visible notice even after a partial reply.
            // Only the provider's dedicated error field is channel content;
            // unwrapped model output and raw diagnostics remain private.
            const notice = isProviderStatusNoise(resultText)
              ? resultText
              : (event.error ?? GENERIC_FAILURE_NOTICE);
            if (sendsFailureNotice(routing)) await deliverErrorResult(routing, notice);
            // Keep the reason in the runner log, since the skipped notice may
            // be the only place it would have been recorded.
            else log(`Error result — notice not sent on this route: ${notice}`);
          }
          // An unwrapped final text only warrants the wrap-nudge when no
          // <message> block was delivered this turn. If a reply already went
          // out as a block, the unwrapped tail stays in the scratchpad log.
          const willRetryWrapping = !failed && hasUnwrapped && !unwrappedNudged;
          notifyExchangeComplete(onExchangeComplete, {
            prompt: archivePrompts[0] ?? initialPrompt,
            result: archivedResult,
            continuation: queryContinuation ?? initialContinuation,
            status: failed ? 'error' : hasUnwrapped || willRetryTaskBlocks ? 'undelivered' : 'completed',
          });
          if (willRetryWrapping) {
            unwrappedNudged = true;
            // Everything that went out this turn: tool sends, door sends and
            // reactions alike, so a reaction-only turn can also answer done.
            const sentThisTurn = chatRowsInWindow(turnStartSeq);
            const destinations = getAllDestinations();
            const names = destinations.map((d) => d.name).join(', ');
            // A tool send can't be told apart from an "on it" ack, so after
            // one the model sees what went out and decides; never a silent drop.
            log(
              sentThisTurn.length > 0
                ? `Wrap-nudge pushed: quoting ${sentThisTurn.length} send(s) from this turn`
                : 'Wrap-nudge pushed: nothing was sent this turn',
            );
            pushRetry(
              sentThisTurn.length > 0
                ? buildInformedWrapNudge(sentThisTurn, undelivered, destinations)
                : `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                    `All output must be wrapped: use <message to="name"> for content to send, or <internal> for scratchpad. ` +
                    `Your destinations: ${names}. ` +
                    `Please re-send your response with the correct wrapping.</system>`,
              { after: turnStartSeq, upto: maxOutboundSeq() },
            );
          }
          if (willRetryTaskBlocks) {
            taskBlockNudged = true;
            const names = getAllDestinations()
              .map((d) => d.name)
              .join(', ');
            pushRetry(buildTaskBlockNudge(taskBlocks, names));
          }
          // Each result consumes one input; retries carry their original
          // user prompt at their own position in the FIFO queue.
          archivePrompts.shift();
        } else archivePrompts.shift();
        // Turn boundary: reset the per-turn sent count after the result's
        // nudge decision has used it. A nudge retry re-counts via its own
        // text events before the retry result, so resetting on every result
        // is safe. The seq high-water mark advances past everything written
        // this turn (door and error deliveries alike), so the next turn's
        // echo check never reaches back across the boundary — a later turn
        // genuinely re-sending the same body still delivers. The assembly
        // buffer dies with the turn: a fragment that never closed is not
        // carried into the next turn — the wrap-nudge owns that case.
        midTurnSent = 0;
        midTurnReplied = 0;
        turnStartSeq = maxOutboundSeq();
        midTurnTail = '';
        // [PATCH-myia #18b] Periodic refresh — if this query has been alive
        // longer than QUERY_REFRESH_AFTER_MS, end gracefully now so the
        // outer loop starts a fresh query for the next batch. Continuation
        // token has been persisted on every `init` event, so the SDK
        // resumes the same conversation in the new stream. Done after
        // dispatching the current result text — the user gets this turn's
        // reply, then we wind down.
        if (Date.now() - queryStartedAt > QUERY_REFRESH_AFTER_MS) {
          log(
            `Query lifetime ${Math.round((Date.now() - queryStartedAt) / 60000)}min exceeds refresh threshold — ending stream gracefully`,
          );
          query.end();
        }
        nudgedWindow = undefined;
        const next = queuedTurns.shift();
        if (next) adoptTurn(next);
        else answering = false;
      } else if (event.type === 'mcp_tool_missing') {
        // [PATCH-myia #8] Issue #27 branch 2: the resumed session's tool
        // registry is broken. Stop draining further SDK events, close out
        // this turn, and let the outer loop clear the continuation. The
        // next inbound will respawn with a fresh init that re-establishes
        // the registry.
        mcpRegistryLost = { toolName: event.toolName, serverName: event.serverName };
        markCompleted(initialBatchIds);
        query.abort();
        break;
      }
    }
  } catch (err) {
    // Freeze the queue before awaiting notices. Follow-ups have already been
    // acknowledged, so an abandoned queued turn cannot rely on redelivery.
    done = true;
    const cancelled = endedForCommand;
    const errMsg = err instanceof Error ? err.message : String(err);
    notifyExchangeComplete(onExchangeComplete, {
      prompt: archivePrompts[0] ?? initialPrompt,
      result: `Error: ${errMsg}`,
      continuation: queryContinuation ?? initialContinuation,
      status: 'error',
    });
    if (!cancelled) {
      // Completed turns are no longer answering or queued. Preserve partial
      // output from unfinished turns and report that the run did not finish.
      // Retrying the same route or several queued turns in one thread needs
      // only one notice. The host picks an a2a reply's session by in_reply_to,
      // so agent routes also compare it.
      const failedRoutes = [...(answering ? [routing] : []), ...queuedTurns.map((turn) => turn.routing)];
      const noticed: RoutingContext[] = [];
      for (const target of failedRoutes) {
        if (!sendsFailureNotice(target)) continue;
        if (
          noticed.some(
            (prior) =>
              prior.platformId === target.platformId &&
              prior.channelType === target.channelType &&
              prior.threadId === target.threadId &&
              (target.channelType !== 'agent' || prior.inReplyTo === target.inReplyTo),
          )
        )
          continue;
        noticed.push(target);
        try {
          await deliverErrorResult(target, GENERIC_FAILURE_NOTICE);
        } catch (noticeError) {
          log(
            `Failed to deliver query error notice: ${noticeError instanceof Error ? noticeError.message : String(noticeError)}`,
          );
        }
      }
    }
    // Continuation recovery receives the original error; diagnostics remain
    // in the exchange archive and runner log, never in the channel notice.
    throw err;
  } finally {
    done = true;
    clearInterval(pollHandle);
    clearInterval(stallHandle); // [PATCH-myia #18]
    clearInterval(heartbeatHandle); // [PATCH-myia #24]
    clearInterval(idleHandle); // [PATCH-myia #27]
    clearInterval(toolStuckHandle); // [PATCH-myia #28]
    // [PATCH-myia #18] If the stream ended (cleanly or via abort) while we
    // still had follow-up acks pending, the watchdog already reset them; but
    // if the stream ended for some OTHER reason (e.g. SDK internal error,
    // mcp_tool_missing path) we must reset them here too — otherwise those
    // messages stay stuck in `processing` forever and never get re-picked.
    if (pendingFollowUpAcks.length > 0 && !stalledAborted) {
      log(
        `Stream ended with ${pendingFollowUpAcks.length} follow-up(s) still pending — resetting acks for retry`,
      );
      try {
        resetProcessingAcks(pendingFollowUpAcks);
      } catch (err) {
        log(`Failed to reset processing acks at stream end: ${err instanceof Error ? err.message : String(err)}`);
      }
      recordFollowUpRuns(pendingFollowUpAcks, 'failed', 'stream-ended-undelivered'); // [PATCH-myia #51]
      pendingFollowUpAcks.length = 0;
    }
  }

  return { continuation: queryContinuation, mcpRegistryLost, stalledAborted, thrashCleared };
}

function notifyExchangeComplete(
  hook: ((exchange: ProviderExchange) => void) | undefined,
  exchange: ProviderExchange,
): void {
  if (!hook) return;
  try {
    hook(exchange);
  } catch (err) {
    log(`onExchangeComplete failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * [PATCH-myia #40] SDK/CLI status telemetry that must never reach a user
 * channel. When a heavy turn auto-compacts, the provider emits notices like
 * `Context compacted (N tokens compacted).` as result text, or returns/throws
 * `Autocompact is thrashing…` / `Claude Code returned an error result: …`.
 * All three of poll-loop's fallback delivery paths (deliverErrorResult, the
 * #19 bare-text routing-source fallback, and the reactive catch-path `Error:`
 * write) would otherwise post these to the group. Incident 2026-07-15: 91 of
 * 93 chat deliveries to the Telegram group over ~11h were this noise, drowning
 * real replies. These are internal telemetry — log them, never deliver. A
 * leading `Error: ` prefix (added by the catch path) is stripped before match.
 * Genuine agent text and genuine provider errors (403 billing_error, MCP init
 * failures, etc.) do NOT match and are delivered as before.
 */
export function isProviderStatusNoise(text: string): boolean {
  const t = text.trim().replace(/^Error:\s*/, '');
  return (
    /^Context compacted \(/.test(t) ||
    /^Autocompact is thrashing\b/.test(t) ||
    /^Claude Code returned an error result\b/.test(t)
  );
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
    case 'mcp_tool_missing':
      log(`MCP tool missing: ${event.toolName} (server=${event.serverName})`);
      break;
  }
}

/**
 * Does a failure on this route get a notice? Task runs report through their
 * run log. A turn woken only by failure notices sends none, so an a2a or
 * self-addressed failure chain stops after one notice.
 */
function sendsFailureNotice(routing: RoutingContext): boolean {
  return !routing.taskRun && !!routing.platformId && !!routing.channelType && !routing.failureNoticeWake;
}

/** Send the dedicated provider error or a generic failure notice. */
async function deliverErrorResult(routing: RoutingContext, text: string): Promise<void> {
  // [PATCH-myia #40] Log, don't deliver — auto-compaction telemetry.
  if (isProviderStatusNoise(text)) {
    log(`Suppressed provider status noise from error-result channel delivery: ${text.trim().slice(0, 80)}`);
    return;
  }
  log('Error result notice — delivering to channel');
  await writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text: stripHarnessTagArtifacts(text), [FAILURE_NOTICE_FIELD]: true }),
  });
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * is sent verbatim to the routing source as a fallback (PATCH-myia #19).
 *
 * The agent SHOULD wrap output in <message to="name">...</message> blocks
 * to address specific destinations. When it forgets (often after MCP
 * registry loss + continuation reset, or after auto-compaction), the
 * fallback ensures the user still gets the reply on the channel they
 * messaged from — better than silently dropping it into scratchpad.
 */
export interface TaskMessageBlock {
  to: string;
  body: string;
}

/** Options for `dispatchResultText`, describing the turn it closes. */
export type ResultDispatchOptions = ResultDispatchCounts &
  ({ suppressDelivery: true; turnStartSeq: number } | { suppressDelivery?: false; turnStartSeq?: number });

interface ResultDispatchCounts {
  /**
   * How many <message> blocks were already delivered from streamed text
   * events this turn. Folds into the returned `sent` total so a bare final
   * text after a mid-turn delivery reads as a self-summary, not an
   * undelivered reply. Tool sends never settle the turn here: the caller
   * turns an unwrapped result after one into an informed nudge.
   */
  midTurnSent?: number;
  /** The midTurnSent blocks that count as the reply (see answersBatch). Defaults to midTurnSent. */
  midTurnReplied?: number;
  /** On a wrap-nudge retry: rows the nudged turn wrote. An exact repeat of one is not sent again. */
  nudgedWindow?: SeqWindow;
  /**
   * Providers declaring `textDelivery: 'mid-turn-complete'`: the result door NEVER delivers
   * content. Mid-turn streaming (parse-time block delivery plus cross-
   * segment assembly) is the single content door; a complete <message>
   * block in the result text is at best a repeat of a mid-turn delivery and
   * at worst content the streaming door missed — either way it is not sent
   * from here. The result door keeps exactly two jobs: surfacing error
   * results (see the isError branch in processQuery) and the wrap-nudge
   * decision. When nothing streamed and the result still carries content,
   * wrapped or not, the turn counts as undelivered and the wrap-nudge fires,
   * so the retry streams through the mid-turn door: the degradation path
   * for streaming-door misses, never a direct result-door send. Task runs,
   * unknown destinations and empty bodies keep their existing result-door
   * handling, none of which delivers content. Requires `turnStartSeq`, the
   * outbound seq at the turn boundary: a result block is a repeat only if
   * this exact message was written since then.
   */
}
/**
 * `<internal>…</internal>` spans are explicitly not-for-delivery scratchpad.
 * Broader than `stripInternalTags` (which the scratchpad log uses): it also
 * matches an opening tag carrying attributes, and is case-insensitive, so a
 * draft quoted inside one can never be promoted to a real send by the
 * mid-turn scan.
 */
const INTERNAL_SPAN_RE = /<internal\b[\s\S]*?<\/internal>/gi;
/**
 * Deliver complete <message to="...">...</message> blocks found in a mid-turn
 * assistant text segment. The SDK's final result carries only the last
 * assistant text, so a wrapped reply composed before a trailing tool call
 * would otherwise never be seen (and the unwrapped-nudge would coax out only
 * a mangled re-send of the final fragment). Chat runs only — in task runs
 * mid-turn blocks stay inert exactly like final-text blocks (one-door: only
 * the send_message tool delivers). Blocks inside an <internal> span are never
 * delivered. Blocks to unknown destinations are left for the result path,
 * which logs the drop into the scratchpad and lets the nudge decide.
 *
 * Cross-segment assembly: `carry` is the unresolved tail of the previous
 * text event (frame-local, turn-local — see midTurnTail in processQuery).
 * The scan runs over carry + text, delivers every complete block in the
 * SETTLED prefix, and returns the new unresolved tail: an unclosed
 * <message …> open (or a bare tag prefix literally split mid-token, e.g.
 * "<mess" / "age to=…"), or an unclosed <internal span — a draft quoted
 * inside one must never be promoted to a send by assembly, so judgment on
 * everything from an open <internal is deferred until it closes. Settled
 * text is consumed exactly once: already-delivered blocks are never inside
 * the carried tail, so they cannot re-match. Net effect: mid-turn parsing
 * behaves as if run over the concatenation of all streamed text, delivered
 * incrementally. A block that never closes anywhere stays in the tail until
 * the turn ends and is then dropped — the wrap-nudge owns that case.
 *
 * Failure ordering: a writeMessageOut failure here propagates and fails the
 * whole turn loudly — the result door never delivers content, so swallowing
 * the error would silently lose the block. An outbound write failure means
 * the session DB is broken; loud is correct.
 */
export interface MidTurnScanResult {
  delivered: number;
  /** Delivered blocks that count as the reply (see answersBatch). */
  replied: number;
  tail: string;
}

export async function deliverMidTurnBlocks(
  text: string,
  routing: RoutingContext,
  turnStartSeq?: number,
  carry = '',
  nudgedWindow?: SeqWindow,
): Promise<MidTurnScanResult> {
  if (routing.taskRun) return { delivered: 0, replied: 0, tail: '' };
  const input = carry + text;
  const tailStart = unresolvedTailStart(input);
  const settled = input.slice(0, tailStart);
  const tail = input.slice(tailStart);
  if (tail && carry !== tail) {
    log(`Mid-turn scan: carrying ${tail.length}-char unresolved tail to the next segment`);
  }
  // Seq high-water mark at THIS scan's start: the echo check below only
  // looks at rows written by EARLIER segments of the same turn.
  const segStartSeq = turnStartSeq === undefined ? 0 : maxOutboundSeq();
  const visible = settled.replace(INTERNAL_SPAN_RE, '');
  // [PATCH-myia #36 — re-homed] Cap on mid-turn delivery. Under the
  // mid-turn-complete contract (our claude provider) the result door never
  // sends, so without this a looping model (GLM: 500+ <message> blocks in one
  // response) would flood messages_out from the mid-turn path instead. The cap
  // is per scan (per text event), the direct analog of the result door's
  // per-response cap. No dedup here: upstream's s09 shape asserts that two
  // IDENTICAL blocks in one segment deliver BOTH (an instructed repeat),
  // so identical-in-scan is a deliberate double-send, not a loop artifact —
  // the cap is the flood bound.
  const MAX_MESSAGES_PER_POLL = 10;
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;
  let match: RegExpExecArray | null;
  let delivered = 0;
  let replied = 0;
  while ((match = MESSAGE_RE.exec(visible)) !== null) {
    if (delivered >= MAX_MESSAGES_PER_POLL) {
      log(
        `WARNING: hit MAX_MESSAGES_PER_POLL (${MAX_MESSAGES_PER_POLL}) in mid-turn scan — dropping remaining <message> blocks`,
      );
      break;
    }
    const toName = match[1];
    const rawBody = match[2];
    const body = stripHarnessTagArtifacts(rawBody.trim());
    const dest = findByName(toName);
    if (!dest) continue;
    // Never deliver a blank message: a body that is empty (or was only
    // harness-tag artifacts) is skipped here; the result path logs it.
    if (!body) {
      log(`Mid-turn <message to="${toName}"> empty after sanitization — skipped`);
      continue;
    }
    // Cross-segment echo guard (live-captured shape, SDK battery s03): after
    // a tool call the model often re-emits the ALREADY-SENT block verbatim as
    // its final text. That final text streams as its own text event, so
    // without this check the door would deliver the same message twice. The
    // check consults the outbound DB — the durable record of what this turn
    // actually wrote — over the frame-local seq window (turnStartSeq,
    // segStartSeq]: identical body, same destination, written this turn by an
    // earlier segment ⇒ echo, skip. No in-process content ledger; cross-turn
    // repeats are out of the window and deliver normally.
    if (turnStartSeq !== undefined && wasWrittenInSeqWindow(dest, body, turnStartSeq, segStartSeq)) {
      log(`Mid-turn <message to="${toName}"> is a verbatim repeat of a message already sent this turn — skipped`);
      continue;
    }
    if (wasWrittenInWindow(dest, body, nudgedWindow)) {
      log(`Mid-turn <message to="${toName}"> repeats a message the nudged turn already sent — skipped`);
      continue;
    }
    await sendToDestination(dest, body, routing);
    delivered++;
    if (answersBatch(dest, routing)) replied++;
    log(`Mid-turn delivery: <message to="${toName}"> (${body.length} chars)`);
  }
  return { delivered, replied, tail };
}

/**
 * Does a block sent to `dest` count as the reply? Not when it goes to another
 * agent: that may be delegation, so unwrapped text after it still gets the
 * nudge. The exception is a block back to the agent whose message woke this
 * turn: that is the reply it is waiting for.
 */
function answersBatch(dest: DestinationEntry, routing: RoutingContext): boolean {
  if (dest.type !== 'agent') return true;
  return routing.channelType === 'agent' && routing.platformId === dest.agentGroupId;
}

const OPEN_INTERNAL_RE = /<internal\b/i;
const OPEN_MESSAGE_RE = /<message\b/;

/**
 * Index where the UNRESOLVED tail of a mid-turn scan begins — everything
 * before it is settled (safe to parse and deliver now), everything from it
 * on must wait for the next text event. input.length when fully settled.
 *
 * Unresolved constructs, earliest wins:
 *  - an unclosed <internal span (case-insensitive, attributes allowed):
 *    blocks quoted inside must not deliver until the span closes and the
 *    exclusion can apply — assembly must never promote a draft;
 *  - an unclosed <message open after the last </message>: the growing block
 *    the assembly exists for. Opens with a close somewhere after them are
 *    finished text (a complete block, or malformed-and-done) — settled;
 *  - a bare tag prefix at the very end ("<mess", "<inter"): a tag literally
 *    split mid-token at the event boundary.
 *
 * Complete <internal> spans are blanked (same length, positions preserved)
 * before looking: an unclosed construct inside a COMPLETED span is settled
 * garbage, not a reason to buffer.
 */
export function unresolvedTailStart(input: string): number {
  const masked = input.replace(INTERNAL_SPAN_RE, (m) => ' '.repeat(m.length));
  const candidates: number[] = [];
  const internalOpen = OPEN_INTERNAL_RE.exec(masked);
  if (internalOpen) candidates.push(internalOpen.index);
  const lastClose = masked.lastIndexOf('</message>');
  const searchFrom = lastClose === -1 ? 0 : lastClose + '</message>'.length;
  const msgOpen = OPEN_MESSAGE_RE.exec(masked.slice(searchFrom));
  if (msgOpen) candidates.push(searchFrom + msgOpen.index);
  if (candidates.length > 0) return Math.min(...candidates);
  const prefixStart = trailingTagPrefixStart(masked);
  return prefixStart === -1 ? input.length : prefixStart;
}

/**
 * Start index of a proper prefix of '<message' (case-sensitive, mirroring
 * MESSAGE_RE) or '<internal' (case-insensitive, mirroring INTERNAL_SPAN_RE)
 * sitting at the very end of the string; -1 when the string does not end
 * mid-token. Longest prefix wins.
 */
function trailingTagPrefixStart(masked: string): number {
  const maxK = Math.min('<internal'.length - 1, masked.length);
  for (let k = maxK; k >= 1; k--) {
    const tailK = masked.slice(masked.length - k);
    if (tailK === '<message'.slice(0, k)) return masked.length - k;
    if (tailK.toLowerCase() === '<internal'.slice(0, k)) return masked.length - k;
  }
  return -1;
}

/** Current outbound seq high-water mark (0 when the table is empty). */
function maxOutboundSeq(): number {
  return getUndeliveredMessages().reduce((max, message) => Math.max(max, message.seq ?? 0), 0);
}

/** Outbound seq window (after, upto]. */
type SeqWindow = { after: number; upto: number };

/**
 * Chat rows written to outbound.db in the seq window (afterSeq, uptoSeq]:
 * door, tool and error sends alike. Every caller fails toward a nudge or a
 * delivery, so a lookup error returns none.
 */
function chatRowsInWindow(afterSeq: number, uptoSeq = Infinity): MessageOutRow[] {
  try {
    // ponytail: reuse the existing semantic read; add a cursor operation only if history scans show up in profiles.
    return getUndeliveredMessages().filter(
      (message) => (message.seq ?? 0) > afterSeq && (message.seq ?? 0) <= uptoSeq && message.kind === 'chat',
    );
  } catch (err) {
    log(`Outbound lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

const INFORMED_NUDGE_QUOTE_MAX = 200;
const INFORMED_NUDGE_ROWS_MAX = 3;

/**
 * Wrap-nudge after tool sends plus an unwrapped final text. The rows can't
 * tell an "on it" from the full reply, so show the model both and let it
 * answer `<internal>done</internal>` or send only what is missing. Quoting
 * the final text also ties a retry queued behind a follow-up to its turn.
 */
export function buildInformedWrapNudge(
  rows: MessageOutRow[],
  finalText: string,
  destinations: DestinationEntry[],
): string {
  const names = destinations.map((d) => d.name).join(', ');
  // Name where each send went, so a reply sent to the wrong place is not taken as done.
  const destinationOf = (row: MessageOutRow): string =>
    destinations.find((d) =>
      d.type === 'agent'
        ? row.channel_type === 'agent' && row.platform_id === d.agentGroupId
        : row.channel_type === d.channelType && row.platform_id === d.platformId,
    )?.name ?? 'unknown';
  const clip = (text: string): string => escapePromptXml(clipCodePoints(text, INFORMED_NUDGE_QUOTE_MAX));
  const sent = rows.slice(0, INFORMED_NUDGE_ROWS_MAX).map((row) => {
    let text = '';
    try {
      const content = JSON.parse(row.content) as {
        text?: unknown;
        files?: unknown;
        operation?: unknown;
        emoji?: unknown;
      };
      const files = Array.isArray(content.files) ? `[file: ${content.files.join(', ')}]` : '';
      // A reaction is quoted as one, so the model can tell it from a reply.
      text =
        content.operation === 'reaction'
          ? `[reaction: ${typeof content.emoji === 'string' ? content.emoji : '?'}]`
          : [typeof content.text === 'string' ? content.text : '', files].filter(Boolean).join(' ');
    } catch {
      // Unparseable row: quote a placeholder.
    }
    return `<sent_message to="${escapePromptXml(destinationOf(row))}">${clip(text || '[non-text message]')}</sent_message>`;
  });
  if (rows.length > INFORMED_NUDGE_ROWS_MAX) sent.push(`(+${rows.length - INFORMED_NUDGE_ROWS_MAX} more)`);
  return (
    `<system>Your final text was not delivered — it was not wrapped in <message to="name">...</message> blocks:\n` +
    `<undelivered_text>${clip(finalText)}</undelivered_text>\n` +
    `Earlier in that turn you already sent:\n${sent.join('\n')}\n` +
    `If what was sent is the full reply, to where it was owed, respond with only <internal>done</internal> and nothing more will be sent. ` +
    `Otherwise send only what is still missing, wrapped in <message to="name">...</message>, without repeating what already went out. ` +
    `Your destinations: ${escapePromptXml(names)}.</system>`
  );
}

/** First `max` code points of `text`, with an ellipsis when cut. Never splits a surrogate pair. */
function clipCodePoints(text: string, max: number): string {
  let end = 0;
  let count = 0;
  for (const char of text) {
    if (count === max) return `${text.slice(0, end)}…`;
    end += char.length;
    count++;
  }
  return text;
}

/**
 * Does messages_out already hold a chat row with this exact destination and
 * body, written in the seq window (afterSeq, uptoSeq]? Used by the mid-turn
 * door's cross-segment echo guard. Content equality is exact: the door writes
 * `JSON.stringify({ text: body })` after the same trim/sanitize pipeline, so
 * a true door-written duplicate always matches; a body differing by even one
 * character is a different message and delivers.
 */
function wasWrittenInSeqWindow(dest: DestinationEntry, body: string, afterSeq: number, uptoSeq: number): boolean {
  if (uptoSeq <= afterSeq) return false;
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  const content = JSON.stringify({ text: body });
  // A lookup error reads as "not written": the guard falls through to
  // delivery, and the write surfaces any real DB breakage loudly.
  return chatRowsInWindow(afterSeq, uptoSeq).some(
    (message) =>
      message.platform_id === platformId && message.channel_type === channelType && message.content === content,
  );
}

/**
 * Did the nudged turn already send this body to this destination? Compares
 * trimmed text, since a tool send keeps the whitespace a block loses.
 */
function wasWrittenInWindow(dest: DestinationEntry, body: string, window: SeqWindow | undefined): boolean {
  if (!window) return false;
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  return chatRowsInWindow(window.after, window.upto).some((message) => {
    if (message.platform_id !== platformId || message.channel_type !== channelType) return false;
    try {
      const content = JSON.parse(message.content) as { text?: unknown; operation?: unknown };
      return content.operation === undefined && typeof content.text === 'string' && content.text.trim() === body;
    } catch {
      return false;
    }
  });
}

export async function dispatchResultText(
  text: string,
  routing: RoutingContext,
  // [PATCH-myia #19] Error turns: the routing-source fallback stands down
  // (error text flows through the caller's deliverErrorResult instead —
  // single delivery, status 'error' archived).
  isError = false,
  options?: ResultDispatchOptions,
): Promise<{ sent: number; hasUnwrapped: boolean; taskBlocks: TaskMessageBlock[]; undelivered: string }> {
  // <internal> spans are not-for-delivery scratchpad. Remove them BEFORE block
  // extraction so a <message> drafted inside one is never delivered from the
  // final text either — the mid-turn seam already guarantees this; without the
  // same strip here the guarantee had a final-text hole. Span content still
  // never reaches the user (the closing stripInternalTags pass removed it from
  // the scratchpad already), so nudge/scratchpad semantics are unchanged.
  text = text.replace(INTERNAL_SPAN_RE, '');
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;
  // [PATCH-myia #36] Cap messages per LLM response. Without this, a looping
  // model (observed with GLM: 500+ identical <message> blocks in one response)
  // floods messages_out and triggers a delivery runaway. 10 is generous — normal
  // agent turns produce 1-3 messages (one per destination). Hitting the cap logs
  // a warning and stops processing further blocks in this response.
  const MAX_MESSAGES_PER_POLL = 10;

  let match: RegExpExecArray | null;
  // Blocks delivered mid-turn count toward this turn's sent total — a final
  // text with no (new) blocks after a mid-turn delivery is scratchpad, not an
  // undelivered reply.
  let sent = options?.midTurnSent ?? 0;
  let replied = options?.midTurnReplied ?? sent;
  // Result blocks that were not delivered (unknown destination, or missed by
  // the stream): always nudge, even when another block went out this turn.
  let missed = 0;
  // <message to> blocks left inert in a task run — drives the same-turn
  // "use send_message" nudge in processQuery.
  const taskBlocks: TaskMessageBlock[] = [];
  let lastIndex = 0;
  const scratchpadParts: string[] = [];
  const seenMessages = new Set<string>(); // dedup for #36

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (sent >= MAX_MESSAGES_PER_POLL) {
      log(`WARNING: hit MAX_MESSAGES_PER_POLL (${MAX_MESSAGES_PER_POLL}) — dropping remaining <message> blocks in this response`);
      scratchpadParts.push(text.slice(lastIndex));
      break;
    }
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = stripHarnessTagArtifacts(match[2].trim());
    lastIndex = MESSAGE_RE.lastIndex;

    // One-door delivery in task sessions: only the send_message tool delivers.
    // A final-text <message to> block here is either an echo of a tool send the
    // agent already made (the double-delivery class) or a send down the wrong
    // path — never deliver it, keep it visible in the scratchpad/run log.
    if (routing.taskRun) {
      log(`Task run: <message to="${toName}"> block not delivered — task sessions send only via explicit tools`);
      scratchpadParts.push(
        `[not delivered — task sessions send only via the send_message tool; to="${toName}"] ${body}`,
      );
      taskBlocks.push({ to: toName, body });
      continue;
    }
    // [PATCH-myia #36] Dedup: skip if we already sent an identical message to
    // the same destination in this response. Catches the GLM loop pattern where
    // the model emits 100+ identical <message to="X">blocks.
    const dedupKey = `${toName}:${body}`;
    if (seenMessages.has(dedupKey)) {
      continue;
    }
    seenMessages.add(dedupKey);

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      // Possibly lost: always nudge. If it already went out before its destination
      // was removed, the informed nudge quotes that send and the model answers done.
      missed++;
      continue;
    }
    // Never deliver a blank message: a body that is empty (or was only
    // harness-tag artifacts stripped by sanitization) goes to the scratchpad
    // log instead of writing an empty chat row.
    if (!body) {
      log(`Empty <message to="${toName}"> body after sanitization — not delivered`);
      scratchpadParts.push(`[not delivered — empty after sanitization; to="${toName}"]`);
      continue;
    }
    // One content door: with a mid-turn delivery provider the result door
    // never sends. A deliverable block here is either a repeat of a mid-turn
    // delivery (keep it out of the scratchpad so it does not read as an
    // undelivered reply) or content the streaming door missed — then it goes
    // to the scratchpad as undelivered content, which makes the turn count as
    // undelivered and fires the wrap-nudge: the model re-sends and the retry
    // streams through the mid-turn door.
    if (options?.suppressDelivery) {
      // Exact match, so a streamed delegation can't hide an unstreamed answer.
      const repeat =
        wasWrittenInWindow(dest, body, options.nudgedWindow) ||
        wasWrittenInSeqWindow(dest, body, options.turnStartSeq, maxOutboundSeq());
      if (repeat) {
        log(`<message to="${toName}"> in final result after a same-turn delivery — repeat, result door does not send`);
      } else {
        log(`<message to="${toName}"> in final result was not delivered this turn — nudging for a mid-turn resend`);
        scratchpadParts.push(`[not delivered — the result door does not send; to="${toName}"] ${body}`);
        missed++;
      }
      continue;
    }
    if (wasWrittenInWindow(dest, body, options?.nudgedWindow)) {
      log(`<message to="${toName}"> repeats a message the nudged turn already sent — not sent again`);
      continue;
    }
    await sendToDestination(dest, body, routing);
    sent++;
    if (answersBatch(dest, routing)) replied++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const internalStripped = stripInternalTags(scratchpadParts.join(''));
  // Defensive: z.ai SDK occasionally leaks `<mcp__server__tool>...</...>`
  // tool-call envelopes as plain text. Without this strip, the fallback
  // below posts the raw XML to the user-facing channel.
  const { cleaned: scratchpad, leakCount } = stripLeakedMcpToolcalls(internalStripped);
  if (leakCount > 0) {
    log(`WARNING: stripped ${leakCount} leaked MCP toolcall block(s) from agent output (z.ai SDK known issue)`);
  }

  // [PATCH-myia #40] Drop provider status telemetry. A heavy turn that only
  // auto-compacted emits e.g. "Context compacted (N tokens compacted)." as its
  // sole text with no <message> envelope; without this it reaches the user's
  // channel (incident 2026-07-15: 91/93 group deliveries were this noise).
  // Return early so no channel write AND no re-wrap nudge fires for pure
  // telemetry. NOTE: the #19 routing-source fallback (deliver unwrapped text
  // raw to the routing source) was RETIRED in the 2026-11 upstream sync:
  // upstream's informed wrap-nudge now quotes the undelivered text back to the
  // model (<undelivered_text>), which covers GLM's unwrapped-emission habit
  // with a re-send instead of a raw delivery. Kept: this noise gate.
  if (!isError && sent === 0 && isProviderStatusNoise(scratchpad)) {
    log(
      `Suppressed provider status noise (${scratchpad.trim().length} chars): ${scratchpad.trim().slice(0, 80)}`,
    );
    return { sent: 0, hasUnwrapped: false, taskBlocks, undelivered: '' };
  }

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  // In a task run, plain final text is the NORMAL ending (it becomes the run
  // log) — never treat it as an undelivered reply or nudge the agent to wrap it.
  const hasUnwrapped = !routing.taskRun && (missed > 0 || (replied === 0 && !!scratchpad));
  if (hasUnwrapped) {
    log(
      replied > 0
        ? `WARNING: a <message to="..."> block in the final text was not delivered`
        : `WARNING: agent output had no <message to="..."> blocks — nothing was sent`,
    );
  }
  return { sent, hasUnwrapped, taskBlocks, undelivered: scratchpad };
}

/**
 * Should this task-run result get the same-turn "your <message> block was
 * not delivered — use send_message" nudge? True at most once per turn
 * (mirrors the unwrappedNudged flag for chat turns).
 */
export function shouldNudgeTaskBlocks(
  taskRun: boolean,
  taskBlocks: TaskMessageBlock[],
  alreadyNudged: boolean,
): boolean {
  return taskRun && taskBlocks.length > 0 && !alreadyNudged;
}

export function buildTaskBlockNudge(taskBlocks: TaskMessageBlock[], destinationNames: string): string {
  const blocks = taskBlocks
    .map(
      ({ to, body }) =>
        `<undelivered_message to="${escapePromptXml(to)}">${escapePromptXml(body)}</undelivered_message>`,
    )
    .join('\n');
  return (
    '<system>The final-output content below was not delivered from this task run:\n' +
    `${blocks}\n` +
    'If and only if any of it still needs to be sent, call send_message with an explicit to destination. ' +
    'If it was already sent or no notification is required, do not send it again. ' +
    `Your destinations: ${escapePromptXml(destinationNames)}. ` +
    'The original task result is already recorded in the run log; do not repeat it.</system>'
  );
}

function escapePromptXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Task runs: the final text is the automatic run summary. Explicit
 * `ncl tasks append-log` calls are additive mid-run notes. Written as a
 * `task_log` outbound row; the host appends it to the series' tasks/<id>.md
 * with its usual timestamp stamp. Never delivered to anyone.
 */
export async function autoAppendTaskLog(text: string): Promise<void> {
  // Run-log hygiene: an inert <message to> block never belongs in the log as
  // raw XML — replace each with its inner text, marked undelivered, so the
  // log stays readable prose.
  const prose = text.replace(
    /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g,
    (_m, to: string, body: string) => `[undelivered → ${to}] ${body.trim()}`,
  );
  const line = stripInternalTags(prose).replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!line) return;
  await writeMessageOut({
    id: generateId(),
    kind: 'task_log',
    content: JSON.stringify({ text: line }),
  });
  log('Task run log auto-appended from final text');
}

async function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): Promise<void> {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId, routing);
  await writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ text: body }),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
