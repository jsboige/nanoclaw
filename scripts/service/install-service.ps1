# Install NanoClaw as a Windows service via NSSM
#
# USAGE: Run in an ELEVATED PowerShell (Admin). From d:\nanoclaw :
#   .\scripts\service\install-service.ps1
#
# This script:
# - Registers a Windows service called "NanoClaw"
# - Configures it to start automatically at boot
# - Redirects stdout/stderr to logs/ with rotation
# - Restarts automatically on crash (5s delay)

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Nssm = Join-Path $PSScriptRoot 'nssm.exe'
$Launcher = Join-Path $PSScriptRoot 'start-nanoclaw.ps1'
$LogDir = Join-Path $RootDir 'logs'
$ServiceName = 'NanoClaw'

if (-not (Test-Path $Nssm)) {
    throw "NSSM not found at $Nssm. Re-download via scripts/service/ setup."
}

# Ensure log directory exists
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
}

# Remove existing service if present (clean slate)
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Service '$ServiceName' already exists — stopping and removing..."
    & $Nssm stop $ServiceName confirm 2>&1 | Out-Null
    & $Nssm remove $ServiceName confirm | Out-Null
}

# Install service — points to PowerShell launcher
Write-Host "Installing service '$ServiceName'..."
& $Nssm install $ServiceName `
    'powershell.exe' `
    '-ExecutionPolicy Bypass -NoProfile -File' `
    "`"$Launcher`""

# Working directory
& $Nssm set $ServiceName AppDirectory $RootDir

# Display name and description
& $Nssm set $ServiceName DisplayName 'NanoClaw Cluster Manager'
& $Nssm set $ServiceName Description 'NanoClaw AI assistant — Cluster Manager for the 6-machine agent cluster. Bridges Telegram to containerized Claude Agent SDK instances.'

# Startup mode: automatic (start at boot)
& $Nssm set $ServiceName Start SERVICE_AUTO_START

# Restart on crash: 5s delay, unlimited retries
& $Nssm set $ServiceName AppRestartDelay 5000
& $Nssm set $ServiceName AppExit Default Restart

# Redirect stdout and stderr to log files with daily rotation
& $Nssm set $ServiceName AppStdout (Join-Path $LogDir 'nanoclaw.out.log')
& $Nssm set $ServiceName AppStderr (Join-Path $LogDir 'nanoclaw.err.log')
& $Nssm set $ServiceName AppRotateFiles 1
& $Nssm set $ServiceName AppRotateOnline 1
& $Nssm set $ServiceName AppRotateBytes 10485760  # 10 MB

# Graceful shutdown: give Node 10s to terminate before SIGKILL
& $Nssm set $ServiceName AppStopMethodConsole 10000
& $Nssm set $ServiceName AppStopMethodWindow 10000
& $Nssm set $ServiceName AppStopMethodThreads 10000

Write-Host ""
Write-Host "✓ Service '$ServiceName' installed." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  Start:     Start-Service $ServiceName"
Write-Host "  Stop:      Stop-Service $ServiceName"
Write-Host "  Status:    Get-Service $ServiceName"
Write-Host "  Logs:      Get-Content $LogDir\nanoclaw.out.log -Tail 50 -Wait"
Write-Host "  Uninstall: $Nssm remove $ServiceName confirm"
