import fs from 'fs';
import path from 'path';

import { Pool } from 'pg';

import { readEnvFile } from './env.js';

const env = readEnvFile([
  'ROOSYNC_SHARED_PATH',
  'ROOSYNC_MACHINE_ID',
  'ROOSYNC_WORKSPACE',
  'ROOSYNC_INBOX_POLL_INTERVAL',
  'ROOSYNC_INBOX_EXTRA_TARGETS',
  'ROOSYNC_RSM_ENV_DIR',
]);

const SHARED = process.env.ROOSYNC_SHARED_PATH || env.ROOSYNC_SHARED_PATH || '';
const MACHINE = process.env.ROOSYNC_MACHINE_ID || env.ROOSYNC_MACHINE_ID || '';
const WORKSPACE = process.env.ROOSYNC_WORKSPACE || env.ROOSYNC_WORKSPACE || '';
const EXTRA_TARGETS_RAW = process.env.ROOSYNC_INBOX_EXTRA_TARGETS || env.ROOSYNC_INBOX_EXTRA_TARGETS || '';
// Directory holding the shared RSM .env (the one the roo-state-manager MCP
// server loads). The PG-unified-store flags live THERE — the fleet flips them
// per machine (pilot #4131), not in this repo's .env. Empty = file-only mode.
const RSM_ENV_DIR = process.env.ROOSYNC_RSM_ENV_DIR || env.ROOSYNC_RSM_ENV_DIR || '';
const POLL_MS = Math.max(
  1000,
  parseInt(process.env.ROOSYNC_INBOX_POLL_INTERVAL || env.ROOSYNC_INBOX_POLL_INTERVAL || '15000', 10) || 15000,
);
const MAIN_GROUP_FOLDER = process.env.ROOSYNC_INBOX_IPC_GROUP_FOLDER || 'telegram_main';
const DATA_DIR = path.resolve(process.cwd(), 'data');

const CUTOFF_DAYS = 3;
const PROCESSED_MAX = 500;

const INBOX_DIR = path.join(SHARED, 'messages', 'inbox');
const CORRUPT_ARCHIVE_DIR = path.join(SHARED, 'messages', 'inbox', '.archive', 'corrupt');
// The host machine's RooSync identity (e.g. "nanoclaw-cluster:nanoclaw") is the
// primary target. But the bot inside the agent container signs its dashboard
// posts with a *different* identity (e.g. "nanoclaw:agent") — see the
// `lastModifiedBy` of workspace-nanoclaw.md. Mentions addressed to that
// in-container identity must also wake the bot, otherwise dashboard
// `mentions:` aimed at the bot's own user-id are silently dropped.
//
// ROOSYNC_INBOX_EXTRA_TARGETS is a comma-separated list of additional
// "machineId:workspace" pairs the watcher will also accept.
const EXPECTED_TARGETS = new Set<string>(
  [`${MACHINE}:${WORKSPACE}`, ...EXTRA_TARGETS_RAW.split(',').map((s) => s.trim())].filter(
    (t) => t.length > 0 && t.includes(':'),
  ),
);

// #4131 B7 — PG read path. When the shared RSM .env turns the unified store on
// (UNIFIED_STORE_CHANNEL_READ_PG=1, or PG_PRIMARY=1 which implies it — same
// gate as roosync-channel-read.ts in RSM), DMs from flipped machines land only
// in PG `roosync_messages`, never as inbox files. The file scan stays on as a
// transition fallback: senders flip per machine, so files keep arriving until
// the whole fleet is PG-primary, and `processedIds` dedups the overlap (a
// message present in both places is injected once).
const RSM_ENV_KEYS = [
  'UNIFIED_STORE_CHANNEL_READ_PG',
  'UNIFIED_STORE_CHANNEL_PG_PRIMARY',
  'UNIFIED_STORE_PG_URL',
] as const;

function resolvePgMode(): { enabled: boolean; url: string } {
  const rsm = RSM_ENV_DIR ? readEnvFile([...RSM_ENV_KEYS], RSM_ENV_DIR) : {};
  const flag = process.env.UNIFIED_STORE_CHANNEL_READ_PG || rsm.UNIFIED_STORE_CHANNEL_READ_PG;
  const primary = process.env.UNIFIED_STORE_CHANNEL_PG_PRIMARY || rsm.UNIFIED_STORE_CHANNEL_PG_PRIMARY;
  const url = process.env.UNIFIED_STORE_PG_URL || rsm.UNIFIED_STORE_PG_URL || '';
  return { enabled: (flag === '1' || primary === '1') && url.length > 0, url };
}

let pgPool: Pool | null = null;
let pgPoolUrl = '';

