// One-shot: advance the pending Review PR task to fire now.
// Companion to the audit-script JSON fix (2026-05-26).
import Database from 'better-sqlite3';
import path from 'node:path';

const DB_PATH = path.resolve(
  'data/v2-sessions/ag-1776992584813-k3oj0w/sess-1776993077016-7qx60e/inbound.db'
);
const TASK_ID = 'task-1779818855501-rgv0v1';

const db = new Database(DB_PATH);

const before = db
  .prepare('SELECT id, status, process_after, recurrence FROM messages_in WHERE id = ?')
  .get(TASK_ID);
console.log('BEFORE:', before);

const now = new Date().toISOString();
const res = db
  .prepare("UPDATE messages_in SET process_after = ? WHERE id = ? AND status = 'pending'")
  .run(now, TASK_ID);
console.log(`rows updated: ${res.changes}`);

const after = db
  .prepare('SELECT id, status, process_after, recurrence FROM messages_in WHERE id = ?')
  .get(TASK_ID);
console.log('AFTER:', after);

db.close();
