/**
 * One-shot drain: the ClusterManager bot accumulated a massive outbound backlog
 * (5700+ messages, many duplicates from LLM emitting hundreds of identical
 * <message to=...> blocks). This happened on 2026-06-07 after a Docker restart
 * left the session in a state where the GLM model entered a production loop.
 *
 * Drain plan:
 *  1. Deduplicate outbound messages: keep the first of each unique content
 *     group, delete all duplicates. Also delete pure spam messages that have
 *     no legitimate value (e.g. hundreds of "checking health").
 *  2. Advance past-due recurring tasks to next cron slot.
 *  3. Mark stale cli-resp-* system messages 'completed'.
 *  4. Clear zombie processing_ack rows.
 *
 * Re-runnable, idempotent. Safe to run while service is stopped.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';

const SESSION_DIR = path.resolve(
  'data/v2-sessions/ag-1776992584813-k3oj0w/sess-1776993077016-7qx60e',
);
const inDb = new Database(path.join(SESSION_DIR, 'inbound.db'));
const outDb = new Database(path.join(SESSION_DIR, 'outbound.db'));
const TZ = process.env.TZ || 'Europe/Paris';
const now = new Date();
const nowIso = now.toISOString();

// ── Phase 0: Outbound dedup ──────────────────────────────────────────

// Count before
const totalBefore = (outDb.prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number }).c;
console.log(`Outbound messages before dedup: ${totalBefore}`);

// Strategy: delete all rows where there exists another row with the same content
// but a lower seq (keep the first occurrence).
const dedupResult = outDb.prepare(`
  DELETE FROM messages_out
  WHERE rowid IN (
    SELECT b.rowid
    FROM messages_out a
    JOIN messages_out b ON a.content = b.content AND a.seq < b.seq
  )
`).run();
console.log(`Outbound duplicates removed: ${dedupResult.changes}`);

// Also: for "checking health" spam, keep at most 1 per unique text
// (already handled by dedup above)

const totalAfter = (outDb.prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number }).c;
console.log(`Outbound messages after dedup: ${totalAfter}`);

// ── Phase 1: Advance past-due recurring tasks ────────────────────────

interface TaskRow {
  id: string;
  kind: string;
  content: string;
  recurrence: string;
  process_after: string | null;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  series_id: string;
}

const pastDue = inDb
  .prepare(
    "SELECT * FROM messages_in WHERE kind='task' AND status='pending' AND recurrence IS NOT NULL AND recurrence != '' AND process_after IS NOT NULL AND process_after < ?",
  )
  .all(nowIso) as TaskRow[];

console.log(`Past-due recurring tasks: ${pastDue.length}`);

function nextEvenSeq(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(seq) AS m FROM messages_in').get() as { m: number | null };
  const m = row?.m ?? 0;
  const candidate = m + 2;
  return candidate % 2 === 0 ? candidate : candidate + 1;
}

const advance = inDb.transaction((row: TaskRow) => {
  const interval = CronExpressionParser.parse(row.recurrence, { tz: TZ, currentDate: now });
  const nextRun = interval.next().toISOString();
  const newId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, platform_id, channel_type, thread_id, content, series_id)
       VALUES (?, ?, ?, datetime('now'), 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId,
      nextEvenSeq(inDb),
      row.kind,
      nextRun,
      row.recurrence,
      row.platform_id,
      row.channel_type,
      row.thread_id,
      row.content,
      row.series_id,
    );

  inDb
    .prepare(
      "UPDATE messages_in SET status='completed', recurrence=NULL WHERE id = ?",
    )
    .run(row.id);

  console.log(
    `advanced: ${row.id} (${row.recurrence}) past_due=${row.process_after} -> new=${newId} next=${nextRun}`,
  );
});

for (const row of pastDue) {
  try {
    advance(row);
  } catch (err) {
    console.error(`FAILED to advance ${row.id}:`, err);
  }
}

// ── Phase 2: Mark stale cli-resp-* completed ─────────────────────────

const staleCliResp = inDb
  .prepare(
    "UPDATE messages_in SET status='completed' WHERE kind='system' AND id LIKE 'cli-resp-%' AND status='pending'",
  )
  .run();
console.log(`cli-resp drained: ${staleCliResp.changes}`);

// ── Phase 3: Clear zombie processing_ack ──────────────────────────────

let zombieCleared = 0;
try {
  const r = outDb
    .prepare("DELETE FROM processing_ack WHERE status != 'completed'")
    .run();
  zombieCleared = r.changes;
} catch (err) {
  console.error('processing_ack cleanup error:', err);
}
console.log(`processing_ack zombies cleared: ${zombieCleared}`);

// ── Phase 4: Snapshot post-drain state ───────────────────────────────

const pending = inDb
  .prepare(
    "SELECT id, kind, status, recurrence, process_after FROM messages_in WHERE status='pending' ORDER BY process_after",
  )
  .all() as Array<Record<string, unknown>>;
console.log('\nPending after drain:');
for (const r of pending) console.log(r);

// Sample of remaining outbound
const sampleOut = outDb
  .prepare('SELECT seq, timestamp, substr(content, 1, 60) AS preview FROM messages_out ORDER BY seq DESC LIMIT 10')
  .all() as Array<Record<string, unknown>>;
console.log('\nLast 10 outbound after dedup:');
for (const r of sampleOut) console.log(r);

inDb.close();
outDb.close();

console.log('\n✅ Drain complete.');
