// One-shot fix for ClusterManager bot review-spam (12 May 2026).
// Cleans up the schedule series `task-1778156453521-1idek6` (Review PR cron):
//   1. Cancel obsolete pending row that still has the old `0,30 * * * *` recurrence
//      and the pre-dedup script.
//   2. Verify the new pending row has the new `0 8,12,16,20 * * *` recurrence + the
//      dedup-aware script.
// The new pending row was already created by the recurrence engine when we updated
// the completed row earlier; this step just neutralizes the duplicate.
import Database from 'better-sqlite3';
import path from 'node:path';

const SERIES_ID = 'task-1778156453521-1idek6';
const DB_PATH = path.resolve(
  'data/v2-sessions/ag-1776992584813-k3oj0w/sess-1776993077016-7qx60e/inbound.db'
);

const NEW_RECURRENCE = '0 8,12,16,20 * * *';

const db = new Database(DB_PATH);

console.log('=== BEFORE ===');
const before = db
  .prepare(
    `SELECT id, status, recurrence, process_after
     FROM messages_in
     WHERE series_id = ? AND status = 'pending'
     ORDER BY process_after ASC`
  )
  .all(SERIES_ID) as Array<{
  id: string;
  status: string;
  recurrence: string | null;
  process_after: string | null;
}>;
for (const r of before) {
  console.log(`  ${r.id}  ${r.status}  recurrence=${r.recurrence}  process_after=${r.process_after}`);
}

// Cancel any pending row in this series whose recurrence is NOT the new one.
const cancel = db
  .prepare(
    `UPDATE messages_in
     SET status = 'completed', recurrence = NULL
     WHERE series_id = ?
       AND kind = 'task'
       AND status = 'pending'
       AND recurrence IS NOT ?`
  )
  .run(SERIES_ID, NEW_RECURRENCE);
console.log(`\nObsolete pending rows cancelled: ${cancel.changes}`);

console.log('\n=== AFTER ===');
const after = db
  .prepare(
    `SELECT id, status, recurrence, process_after
     FROM messages_in
     WHERE series_id = ? AND status = 'pending'
     ORDER BY process_after ASC`
  )
  .all(SERIES_ID) as Array<{
  id: string;
  status: string;
  recurrence: string | null;
  process_after: string | null;
}>;
for (const r of after) {
  console.log(`  ${r.id}  ${r.status}  recurrence=${r.recurrence}  process_after=${r.process_after}`);
}

if (after.length === 1 && after[0].recurrence === NEW_RECURRENCE) {
  console.log('\nOK: exactly one pending row, with new recurrence.');
  process.exit(0);
} else {
  console.error('\nWARNING: state is not the expected single-pending-row.');
  process.exit(1);
}

db.close();
