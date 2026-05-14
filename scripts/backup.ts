/**
 * NanoClaw persistent-data backup.
 *
 * Snapshots the non-git, irreplaceable host-side state to an off-`D:\` location:
 *   - every SQLite DB under data/  (central v2.db + per-session inbound/outbound)
 *     via the SQLite online-backup API + PRAGMA integrity_check  — never a raw
 *     copy of a live WAL file
 *   - small data/ state files (.json) and .env
 *   - groups/  minus node_modules and nested git repos (working *and* bare —
 *     those are reconstructible from their remote)
 *   - the Claude Code harness memory dir for this workspace
 *
 * Retention: keeps the most recent NANOCLAW_BACKUP_KEEP snapshots, prunes older.
 *
 * Run:   pnpm exec tsx scripts/backup.ts
 * Dest:  $NANOCLAW_BACKUP_DIR  (default E:\nanoclaw-backups)
 * Exit:  0 = all DBs passed integrity_check, 1 = at least one failed / errored.
 *
 * Tracked by jsboige/nanoclaw#48.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const BACKUP_BASE = process.env.NANOCLAW_BACKUP_DIR || 'E:\\nanoclaw-backups';
const KEEP = Number(process.env.NANOCLAW_BACKUP_KEEP || 7);
const MEMORY_DIR = path.join(
  os.homedir(),
  '.claude',
  'projects',
  'd--nanoclaw',
  'memory',
);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.join(BACKUP_BASE, stamp);

type DbResult = { src: string; bytes: number; integrity: string };
type FileResult = { src: string; bytes: number };
const dbResults: DbResult[] = [];
const fileResults: FileResult[] = [];
const errors: string[] = [];

/** Recursively collect *.db files under a directory. */
function findDbs(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findDbs(full));
    else if (entry.isFile() && entry.name.endsWith('.db')) out.push(full);
  }
  return out;
}

/** A dir is a git repo (skip it) if it has a .git, or is a bare repo. */
function isGitRepo(dir: string): boolean {
  if (fs.existsSync(path.join(dir, '.git'))) return true;
  return (
    fs.existsSync(path.join(dir, 'HEAD')) &&
    fs.existsSync(path.join(dir, 'objects')) &&
    fs.existsSync(path.join(dir, 'refs'))
  );
}

async function backupDb(src: string): Promise<void> {
  const rel = path.relative(REPO_ROOT, src);
  const target = path.join(dest, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    const db = new Database(src, { readonly: true });
    try {
      await db.backup(target);
    } finally {
      db.close();
    }
    const check = new Database(target, { readonly: true });
    let integrity = 'unknown';
    try {
      integrity = (check.pragma('integrity_check', { simple: true }) as string) ?? 'unknown';
    } finally {
      check.close();
    }
    const bytes = fs.statSync(target).size;
    dbResults.push({ src: rel, bytes, integrity });
    if (integrity !== 'ok') errors.push(`integrity_check failed for ${rel}: ${integrity}`);
  } catch (err) {
    errors.push(`backup failed for ${rel}: ${(err as Error).message}`);
  }
}

function copyFile(src: string): void {
  if (!fs.existsSync(src)) return;
  const rel = path.relative(REPO_ROOT, src);
  const target = path.join(dest, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(src, target);
  fileResults.push({ src: rel, bytes: fs.statSync(target).size });
}

function copyTree(srcDir: string, label: string): void {
  if (!fs.existsSync(srcDir)) return;
  const target = path.join(dest, label);
  let skipped = 0;
  let copied = 0;
  fs.cpSync(srcDir, target, {
    recursive: true,
    filter: (s) => {
      const base = path.basename(s);
      if (base === 'node_modules') {
        skipped++;
        return false;
      }
      if (fs.statSync(s).isDirectory() && s !== srcDir && isGitRepo(s)) {
        skipped++;
        return false;
      }
      if (fs.statSync(s).isFile()) copied++;
      return true;
    },
  });
  fileResults.push({ src: `${label}/ (tree, ${copied} files, ${skipped} dirs skipped)`, bytes: -1 });
}

async function main(): Promise<void> {
  console.log(`[backup] NanoClaw → ${dest}`);
  fs.mkdirSync(dest, { recursive: true });

  // 1. SQLite DBs — online-backup API + integrity_check.
  const dbs = findDbs(path.join(REPO_ROOT, 'data'));
  for (const db of dbs) await backupDb(db);
  console.log(`[backup] ${dbResults.length} SQLite DB(s) snapshotted`);

  // 2. Small data/ state files + .env.
  for (const f of ['data/circuit-breaker.json', 'data/roosync-inbox-processed.json', 'data/restart-result.txt', 'data/nanoclaw.db', '.env']) {
    // data/nanoclaw.db handled by findDbs already; copyFile is idempotent-safe via overwrite — skip if already a *.db we backed up
    if (f.endsWith('.db')) continue;
    copyFile(path.join(REPO_ROOT, f));
  }

  // 3. groups/ minus node_modules + nested git repos.
  copyTree(path.join(REPO_ROOT, 'groups'), 'groups');

  // 4. Claude Code harness memory for this workspace.
  copyTree(MEMORY_DIR, 'claude-harness-memory');

  // 5. Manifest.
  const manifest = {
    tool: 'scripts/backup.ts',
    issue: 'jsboige/nanoclaw#48',
    createdAt: new Date().toISOString(),
    host: os.hostname(),
    repoRoot: REPO_ROOT,
    dest,
    databases: dbResults,
    files: fileResults,
    errors,
    ok: errors.length === 0,
  };
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // 6. Retention — keep the most recent KEEP snapshots.
  const snapshots = fs
    .readdirSync(BACKUP_BASE, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const prune = snapshots.slice(0, Math.max(0, snapshots.length - KEEP));
  for (const old of prune) {
    fs.rmSync(path.join(BACKUP_BASE, old), { recursive: true, force: true });
    console.log(`[backup] pruned old snapshot ${old}`);
  }

  // Summary.
  const totalDbBytes = dbResults.reduce((n, r) => n + r.bytes, 0);
  console.log(`[backup] DBs: ${dbResults.length} (${(totalDbBytes / 1024).toFixed(0)} KB), integrity: ${dbResults.every((r) => r.integrity === 'ok') ? 'all ok' : 'FAILURES'}`);
  console.log(`[backup] files/trees: ${fileResults.length}`);
  console.log(`[backup] retained snapshots: ${Math.min(snapshots.length, KEEP)} / KEEP=${KEEP}`);
  if (errors.length) {
    console.error(`[backup] ${errors.length} ERROR(S):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('[backup] OK');
}

main().catch((err) => {
  console.error(`[backup] FATAL: ${(err as Error).stack || err}`);
  process.exit(1);
});
