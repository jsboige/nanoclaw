/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live in `src/modules/scheduling/db.test.ts` with the
 * rest of the scheduling module.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import { expireAncientScheduledMessages, migrateMessagesInTable } from './session-db.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('migrateMessagesInTable', () => {
  it('backfills series_id = id on legacy rows and is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a legacy inbound.db WITHOUT series_id to simulate a pre-fix install.
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'task', datetime('now'), 'pending', '{}')",
    ).run('legacy-1', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('legacy-1') as {
      series_id: string;
    };
    expect(row.series_id).toBe('legacy-1');
    db.close();
  });
});

describe('expireAncientScheduledMessages', () => {
  function makeDb(): Database.Database {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        series_id      TEXT,
        tries          INTEGER DEFAULT 0,
        trigger        INTEGER NOT NULL DEFAULT 1,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    return db;
  }

  function insert(
    db: Database.Database,
    args: {
      id: string;
      seq: number;
      kind?: string;
      status?: string;
      processAfter?: string | null;
      recurrence?: string | null;
    },
  ): void {
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, series_id, content)
       VALUES (?, ?, ?, datetime('now'), ?, ?, ?, ?, '{}')`,
    ).run(
      args.id,
      args.seq,
      args.kind ?? 'task',
      args.status ?? 'pending',
      args.processAfter ?? null,
      args.recurrence ?? null,
      args.id,
    );
  }

  it('expires one-shot pending tasks older than the threshold', () => {
    const db = makeDb();
    // 24h ago — clearly older than a 6h cutoff
    insert(db, { id: 'stale-1', seq: 2, processAfter: '2026-04-30T00:00:00.000Z' });
    insert(db, { id: 'stale-2', seq: 4, processAfter: '2026-04-30T06:00:00.000Z' });
    // Future — must remain
    insert(db, { id: 'future-1', seq: 6, processAfter: '2099-01-01T00:00:00.000Z' });
    // Recurring — must remain even if stale
    insert(db, {
      id: 'recurring-1',
      seq: 8,
      processAfter: '2026-04-30T00:00:00.000Z',
      recurrence: '0 9 * * *',
    });
    // Chat kind — never expired by this rule (user input)
    insert(db, {
      id: 'chat-1',
      seq: 10,
      kind: 'chat',
      processAfter: '2026-04-30T00:00:00.000Z',
    });

    const cutoff = '2026-05-01T00:00:00.000Z';
    const expired = expireAncientScheduledMessages(db, cutoff);

    expect(expired.map((e) => e.id).sort()).toEqual(['stale-1', 'stale-2']);

    const statuses = db.prepare('SELECT id, status FROM messages_in ORDER BY id').all() as Array<{
      id: string;
      status: string;
    }>;
    const byId = Object.fromEntries(statuses.map((r) => [r.id, r.status]));
    expect(byId['stale-1']).toBe('expired');
    expect(byId['stale-2']).toBe('expired');
    expect(byId['future-1']).toBe('pending');
    expect(byId['recurring-1']).toBe('pending');
    expect(byId['chat-1']).toBe('pending');

    db.close();
  });

  it('returns empty array when nothing matches', () => {
    const db = makeDb();
    insert(db, { id: 'future-1', seq: 2, processAfter: '2099-01-01T00:00:00.000Z' });

    const expired = expireAncientScheduledMessages(db, '2026-05-01T00:00:00.000Z');
    expect(expired).toEqual([]);
    db.close();
  });

  it('is idempotent — re-running does not re-affect already expired rows', () => {
    const db = makeDb();
    insert(db, { id: 'stale-1', seq: 2, processAfter: '2026-04-30T00:00:00.000Z' });

    const cutoff = '2026-05-01T00:00:00.000Z';
    const first = expireAncientScheduledMessages(db, cutoff);
    expect(first).toHaveLength(1);
    const second = expireAncientScheduledMessages(db, cutoff);
    expect(second).toEqual([]);
    db.close();
  });
});
