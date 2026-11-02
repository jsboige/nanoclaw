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
#
# 2026-11-02 — repli sur ECHEC DE RUN, pas seulement en pre-vol. Deux nuits de suite le
# pre-vol racine a PASSE puis le run a echoue mi-parcours : DriveFS recyle vers 02:50-03:30
# et post-restart il accepte l'ecriture a la racine mais refuse ~1/3 des ecritures profondes
# (mesure : 69 DBs ecrites sur 102, echecs avales jusqu'au FATAL). Sur echec du run primaire,
# on rejoue integrallement sur l'autre destination si elle est inscriptible.
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

function Invoke-BackupRun([string]$dest) {
    $env:NANOCLAW_BACKUP_DIR = $dest
    # PS 5.1 : EAP='Stop' + 2>&1 sur une commande native throw sur la 1re ligne stderr
    # (faux LastTaskResult=1 du 30/10) — on relache autour du pipeline natif uniquement.
    $ErrorActionPreference = 'Continue'
    & $Tsx $Entry 2>&1 | Out-File -FilePath $LogFile -Append -Encoding utf8
    $ErrorActionPreference = 'Stop'
    return $LASTEXITCODE
}

if (Test-DestWritable $DestG) {
    $Primary = $DestG
} elseif (Test-DestWritable $DestF) {
    $Primary = $DestF
    "[run-backup] WARN: $DestG non inscriptible (DriveFS indisponible) - primaire sur $DestF" | Out-File -FilePath $LogFile -Append -Encoding utf8
} else {
    $Primary = $DestG
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
# du pipeline natif ; $LASTEXITCODE propage toujours le vrai code de tsx (voir Invoke-BackupRun).

$code = Invoke-BackupRun $Primary

# 2026-11-02 — rejeu sur ECHEC : le pre-vol racine peut passer alors que DriveFS
# refuse des ecritures profondes en cours de run (2 nuits perdues les 01-02/11).
# Une reussite du rejeu sauve la nuit : exit 0, le WARN journalise la bascule.
if ($code -ne 0) {
    $Fallback = if ($Primary -eq $DestG) { $DestF } else { $DestG }
    if ($Fallback -eq $DestF -and (Test-DestWritable $DestF)) {
        "[run-backup] WARN: run KO sur $Primary (exit=$code) - rejeu integral sur $Fallback" | Out-File -FilePath $LogFile -Append -Encoding utf8
        $code = Invoke-BackupRun $DestF
        if ($code -eq 0) {
            "[run-backup] WARN: rejeu $Fallback OK - la nuit est sauvee, G: est a requalifier" | Out-File -FilePath $LogFile -Append -Encoding utf8
        }
    }
}

"[run-backup] finished, exit=$code" | Out-File -FilePath $LogFile -Append -Encoding utf8
exit $code
