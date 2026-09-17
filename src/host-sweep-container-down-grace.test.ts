/**
 * Integration regression test for #3350 (Option A): the container-not-running
 * stuck reset must not fire on a single registry false negative.
 *
 * Drives the real sweep loop (startHostSweep) against a real central DB and
 * real on-disk session DBs, mocking only the container runner. The wake mock
 * resolves successfully but NEVER registers the container as running — the
 * registry false negative that replayed live tour envelopes into twin
 * containers (two TOUR posts on the same cron slot, 23/08 + 31/08 + 10
 * recurrences). Controls:
 *   - negative: a claim within CONTAINER_DOWN_GRACE_MS survives any number
 *     of consecutive negative sweeps (the old code reset it on tick 1);
 *   - positive: once the claim is past the grace, the FIRST tick only arms
 *     and the SECOND consecutive negative tick resets (backoff retry +
 *     orphan-claim cleanup still work — the gate must not become a stall);
 *   - disarm: a probe that sees the container running breaks the negative
 *     streak, so the next negative probe arms again instead of confirming.
 * Goes red if the grace gate in maintainSessionMailbox stops being consulted
 * on the `!alive` path, or if it starts resetting on the first probe.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Override DATA_DIR for tests
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-host-sweep-condown-grace' };
});

// Mock container runner to prevent actual Docker spawning. wakeContainer
// resolves true but does NOT flip isContainerRunning — the running-container
// registry keeps reporting "not running" even though the wake "succeeded",
// which is the false-negative shape this gate exists for.
vi.mock('./container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn().mockReturnValue(false),
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
}));

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { createSession } from './db/sessions.js';
import { isContainerRunning, killContainer } from './container-runner.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { _resetContainerDownTrackingForTesting, CONTAINER_DOWN_GRACE_MS } from './reconcile-session.js';
import { heartbeatPath, initSessionFolder, writeSessionMessage } from './session-manager.js';
import { outboundDbPath, inboundDbPath } from './mailbox/sqlite/paths.js';

const TEST_DIR = '/tmp/nanoclaw-test-host-sweep-condown-grace';
const AG = 'ag-test';
const SESS = 'sess-test';
// Mirrors SWEEP_INTERVAL_MS in host-sweep.ts — identifies the sweep's
// self-reschedule among other setTimeout calls (e.g. vi.waitFor's polling).
const SWEEP_INTERVAL_MS = 60_000;

function now(): string {
  return new Date().toISOString();
}

function seedClaim(messageId: string, ageMs: number): void {
  const db = new Database(outboundDbPath(AG, SESS));
  db.prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', ?)").run(
    messageId,
    new Date(Date.now() - ageMs).toISOString(),
  );
  db.close();
}

function claimsCount(): number {
  const db = new Database(outboundDbPath(AG, SESS));
  const rows = db.prepare("SELECT COUNT(*) as count FROM processing_ack WHERE status = 'processing'").get() as {
    count: number;
  };
  db.close();
  return rows.count;
}

function messageRow(messageId: string): { status: string; tries: number; process_after: string | null } {
  const db = new Database(inboundDbPath(AG, SESS));
  const row = db.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get(messageId) as {
    status: string;
    tries: number;
    process_after: string | null;
  };
  db.close();
  return row;
}

/** Touch the heartbeat so the running-container SLA (voie A) sees fresh life and never kills on an inherited old claim. */
function touchHeartbeat(): void {
  fs.writeFileSync(heartbeatPath(AG, SESS), String(Date.now()));
}

/**
 * The sweep loop signals tick completion by rescheduling itself via
 * setTimeout(sweep, SWEEP_INTERVAL_MS). Capture those callbacks instead of
 * scheduling them, so each tick ends inert and the test drives the next tick
 * explicitly. All other setTimeout calls pass through untouched.
 */
const sweepCallbacks: Array<() => void> = [];
const realSetTimeout = global.setTimeout;
let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

/** Run exactly one sweep tick and wait for it to complete. */
async function runSweepTick(): Promise<void> {
  const before = sweepCallbacks.length;
  if (before === 0) {
    startHostSweep();
  } else {
    // Invoke the captured self-reschedule — the real next-tick path.
    sweepCallbacks[before - 1]();
  }
  // Explicit generous timeout: on a cold start the first tick pays for the
  // central-DB migrations and the first mailbox session open, which can
  // exceed vi.waitFor's 1s default (observed flake on Windows runners).
  await vi.waitFor(
    () => {
      expect(sweepCallbacks.length).toBe(before + 1);
    },
    { timeout: 10_000 },
  );
}

