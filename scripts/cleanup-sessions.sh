#!/bin/bash
#
# Archive (never delete) orphaned v2 session directories.
#
# A session directory under data/v2-sessions/<agent_group_id>/<session_id>/
# is considered "orphaned" when its <session_id> no longer appears in the
# central DB's `sessions` table. Orphaned dirs are tar.gz'd into
# data/v2-sessions/_archive/<agent_group_id>/<session_id>-<UTC>.tar.gz
# and only then removed from their original location.
#
# Active sessions (rows in sessions table) are never touched.
#
# Usage:  ./scripts/cleanup-sessions.sh [--dry-run] [--min-age-days N]
#
#   --dry-run         List what would be archived; touch nothing.
#   --min-age-days N  Only archive orphaned sessions whose dir mtime is older
#                     than N days (default: 14). Prevents archiving sessions
#                     mid-deletion or transient orphans during DB migrations.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

CENTRAL_DB="$PROJECT_ROOT/data/v2.db"
SESSIONS_ROOT="$PROJECT_ROOT/data/v2-sessions"
ARCHIVE_ROOT="$SESSIONS_ROOT/_archive"

DRY_RUN=false
MIN_AGE_DAYS=14

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --min-age-days) MIN_AGE_DAYS="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { echo "[cleanup] $*"; }

if [ ! -f "$CENTRAL_DB" ]; then
  log "ERROR: central DB not found at $CENTRAL_DB"
  exit 1
fi
if [ ! -d "$SESSIONS_ROOT" ]; then
  log "no sessions dir at $SESSIONS_ROOT — nothing to do"
  exit 0
fi

# Collect live session ids. Use a set-of-lines for robust matching.
ACTIVE_IDS=$(sqlite3 "$CENTRAL_DB" "SELECT id FROM sessions;" 2>/dev/null || true)

is_active() {
  local id="$1"
  printf '%s\n' "$ACTIVE_IDS" | grep -qFx "$id"
}

ARCHIVED_COUNT=0
ARCHIVED_BYTES=0

mkdir -p "$ARCHIVE_ROOT"

for ag_dir in "$SESSIONS_ROOT"/*/; do
  [ -d "$ag_dir" ] || continue
  ag_id="$(basename "$ag_dir")"
  # Skip the archive dir itself.
  [ "$ag_id" = "_archive" ] && continue

  for sess_dir in "$ag_dir"*/; do
    [ -d "$sess_dir" ] || continue
    sess_id="$(basename "$sess_dir")"

    # Skip active sessions.
    if is_active "$sess_id"; then
      continue
    fi

    # Skip too-recent dirs (transient orphans during migrations / mid-delete).
    if [ -z "$(find "$sess_dir" -maxdepth 0 -mtime "+$MIN_AGE_DAYS" 2>/dev/null)" ]; then
      continue
    fi

    size_kb=$(du -sk "$sess_dir" 2>/dev/null | cut -f1)
    archive_dir="$ARCHIVE_ROOT/$ag_id"
    mkdir -p "$archive_dir"
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    archive_path="$archive_dir/${sess_id}-${ts}.tar.gz"

    if $DRY_RUN; then
      log "would archive: $sess_dir (${size_kb}K) → $archive_path"
    else
      log "archiving: $sess_dir (${size_kb}K) → $archive_path"
      # tar from parent so paths inside the archive are relative.
      tar -czf "$archive_path" -C "$ag_dir" "$sess_id"
      rm -rf "$sess_dir"
    fi

    ARCHIVED_COUNT=$((ARCHIVED_COUNT + 1))
    ARCHIVED_BYTES=$((ARCHIVED_BYTES + size_kb))
  done
done

if $DRY_RUN; then
  log "DRY RUN — would archive $ARCHIVED_COUNT session(s), ~${ARCHIVED_BYTES}K"
else
  log "Done — archived $ARCHIVED_COUNT session(s), ~${ARCHIVED_BYTES}K"
fi
