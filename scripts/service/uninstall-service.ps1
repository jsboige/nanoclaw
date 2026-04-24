# Uninstall NanoClaw Windows service
#
# USAGE (elevated PowerShell):
#   .\scripts\service\uninstall-service.ps1

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

$Nssm = Join-Path $PSScriptRoot 'nssm.exe'
$ServiceName = 'NanoClaw'

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "Service '$ServiceName' is not installed."
    exit 0
}

Write-Host "Stopping service '$ServiceName'..."
& $Nssm stop $ServiceName confirm 2>&1 | Out-Null

Write-Host "Removing service '$ServiceName'..."
& $Nssm remove $ServiceName confirm | Out-Null

Write-Host "✓ Service '$ServiceName' removed." -ForegroundColor Green