function rmTestDir(): void {
  // Windows: SQLite handles close asynchronously enough that an immediate
  // recursive delete can hit EBUSY — retry instead of cascading into the
  // next test's setup.
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, maxRetries: 5, retryDelay: 100 });
}

beforeEach(async () => {
  vi.mocked(isContainerRunning).mockReset().mockReturnValue(false);
  vi.mocked(killContainer).mockReset();
  _resetContainerDownTrackingForTesting();

  sweepCallbacks.length = 0;
  setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === SWEEP_INTERVAL_MS) {
      sweepCallbacks.push(fn);
      return 0 as unknown as NodeJS.Timeout;
    }
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout);

  rmTestDir();
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: AG, name: 'Test Agent', folder: 'test-agent', agent_provider: null, created_at: now() });
  await createSession({
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder(AG, SESS);

  // A due message (claimed by a container the registry can no longer see)
  // plus the claim itself — the twin setup. messages_in stays 'pending'
  // while processing; only processing_ack moved to 'processing'.
  await writeSessionMessage(AG, SESS, { id: 'm-1', kind: 'chat', timestamp: now(), content: '{"text":"hi"}' });
});

afterEach(async () => {
  stopHostSweep();
  setTimeoutSpy.mockRestore();
  await closeDb();
  rmTestDir();
});

describe('host sweep container-down grace gate (#3350 Option A)', () => {
  it('negative control: a claim within the grace survives consecutive negative sweeps', async () => {
    seedClaim('m-1', 30_000); // claimed 30s ago — a live, young turn

    await runSweepTick();
    expect(claimsCount()).toBe(1); // old code reset here — the twin replay
    expect(messageRow('m-1').tries).toBe(0);

    await runSweepTick();
    expect(claimsCount()).toBe(1);
    expect(messageRow('m-1').tries).toBe(0);

    await runSweepTick();
    expect(claimsCount()).toBe(1);
    expect(messageRow('m-1').tries).toBe(0);
    expect(messageRow('m-1').process_after).toBeNull();
    expect(killContainer).not.toHaveBeenCalled();
  });

  it('positive control: past the grace, the first tick arms and the second resets', async () => {
    seedClaim('m-1', 2 * 60 * 60 * 1000); // claimed 2h ago — a genuine orphan

    // Tick 1: first consecutive negative probe — arm only, even for a 2h-old
    // claim. The double-probe requirement holds regardless of claim age.
    await runSweepTick();
    expect(claimsCount()).toBe(1);

    // Tick 2: second consecutive negative probe + claim past grace → reset.
    await runSweepTick();
    expect(claimsCount()).toBe(0); // orphan claim dropped
    const row = messageRow('m-1');
    expect(row.tries).toBe(1); // retried with backoff
    expect(row.process_after).not.toBeNull();
    expect(killContainer).not.toHaveBeenCalled(); // voie B never kills
  });

  it('disarm: a probe seeing the container run breaks the negative streak', async () => {
    seedClaim('m-1', 2 * 60 * 60 * 1000);
    // Keep voie A quiet on the alive tick: a fresh heartbeat postdates the
    // inherited claim, so the running-container SLA sees signs of life and
    // does not kill (this test is about the voie B streak, not voie A).
    touchHeartbeat();

    // Tick 1: negative probe — arm.
    await runSweepTick();
    expect(claimsCount()).toBe(1);

    // Tick 2: the registry sees the container running — streak cleared.
    vi.mocked(isContainerRunning).mockReturnValue(true);
    await runSweepTick();
    expect(killContainer).not.toHaveBeenCalled();
    vi.mocked(isContainerRunning).mockReturnValue(false);

    // Tick 3: negative again — this is a FIRST probe of a new streak, not a
    // confirming one. Had the alive tick failed to clear the streak, the
    // 2h-old claim would reset right here.
    await runSweepTick();
    expect(claimsCount()).toBe(1);
    expect(messageRow('m-1').tries).toBe(0);

    // Tick 4: second consecutive negative of the new streak → reset.
    await runSweepTick();
    expect(claimsCount()).toBe(0);
    expect(messageRow('m-1').tries).toBe(1);
  });

  it('exposes the retained threshold for fleet tuning', () => {
    // Option A mandates the chosen threshold be exposed; pin it so any
    // change is a deliberate, reviewed edit.
    expect(CONTAINER_DOWN_GRACE_MS).toBe(90 * 1000);
  });
});
