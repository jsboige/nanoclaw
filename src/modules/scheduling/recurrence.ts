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

import { TIMEZONE } from '../../config.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { clearRecurrence, getCompletedRecurring, insertRecurrence, type RecurringMessage } from './db.js';

export async function handleRecurrence(inDb: Database.Database, session: Session): Promise<void> {
  const recurring = getCompletedRecurring(inDb);

  for (const msg of recurring) {
    try {
      const { CronExpressionParser } = await import('cron-parser');
      // Interpret the cron expression in the user's timezone. v1 did this
      // (src/v1/task-scheduler.ts:20-49); without it, a task written "0 9 * * *"
      // by an agent running in a user's local TZ fires at 09:00 UTC instead of
      // 09:00 user-local.
      const interval = CronExpressionParser.parse(msg.recurrence, { tz: TIMEZONE });
      const nextRun = interval.next().toISOString();
      const prefix = msg.kind === 'task' ? 'task' : 'msg';
      const newId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      insertRecurrence(inDb, msg, newId, nextRun);
      clearRecurrence(inDb, msg.id);

      log.info('Inserted next recurrence', {
        originalId: msg.id,
        newId,
        seriesId: msg.series_id,
        nextRun,
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
    const interval = CronExpressionParser.parse(msg.recurrence, { tz: TIMEZONE });
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
