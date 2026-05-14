# Register (or re-register) the NanoClaw persistent-data backup as a Windows
# Scheduled Task: daily snapshot of data/ + groups/ + harness memory to an
# off-D:\ location (see scripts/backup.ts).
#
# Runs under the CURRENT user session (Limited / no UAC) — same principal as
# NanoClawRooSyncInboxWatcher, so it can read the user's profile memory dir.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-backup-task.ps1
#
# Tracked by jsboige/nanoclaw#48.

$ErrorActionPreference = 'Stop'

$TaskName = 'NanoClawBackup'
$ScriptDir = $PSScriptRoot
$Launcher = Join-Path $ScriptDir 'run-backup.ps1'

if (-not (Test-Path $Launcher)) {
    Write-Error "Launcher not found: $Launcher"
    exit 1
}

$Action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`""

# Daily at 04:17 (off-peak, off the :00 mark). StartWhenAvailable catches up a
# missed run if the machine was off at 04:17.
$Trigger = New-ScheduledTaskTrigger -Daily -At '04:17'

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

$Principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[install-backup-task] Removing existing task '$TaskName'"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Write-Host "[install-backup-task] Registering task '$TaskName' for user $env:USERDOMAIN\$env:USERNAME (daily 04:17)"
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description 'NanoClaw persistent-data backup — daily SQLite-safe snapshot of data/ + groups/ + harness memory to off-D:\ (jsboige/nanoclaw#48)' | Out-Null

Write-Host "[install-backup-task] Task registered. Running it once now to verify."
Start-ScheduledTask -TaskName $TaskName

Start-Sleep -Seconds 8
$info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host "[install-backup-task] State: $state | LastRunTime: $($info.LastRunTime) | LastTaskResult: $($info.LastTaskResult) (0 = success)"
