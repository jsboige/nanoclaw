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
import { handleRecurrence } from './recurrence.js';
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

    const row = db
      .prepare(`SELECT id, status, recurrence FROM messages_in WHERE id='task-bad'`)
      .get() as { id: string; status: string; recurrence: string | null };
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
