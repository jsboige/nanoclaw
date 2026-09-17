/**
 * Per-session reconcile — one session's maintenance pass, extracted from the
 * host sweep so it can run per key instead of only inside the global tick.
 * `reconcileSession(sessionId)` is the `ReconcileFn` shape from
 * src/reconcile.ts: level-triggered, reads current state, a missing or
 * closed session is a clean no-op.
 *
 * Stuck / idle detection (replaces the old IDLE_TIMEOUT setTimeout + 10-min
 * heartbeat threshold):
 *
 *   If the container isn't running and there are 'processing' rows left over
 *   (e.g. it crashed mid-turn) → reset them to pending with backoff +
 *   tries++. Existing retry machinery does the rest. Gated since #3350: the
 *   reset only runs after two consecutive negative container probes AND once
 *   every claim is older than CONTAINER_DOWN_GRACE_MS — a single registry
 *   false negative must not replay a live turn envelope (see
 *   decideContainerDownReset).
 *
 *   If the container IS running:
 *     1. Absolute ceiling: heartbeat age > max(30 min, current_bash_timeout)
 *        → kill. Covers the "alive but silent for 30 min" case. Extended
 *        only while Bash is declared as running longer, honouring the
 *        user's own timeout directive. Kill then resets processing rows.
 *        When no heartbeat file exists yet, falls back to the tracked
 *        container spawn time so a container that goes idle without ever
 *        reaching an SDK event —
 *        and so never writes a heartbeat — still ages out instead of
 *        living forever (see decideStuckAction's grace-period comment).
 *
 *     2. Message-scoped stuck: for each 'processing' row, tolerance =
 *        max(60s, current_bash_timeout_ms_if_Bash_running). If
 *        (claim_age > tolerance) AND (heartbeat_mtime <= status_changed)
 *        → kill + reset this message + tries++. Semantics: "container
 *        claimed a message and went quiet past tolerance since the claim."
 */
import fs from 'fs';

import { getSessionClaim } from './db/coordination.js';
import { getSession, isTaskThread, updateSession } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { log } from './log.js';
import { heartbeatPath, withExistingMailboxSession } from './session-manager.js';
import { getContainerStartedAtMs, isContainerRunning, killContainer } from './container-runner.js';
import { requestWake } from './request-wake.js';
import type { Session } from './types.js';
import type { ContainerState, InboundMailbox, OutboundMailbox } from './mailbox/index.js';

// Absolute idle ceiling for a running container. If the heartbeat file hasn't
// been touched in this long, the container is either stuck or doing genuinely
// nothing — kill and restart on the next inbound.
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?"
export const CLAIM_STUCK_MS = 60 * 1000;
// [PATCH-myia #48] Grace applied to the container-not-running reset path (the
// `!alive` branch of maintainSessionMailbox). A false negative from the
// running-container registry (host restart while the container survived,
// adoption race) used to reset 'processing' rows on the FIRST miss, replaying
// a live turn envelope into a second container — the #3350 twin episodes. The
// reset now requires the claim age to exceed this AND two consecutive negative
// probes (see decideContainerDownReset). Chosen strictly above CLAIM_STUCK_MS
// and above the 60s sweep floor: voie B is never more eager than voie A's
// floor tolerance, and a claim inside its normal first-sweep working window is
// never replayed. This does NOT bound voie B by voie A's widened tolerance:
// voie A extends its per-claim tolerance with the declared Bash timeout
// (max(CLAIM_STUCK_MS, declaredBashMs) — a declared 10-min Bash is tolerated
// 600 s), so with declaredBashMs > 90 s voie B may legitimately reset a claim
// voie A would still tolerate. Accepted: two consecutive negative probes
// evidence a container that is actually gone, which a running-but-silent
// container cannot provide.
export const CONTAINER_DOWN_GRACE_MS = 90 * 1000;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number };

export type ContainerDownDecision =
  /** First negative probe of the current streak — record it, reset deferred. */
  | { action: 'arm' }
  /** Container down on consecutive probes, but claims are still within grace. */
  | { action: 'wait' }
  /** Consecutive negative probes AND every claim past the grace — reset now. */
  | { action: 'reset' };

