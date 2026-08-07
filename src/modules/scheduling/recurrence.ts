/**
 * Sweep hook for recurring tasks.
 *
 * Every sweep tick, find `messages_in` rows that are `completed` AND still
 * have a `recurrence` cron expression. For each, compute the next run via
 * cron-parser, insert a fresh pending row (copying series_id forward), then
 * clear the recurrence on the original so it isn't re-cloned next tick.
 *
 * Called from `src/host-sweep.ts` inside `MODULE-HOOK:scheduling-recurrence`.
 * When scheduling ships inline (current state through PR #7), the hook is a
 * direct dynamic import. When scheduling moves to the modules branch in
 * PR #8, the install skill re-fills the marker on install.
 */
import type Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';

import { resolveGroupTimezone } from '../../container-config.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import {
  clearRecurrence,
  getCompletedRecurring,
  insertRecurrence,
  trailingFailedRuns,
  type RecurringMessage,
} from './db.js';
import { appendRunLog } from './run-log.js';

// Consecutive pre-task-script failures (the series' trailing FAILED runs —
// derived from occurrence rows, no stored counter) throttle a broken monitor
// script instead of letting it wake a container at raw cron cadence forever.
// A deliberate wakeAgent=false gate is a normal completed run and never backs
// off. Mirrors the stuck-message retry in host-sweep.ts (BACKOFF_BASE_MS
// doubling, MAX_TRIES → failed): fail loud, don't spin.
const SCRIPT_FAIL_PAUSE_CAP = 8;
const SCRIPT_BACKOFF_CAP_MIN = 60;

/** 2, 4, 8, 16, 32, 60, 60… minutes for fails = 1, 2, 3… */
export function scriptBackoffMinutes(fails: number): number {
  return Math.min(2 * 2 ** (fails - 1), SCRIPT_BACKOFF_CAP_MIN);
}

/** Host-written line in the series run log — no agent session exists to call
 *  append-log when a script-gated series is auto-paused. Uses the shared
 *  appendRunLog helper (one writer format); appendRunLog throws on a bad
 *  series charset or a missing agent group, and the sweep must not crash
 *  over a log line, so failures are logged and swallowed. */
function appendHostTaskNote(agentGroupId: string, seriesId: string, note: string): void {
  try {
    appendRunLog(agentGroupId, seriesId, note);
  } catch (err) {
    log.warn('Could not append host task note to run log', { agentGroupId, seriesId, err });
  }
}

