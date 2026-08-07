/**
 * Tests for `handleRecurrence` — specifically the timezone-aware cron
 * interpretation ported from v1 (src/v1/task-scheduler.ts).
 *
 * Core invariant: cron expressions are interpreted in the user's TIMEZONE,
 * not UTC. Without this, `"0 9 * * *"` fires at 09:00 UTC instead of 09:00
 * user-local — a recurring scheduling bug users can't diagnose.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { insertTaskRow } from './db.js';
import { advanceRecurringTaskAfterFailure, handleRecurrence, scriptBackoffMinutes } from './recurrence.js';
import type { Session } from '../../types.js';

// Pin a non-UTC zone so the tz-interpretation test is exact even on UTC CI.
// Asia/Tokyo is UTC+9 with no DST: "0 9 * * *" must land at 00:00:00Z sharp.
vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return { ...actual, TIMEZONE: 'Asia/Tokyo', GROUPS_DIR: '/tmp/nanoclaw-recurrence-test/groups' };
});

// The auto-pause note goes through the shared appendRunLog helper, which
// resolves the group folder from the central DB — mock it to a fixed folder.
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => (id === 'ag-test' ? { id, folder: 'g-test' } : undefined),
}));

// resolveGroupTimezone reads the group's config row from the central DB
// (not initialized here). Default: no override → falls back to the mocked
// install TIMEZONE; individual tests set an override to test precedence.
const containerConfigState = vi.hoisted(() => ({ timezone: null as string | null }));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: () => ({ timezone: containerConfigState.timezone }),
}));

const TEST_DIR = '/tmp/nanoclaw-recurrence-test';
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
  containerConfigState.timezone = null;
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
    insertTaskRow(db, {
      id: 'task-1',
      seriesId: 'task-1',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: '0 9 * * *', // every day at 09:00 (user TZ)
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
    insertTaskRow(db, {
      id: 'task-bad',
      seriesId: 'task-bad',
      processAfter: '2020-01-01T00:00:00.000Z',
      // Invalid: cron-parser rejects ranges where min > max ("21-5" should be
      // split into "21-23,0-5"). Real-world reproducer from Apr 30 incident.
      recurrence: '0 21-5 * * *',
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

  it('interprets the cron expression in TIMEZONE, not UTC (the v1 regression)', async () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-tz',
      seriesId: 'task-tz',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: '0 9 * * *', // 09:00 Asia/Tokyo === 00:00 UTC, exactly
      content: JSON.stringify({ prompt: 'daily digest' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-tz'`).run();

    await handleRecurrence(db, fakeSession());

    const follow = db.prepare(`SELECT process_after FROM messages_in WHERE id != 'task-tz'`).get() as {
      process_after: string;
    };
    // Drop the `{ tz }` option in recurrence.ts and this reads
    // T09:00:00 (09:00 UTC) instead — red, even on a UTC CI runner.
    expect(follow.process_after).toMatch(/T00:00:00/);
  });

  it('re-arms in the group timezone override, not the install TIMEZONE', async () => {
    // Install tz is pinned to Asia/Tokyo above; the group override must win.
    // Asia/Kolkata is UTC+5:30 with no DST: 09:00 local === 03:30 UTC, exactly.
    containerConfigState.timezone = 'Asia/Kolkata';
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-group-tz',
      seriesId: 'task-group-tz',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'daily digest' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-group-tz'`).run();

    await handleRecurrence(db, fakeSession());

    const follow = db.prepare(`SELECT process_after FROM messages_in WHERE id != 'task-group-tz'`).get() as {
      process_after: string;
    };
    expect(follow.process_after).toMatch(/T03:30:00/);
  });

  it('does not clone rows whose recurrence is already cleared', async () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-1',
      seriesId: 'task-1',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: null,
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
    insertTaskRow(db, {
      id: 'task-fail',
      seriesId: 'task-fail',
      processAfter: '2026-05-28T13:15:00.000Z',
      recurrence: '15 8-22 * * *',
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

  // [merged] PATCH #34's "preserves platform routing fields" test was dropped:
  // upstream centralized all task inserts through insertTaskRow, which hardcodes
  // platform_id/channel_type/thread_id NULL (routing is now session-derived).
  // The clone no longer carries per-row routing fields, so the assertion no
  // longer holds against the merged insert path.

  it('returns false when message id does not exist', async () => {
    const db = freshDb();
    const result = await advanceRecurringTaskAfterFailure(db, 'nope', fakeSession());
    expect(result).toBe(false);
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM messages_in`).get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('returns false and does not clone when row has no recurrence', async () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-oneshot',
      seriesId: 'task-oneshot',
      processAfter: '2026-05-28T13:00:00.000Z',
      recurrence: null,
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
    insertTaskRow(db, {
      id: 'task-badcron',
      seriesId: 'task-badcron',
      processAfter: '2026-05-28T13:00:00.000Z',
      recurrence: '0 21-5 * * *', // invalid range, repro from Apr 30
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
    insertTaskRow(db, {
      id: 'task-idem',
      seriesId: 'task-idem',
      processAfter: '2026-05-28T13:00:00.000Z',
      recurrence: '0 9 * * *',
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

describe('handleRecurrence — script-failure backoff (streak derived from failed runs)', () => {
  // A series whose last `fails` occurrences all landed as FAILED (script-skip:error
  // runs, as synced by syncProcessingAcks). Only the newest row keeps recurrence —
  // older occurrences had theirs cleared when they were re-armed. fails=0 seeds one
  // healthy completed run.
  function seedFailedStreak(db: ReturnType<typeof freshDb>, fails: number) {
    const rows = Math.max(fails, 1);
    for (let i = 0; i < rows; i++) {
      insertTaskRow(db, {
        id: `task-s-${i}`,
        seriesId: 'task-s-0',
        processAfter: '2020-01-01T00:00:00.000Z',
        recurrence: i === rows - 1 ? '* * * * *' : null, // every minute — raw cron next is ~+1min
        content: JSON.stringify({ prompt: 'monitor', script: 'exit 1' }),
      });
      db.prepare(`UPDATE messages_in SET status = ? WHERE id = ?`).run(
        fails === 0 ? 'completed' : 'failed',
        `task-s-${i}`,
      );
    }
    return `task-s-${rows - 1}`; // the row carrying recurrence
  }

  const clone = (db: ReturnType<typeof freshDb>) =>
    db.prepare(`SELECT status, process_after, recurrence FROM messages_in WHERE id NOT LIKE 'task-s-%'`).get() as {
      status: string;
      process_after: string;
      recurrence: string | null;
    };

  it('exports the documented 2,4,8,…,60 progression', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(scriptBackoffMinutes)).toEqual([2, 4, 8, 16, 32, 60, 60]);
  });

  it('pushes the clone past raw cron cadence while the script is failing', async () => {
    const db = freshDb();
    seedFailedStreak(db, 3); // streak 3 → backoff 8 min; cron next ≈ +1 min
    await handleRecurrence(db, fakeSession());

    const next = clone(db);
    expect(next.status).toBe('pending');
    const deltaMin = (new Date(next.process_after).getTime() - Date.now()) / 60_000;
    expect(deltaMin).toBeGreaterThan(7); // backoff won over the 1-min cron grid
  });

  it('a healthy series (trailing run completed) re-arms on the raw cron grid', async () => {
    const db = freshDb();
    seedFailedStreak(db, 0);
    await handleRecurrence(db, fakeSession());

    const next = clone(db);
    expect(next.status).toBe('pending');
    const deltaMin = (new Date(next.process_after).getTime() - Date.now()) / 60_000;
    expect(deltaMin).toBeLessThan(2); // no backoff applied
  });

  it('auto-pauses the series at the cap instead of re-arming', async () => {
    const db = freshDb();
    const liveId = seedFailedStreak(db, 8);
    await handleRecurrence(db, fakeSession());

    const next = clone(db);
    expect(next.status).toBe('paused'); // `ncl tasks resume` revives in place
    expect(next.recurrence).toBe('* * * * *');
    const original = db.prepare(`SELECT recurrence FROM messages_in WHERE id = ?`).get(liveId) as {
      recurrence: string | null;
    };
    expect(original.recurrence).toBeNull(); // not re-cloned next sweep
  });

  it('writes the auto-pause note into the series run log via the shared appendRunLog', async () => {
    const db = freshDb();
    seedFailedStreak(db, 8);
    await handleRecurrence(db, fakeSession());

    // Same file + format appendRunLog owns: groups/<folder>/tasks/<series>.md
    const logFile = path.join(TEST_DIR, 'groups', 'g-test', 'tasks', 'task-s-0.md');
    expect(fs.existsSync(logFile)).toBe(true);
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain('auto-paused after 8 consecutive script failures');
    expect(content).toContain('ncl tasks resume task-s-0');
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} — /m); // appendRunLog's local-time stamp
  });
});
