# Register (or re-register) the RooSync inbox watcher as a Windows Scheduled Task.
#
# Runs under the CURRENT user session so the watcher can access the user's
# mapped Google Drive (G:\). Triggered at logon, keeps running continuously.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-roosync-watcher-task.ps1

$ErrorActionPreference = 'Stop'

$TaskName = 'NanoClawRooSyncInboxWatcher'
$ScriptDir = $PSScriptRoot
$Launcher = Join-Path $ScriptDir 'start-roosync-watcher.ps1'

if (-not (Test-Path $Launcher)) {
    Write-Error "Launcher not found: $Launcher"
    exit 1
}

$Action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`""

# Trigger at logon of the current user
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Settings: run hidden, don't stop when on battery, restart on failure,
# keep running indefinitely
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)  # 0 = unlimited

# Run as the current interactive user (needed for G:\ access)
$Principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

# Remove existing registration if present
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[install-roosync-watcher-task] Removing existing task '$TaskName'"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Write-Host "[install-roosync-watcher-task] Registering task '$TaskName' for user $env:USERDOMAIN\$env:USERNAME"
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description 'NanoClaw RooSync inbox watcher (user session, writes IPC files for LocalSystem service)' | Out-Null

Write-Host "[install-roosync-watcher-task] Task registered. Starting it now."
Start-ScheduledTask -TaskName $TaskName

Start-Sleep -Seconds 2
$info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
Write-Host "[install-roosync-watcher-task] Task state: $((Get-ScheduledTask -TaskName $TaskName).State), LastRunTime: $($info.LastRunTime), LastTaskResult: $($info.LastTaskResult)"
