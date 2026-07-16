import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import {
  getPendingMessages,
  markProcessing,
  markCompleted,
  resetProcessingAcks, // [PATCH-myia #18]
  type MessageInRow,
} from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import {
  getInboundDb,
  touchHeartbeat,
  clearStaleProcessingAcks,
  getContainerToolInFlight, // [PATCH-myia #28]
  clearContainerToolInFlight, // [PATCH-myia #28]
} from './db/connection.js';
import { recordTaskRun } from './db/task-run-logs.js'; // [PATCH-myia #9]
import { clearContinuation, migrateLegacyContinuation, setContinuation } from './db/session-state.js';
import { clearCurrentInReplyTo, setCurrentInReplyTo } from './current-batch.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isRunnerCommand,
  stripInternalTags,
  stripLeakedMcpToolcalls, // [PATCH-myia #16]
  type RoutingContext,
} from './formatter.js';
// [PATCH-myia #8] mcp-health probe
import { formatFailures, probeMcpRemoteCached, type RequiredRemote } from './mcp-health.js';
import { isUploadTraceCommand, uploadTrace } from './upload-trace.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderExchange } from './providers/types.js';

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
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
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
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
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
        writeMessageOut({
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
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isUploadTraceCommand(msg)) {
        log('Uploading session trace to Hugging Face');
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: uploadTrace() }),
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
    let skipped: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markCompleted(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
      // Log skipped tasks. Duration is approximate (the pre-task script
      // ran but we don't capture its individual time here); use 0 as a
      // placeholder — the meaningful field is status='skipped'.
      const skippedSet = new Set(skipped);
      for (const task of tasksInBatch.filter((t) => skippedSet.has(t.id))) {
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
    const prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    const query = config.provider.query({
      prompt,
      continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
    });

    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped);
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    // [PATCH-myia #9] task_run_logs observability
    const tasksKept = tasksInBatch.filter((t) => !skippedSet.has(t.id));
    const batchStartedAt = Date.now();
    let batchError: string | null = null;
    let stalledAborted = false; // [PATCH-myia #26]
    // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
    // can stamp it on outbound rows — needed for a2a return-path routing.
    setCurrentInReplyTo(routing.inReplyTo);
    try {
      const result = await processQuery(
        query,
        routing,
        processingIds,
        config.providerName,
        config.provider.onExchangeComplete?.bind(config.provider),
        prompt,
        continuation,
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
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);
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
                text: `🔄 Transient session error — holding your message, I'll retry once the chain recovers.`,
              }),
            });
          }
          resetProcessingAcks(processingIds);
          stalledAborted = true;
          await sleep(BLOCKED_RETRY_BACKOFF_MS);
        }
      } else {
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: `Error: ${errMsg}` }),
        });
      }
    } finally {
      clearCurrentInReplyTo();
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
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
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
}

