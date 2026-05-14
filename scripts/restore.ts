/**
 * NanoClaw persistent-data restore / backup-validation.
 *
 * Restores a snapshot produced by scripts/backup.ts into a target directory and
 * verifies it: every DB in the snapshot's manifest is present and passes
 * PRAGMA integrity_check, every tree is present.
 *
 * Default target is a scratch dir (`.restore-verify/`) so the snapshot can be
 * validated WITHOUT touching the live install — this is the "validate the
 * backup" path. To do a real restore, pass `--into <dir>`; restoring straight
 * into the repo root is refused unless `--force` is also given (and the host
 * service must be stopped first — see docs/backup-restore.md).
 *
 * Run:
 *   pnpm exec tsx scripts/restore.ts                 # latest snapshot → .restore-verify/
 *   pnpm exec tsx scripts/restore.ts <snapshot-name> # a specific snapshot
 *   pnpm exec tsx scripts/restore.ts --into D:\path  # real restore target
 *
 * Exit: 0 = snapshot valid / restore verified, 1 = a check failed.
 *
 * Tracked by jsboige/nanoclaw#48.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const BACKUP_BASE = process.env.NANOCLAW_BACKUP_DIR || 'E:\\nanoclaw-backups';

const args = process.argv.slice(2);
const force = args.includes('--force');
const intoIdx = args.indexOf('--into');
const intoArg = intoIdx >= 0 ? args[intoIdx + 1] : undefined;
const snapshotArg = args.find((a, i) => !a.startsWith('--') && i !== intoIdx + 1);

function latestSnapshot(): string {
  const dirs = fs
    .readdirSync(BACKUP_BASE, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (dirs.length === 0) throw new Error(`no snapshots under ${BACKUP_BASE}`);
  return dirs[dirs.length - 1];
}

const snapshotName = snapshotArg || latestSnapshot();
const snapshotDir = path.join(BACKUP_BASE, snapshotName);
const target = path.resolve(intoArg || path.join(REPO_ROOT, '.restore-verify'));

if (!fs.existsSync(snapshotDir)) {
  console.error(`[restore] snapshot not found: ${snapshotDir}`);
  process.exit(1);
}
if (target === REPO_ROOT && !force) {
  console.error('[restore] refusing to restore into the repo root without --force');
  console.error('[restore] stop the nanoclaw service first, then re-run with --force');
  process.exit(1);
}

type Manifest = {
  databases: { src: string; bytes: number; integrity: string }[];
  files: { src: string; bytes: number }[];
  ok: boolean;
  createdAt: string;
};

const manifestPath = path.join(snapshotDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`[restore] no manifest.json in ${snapshotDir}`);
  process.exit(1);
}
const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

console.log(`[restore] snapshot : ${snapshotName} (created ${manifest.createdAt}, manifest.ok=${manifest.ok})`);
console.log(`[restore] target   : ${target}`);

const failures: string[] = [];

// Copy the whole snapshot tree into target (skip the manifest itself).
fs.mkdirSync(target, { recursive: true });
for (const entry of fs.readdirSync(snapshotDir)) {
  if (entry === 'manifest.json') continue;
  fs.cpSync(path.join(snapshotDir, entry), path.join(target, entry), { recursive: true });
}

// Verify every DB from the manifest: present + integrity_check ok.
let dbOk = 0;
for (const db of manifest.databases) {
  const restored = path.join(target, db.src);
  if (!fs.existsSync(restored)) {
    failures.push(`missing after restore: ${db.src}`);
    continue;
  }
  try {
    const conn = new Database(restored, { readonly: true });
    let integrity = 'unknown';
    let tables = 0;
    try {
      integrity = (conn.pragma('integrity_check', { simple: true }) as string) ?? 'unknown';
      tables = (
        conn.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number }
      ).n;
    } finally {
      conn.close();
    }
    if (integrity === 'ok') {
      dbOk++;
      console.log(`[restore]   ok  ${db.src} (${tables} tables)`);
    } else {
      failures.push(`integrity_check=${integrity} for ${db.src}`);
    }
  } catch (err) {
    failures.push(`cannot open restored ${db.src}: ${(err as Error).message}`);
  }
}

// Verify every file / tree from the manifest is present.
let fileOk = 0;
for (const f of manifest.files) {
  // tree entries look like "groups/ (tree, N files, M dirs skipped)"
  const name = f.src.replace(/\\/g, '/').split(' ')[0].replace(/\/$/, '');
  const restored = path.join(target, name);
  if (fs.existsSync(restored)) {
    fileOk++;
  } else {
    failures.push(`missing after restore: ${f.src}`);
  }
}

console.log(`[restore] DBs verified : ${dbOk}/${manifest.databases.length}`);
console.log(`[restore] files/trees  : ${fileOk}/${manifest.files.length}`);

if (failures.length) {
  console.error(`[restore] ${failures.length} FAILURE(S):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`[restore] PASS — snapshot ${snapshotName} is restorable and verified`);
if (target.endsWith('.restore-verify')) {
  console.log('[restore] (scratch verify dir left in place — safe to delete)');
}
