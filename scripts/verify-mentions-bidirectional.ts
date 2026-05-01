/**
 * Bidirectional mentions intercom — autonomous wake-chain smoke test.
 *
 * Purpose: prove the dashboard-mention → bot-wake chain works end-to-end
 * WITHOUT a human in the loop. The session-2026-05-01 verification relied
 * on an interactive Claude Code session reading the dashboard, which does
 * not exercise the autonomous worker path. This script does.
 *
 * Chain under test:
 *
 *   1. Write a RooSync inbox file under ${SHARED}/messages/inbox/
 *      with `to: "nanoclaw:agent"` (a target the standalone watcher accepts
 *      via ROOSYNC_INBOX_EXTRA_TARGETS — see src/roosync-inbox-standalone.ts)
 *   2. Standalone watcher detects, writes IPC payload to
 *      data/ipc/telegram_main/messages/roosync-<id>.json
 *   3. Host IPC consumer reads the IPC file, injects a synthetic message
 *      into the bot session's inbound.db
 *   4. Host wake path spawns the bot container if not already running
 *   5. Container processes the synthetic message — outbound.db gains a row
 *
 * The script blocks at each stage with a timeout. On success, prints
 * timing breakdown. On failure, points to the broken hop. Cleans up its
 * own test row even on failure.
 *
 * NOT covered (limitation): the FULL dashboard MCP layer above step 1.
 * Posting via roosync_dashboard with mentions[] is what triggers the
 * inbox file write — this script skips that and writes the file
 * directly. Test the dashboard MCP layer separately if/when needed.
 *
 * Usage:
 *   pnpm exec tsx scripts/verify-mentions-bidirectional.ts
 *
 * Exit code 0 = all hops passed, 1 = at least one hop failed.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../src/env.js';

const env = readEnvFile([
  'ROOSYNC_SHARED_PATH',
  'ROOSYNC_INBOX_EXTRA_TARGETS',
  'ROOSYNC_INBOX_IPC_GROUP_FOLDER',
]);

const SHARED = process.env.ROOSYNC_SHARED_PATH || env.ROOSYNC_SHARED_PATH || '';
const EXTRA_TARGETS_RAW = process.env.ROOSYNC_INBOX_EXTRA_TARGETS || env.ROOSYNC_INBOX_EXTRA_TARGETS || '';
const IPC_GROUP_FOLDER = process.env.ROOSYNC_INBOX_IPC_GROUP_FOLDER || env.ROOSYNC_INBOX_IPC_GROUP_FOLDER || 'telegram_main';
const DATA_DIR = path.resolve(process.cwd(), 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'v2-sessions');
const CENTRAL_DB = path.join(DATA_DIR, 'v2.db');

const STAGE_TIMEOUTS_MS = {
  ipcWrite: 30_000, // standalone watcher polls every 15s
  inboundInject: 60_000, // host IPC consumer polls every ~5s, plus DB write
  outboundResponse: 180_000, // bot wake (container spawn cold start) + processing
};
const POLL_INTERVAL_MS = 1_000;

function logLine(stage: string, msg: string, extra?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    stage,
    msg,
    ...(extra ?? {}),
  });
  process.stdout.write(line + '\n');
}

function pickTarget(): string {
  const all = EXTRA_TARGETS_RAW.split(',')
    .map((s) => s.trim())
    .filter((s) => s.includes(':'));
  if (all.length === 0) {
    throw new Error('ROOSYNC_INBOX_EXTRA_TARGETS empty — bot identity not configured');
  }
  // Prefer "nanoclaw:agent" — that's what the bot inside the container signs as
  return all.find((t) => t === 'nanoclaw:agent') ?? all[0];
}

function pickActiveBotSession(): { agentGroupId: string; sessionId: string } {
  if (!fs.existsSync(CENTRAL_DB)) {
    throw new Error(`Central DB not found at ${CENTRAL_DB} — host not running?`);
  }
  const db = new Database(CENTRAL_DB, { readonly: true });
  try {
    const row = db
      .prepare("SELECT id, agent_group_id FROM sessions WHERE status = 'active' ORDER BY last_active DESC LIMIT 1")
      .get() as { id: string; agent_group_id: string } | undefined;
    if (!row) {
      throw new Error('No active session in central DB');
    }
    return { agentGroupId: row.agent_group_id, sessionId: row.id };
  } finally {
    db.close();
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(
  label: string,
  timeoutMs: number,
  check: () => T | null,
): Promise<{ ok: true; value: T; elapsedMs: number } | { ok: false; elapsedMs: number }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const got = check();
      if (got !== null && got !== undefined) {
        return { ok: true, value: got, elapsedMs: Date.now() - start };
      }
    } catch (err) {
      logLine(label, 'check threw, continuing', { err: err instanceof Error ? err.message : String(err) });
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, elapsedMs: Date.now() - start };
}

async function main(): Promise<number> {
  if (!SHARED) {
    logLine('config', 'ROOSYNC_SHARED_PATH not set — cannot test', { fatal: true });
    return 1;
  }

  const target = pickTarget();
  const session = pickActiveBotSession();
  const sessionDir = path.join(SESSIONS_DIR, session.agentGroupId, session.sessionId);
  const inboundDbPath = path.join(sessionDir, 'inbound.db');
  const outboundDbPath = path.join(sessionDir, 'outbound.db');

  if (!fs.existsSync(inboundDbPath)) {
    logLine('config', 'Bot session inbound.db not found', { path: inboundDbPath, fatal: true });
    return 1;
  }

  // Unique marker for this run — embedded in the message body so we can find
  // it again at every stage without ambiguity.
  const marker = `verify-mentions-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inboxId = `msg-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${marker}`;
  const inboxFile = path.join(SHARED, 'messages', 'inbox', `${inboxId}.json`);
  const ipcDir = path.join(DATA_DIR, 'ipc', IPC_GROUP_FOLDER, 'messages');

  logLine('config', 'starting', {
    target,
    sessionId: session.sessionId,
    agentGroupId: session.agentGroupId,
    marker,
    inboxFile,
    ipcDir,
  });

  // ── Stage 0: write the inbox file ──
  const payload = {
    id: inboxId,
    from: 'verify-mentions-script:nanoclaw',
    to: target,
    subject: '[VERIF] bidirectional mentions smoke test',
    body: `Smoke test from scripts/verify-mentions-bidirectional.ts.\n\nMarker: ${marker}\n\nIf you receive this, please ignore — it's an automated wake-chain test, not a real ask.`,
    tags: ['VERIF', 'TEST'],
    timestamp: new Date().toISOString(),
    priority: 'low',
    status: 'unread',
  };

  fs.mkdirSync(path.dirname(inboxFile), { recursive: true });
  fs.writeFileSync(inboxFile, JSON.stringify(payload, null, 2));
  logLine('stage-0', 'inbox file written', { inboxFile });

  let ok = true;
  const cleanup = () => {
    // Move test inbox file to the corrupt archive's sibling 'test' dir so it
    // doesn't pollute the inbox if any stage fails. If the standalone watcher
    // already processed and removed the file, this no-ops.
    if (fs.existsSync(inboxFile)) {
      const testArchive = path.join(SHARED, 'messages', 'inbox', '.archive', 'test');
      try {
        fs.mkdirSync(testArchive, { recursive: true });
        fs.renameSync(inboxFile, path.join(testArchive, path.basename(inboxFile)));
        logLine('cleanup', 'inbox file archived', { dest: testArchive });
      } catch (err) {
        logLine('cleanup', 'inbox archive failed (manual cleanup may be needed)', {
          inboxFile,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  // ── Stage 1: standalone watcher writes IPC file ──
  const ipcResult = await pollUntil('stage-1', STAGE_TIMEOUTS_MS.ipcWrite, () => {
    if (!fs.existsSync(ipcDir)) return null;
    const found = fs.readdirSync(ipcDir).find((f) => f.includes(inboxId));
    return found ? path.join(ipcDir, found) : null;
  });

  if (!ipcResult.ok) {
    logLine('stage-1', 'TIMEOUT — standalone watcher did not write IPC file', {
      timeoutMs: STAGE_TIMEOUTS_MS.ipcWrite,
      elapsedMs: ipcResult.elapsedMs,
      hint: 'Is the standalone watcher running? Check Scheduled Task "RooSync-Inbox-Watcher" + logs/roosync-inbox-standalone.log',
    });
    ok = false;
  } else {
    logLine('stage-1', 'OK — standalone watcher wrote IPC file', {
      ipcFile: ipcResult.value,
      elapsedMs: ipcResult.elapsedMs,
    });
  }

  // ── Stage 2: host IPC consumer injects synthetic message ──
  if (ok) {
    const inboundResult = await pollUntil('stage-2', STAGE_TIMEOUTS_MS.inboundInject, () => {
      const db = new Database(inboundDbPath, { readonly: true });
      try {
        const row = db
          .prepare("SELECT id, status FROM messages_in WHERE content LIKE ? AND status != 'expired' LIMIT 1")
          .get(`%${marker}%`) as { id: string; status: string } | undefined;
        return row ?? null;
      } finally {
        db.close();
      }
    });

    if (!inboundResult.ok) {
      logLine('stage-2', 'TIMEOUT — host IPC consumer did not inject into inbound.db', {
        timeoutMs: STAGE_TIMEOUTS_MS.inboundInject,
        elapsedMs: inboundResult.elapsedMs,
        hint: 'Is the host (NanoClaw service) running? Check logs/nanoclaw.log for IPC consumer activity',
      });
      ok = false;
    } else {
      logLine('stage-2', 'OK — synthetic message in inbound.db', {
        messageId: inboundResult.value.id,
        status: inboundResult.value.status,
        elapsedMs: inboundResult.elapsedMs,
      });
    }
  }

  // ── Stage 3: container processes — outbound.db gains a response ──
  if (ok) {
    if (!fs.existsSync(outboundDbPath)) {
      logLine('stage-3', 'outbound.db absent — container has never run for this session', {
        outboundDbPath,
        hint: 'Wake will create it on first spawn; if this persists, check container logs',
      });
    }
    const outboundResult = await pollUntil('stage-3', STAGE_TIMEOUTS_MS.outboundResponse, () => {
      if (!fs.existsSync(outboundDbPath)) return null;
      const db = new Database(outboundDbPath, { readonly: true });
      try {
        // The bot's response will reference the marker explicitly, OR there
        // will be a new outbound row written AFTER our inbox file. Either is
        // a positive signal that the wake chain reached the container.
        const refRow = db
          .prepare("SELECT id, kind, datetime(created_at) as created FROM messages_out WHERE content LIKE ? LIMIT 1")
          .get(`%${marker}%`) as { id: string; kind: string; created: string } | undefined;
        return refRow ?? null;
      } finally {
        db.close();
      }
    });

    if (!outboundResult.ok) {
      logLine('stage-3', 'TIMEOUT — bot did not respond referencing the marker', {
        timeoutMs: STAGE_TIMEOUTS_MS.outboundResponse,
        elapsedMs: outboundResult.elapsedMs,
        hint: 'Wake may have spawned the container but the agent ignored the synthetic message. Check container logs.',
      });
      ok = false;
    } else {
      logLine('stage-3', 'OK — bot wrote outbound row referencing marker', {
        messageId: outboundResult.value.id,
        kind: outboundResult.value.kind,
        elapsedMs: outboundResult.elapsedMs,
      });
    }
  }

  cleanup();

  logLine('result', ok ? 'ALL STAGES PASSED' : 'AT LEAST ONE STAGE FAILED', { ok });
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    logLine('fatal', 'unhandled error', { err: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