export async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  onExchangeComplete: ((exchange: ProviderExchange) => void) | undefined,
  initialPrompt: string,
  initialContinuation: string | undefined,
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let mcpRegistryLost: { toolName: string; serverName: string } | undefined;
  let done = false;
  let unwrappedNudged = false;
  // Prompt queue for the exchange hook — each result event consumes the
  // oldest unanswered prompt, except a wrapping-retry result, which answers
  // the same prompt again. Unused (and unmaintained) when the provider
  // doesn't implement `onExchangeComplete`.
  const archivePrompts: string[] = [initialPrompt];

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

  // [PATCH-myia #25] Push serialization — hold new follow-ups until the
  // current turn finishes. Earlier behavior pushed every arrival straight
  // into the live stream, so the SDK merged multiple user messages into a
  // single turn and emitted ONE result for N inputs — the extra messages
  // got silently swallowed (no per-message reply, no fallback dispatch).
  // Now we push at most one batch at a time: while `awaitingResult` is
  // true (initial prompt or a previous follow-up batch still being
  // answered), new arrivals accumulate in `queuedFollowUps` and get
  // pushed as a single consolidated batch on the next `result`. They are
  // still marked processing on arrival (so the host knows they're claimed
  // and won't pick them up via the sweep), and they're reset back to
  // pending if the stream ends before they get pushed.
  //
  // `awaitingResult` starts true because the initial prompt was already
  // injected by config.provider.query() before this function was called.
  let awaitingResult = true;
  const queuedFollowUps: MessageInRow[] = [];

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
        if (pending.some((m) => isRunnerCommand(m))) {
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
        const newMessages = pending.filter((m) => m.kind !== 'system');
        if (newMessages.length === 0) return;

        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        // Mirrors the initial-batch hook above.
        let keep = newMessages;
        let skipped: string[] = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markCompleted(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.join(', ')}`);
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work; the
        // claimed messages get released by the host's processing-claim sweep.
        if (done) return;

        // [PATCH-myia #25] Serialize pushes: if a turn is already in flight
        // (initial prompt or a prior follow-up batch awaiting its result),
        // queue this batch locally. It will be drained on the next `result`
        // event so each batch gets its own SDK turn (and therefore its own
        // user-visible reply) rather than being merged into the running turn.
        if (awaitingResult) {
          queuedFollowUps.push(...keep);
          log(
            `Queued ${keep.length} follow-up(s) — turn in flight (${queuedFollowUps.length} total queued)`,
          );
          return;
        }

        const keptIds = keep.map((m) => m.id);
        const prompt = formatMessages(keep);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        unwrappedNudged = false;
        query.push(prompt);
        // [PATCH-myia #18] Defer markCompleted until a `result` event arrives.
        // The previous behavior marked these completed immediately after push,
        // which silently lost messages whenever the SDK failed to emit a
        // matching result event (push-mode stall). Now they stay in
        // `processing` state and are either drained on the next result event,
        // or reset+retried by the stall watchdog below.
        pendingFollowUpAcks.push(...keptIds);
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

        // Detect SQLite cross-mount corruption (Docker Desktop macOS virtiofs /
        // gRPC-FUSE coherency bug — the kernel page cache for the inbound.db
        // bind mount can latch a torn snapshot mid-host-write, after which
        // every fresh openInboundDb() in this process sees the same broken
        // view. Reopening inside the container does NOT recover; only a fresh
        // container mount does. Exit so the host sweep respawns us.
        if (isCorruptionError(errMsg)) {
          corruptionStreak += 1;
          if (corruptionStreak >= CORRUPTION_STREAK_EXIT) {
            log(
              `Follow-up poll: ${corruptionStreak} consecutive '${errMsg}' errors — ` +
                `inbound.db page cache is poisoned. Exiting so host respawns with a fresh mount.`,
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
          corruptionStreak = 0;
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
        `(initial=${initialBatchIds.length}, pending-follow-ups=${pendingFollowUpAcks.length}, queued=${queuedFollowUps.length}). ` +
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
      pendingFollowUpAcks.length = 0;
    }
    // Queued (not-yet-pushed) follow-ups were claimed by markProcessing
    // when they arrived. Release them too so the next outer-loop
    // iteration re-picks them in a fresh query.
    if (queuedFollowUps.length > 0) {
      const queuedIds = queuedFollowUps.map((m) => m.id);
      try {
        resetProcessingAcks(queuedIds);
      } catch (err) {
        log(
          `Failed to reset queued follow-up acks during stall: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      queuedFollowUps.length = 0;
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
    // If we have queued follow-ups, the result handler will drain them on
    // the next `result` event. (Reaching this branch with a non-empty
    // queue would mean we got a result but skipped the drain — shouldn't
    // happen in normal flow, but defensive.)
    if (queuedFollowUps.length > 0) return;

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
      pendingFollowUpAcks.length = 0;
    }
    if (queuedFollowUps.length > 0) {
      const queuedIds = queuedFollowUps.map((m) => m.id);
      try {
        resetProcessingAcks(queuedIds);
      } catch (err) {
        log(`Failed to reset queued follow-up acks during tool-stuck: ${err instanceof Error ? err.message : String(err)}`);
      }
      queuedFollowUps.length = 0;
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
      } else if (event.type === 'result') {
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
          pendingFollowUpAcks.length = 0;
        }
        awaitingResult = false;
        lastResultAt = Date.now(); // [PATCH-myia #27]
        if (event.text) {
          // Pass isError so dispatchResultText's [PATCH-myia #19] routing-source
          // fallback stands down for error turns — those flow through upstream's
          // dedicated deliverErrorResult path below (single delivery, status
          // 'error' archived). #19 keeps owning normal unwrapped output.
          const { sent, hasUnwrapped } = dispatchResultText(event.text, routing, event.isError === true);
          if (sent === 0 && event.isError === true) {
            // Non-retryable error turn (e.g. a 403 billing_error) with no
            // <message> envelope: deliver the notice instead of dropping it as
            // scratchpad, and skip the re-wrap nudge — it would just re-hammer
            // the failing gateway turn after turn.
            deliverErrorResult(event.text, routing);
            notifyExchangeComplete(onExchangeComplete, {
              prompt: archivePrompts[0] ?? initialPrompt,
              result: event.text,
              continuation: queryContinuation ?? initialContinuation,
              status: 'error',
            });
            archivePrompts.shift();
          } else {
            // [PATCH-myia #19] The bare-text fallback (deliver unwrapped output
            // to the routing source so the user still gets *something* this
            // turn) now lives inside dispatchResultText — see its body. The
            // re-wrap nudge below is upstream's preferred recovery and subsumes
            // #19's former nudge here.
            const willRetryWrapping = hasUnwrapped && !unwrappedNudged;
            notifyExchangeComplete(onExchangeComplete, {
              prompt: archivePrompts[0] ?? initialPrompt,
              result: event.text,
              continuation: queryContinuation ?? initialContinuation,
              status: hasUnwrapped ? 'undelivered' : 'completed',
            });
            if (willRetryWrapping) {
              unwrappedNudged = true;
              const destinations = getAllDestinations();
              const names = destinations.map((d) => d.name).join(', ');
              query.push(
                `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                  `All output must be wrapped: use <message to="name"> for content to send, or <internal> for scratchpad. ` +
                  `Your destinations: ${names}. ` +
                  `Please re-send your response with the correct wrapping.</system>`,
              );
            }
            // The wrapping-retry result answers the SAME user prompt — keep it
            // queued so the retry archives against it, not the nudge text.
            if (!willRetryWrapping) archivePrompts.shift();
          }
        } else {
          archivePrompts.shift();
        }
        // [PATCH-myia #25] Drain queued follow-ups into a fresh turn. Any
        // messages that arrived while the previous turn was in flight have
        // been holding in `queuedFollowUps`; push them as a single batch
        // now so they get their own result (and therefore their own user
        // reply). Guard against pushing into a stream we're about to end
        // (slash command or refresh) — those follow-ups will be reset to
        // pending in the finally block and re-picked by the outer loop.
        if (
          queuedFollowUps.length > 0 &&
          !endedForCommand &&
          !stalledAborted &&
          Date.now() - queryStartedAt <= QUERY_REFRESH_AFTER_MS
        ) {
          const batch = queuedFollowUps.splice(0);
          const batchIds = batch.map((m) => m.id);
          const prompt = formatMessages(batch);
          log(`Draining ${batch.length} queued follow-up(s) into fresh turn`);
          query.push(prompt);
          pendingFollowUpAcks.push(...batchIds);
          awaitingResult = true;
        }
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
    const errMsg = err instanceof Error ? err.message : String(err);
    notifyExchangeComplete(onExchangeComplete, {
      prompt: archivePrompts[0] ?? initialPrompt,
      result: `Error: ${errMsg}`,
      continuation: queryContinuation ?? initialContinuation,
      status: 'error',
    });
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
      pendingFollowUpAcks.length = 0;
    }
    // [PATCH-myia #25] Same treatment for queued-but-not-yet-pushed follow-
    // ups: they were claimed by markProcessing on arrival, so without an
    // explicit reset they'd stay in `processing` until the host sweep
    // clears them — which only happens after CLAIM_STUCK_MS+heartbeat-age
    // checks. Resetting immediately means the outer loop's next iteration
    // (or a fresh container spawn) picks them up at once.
    if (queuedFollowUps.length > 0 && !stalledAborted) {
      const queuedIds = queuedFollowUps.map((m) => m.id);
      log(
        `Stream ended with ${queuedFollowUps.length} queued follow-up(s) — resetting acks for retry`,
      );
      try {
        resetProcessingAcks(queuedIds);
      } catch (err) {
        log(
          `Failed to reset queued follow-up acks at stream end: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      queuedFollowUps.length = 0;
    }
  }

  return { continuation: queryContinuation, mcpRegistryLost, stalledAborted };
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
 * Deliver a turn's text straight to the channel the batch arrived on. Used when
 * a turn ends in a provider error (e.g. a non-retryable 403 billing_error) with
 * no <message> envelope: the notice would otherwise be dropped as scratchpad.
 * This is the same user-facing write the outer catch block does, minus the
 * `Error:` prefix — the provider's text is already a user-facing message.
 */
function deliverErrorResult(text: string, routing: RoutingContext): void {
  log('Error result with no <message> envelope — delivering to channel');
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text }),
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
function dispatchResultText(
  text: string,
  routing: RoutingContext,
  isError = false,
): { sent: number; hasUnwrapped: boolean } {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;
  // [PATCH-myia #36] Cap messages per LLM response. Without this, a looping
  // model (observed with GLM: 500+ identical <message> blocks in one response)
  // floods messages_out and triggers a delivery runaway. 10 is generous — normal
  // agent turns produce 1-3 messages (one per destination). Hitting the cap logs
  // a warning and stops processing further blocks in this response.
  const MAX_MESSAGES_PER_POLL = 10;

  let match: RegExpExecArray | null;
  let sent = 0;
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
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;

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
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
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

  // [PATCH-myia #19] Routing-source fallback. If the agent produced text but
  // failed to wrap any of it in `<message to="...">` blocks, send the cleaned
  // scratchpad to the source of the inbound that triggered this turn. The
  // alternative (current upstream behavior) is to silently drop the reply,
  // which from the user's POV looks identical to "the bot ignored me." This
  // recurs especially after MCP registry loss → continuation cleared → fresh
  // SDK init that sometimes drops the destination-wrapping discipline.
  //
  // We only fall back when:
  //   - !isError (error turns flow through the caller's deliverErrorResult
  //     path instead — single delivery, status 'error' archived; without this
  //     gate #19 and deliverErrorResult would both write the same notice)
  //   - sent === 0 (no <message> blocks succeeded)
  //   - scratchpad has substantive content (not just whitespace)
  //   - routing has a usable channel (platformId + channelType)
  if (
    !isError &&
    sent === 0 &&
    scratchpad.trim().length > 0 &&
    routing.platformId &&
    routing.channelType
  ) {
    log(
      `FALLBACK: agent output had no <message to="..."> blocks — sending ${scratchpad.length} chars to routing source (${routing.channelType}:${routing.platformId})`,
    );
    writeMessageOut({
      id: generateId(),
      in_reply_to: routing.inReplyTo,
      kind: 'chat',
      platform_id: routing.platformId,
      channel_type: routing.channelType,
      thread_id: routing.threadId ?? null,
      content: JSON.stringify({ text: scratchpad.trim() }),
    });
    // Suppress upstream's nudge here: PATCH #19 already delivered the bare
    // text to the user's channel this turn, so re-prompting the agent to
    // "re-send with proper wrapping" would just trigger the same unwrapped
    // emission again (test verifies this — see PATCHES.md#19). The nudge
    // path remains active for the unwrapped-with-no-fallback case below.
    return { sent: 0, hasUnwrapped: false };
  }

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  const hasUnwrapped = sent === 0 && !!scratchpad;
  if (hasUnwrapped) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
  return { sent, hasUnwrapped };
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId);
  writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ text: body }),
  });
}

/**
 * Find the thread_id and message id from the most recent inbound message
 * matching the given channel+platform. Returns null if no match found.
 */
function resolveDestinationThread(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string | null } | null {
  try {
    const db = getInboundDb();
    const row = db
      .prepare(
        `SELECT thread_id, id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { thread_id: string | null; id: string } | undefined;
    if (row) return { threadId: row.thread_id, inReplyTo: row.id };
  } catch (err) {
    log(`resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
