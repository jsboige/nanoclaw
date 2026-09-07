/**
 * task_run_logs — execution history for scheduled tasks.
 *
 * Restores the v1 surface (`store/messages.db.task_run_logs`) lost in the
 * v2 rewrite. One row per occurrence of a task message processed by the
 * container. `task_id` is the message id; `series_id` ties recurring
 * occurrences together (matches the v2 messages_in.series_id semantics).
 *
 * Facade over the mailbox seam: the SQL lives in the sqlite driver
 * (mailbox/sqlite/index.ts) so src/db/ holds no raw DB access — the
 * architecture test greps this directory. See the poll-loop for write call
 * sites.
 */
import { listTaskRuns, recordTaskRun } from '../mailbox/sqlite/index.js';

export type { TaskRunLog } from '../mailbox/sqlite/index.js';

export type RecordTaskRunInput = {
  task_id: string;
  series_id?: string | null;
  run_at: string;
  duration_ms: number;
  status: 'completed' | 'failed' | 'skipped';
  result?: string | null;
  error?: string | null;
};

export type ListTaskRunsOptions = {
  taskOrSeriesId?: string;
  limit?: number;
};

export { listTaskRuns };
export { recordTaskRun };
