/**
 * Tests for `handleRecurrence` — specifically the timezone-aware cron
 * interpretation ported from v1 (src/v1/task-scheduler.ts).
 *
 * Core invariant: cron expressions are interpreted in the user's TIMEZONE,
 * not UTC. Without this, `"0 9 * * *"` fires at 09:00 UTC instead of 09:00
 * user-local — a recurring scheduling bug users can't diagnose.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { insertTask } from './db.js';
import { advanceRecurringTaskAfterFailure, handleRecurrence } from './recurrence.js';
import type { Session } from '../../types.js';

// Per-process tmp dir avoids EPERM under Windows when sibling test files hold
// open handles to the shared `/tmp/nanoclaw-recurrence-test` location.
const TEST_DIR = path.join(os.tmpdir(), `nanoclaw-recurrence-test-${process.pid}`);
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

let openDb: ReturnType<typeof openInboundDb> | null = null;

function freshDb() {
  if (openDb) {
    try {
      openDb.close();
    } catch {
      // already closed
    }
    openDb = null;
  }
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  openDb = openInboundDb(DB_PATH);
  return openDb;
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: 'mg-test',
    thread_id: null,
    status: 'active',
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    container_status: 'stopped',
  } as Session;
}

afterEach(() => {
  if (openDb) {
    try {
      openDb.close();
    } catch {
      // already closed
    }
    openDb = null;
  }
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('handleRecurrence', () => {
  it('clones a completed recurring task with a next-run in the future', async () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: '0 9 * * *', // every day at 09:00 (user TZ)
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'daily digest' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-1'`).run();

    await handleRecurrence(db, fakeSession());

    const rows = db
      .prepare(`SELECT id, status, process_after, recurrence, series_id FROM messages_in ORDER BY seq`)
      .all() as Array<{
      id: string;
      status: string;
      process_after: string;
      recurrence: string | null;
      series_id: string;
    }>;
    expect(rows).toHaveLength(2);
    const original = rows.find((r) => r.id === 'task-1')!;
    const follow = rows.find((r) => r.id !== 'task-1')!;
    expect(original.recurrence).toBeNull();
    expect(follow.status).toBe('pending');
    expect(follow.recurrence).toBe('0 9 * * *');
    expect(follow.series_id).toBe('task-1');
    expect(new Date(follow.process_after).getTime()).toBeGreaterThan(Date.now());
  });

  it('clears recurrence when cron expression is malformed (no infinite re-error)', async () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-bad',
      processAfter: '2020-01-01T00:00:00.000Z',
      // Invalid: cron-parser rejects ranges where min > max ("21-5" should be
      // split into "21-23,0-5"). Real-world reproducer from Apr 30 incident.
      recurrence: '0 21-5 * * *',
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'night shift' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-bad'`).run();

    await handleRecurrence(db, fakeSession());

    const row = db.prepare(`SELECT id, status, recurrence FROM messages_in WHERE id='task-bad'`).get() as {
      id: string;
      status: string;
      recurrence: string | null;
    };
    // Recurrence cleared so the next tick won't pick this row up again.
    expect(row.recurrence).toBeNull();
    // No follow-up row created — recurrence was unparseable.
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM messages_in`).get() as { c: number }).c;
    expect(count).toBe(1);

    // Idempotent: a second tick should be a no-op.
    await handleRecurrence(db, fakeSession());
    const countAfter = (db.prepare(`SELECT COUNT(*) AS c FROM messages_in`).get() as { c: number }).c;
    expect(countAfter).toBe(1);
  });

  it('does not clone rows whose recurrence is already cleared', async () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'one-off' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-1'`).run();

    await handleRecurrence(db, fakeSession());

    const count = (db.prepare(`SELECT COUNT(*) AS c FROM messages_in`).get() as { c: number }).c;
    expect(count).toBe(1);
  });
});

describe('advanceRecurringTaskAfterFailure', () => {
  // Regression: 2026-05-28. ClusterManager cron series `15 8-22 * * *` and
  // `30 8-22 * * *` both went silent after their `messages_in` rows hit
  // status='failed' with tries=5 from stall retries. handleRecurrence's
  // `status='completed'` filter skipped them forever — series dead. The
  // safety net advances the series even when the row failed.

  it('enqueues next instance and clears recurrence on the failed row', async () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-fail',
      processAfter: '2026-05-28T13:15:00.000Z',
      recurrence: '15 8-22 * * *',
      platformId: 'tg-123',
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({ prompt: 'cron review' }),
    });
    db.prepare(`UPDATE messages_in SET status='failed', tries=5 WHERE id='task-fail'`).run();

    const result = await advanceRecurringTaskAfterFailure(db, 'task-fail', fakeSession());

    expect(result).toBe(true);

    const rows = db
      .prepare(`SELECT id, status, process_after, recurrence, series_id FROM messages_in ORDER BY seq`)
      .all() as Array<{
      id: string;
      status: string;
      process_after: string;
      recurrence: string | null;
      series_id: string;
    }>;
    expect(rows).toHaveLength(2);

    const failed = rows.find((r) => r.id === 'task-fail')!;
    const next = rows.find((r) => r.id !== 'task-fail')!;

    // Failed row keeps status='failed' for audit; recurrence cleared so the
    // safety net + handleRecurrence both skip it on future ticks.
    expect(failed.status).toBe('failed');
    expect(failed.recurrence).toBeNull();

    // Next instance carries the series forward, pending, with same cron.
    expect(next.status).toBe('pending');
    expect(next.recurrence).toBe('15 8-22 * * *');
    expect(next.series_id).toBe('task-fail');
    expect(new Date(next.process_after).getTime()).toBeGreaterThan(Date.now());
  });

  it('preserves platform routing fields on the cloned row', async () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-route',
      processAfter: '2026-05-28T13:30:00.000Z',
      recurrence: '30 8-22 * * *',
      platformId: 'slack-C0',
      channelType: 'slack',
      threadId: 'thread-99',
      content: JSON.stringify({ prompt: 'second cron' }),
    });
    db.prepare(`UPDATE messages_in SET status='failed', tries=5 WHERE id='task-route'`).run();

    await advanceRecurringTaskAfterFailure(db, 'task-route', fakeSession());

    const next = db
      .prepare(`SELECT platform_id, channel_type, thread_id, content FROM messages_in WHERE id != 'task-route'`)
      .get() as {
      platform_id: string;
      channel_type: string;
      thread_id: string;
      content: string;
    };
    expect(next.platform_id).toBe('slack-C0');
    expect(next.channel_type).toBe('slack');
    expect(next.thread_id).toBe('thread-99');
    expect(JSON.parse(next.content)).toEqual({ prompt: 'second cron' });
  });

  it('returns false when message id does not exist', async () => {
    const db = freshDb();
    const result = await advanceRecurringTaskAfterFailure(db, 'nope', fakeSession());
    expect(result).toBe(false);
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM messages_in`).get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('returns false and does not clone when row has no recurrence', async () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-oneshot',
      processAfter: '2026-05-28T13:00:00.000Z',
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'one-shot' }),
    });
    db.prepare(`UPDATE messages_in SET status='failed', tries=5 WHERE id='task-oneshot'`).run();

    const result = await advanceRecurringTaskAfterFailure(db, 'task-oneshot', fakeSession());

    expect(result).toBe(false);
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM messages_in`).get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('clears recurrence on malformed cron (no infinite re-error from safety net)', async () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-badcron',
      processAfter: '2026-05-28T13:00:00.000Z',
      recurrence: '0 21-5 * * *', // invalid range, repro from Apr 30
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'night shift' }),
    });
    db.prepare(`UPDATE messages_in SET status='failed', tries=5 WHERE id='task-badcron'`).run();

    const result = await advanceRecurringTaskAfterFailure(db, 'task-badcron', fakeSession());

    expect(result).toBe(false);
    const row = db.prepare(`SELECT recurrence FROM messages_in WHERE id='task-badcron'`).get() as {
      recurrence: string | null;
    };
    expect(row.recurrence).toBeNull();

    // No clone produced for unparseable cron.
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM messages_in`).get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('is idempotent — second call on the same failed id is a no-op (recurrence already cleared)', async () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-idem',
      processAfter: '2026-05-28T13:00:00.000Z',
      recurrence: '0 9 * * *',
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'idempotent' }),
    });
    db.prepare(`UPDATE messages_in SET status='failed', tries=5 WHERE id='task-idem'`).run();

    await advanceRecurringTaskAfterFailure(db, 'task-idem', fakeSession());
    const countAfterFirst = (db.prepare(`SELECT COUNT(*) AS c FROM messages_in`).get() as { c: number }).c;
    expect(countAfterFirst).toBe(2);

    const result = await advanceRecurringTaskAfterFailure(db, 'task-idem', fakeSession());
    expect(result).toBe(false);
    const countAfterSecond = (db.prepare(`SELECT COUNT(*) AS c FROM messages_in`).get() as { c: number }).c;
    expect(countAfterSecond).toBe(2);
  });
});
