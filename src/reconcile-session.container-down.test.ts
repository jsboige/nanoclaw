/**
 * Unit tests for the container-not-running grace gate (#3350, Option A).
 *
 * The `!alive` branch of maintainSessionMailbox used to reset 'processing'
 * rows on the FIRST negative probe of the running-container registry. A
 * single false negative (host restart while the container survived, adoption
 * race) then replayed a live turn envelope into a second container — the
 * twin TOUR posts of the #3350 episodes. Option A gates that reset behind
 * two conditions: two consecutive negative probes, and every claim older
 * than CONTAINER_DOWN_GRACE_MS. The pure decision (decideContainerDownReset)
 * is tested boundary-exact; the probe seam (_containerDownProbeForTesting)
 * is driven against real sqlite mailboxes for the positive/negative controls.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  CONTAINER_DOWN_GRACE_MS,
  _containerDownProbeForTesting,
  _resetContainerDownTrackingForTesting,
  decideContainerDownReset,
} from './reconcile-session.js';
import type { Session } from './types.js';
import { wrapSqliteInbound, wrapSqliteOutbound } from './mailbox/sqlite/index.js';

const BASE = Date.parse('2026-09-14T03:00:00.000Z');
const JUST_WITHIN_GRACE_MS = CONTAINER_DOWN_GRACE_MS - 1;
const JUST_OVER_GRACE_MS = CONTAINER_DOWN_GRACE_MS + 1;

function claim(id: string, offsetMs: number) {
  return { messageId: id, statusChanged: new Date(BASE - offsetMs).toISOString() };
}

describe('decideContainerDownReset', () => {
  it('arms on the first negative probe regardless of claim age', () => {
    // Even a 2h-old claim must not reset on a lone negative probe — that
    // single-probe reset is exactly the #3350 twin mechanism.
    expect(
      decideContainerDownReset({
        now: BASE,
        firstNegativeAtMs: null,
        claims: [claim('msg-1', 2 * 60 * 60 * 1000)],
      }),
    ).toEqual({ action: 'arm' });
  });

  it('waits on the confirming probe while a claim is within the grace', () => {
    expect(
      decideContainerDownReset({
        now: BASE,
        firstNegativeAtMs: BASE - 60_000,
        claims: [claim('msg-1', JUST_WITHIN_GRACE_MS)],
      }),
    ).toEqual({ action: 'wait' });
  });

  it('waits when a claim is exactly at the grace boundary — age must exceed the threshold', () => {
    expect(
      decideContainerDownReset({
        now: BASE,
        firstNegativeAtMs: BASE - 60_000,
        claims: [claim('msg-1', CONTAINER_DOWN_GRACE_MS)],
      }),
    ).toEqual({ action: 'wait' });
  });

  it('resets on the confirming probe once every claim is past the grace', () => {
    expect(
      decideContainerDownReset({
        now: BASE,
        firstNegativeAtMs: BASE - 60_000,
        claims: [claim('msg-1', JUST_OVER_GRACE_MS)],
      }),
    ).toEqual({ action: 'reset' });
  });

  it('resets with several claims when all are past the grace', () => {
    expect(
      decideContainerDownReset({
        now: BASE,
        firstNegativeAtMs: BASE - 60_000,
        claims: [claim('msg-1', JUST_OVER_GRACE_MS), claim('msg-2', 10 * 60 * 1000)],
      }),
    ).toEqual({ action: 'reset' });
  });

  it('waits when any claim is still within the grace — no partial replay', () => {
    // All-or-nothing: a young live claim shields the batch, so the reset
    // never requeues a claim that may still be actively processed.
    expect(
      decideContainerDownReset({
        now: BASE,
        firstNegativeAtMs: BASE - 60_000,
        claims: [claim('msg-1', 10 * 60 * 1000), claim('msg-2', 5_000)],
      }),
    ).toEqual({ action: 'wait' });
  });

  it('waits when there are no claims to reset', () => {
    expect(
      decideContainerDownReset({
        now: BASE,
        firstNegativeAtMs: BASE - 60_000,
        claims: [],
      }),
    ).toEqual({ action: 'wait' });
  });

  it('waits on an unparseable claim timestamp — unknown age is not evidence of an orphan', () => {
    expect(
      decideContainerDownReset({
        now: BASE,
        firstNegativeAtMs: BASE - 60_000,
        claims: [{ messageId: 'msg-1', statusChanged: 'not-a-date' }],
      }),
    ).toEqual({ action: 'wait' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Probe-seam controls (real sqlite mailboxes, deterministic clock)
// ─────────────────────────────────────────────────────────────────────────────

function makeSessionDbs() {
  const rawIn = new Database(':memory:');
  rawIn.exec(`
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      kind          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      process_after TEXT,
      recurrence    TEXT,
      series_id     TEXT,
      tries         INTEGER DEFAULT 0,
      trigger       INTEGER NOT NULL DEFAULT 1,
      platform_id   TEXT,
      channel_type  TEXT,
      thread_id     TEXT,
      content       TEXT NOT NULL
    );
  `);
  const rawOut = new Database(':memory:');
  rawOut.exec(`
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
  `);
  return {
    inDb: Object.assign(wrapSqliteInbound(rawIn), { prepare: rawIn.prepare.bind(rawIn) }),
    outDb: Object.assign(wrapSqliteOutbound(rawOut), { prepare: rawOut.prepare.bind(rawOut) }),
  };
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

/** Seed one claimed message: pending inbound row + 'processing' ack row, claimed `ageMs` before `now`. */
function seedClaim(dbs: ReturnType<typeof makeSessionDbs>, id: string, seq: number, now: number, ageMs: number): void {
  const claimedAt = new Date(now - ageMs).toISOString();
  dbs.inDb
    .prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', ?, 'pending', '{}')",
    )
    .run(id, seq, claimedAt);
  dbs.outDb.prepare("INSERT INTO processing_ack VALUES (?, 'processing', ?)").run(id, claimedAt);
}

