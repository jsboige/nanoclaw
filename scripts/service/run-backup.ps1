# NanoClaw persistent-data backup launcher (Scheduled Task action).
#
# cd to the repo root, run scripts/backup.ts via the in-tree tsx, append output
# to logs/backup.log. Exit code is propagated so the Scheduled Task's
# LastTaskResult reflects backup integrity (0 = ok, 1 = a DB failed/errored).
#
# Tracked by jsboige/nanoclaw#48.

$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Tsx = Join-Path $RootDir 'node_modules\.bin\tsx.cmd'
$Entry = Join-Path $RootDir 'scripts\backup.ts'
$LogDir = Join-Path $RootDir 'logs'
$LogFile = Join-Path $LogDir 'backup.log'

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

Set-Location $RootDir

$stamp = (Get-Date).ToString('o')
"[run-backup] $stamp starting (pid $PID)" | Out-File -FilePath $LogFile -Append -Encoding utf8

if (-not (Test-Path $Tsx)) {
    "[run-backup] ERROR: tsx not found at $Tsx — run pnpm install" | Out-File -FilePath $LogFile -Append -Encoding utf8
    exit 1
}

# Out-File -Encoding utf8: PowerShell 5.1's `*>>` defaults to UTF-16LE on FR
# locale, which makes the log unreadable to grep/tail.
& $Tsx $Entry 2>&1 | Out-File -FilePath $LogFile -Append -Encoding utf8
$code = $LASTEXITCODE

"[run-backup] finished, exit=$code" | Out-File -FilePath $LogFile -Append -Encoding utf8
exit $code
