import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';

const env = readEnvFile([
  'ROOSYNC_SHARED_PATH',
  'ROOSYNC_MACHINE_ID',
  'ROOSYNC_WORKSPACE',
  'ROOSYNC_INBOX_POLL_INTERVAL',
]);

const SHARED = process.env.ROOSYNC_SHARED_PATH || env.ROOSYNC_SHARED_PATH || '';
const MACHINE = process.env.ROOSYNC_MACHINE_ID || env.ROOSYNC_MACHINE_ID || '';
const WORKSPACE = process.env.ROOSYNC_WORKSPACE || env.ROOSYNC_WORKSPACE || '';
const POLL_MS = Math.max(
  1000,
  parseInt(
    process.env.ROOSYNC_INBOX_POLL_INTERVAL ||
      env.ROOSYNC_INBOX_POLL_INTERVAL ||
      '15000',
    10,
  ) || 15000,
);
const MAIN_GROUP_FOLDER =
  process.env.ROOSYNC_INBOX_IPC_GROUP_FOLDER || 'telegram_main';
const DATA_DIR = path.resolve(process.cwd(), 'data');

const CUTOFF_DAYS = 3;
const PROCESSED_MAX = 500;

const INBOX_DIR = path.join(SHARED, 'messages', 'inbox');
const EXPECTED_TO = `${MACHINE}:${WORKSPACE}`;
const IPC_MESSAGES_DIR = path.join(
  DATA_DIR,
  'ipc',
  MAIN_GROUP_FOLDER,
  'messages',
);
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
    if (Array.isArray(parsed.ids))
      return new Set(parsed.ids.slice(-PROCESSED_MAX));
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

    let msg: {
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
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      log('warn', {
        msg: 'parse failed',
        file: f,
        err: err instanceof Error ? err.message : String(err),
      });
      processedIds.add(id);
      continue;
    }

    if (!msg || !msg.id || !msg.to || !msg.from) {
      processedIds.add(id);
      continue;
    }
    if (msg.to !== EXPECTED_TO) {
      processedIds.add(id);
      continue;
    }

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
        ipcFile,
      });
    } catch (err) {
      log('error', {
        msg: 'ipc write failed',
        file: f,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    processedIds.add(id);
  }

  if (processedIds.size > PROCESSED_MAX) {
    const sorted = [...processedIds].sort();
    processedIds = new Set(sorted.slice(-PROCESSED_MAX));
  }
  saveProcessed(processedIds);
}

function loop(): void {
  if (stopped) return;
  try {
    pollOnce();
  } catch (err) {
    log('error', {
      msg: 'poll loop error',
      err: err instanceof Error ? err.message : String(err),
    });
  }
  setTimeout(loop, POLL_MS);
}

log('info', {
  msg: 'started',
  inboxDir: INBOX_DIR,
  expectedTo: EXPECTED_TO,
  pollMs: POLL_MS,
  cutoffDays: CUTOFF_DAYS,
  ipcDir: IPC_MESSAGES_DIR,
  processedLoaded: processedIds.size,
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