function messageRow(dbs: ReturnType<typeof makeSessionDbs>, id: string) {
  return dbs.inDb.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get(id) as {
    status: string;
    tries: number;
    process_after: string | null;
  };
}

describe('voie-B probe seam — positive/negative controls', () => {
  beforeEach(() => {
    _resetContainerDownTrackingForTesting();
  });

  it('negative control: a single negative probe never resets, even a 2h-old claim', () => {
    const dbs = makeSessionDbs();
    seedClaim(dbs, 'm-1', 1, BASE, 2 * 60 * 60 * 1000);

    _containerDownProbeForTesting(dbs.inDb, dbs.outDb, fakeSession(), BASE);

    expect(dbs.outDb.getProcessingClaims()).toHaveLength(1); // ack survived
    expect(messageRow(dbs, 'm-1').tries).toBe(0); // message untouched
  });

  it('negative control: consecutive probes with a young claim stay deferred', () => {
    const dbs = makeSessionDbs();
    seedClaim(dbs, 'm-1', 1, BASE, 30_000);

    _containerDownProbeForTesting(dbs.inDb, dbs.outDb, fakeSession(), BASE);
    _containerDownProbeForTesting(dbs.inDb, dbs.outDb, fakeSession(), BASE + 30_000);
    _containerDownProbeForTesting(dbs.inDb, dbs.outDb, fakeSession(), BASE + 60_000);

    expect(dbs.outDb.getProcessingClaims()).toHaveLength(1);
    expect(messageRow(dbs, 'm-1').tries).toBe(0);
  });

  it('positive control: second consecutive probe with the claim past grace resets with backoff', () => {
    const dbs = makeSessionDbs();
    seedClaim(dbs, 'm-1', 1, BASE, CONTAINER_DOWN_GRACE_MS + 10_000);

    _containerDownProbeForTesting(dbs.inDb, dbs.outDb, fakeSession(), BASE); // arm
    _containerDownProbeForTesting(dbs.inDb, dbs.outDb, fakeSession(), BASE + 60_000); // confirm + past grace

    expect(dbs.outDb.getProcessingClaims()).toEqual([]); // orphan claim dropped
    const row = messageRow(dbs, 'm-1');
    expect(row.tries).toBe(1); // retried with backoff
    expect(row.process_after).not.toBeNull();
  });

  it('does not double-reset: the post-reset probe sequence re-arms from scratch', () => {
    const dbs = makeSessionDbs();
    seedClaim(dbs, 'm-1', 1, BASE, CONTAINER_DOWN_GRACE_MS + 10_000);

    _containerDownProbeForTesting(dbs.inDb, dbs.outDb, fakeSession(), BASE);
    _containerDownProbeForTesting(dbs.inDb, dbs.outDb, fakeSession(), BASE + 60_000); // reset happened
    _containerDownProbeForTesting(dbs.inDb, dbs.outDb, fakeSession(), BASE + 120_000); // no claims → wait

    expect(dbs.outDb.getProcessingClaims()).toEqual([]);
    expect(messageRow(dbs, 'm-1').tries).toBe(1); // not bumped a second time
  });

  it('a positive probe between negatives breaks the streak (disarm)', () => {
    // The seam covers the negative branch only; the disarm itself is
    // containerDownSince.delete on the alive branch. What this test pins is
    // the consequence visible through the seam: after a streak break the
    // next negative probe is a first probe again — with a past-grace claim
    // it arms instead of resetting.
    const dbs = makeSessionDbs();
    seedClaim(dbs, 'm-1', 1, BASE, CONTAINER_DOWN_GRACE_MS + 10_000);

    _containerDownProbeForTesting(dbs.inDb, dbs.outDb, fakeSession(), BASE); // arm
    // (streak cleared here by the alive branch in production)
    _resetContainerDownTrackingForTesting();
    _containerDownProbeForTesting(dbs.inDb, dbs.outDb, fakeSession(), BASE + 60_000); // first probe again

    expect(dbs.outDb.getProcessingClaims()).toHaveLength(1); // not reset
    expect(messageRow(dbs, 'm-1').tries).toBe(0);
  });
});