/**
 * Pure decision for whether a running container should be killed this sweep
 * tick. Inputs are all deterministic; filesystem and mailbox reads happen in the
 * caller.
 */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  containerStartedAtMs?: number; // fallback when heartbeat file absent
  containerState: ContainerState | null;
  claims: Array<{ messageId: string; statusChanged: string }>;
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerStartedAtMs, containerState, claims } = args;
  const declaredBashMs = bashTimeoutMs(containerState);

  // Ceiling check prefers the heartbeat file's mtime. A freshly-spawned
  // container hasn't had any SDK activity yet so no heartbeat file exists —
  // if we treated that as infinitely stale we'd kill every container within
  // seconds of spawn. But "no heartbeat file" isn't only a spawn-grace-period
  // signal: a container can also finish its one turn (or find nothing to do)
  // without its poll loop ever reaching an SDK event, in which case a
  // heartbeat file is never created for the rest of that container's life,
  // and it sits alive-but-idle forever, immune to this check. Falling back
  // to the container's spawn timestamp gives fresh spawns the same grace
  // period as before (age starts at ~0) while still aging out a
  // container that never ticks. Genuinely-dead containers that never wrote a
  // heartbeat AND have no session record are caught by the separate
  // "container process not running" cleanup path, not here. If a fresh
  // container is hanging at the gate (claimed a message but never did
  // anything) the claim-stuck check below handles it independently of this
  // fallback.
  const effectiveHeartbeatMs = heartbeatMtimeMs !== 0 ? heartbeatMtimeMs : (containerStartedAtMs ?? 0);
  if (effectiveHeartbeatMs !== 0) {
    const heartbeatAge = now - effectiveHeartbeatMs;
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0);
    if (heartbeatAge > ceiling) {
      return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0);
  for (const claim of claims) {
    const claimedAt = Date.parse(claim.statusChanged);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.messageId, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}

/**
 * [PATCH-myia #48] Pure decision for whether the container-not-running
 * stuck-reset may run this pass. The old behavior reset 'processing' rows on
 * the FIRST negative probe, so a single registry false negative replayed a
 * live turn envelope into a second container (#3350 twins: two TOUR posts on
 * the same slot). The reset now requires BOTH:
 *
 *   1. two consecutive probes concluded "not running" — the first negative
 *      probe only arms, a later one confirms, and a positive probe in
 *      between disarms (the caller clears the streak when the container is
 *      seen running). The two probes carry no minimum temporal separation:
 *      consecutive sweep ticks milliseconds apart both count — the gate is
 *      the claim's age, not the streak's duration. And
 *   2. every 'processing' claim is older than CONTAINER_DOWN_GRACE_MS, so a
 *      claim still inside its normal working window is never replayed. The
 *      grace bounds voie B against voie A's FLOOR (CLAIM_STUCK_MS) only:
 *      voie A widens its per-claim tolerance with the declared Bash timeout,
 *      so with declaredBashMs > 90 s voie B can reset a claim voie A would
 *      still tolerate — accepted, because consecutive negative probes
 *      evidence a dead container rather than a silent one.
 *
 * Inputs are deterministic; the streak map and mailbox reads stay in the
 * caller. Claims with unparseable timestamps block the reset (unknown age
 * is not evidence of an orphan) — same posture as decideStuckAction.
 */
export function decideContainerDownReset(args: {
  now: number;
  /** Timestamp of the previous negative probe in the current streak, null when the previous probe was positive or none ran. */
  firstNegativeAtMs: number | null;
  claims: Array<{ messageId: string; statusChanged: string }>;
}): ContainerDownDecision {
  const { now, firstNegativeAtMs, claims } = args;
  if (firstNegativeAtMs === null) return { action: 'arm' };
  if (claims.length === 0) return { action: 'wait' };
  for (const claim of claims) {
    const claimedAt = Date.parse(claim.statusChanged);
    if (Number.isNaN(claimedAt)) return { action: 'wait' };
    if (now - claimedAt <= CONTAINER_DOWN_GRACE_MS) return { action: 'wait' };
  }
  return { action: 'reset' };
}

/** A per-task session with no live tasks and no running container is spent → close it. */
export function shouldCloseTaskSession(
  threadId: string | null,
  containerRunning: boolean,
  liveTaskCount: number,
): boolean {
  return isTaskThread(threadId) && !containerRunning && liveTaskCount === 0;
}

/** Reconcile one session against current state. Missing/closed sessions no-op. */
export async function reconcileSession(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session || session.status !== 'active') {
    // A gone session must not keep a probe streak alive.
    containerDownSince.delete(sessionId);
    return;
  }
  await reconcileActiveSession(session);
}

