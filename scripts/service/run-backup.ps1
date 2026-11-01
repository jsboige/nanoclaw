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

# 2026-10-30 — regle user : les backups sortent de D: (et de tout disque interne) vers
# GDrive et/ou le disque USB. G: = copie hors machine (cloud), F: = alternative USB locale.
# backup.ts lit NANOCLAW_BACKUP_DIR (defaut E:\nanoclaw-backups, desormais obsolete).
#
# 2026-11-01 — pre-vol d'ecriture + repli. Le 01/11 a 03:17 le run est mort en FATAL
# (mkdirSync ENOENT) parce que DriveFS etait deconnecte : G: LISTE encore son contenu depuis
# le cache mais TOUTE ecriture echoue — le snapshot du jour a ete perdu. Pre-vol reel (ecriture
# d'une sonde) puis repli sur F:, que la regle user autorise explicitement ("et/ou disque USB").
$DestG = 'G:\Mon Drive\Backups-Cloud\nanoclaw'
$DestF = 'F:\Backups\nanoclaw'

function Test-DestWritable([string]$dir) {
    try {
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop | Out-Null
        }
        $probe = Join-Path $dir ('.wtest-' + [guid]::NewGuid().ToString('N') + '.tmp')
        [System.IO.File]::WriteAllText($probe, 'ok')
        Remove-Item -LiteralPath $probe -Force -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

if (Test-DestWritable $DestG) {
    $env:NANOCLAW_BACKUP_DIR = $DestG
} elseif (Test-DestWritable $DestF) {
    $env:NANOCLAW_BACKUP_DIR = $DestF
    "[run-backup] WARN: $DestG non inscriptible (DriveFS indisponible) - repli sur $DestF" | Out-File -FilePath $LogFile -Append -Encoding utf8
} else {
    $env:NANOCLAW_BACKUP_DIR = $DestG
    "[run-backup] WARN: aucune destination inscriptible (G: et F:) - le run va echouer" | Out-File -FilePath $LogFile -Append -Encoding utf8
}

$stamp = (Get-Date).ToString('o')
"[run-backup] $stamp starting (pid $PID)" | Out-File -FilePath $LogFile -Append -Encoding utf8

if (-not (Test-Path $Tsx)) {
    "[run-backup] ERROR: tsx not found at $Tsx — run pnpm install" | Out-File -FilePath $LogFile -Append -Encoding utf8
    exit 1
}

# Out-File -Encoding utf8: PowerShell 5.1's `*>>` defaults to UTF-16LE on FR
# locale, which makes the log unreadable to grep/tail.
#
# 2026-10-30 — fix faux LastTaskResult=1 : sous PS 5.1, ErrorActionPreference='Stop'
# + `2>&1` sur une commande native fait THROW sur la premiere ligne stderr (NativeCommandError,
# cf. https://github.com/PowerShell/PowerShell/issues/3996) — le script mourait avant
# "finished", exit=1, alors que le backup reussissait. On relache la preference autour
# du pipeline natif ; $LASTEXITCODE propage toujours le vrai code de tsx.
$ErrorActionPreference = 'Continue'
& $Tsx $Entry 2>&1 | Out-File -FilePath $LogFile -Append -Encoding utf8
$ErrorActionPreference = 'Stop'
$code = $LASTEXITCODE

"[run-backup] finished, exit=$code" | Out-File -FilePath $LogFile -Append -Encoding utf8
exit $code