async function getPgPool(url: string): Promise<Pool> {
  if (pgPool && pgPoolUrl === url) return pgPool;
  if (pgPool) await pgPool.end().catch(() => {});
  // max:1 — a sidecar poller needs one connection; a bigger pool just holds
  // slots the RSM server may need (B11b keeps a reserve for G: reads).
  pgPool = new Pool({ connectionString: url, max: 1 });
  pgPoolUrl = url;
  return pgPool;
}

async function dropPgPool(): Promise<void> {
  const pool = pgPool;
  pgPool = null;
  pgPoolUrl = '';
  if (pool) await pool.end().catch(() => {});
}
const IPC_MESSAGES_DIR = path.join(DATA_DIR, 'ipc', MAIN_GROUP_FOLDER, 'messages');
const STATE_FILE = path.join(DATA_DIR, 'roosync-inbox-processed.json');

function log(level: 'info' | 'warn' | 'error', data: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    component: 'roosync-inbox-standalone',
    ...data,
  });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

if (!SHARED || !MACHINE || !WORKSPACE) {
  log('error', {
    msg: 'missing config, exiting',
    hasShared: Boolean(SHARED),
    hasMachine: Boolean(MACHINE),
    hasWorkspace: Boolean(WORKSPACE),
  });
  process.exit(1);
}

