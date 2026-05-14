# Backup & Restore — NanoClaw persistent data

NanoClaw v2 keeps no state in a Docker volume. The host process spawns ephemeral
per-session containers (`--rm`); everything that matters lives on the **host
filesystem** under `data/` and `groups/`, plus the Claude Code harness memory in
the user profile. The realistic loss vectors are an upstream sync clobbering
install-specific files, an accidental `data/` deletion, disk failure on `D:`, or
SQLite corruption — not a replaced volume.

Tracked by [jsboige/nanoclaw#48](https://github.com/jsboige/nanoclaw/issues/48).
Background incident: the 2026-05-14 Hermes total memory loss.

## What is backed up

| Path | What it is | Git? |
|------|-----------|------|
| `data/**/*.db` | Central `v2.db` + per-session `inbound.db` / `outbound.db` | no |
| `data/*.json`, `data/restart-result.txt` | Runtime state files | no |
| `.env` | Credential wiring | no |
| `groups/` | Per-agent-group filesystem — minus `node_modules` and nested git repos (working *and* bare; those are reconstructible from their remote) | no |
| `~/.claude/projects/d--nanoclaw/memory/` | Claude Code harness memory for this workspace | no |

Each snapshot also contains a `manifest.json` (per-DB `integrity_check` result,
file list, `ok` flag, timestamps).

## Backup

```bash
pnpm exec tsx scripts/backup.ts
```

- DBs are copied with the SQLite **online-backup API** (`better-sqlite3`
  `db.backup()`), never a raw copy of a live WAL file, then each copy is verified
  with `PRAGMA integrity_check`.
- Destination: `NANOCLAW_BACKUP_DIR` (default `E:\nanoclaw-backups` — on
  `myia-ai-01`, disk 2, a separate physical NVMe from `D:` = disk 1).
- Retention: keeps the most recent `NANOCLAW_BACKUP_KEEP` snapshots (default 7),
  prunes older.
- Exit code: `0` = all DBs passed integrity; `1` = at least one failed/errored.

### Scheduled (automatic)

`scripts/service/install-backup-task.ps1` registers the Windows Scheduled Task
**`NanoClawBackup`** — daily at 04:17, running as the current user (Limited, no
UAC). It calls `scripts/service/run-backup.ps1`, which logs to `logs/backup.log`
and propagates the exit code to the task's `LastTaskResult`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/service/install-backup-task.ps1
```

Check health:

```powershell
Get-ScheduledTask -TaskName NanoClawBackup | Get-ScheduledTaskInfo |
  Select-Object LastRunTime, LastTaskResult, NextRunTime   # LastTaskResult 0 = ok
```

## Validate a backup (non-destructive)

Restores a snapshot into a scratch dir (`.restore-verify/`, git-ignored) and
verifies every DB in the manifest is present and passes `integrity_check`, and
every tree is present. Touches nothing in the live install.

```bash
pnpm exec tsx scripts/restore.ts                    # latest snapshot
pnpm exec tsx scripts/restore.ts <snapshot-name>    # a specific one
```

Exit `0` = the snapshot is restorable and verified. Delete `.restore-verify/`
afterwards (the script reminds you).

## Restore (destructive — real recovery)

> Restoring overwrites the live `data/` and `groups/`. The host service **must be
> stopped first**, or the running container's open DB handles will fight the
> restore and you'll get a corrupt mix.

1. **Stop the service** (so nothing holds the session DBs open):
   ```powershell
   Start-Process nssm -ArgumentList stop,nanoclaw -Verb RunAs -Wait
   ```
2. **Pick and validate the snapshot** before trusting it:
   ```bash
   pnpm exec tsx scripts/restore.ts <snapshot-name>   # PASS in scratch first
   ```
3. **Restore into the repo root** — `--force` is required because the target is
   the repo root:
   ```bash
   pnpm exec tsx scripts/restore.ts <snapshot-name> --into D:\nanoclaw --force
   ```
   This copies the snapshot's `data/`, `groups/`, `.env` and
   `claude-harness-memory/` over the live tree, then re-runs `integrity_check` on
   every restored DB.
4. **Restore the harness memory** if needed — the snapshot's
   `claude-harness-memory/` maps to `~/.claude/projects/d--nanoclaw/memory/`;
   copy it back manually (it is outside the repo root).
5. **Restart and verify**:
   ```powershell
   Start-Process nssm -ArgumentList start,nanoclaw -Verb RunAs -Wait
   ```
   Then confirm the central DB schema version and a Telegram round-trip:
   ```bash
   pnpm exec tsx scripts/q.ts data/v2.db "SELECT * FROM schema_version"
   ```

## Pre-upgrade safety gate (mandatory)

Before any destructive operation — `git pull` / upstream sync (`/update-nanoclaw`),
`./container/build.sh`, or a `data/` migration — take a fresh snapshot and
confirm it:

```bash
pnpm exec tsx scripts/backup.ts && pnpm exec tsx scripts/restore.ts
```

Both must exit `0`. Note the snapshot name in the session / on
`workspace-nanoclaw`. Only then proceed with the upgrade. This is the human gate
that the Hermes incident skipped.