async function reconcileActiveSession(session: Session): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  try {
    let dueCount = 0;
    let shouldWake = false;
    const exists = await withExistingMailboxSession(agentGroup.id, session.id, async (mailbox) => {
      mailbox.applyProcessingAcks(mailbox.getTerminalProcessingAcks());
      dueCount = mailbox.countDueMessages();
      shouldWake = dueCount > 0 && !isContainerRunning(session.id);
      if (!shouldWake) {
        await maintainSessionMailbox(mailbox, session, agentGroup.id);
      }
      return true;
    });
    if (!exists) return;

    if (!shouldWake) return;

    // Waking refreshes routing through the mailbox. Keep it outside the
    // session transaction so serialized implementations do not re-enter
    // themselves while the sweep still owns the session.
    log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
    await requestWake(session, 'due-message');

    await withExistingMailboxSession(agentGroup.id, session.id, async (mailbox) => {
      await maintainSessionMailbox(mailbox, session, agentGroup.id);
    });
  } catch (err) {
    log.error('Session mailbox sweep failed', {
      agentGroupId: agentGroup.id,
      sessionId: session.id,
      err,
    });
  }
}

/**
 * [PATCH-myia #48] SessionId → timestamp of the first "container not running"
 * probe in the current streak. Written by the first negative probe, cleared by
 * any positive probe (or when the session goes away) — so a lone registry
 * false negative can never reach the reset on its own.
 */
const containerDownSince = new Map<string, number>();

/** Test seam: clear the container-down probe streak between tests. */
export function _resetContainerDownTrackingForTesting(): void {
  containerDownSince.clear();
}

/**
 * The container-not-running reset (voie B), gated by the #3350 grace: the
 * first negative probe only arms, a later consecutive one confirms, and the
 * claims must all be past CONTAINER_DOWN_GRACE_MS before anything resets.
 * `now` is a parameter so tests can drive the streak deterministically.
 */
function probeContainerDownAndMaybeReset(
  inDb: InboundMailbox,
  outDb: OutboundMailbox,
  session: Session,
  now: number,
): void {
  const decision = decideContainerDownReset({
    now,
    firstNegativeAtMs: containerDownSince.get(session.id) ?? null,
    claims: outDb.getProcessingClaims(),
  });
  if (decision.action === 'arm') {
    containerDownSince.set(session.id, now);
    log.info('Container probe negative — grace armed, stuck reset deferred', {
      sessionId: session.id,
      graceMs: CONTAINER_DOWN_GRACE_MS,
    });
    return;
  }
  if (decision.action === 'wait') {
    log.info('Container down on consecutive probes — claims still within grace, reset deferred', {
      sessionId: session.id,
      graceMs: CONTAINER_DOWN_GRACE_MS,
    });
    return;
  }
  containerDownSince.delete(session.id);
  resetStuckProcessingRows(inDb, outDb, session, 'container not running (confirmed by consecutive probes)');
}

/** Test seam for the voie-B grace gate: one negative-probe pass at `now`. */
export function _containerDownProbeForTesting(
  inDb: InboundMailbox,
  outDb: OutboundMailbox,
  session: Session,
  now: number,
): void {
  probeContainerDownAndMaybeReset(inDb, outDb, session, now);
}

async function maintainSessionMailbox(
  mailbox: InboundMailbox & OutboundMailbox,
  session: Session,
  agentGroupId: string,
): Promise<void> {
  const alive = isContainerRunning(session.id);
  if (alive) {
    // A live container breaks the negative-probe streak — see
    // probeContainerDownAndMaybeReset.
    containerDownSince.delete(session.id);
    await enforceRunningContainerSla(mailbox, mailbox, session, agentGroupId);
  }
  if (!alive) {
    // [PATCH-myia #48] Two-probe + grace gate replaces the old first-miss
    // resetStuckProcessingRows call — do not restore the one-probe reset.
    probeContainerDownAndMaybeReset(mailbox, mailbox, session, Date.now());
  }

  // MODULE-HOOK:scheduling-recurrence:start
  const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
  await handleRecurrence(mailbox, session);
  // MODULE-HOOK:scheduling-recurrence:end

  if (isTaskThread(session.thread_id)) {
    const liveTasks = mailbox.countLiveTasks();
    if (shouldCloseTaskSession(session.thread_id, isContainerRunning(session.id), liveTasks)) {
      await updateSession(session.id, { status: 'closed' });
      log.info('Closed spent task session', { sessionId: session.id, threadId: session.thread_id });
    }
  }

  // MODULE-HOOK:cross-session-echo-prune:start
  try {
    const { pruneEchoBacklog } = await import('./modules/cross-session-context/index.js');
    const pruned = pruneEchoBacklog(mailbox);
    if (pruned > 0) log.info('Pruned session-echo backlog', { sessionId: session.id, pruned });
  } catch (err) {
    log.error('Echo backlog prune failed', { sessionId: session.id, err });
  }
  // MODULE-HOOK:cross-session-echo-prune:end
}

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