export async function handleRecurrence(inDb: Database.Database, session: Session): Promise<void> {
  const recurring = getCompletedRecurring(inDb);
  // Resolved per call, not cached at module load: a group timezone change
  // (approved `groups config update --timezone`) must shift the series from
  // the very next re-arm.
  const tz = resolveGroupTimezone(session.agent_group_id);

  for (const msg of recurring) {
    try {
      // Interpret the cron expression in the user's timezone. v1 did this
      // (src/v1/task-scheduler.ts:20-49); without it, a task written "0 9 * * *"
      // by an agent running in a user's local TZ fires at 09:00 UTC instead of
      // 09:00 user-local.
      const interval = CronExpressionParser.parse(msg.recurrence, { tz });
      const cronNext = interval.next().toDate();
      const newId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const scriptFails = trailingFailedRuns(inDb, msg.series_id ?? msg.id);

      if (scriptFails >= SCRIPT_FAIL_PAUSE_CAP) {
        // Re-arm PAUSED at the cron time so `ncl tasks resume` revives the
        // series in place; leave the why in the run log.
        insertRecurrence(inDb, msg, newId, cronNext.toISOString(), 'paused');
        clearRecurrence(inDb, msg.id);
        appendHostTaskNote(
          session.agent_group_id,
          msg.series_id,
          `auto-paused after ${scriptFails} consecutive script failures (host); fix the script, then \`ncl tasks resume ${msg.series_id}\``,
        );
        log.warn('Task series auto-paused: script keeps failing', {
          seriesId: msg.series_id,
          scriptFails,
          sessionId: session.id,
        });
        continue;
      }

      const backoffAt = scriptFails > 0 ? Date.now() + scriptBackoffMinutes(scriptFails) * 60_000 : 0;
      const nextRun = new Date(Math.max(cronNext.getTime(), backoffAt)).toISOString();

      insertRecurrence(inDb, msg, newId, nextRun);
      clearRecurrence(inDb, msg.id);

      log.info('Inserted next recurrence', {
        originalId: msg.id,
        newId,
        seriesId: msg.series_id,
        nextRun,
        ...(scriptFails > 0 && { scriptFails, backoffMin: scriptBackoffMinutes(scriptFails) }),
        sessionId: session.id,
      });
    } catch (err) {
      // Cron string can't fix itself — clearing recurrence stops every-tick spam
      // and lets the agent see the failure once instead of repeatedly. Discovered
      // after a "0 21-5 * * *" task (invalid range, min>max) re-threw every minute
      // for ~16h, blocking the night shift entirely.
      try {
        clearRecurrence(inDb, msg.id);
      } catch (clearErr) {
        log.error('Failed to clear malformed recurrence after parse error', {
          messageId: msg.id,
          err: clearErr,
        });
      }
      log.error('Cleared malformed recurrence after parse failure', {
        messageId: msg.id,
        recurrence: msg.recurrence,
        err,
      });
    }
  }
}

/**
 * Auto-advance a recurring task after MAX_TRIES failure.
 *
 * Mirrors handleRecurrence but operates on a single message id regardless of
 * status. Without this, a transient failure cascade (5 stalls,
 * session-invalid hits, OneCLI hiccups) silently kills the cron series: the
 * row gets status='failed', handleRecurrence's `status='completed'` filter
 * skips it, no next instance is ever enqueued, and the bot goes quiet
 * indefinitely. Reproduced 2026-05-28 with two ClusterManager cron series
 * (`15 8-22 * * *` + `30 8-22 * * *`) both flat-lined for ~3h after stall
 * retries exhausted.
 *
 * Returns true if a next instance was enqueued, false otherwise. Errors are
 * logged, never thrown — the caller's markMessageFailed must still run.
 */
export async function advanceRecurringTaskAfterFailure(
  inDb: Database.Database,
  messageId: string,
  session: Session,
): Promise<boolean> {
  const msg = inDb
    .prepare("SELECT * FROM messages_in WHERE id = ? AND kind = 'task' AND recurrence IS NOT NULL AND recurrence != ''")
    .get(messageId) as RecurringMessage | undefined;
  if (!msg) return false;

  try {
    const { CronExpressionParser } = await import('cron-parser');
    // [PATCH-myia #34] use the group's configured timezone (upstream replaced
    // the module-level TIMEZONE const with resolveGroupTimezone in handleRecurrence).
    const interval = CronExpressionParser.parse(msg.recurrence, { tz: resolveGroupTimezone(session.agent_group_id) });
    const nextRun = interval.next().toISOString();
    const newId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    insertRecurrence(inDb, msg, newId, nextRun);
    clearRecurrence(inDb, msg.id);

    log.warn('Auto-advanced recurring task after MAX_TRIES failure', {
      failedId: msg.id,
      newId,
      seriesId: msg.series_id,
      nextRun,
      sessionId: session.id,
    });
    return true;
  } catch (err) {
    try {
      clearRecurrence(inDb, msg.id);
    } catch (clearErr) {
      log.error('Failed to clear recurrence after MAX_TRIES failure advance error', {
        messageId: msg.id,
        err: clearErr,
      });
    }
    log.error('Failed to advance recurring task after MAX_TRIES failure', {
      messageId: msg.id,
      recurrence: msg.recurrence,
      err,
    });
    return false;
  }
}
