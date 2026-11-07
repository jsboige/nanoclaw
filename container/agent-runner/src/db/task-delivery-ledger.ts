/**
 * [PATCH-myia #51] Delivery ledger for scheduled tasks (roo-extensions#3350,
 * class b: in-container double execution of the same task_id).
 *
 * A run that dies after publishing leaves the host no way to know the turn
 * already delivered: the row is reset to pending, re-claimed, re-executed,
 * and the retry re-publishes. This ledger closes that hole at the claim —
 * "this task id has a chat publication from a previous execution" is
 * recorded at the single outbound funnel (db/messages-out.ts writeMessageOut)
 * whenever a task execution is live, and the poll loop refuses to re-claim
 * task ids that already have a row.
 *
 * Attribution uses the exec state (session_state key `current_task_exec`),
 * NOT `messages_out.in_reply_to`: the reply-route stamp freezes on the
 * leading batch for the whole lifetime of a push-mode query (measured
 * 2026-11-06: publications at 15:45-16:46 all stamped with a task completed
 * at 15:15:01), so in_reply_to cannot be trusted to name the producing task.
 */
import { getAgentMailbox } from '../mailbox/index.js';

/** Upsert ledger rows: this execution (token) delivered for each task id. */
export function recordTaskDelivery(taskIds: string[], destination: string, token: string): void {
  getAgentMailbox().operations.recordTaskDelivery(taskIds, destination, token);
}

/** Which of the given task ids a previous execution already delivered. */
export function getDeliveredTaskIds(taskIds: string[]): string[] {
  if (taskIds.length === 0) return [];
  return getAgentMailbox().operations.getDeliveredTaskIds(taskIds);
}