function bashTimeoutMs(state: ContainerState | null): number | null {
  if (!state || state.currentTool !== 'Bash') return null;
  return state.toolDeclaredTimeoutMs;
}

/**
 * The incarnation gate: evidence that predates the current incarnation's
 * durable claim time is not evidence against this container. A heartbeat
 * mtime older than the claim is the previous incarnation's file — treated as
 * absent, so the spawn-time fallback gives the fresh container its grace. A
 * processing claim older than the claim time was inherited from a crashed
 * predecessor — its age is measured from this incarnation's start, so the
 * fresh container gets a full tolerance window to clear it before it can
 * kill. Replaces the old wake-tick grace flag: the fence is a durable fact
 * about when this incarnation began, not volatile "we just woke it"
 * bookkeeping — it survives restarts and applies on every pass, not only the
 * one that issued the wake.
 */
async function enforceRunningContainerSla(
  inDb: InboundMailbox,
  outDb: OutboundMailbox,
  session: Session,
  agentGroupId: string,
): Promise<void> {
  let incarnationStartMs = 0;
  const claimRow = await getSessionClaim(session.id);
  if (claimRow?.claimed_at) {
    const parsed = Date.parse(claimRow.claimed_at);
    if (!Number.isNaN(parsed)) incarnationStartMs = parsed;
  }

  const rawHeartbeatMs = heartbeatMtimeMs(agentGroupId, session.id);
  const gatedHeartbeatMs = rawHeartbeatMs >= incarnationStartMs ? rawHeartbeatMs : 0;
  const gatedClaims = outDb.getProcessingClaims().map((claim) => {
    const claimedAt = Date.parse(claim.statusChanged);
    if (Number.isNaN(claimedAt) || claimedAt >= incarnationStartMs) return claim;
    return { ...claim, statusChanged: new Date(incarnationStartMs).toISOString() };
  });

  const decision = decideStuckAction({
    now: Date.now(),
    heartbeatMtimeMs: gatedHeartbeatMs,
    containerStartedAtMs: getContainerStartedAtMs(session.id),
    containerState: outDb.getContainerState(),
    claims: gatedClaims,
  });

  if (decision.action === 'ok') return;

  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      ceilingMs: decision.ceilingMs,
    });
    killContainer(session.id, 'absolute-ceiling');
    resetStuckProcessingRows(inDb, outDb, session, 'absolute-ceiling');
    return;
  }

  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
  });
  killContainer(session.id, 'claim-stuck');
  resetStuckProcessingRows(inDb, outDb, session, 'claim-stuck');
}

export function _resetStuckProcessingRowsForTesting(
  inDb: InboundMailbox,
  outDb: OutboundMailbox,
  session: Session,
  reason: string,
): void {
  resetStuckProcessingRows(inDb, outDb, session, reason);
}

function resetStuckProcessingRows(
  inDb: InboundMailbox,
  outDb: OutboundMailbox,
  session: Session,
  reason: string,
): void {
  const claims = outDb.getProcessingClaims();
  const now = Date.now();
  for (const { messageId } of claims) {
    const msg = inDb.getMessageForRetry(messageId, 'pending');
    if (!msg) continue;

    // Already rescheduled for a future retry — don't bump tries again. The
    // wake path (sweep step 2) will fire when process_after elapses and a
    // fresh container will clean the orphan claim on startup.
    if (msg.processAfter && Date.parse(msg.processAfter) > now) continue;

    if (msg.tries >= MAX_TRIES) {
      inDb.markMessageFailed(msg.id);
      log.warn('Message marked as failed after max retries', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      inDb.retryWithBackoff(msg.id, backoffSec);
      log.info('Reset stale message with backoff', {
        messageId: msg.id,
        tries: msg.tries,
        backoffMs,
        reason,
      });
    }
  }

  // Drop the orphan 'processing' rows. Without this, the next sweep tick
  // would re-read them, see the old status_changed timestamp, conclude the
  // freshly respawned container is stuck, and SIGKILL it before its
  // agent-runner has a chance to run clearStaleProcessingAcks() on startup.
  try {
    const cleared = outDb.deleteOrphanProcessingClaims();
    if (cleared > 0) {
      log.info('Cleared orphan processing claims', { sessionId: session.id, cleared, reason });
    }
  } catch (err) {
    log.warn('Failed to clear orphan processing claims', { sessionId: session.id, err });
  }
}
