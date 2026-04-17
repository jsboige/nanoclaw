import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  DEFAULT_TRIGGER,
  ROOSYNC_INBOX_POLL_INTERVAL,
  ROOSYNC_INBOX_TARGET_JID,
  ROOSYNC_MACHINE_ID,
  ROOSYNC_SHARED_PATH,
  ROOSYNC_WORKSPACE,
} from './config.js';
import { storeMessageDirect } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body?: string;
  tags?: string[];
  timestamp?: string;
  priority?: string;
  status?: string;
}

export interface RoosyncInboxWatcherDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export interface RoosyncInboxWatcherOptions {
  sharedPath?: string;
  machineId?: string;
  workspace?: string;
  pollInterval?: number;
  targetJid?: string;
  dataDir?: string;
  now?: () => Date;
}

const PROCESSED_MAX = 500;
// Only scan files whose name encodes a date within the last N days. Google Drive
// inboxes can hold thousands of old messages; re-reading them every poll is
// both slow and pointless.
const CUTOFF_DAYS = 3;

interface ProcessedState {
  ids: string[];
}

function computeCutoffPrefix(now: Date, days: number): string {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const y = cutoff.getUTCFullYear();
  const m = String(cutoff.getUTCMonth() + 1).padStart(2, '0');
  const d = String(cutoff.getUTCDate()).padStart(2, '0');
  return `msg-${y}${m}${d}`;
}