fs.mkdirSync(IPC_MESSAGES_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

function computeCutoffPrefix(now: Date, days: number): string {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const y = cutoff.getUTCFullYear();
  const m = String(cutoff.getUTCMonth() + 1).padStart(2, '0');
  const d = String(cutoff.getUTCDate()).padStart(2, '0');
  return `msg-${y}${m}${d}`;
}

function loadProcessed(): Set<string> {
  try {
    if (!fs.existsSync(STATE_FILE)) return new Set();
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as {
      ids?: string[];
    };
    if (Array.isArray(parsed.ids)) return new Set(parsed.ids.slice(-PROCESSED_MAX));
  } catch (err) {
    log('warn', {
      msg: 'failed to load state',
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return new Set();
}

function saveProcessed(ids: Set<string>): void {
  try {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ids: [...ids] }, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    log('error', {
      msg: 'failed to save state',
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

let processedIds = loadProcessed();
let missingDirLogged = false;
let stopped = false;

type InboxMessage = {
  id?: string;
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  tags?: string[];
  timestamp?: string;
  priority?: string;
  status?: string;
};

/** Write the synthetic-message IPC file for one accepted inbox message. */
function deliverToIpc(msg: InboxMessage, source: string): boolean {
  const ipcPayload = {
    type: 'inject_synthetic_message',
    inboxMsg: msg,
    enqueued_at: new Date().toISOString(),
  };
  const ipcFile = path.join(IPC_MESSAGES_DIR, `roosync-${msg.id}.json`);
  try {
    const tmp = `${ipcFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ipcPayload, null, 2));
    fs.renameSync(tmp, ipcFile);
    log('info', {
      msg: 'ipc file written',
      msgId: msg.id,
      from: msg.from,
      subject: msg.subject,
      source,
      ipcFile,
    });
    return true;
  } catch (err) {
    log('error', {
      msg: 'ipc write failed',
      source,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * One PG poll cycle (#4131 B7). Reads recent `roosync_messages` rows addressed
 * to any machine this watcher serves, filters by the same EXPECTED_TARGETS set
 * as the file path, and injects unseen ones through the same IPC write.
 * Mirrors RSM's roosync-channel-read gate: PG failure logs and waits for the
 * next cycle (the file scan below still runs as the transition fallback).
 */
async function pollPgOnce(): Promise<void> {
  const { enabled, url } = resolvePgMode();
  if (!enabled) return;

  const machines = [...new Set([...EXPECTED_TARGETS].map((t) => t.split(':')[0]))];
  if (machines.length === 0) return;

  const cutoff = new Date(Date.now() - CUTOFF_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let rows: Array<{
    id: string;
    from_machine: string;
    from_workspace: string | null;
    to_machine: string;
    to_workspace: string | null;
    subject: string | null;
    body: string | null;
    priority: string | null;
    status: string | null;
    created_at: string;
    tags: string[] | null;
  }>;
  try {
    const pool = await getPgPool(url);
    const result = await pool.query(
      `SELECT id, from_machine, from_workspace, to_machine, to_workspace,
              subject, body, priority, status, created_at, tags
       FROM roosync_messages
       WHERE to_machine = ANY($1::text[])
         AND created_at > $2
         AND status <> 'destroyed'
       ORDER BY created_at ASC
       LIMIT 500`,
      [machines, cutoff],
    );
    rows = result.rows;
  } catch (err) {
    log('error', {
      msg: 'pg inbox query failed; will retry next cycle',
      err: err instanceof Error ? err.message : String(err),
    });
    await dropPgPool();
    return;
  }

  for (const row of rows) {
    const id = row.id;
    if (processedIds.has(id)) continue;

    const msg: InboxMessage = {
      id: row.id,
      from: row.from_workspace ? `${row.from_machine}:${row.from_workspace}` : row.from_machine,
      to: row.to_workspace ? `${row.to_machine}:${row.to_workspace}` : row.to_machine,
      subject: row.subject ?? undefined,
      body: row.body ?? undefined,
      priority: row.priority ?? undefined,
      status: row.status ?? undefined,
      timestamp: row.created_at,
      ...(row.tags && row.tags.length > 0 ? { tags: row.tags } : {}),
    };

    if (!msg.to || !EXPECTED_TARGETS.has(msg.to)) {
      processedIds.add(id);
      continue;
    }
    if (deliverToIpc(msg, 'pg')) processedIds.add(id);
  }
}

function pollOnce(): void {
  if (!fs.existsSync(INBOX_DIR)) {
    if (!missingDirLogged) {
      log('warn', {
        msg: 'inbox directory not accessible',
        inboxDir: INBOX_DIR,
      });
      missingDirLogged = true;
    }
    return;
  }
  missingDirLogged = false;

  let files: string[];
  try {
    files = fs.readdirSync(INBOX_DIR);
  } catch (err) {
    log('error', {
      msg: 'readdir failed',
      inboxDir: INBOX_DIR,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const cutoff = computeCutoffPrefix(new Date(), CUTOFF_DAYS);

  for (const f of files) {
    if (!f.startsWith('msg-') || !f.endsWith('.json')) continue;
    if (f < cutoff) continue;
    const id = f.slice(0, -5);
    if (processedIds.has(id)) continue;

    const full = path.join(INBOX_DIR, f);
    let raw: string;
    try {
      raw = fs.readFileSync(full, 'utf-8');
    } catch (err) {
      log('warn', {
        msg: 'read failed',
        file: f,
        err: err instanceof Error ? err.message : String(err),
      });
      processedIds.add(id);
      continue;
    }

    let msg: InboxMessage;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      // Corrupt JSON: move out of the inbox so the watcher doesn't re-read
      // it forever (parse-fail is deterministic, retrying is wasted IO and
      // log noise). Archive preserves the file for offline inspection.
      archiveCorrupt(full, f, err);
      processedIds.add(id);
      continue;
    }

    if (!msg || !msg.id || !msg.to || !msg.from) {
      processedIds.add(id);
      continue;
    }
    if (!EXPECTED_TARGETS.has(msg.to)) {
      processedIds.add(id);
      continue;
    }

    if (deliverToIpc(msg, f)) processedIds.add(id);
  }

  if (processedIds.size > PROCESSED_MAX) {
    const sorted = [...processedIds].sort();
    processedIds = new Set(sorted.slice(-PROCESSED_MAX));
  }
  saveProcessed(processedIds);
}

function archiveCorrupt(fullPath: string, filename: string, err: unknown): void {
  try {
    fs.mkdirSync(CORRUPT_ARCHIVE_DIR, { recursive: true });
  } catch (mkdirErr) {
    log('error', {
      msg: 'corrupt-archive mkdir failed; leaving file in inbox',
      file: filename,
      err: mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr),
    });
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(CORRUPT_ARCHIVE_DIR, `${stamp}-${filename}`);
  try {
    fs.renameSync(fullPath, target);
    log('warn', {
      msg: 'archived corrupt inbox file',
      file: filename,
      target,
      parseErr: err instanceof Error ? err.message : String(err),
    });
  } catch (renameErr) {
    log('error', {
      msg: 'corrupt-archive rename failed; leaving file in inbox',
      file: filename,
      target,
      err: renameErr instanceof Error ? renameErr.message : String(renameErr),
    });
  }
}

async function loop(): Promise<void> {
  if (stopped) return;
  try {
    await pollPgOnce();
  } catch (err) {
    log('error', {
      msg: 'pg poll loop error',
      err: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    pollOnce();
  } catch (err) {
    log('error', {
      msg: 'poll loop error',
      err: err instanceof Error ? err.message : String(err),
    });
  }
  setTimeout(() => void loop(), POLL_MS);
}

log('info', {
  msg: 'started',
  inboxDir: INBOX_DIR,
  expectedTargets: [...EXPECTED_TARGETS],
  pollMs: POLL_MS,
  cutoffDays: CUTOFF_DAYS,
  ipcDir: IPC_MESSAGES_DIR,
  processedLoaded: processedIds.size,
  rsmEnvDir: RSM_ENV_DIR || '(none — file-only mode)',
  pgMode: resolvePgMode().enabled ? 'on' : 'off (flag/URL absent from RSM env)',
});

process.on('SIGINT', () => {
  log('info', { msg: 'SIGINT received, stopping' });
  stopped = true;
  process.exit(0);
});
process.on('SIGTERM', () => {
  log('info', { msg: 'SIGTERM received, stopping' });
  stopped = true;
  process.exit(0);
});

loop();