export function startRoosyncInboxWatcher(
  deps: RoosyncInboxWatcherDeps,
  options: RoosyncInboxWatcherOptions = {},
): { stop: () => void } {
  const sharedPath = options.sharedPath ?? ROOSYNC_SHARED_PATH;
  const machineId = options.machineId ?? ROOSYNC_MACHINE_ID;
  const workspace = options.workspace ?? ROOSYNC_WORKSPACE;
  const pollInterval = options.pollInterval ?? ROOSYNC_INBOX_POLL_INTERVAL;
  const targetJidOverride = options.targetJid ?? ROOSYNC_INBOX_TARGET_JID;
  const dataDir = options.dataDir ?? DATA_DIR;
  const now = options.now ?? (() => new Date());

  if (!sharedPath || !machineId || !workspace) {
    logger.info(
      {
        hasSharedPath: Boolean(sharedPath),
        hasMachineId: Boolean(machineId),
        hasWorkspace: Boolean(workspace),
      },
      'RooSync inbox watcher disabled (missing config)',
    );
    return { stop: () => {} };
  }

  const inboxDir = path.join(sharedPath, 'messages', 'inbox');
  const expectedTo = `${machineId}:${workspace}`;
  const stateFile = path.join(dataDir, 'roosync-inbox-processed.json');

  fs.mkdirSync(dataDir, { recursive: true });
  let processedIds = new Set(loadProcessed(stateFile));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  logger.info(
    {
      inboxDir,
      expectedTo,
      pollInterval,
      cutoffDays: CUTOFF_DAYS,
      processedLoaded: processedIds.size,
    },
    'RooSync inbox watcher started',
  );

  let missingDirLogged = false;
  const pollOnce = () => {
    if (!fs.existsSync(inboxDir)) {
      if (!missingDirLogged) {
        logger.warn(
          { inboxDir },
          'RooSync inbox: directory not accessible (permissions? Google Drive mount not mapped for service account?) — poll returning early',
        );
        missingDirLogged = true;
      }
      return;
    }

    let files: string[];
    try {
      files = fs.readdirSync(inboxDir);
    } catch (err) {
      logger.error({ err, inboxDir }, 'RooSync inbox: readdir failed');
      return;
    }

    const cutoffPrefix = computeCutoffPrefix(now(), CUTOFF_DAYS);

    // Filter by name BEFORE opening any file: strip old backlog, strip
    // already-processed IDs. Filename = `${id}.json` where id starts with
    // "msg-YYYYMMDD...", matching the id field inside the JSON payload.
    const candidates: { id: string; file: string }[] = [];
    for (const f of files) {
      if (!f.startsWith('msg-') || !f.endsWith('.json')) continue;
      if (f < cutoffPrefix) continue; // lexicographic compare (ISO-like dates)
      const id = f.slice(0, -5);
      if (processedIds.has(id)) continue;
      candidates.push({ id, file: f });
    }

    for (const { id, file } of candidates) {
      const full = path.join(inboxDir, file);
      let msg: InboxMessage;
      try {
        msg = JSON.parse(fs.readFileSync(full, 'utf-8')) as InboxMessage;
      } catch (err) {
        logger.warn({ file, err }, 'RooSync inbox: failed to parse file');
        processedIds.add(id);
        continue;
      }

      if (!msg || !msg.id || !msg.to || !msg.from) {
        processedIds.add(id);
        continue;
      }
      if (msg.to !== expectedTo) {
        processedIds.add(id);
        continue;
      }

      const targetJid = resolveTargetJid(
        deps.registeredGroups(),
        targetJidOverride,
      );
      if (!targetJid) {
        logger.warn(
          { msgId: msg.id },
          'RooSync inbox: no main group registered, cannot inject mention',
        );
        continue;
      }

      const synthetic = buildSyntheticMessage(msg, targetJid, now());
      try {
        storeMessageDirect(synthetic);
      } catch (err) {
        logger.error(
          { err, msgId: msg.id },
          'RooSync inbox: storeMessageDirect failed',
        );
        continue;
      }

      logger.info(
        {
          msgId: msg.id,
          from: msg.from,
          subject: msg.subject,
          targetJid,
          syntheticId: synthetic.id,
        },
        'RooSync inbox mention injected as synthetic message',
      );

      processedIds.add(id);
    }

    // Cap processed set to avoid unbounded growth. Keep the most recent IDs
    // by date prefix (they sort correctly because IDs start with the date).
    if (processedIds.size > PROCESSED_MAX) {
      const sorted = [...processedIds].sort();
      processedIds = new Set(sorted.slice(-PROCESSED_MAX));
    }
    saveProcessed(stateFile, processedIds);
  };

  const loop = () => {
    if (stopped) return;
    try {
      pollOnce();
    } catch (err) {
      logger.error({ err }, 'RooSync inbox watcher loop error');
    }
    timer = setTimeout(loop, pollInterval);
  };

  timer = setTimeout(loop, pollInterval);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function resolveTargetJid(
  groups: Record<string, RegisteredGroup>,
  override: string,
): string | null {
  if (override) return override;
  for (const [jid, g] of Object.entries(groups)) {
    if (g.isMain) return jid;
  }
  return null;
}

export function buildSyntheticMessage(
  msg: InboxMessage,
  targetJid: string,
  now: Date,
): {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message: boolean;
} {
  const shortBody = (msg.body || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const tags = msg.tags?.length ? ` [${msg.tags.join(', ')}]` : '';
  const content =
    `${DEFAULT_TRIGGER} [roosync-inbox] Nouvelle mention RooSync reçue.\n\n` +
    `From: ${msg.from}\nSubject: ${msg.subject}${tags}\nMessageId: ${msg.id}\n\n` +
    `Extrait: ${shortBody}\n\n` +
    `Lis ton inbox (roosync_read mode:"inbox") et agis selon le contenu.`;

  return {
    id: `roosync-${msg.id}`,
    chat_jid: targetJid,
    sender: 'roosync-inbox',
    sender_name: 'RooSync Inbox',
    content,
    timestamp: now.toISOString(),
    is_from_me: false,
    is_bot_message: false,
  };
}

function loadProcessed(stateFile: string): string[] {
  try {
    if (!fs.existsSync(stateFile)) return [];
    const parsed = JSON.parse(
      fs.readFileSync(stateFile, 'utf-8'),
    ) as ProcessedState;
    if (Array.isArray(parsed.ids)) return parsed.ids.slice(-PROCESSED_MAX);
  } catch (err) {
    logger.warn({ err, stateFile }, 'RooSync inbox: failed to load state');
  }
  return [];
}

function saveProcessed(stateFile: string, ids: string[] | Set<string>): void {
  try {
    const array = Array.isArray(ids) ? ids : [...ids];
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ids: array }, null, 2));
    fs.renameSync(tmp, stateFile);
  } catch (err) {
    logger.error({ err, stateFile }, 'RooSync inbox: failed to save state');
  }
}
