# NanoClaw service launcher
# Loads .env into the process environment and starts the NanoClaw host process
#
# Used by NSSM to run NanoClaw as a Windows service with full .env loaded.
# Log files are managed by NSSM (AppStdout / AppStderr).

$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$EnvFile = Join-Path $RootDir '.env'
$EntryPoint = Join-Path $RootDir 'dist/index.js'

Set-Location $RootDir

# Load .env into process env (skip comments, handle quoted values)
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#')) { return }
        $eqIdx = $line.IndexOf('=')
        if ($eqIdx -lt 1) { return }
        $name = $line.Substring(0, $eqIdx).Trim()
        $value = $line.Substring($eqIdx + 1).Trim()
        # Strip surrounding quotes
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
    Write-Host "[start-nanoclaw] Loaded .env from $EnvFile"
} else {
    Write-Host "[start-nanoclaw] WARNING: .env not found at $EnvFile"
}

# Launch NanoClaw
Write-Host "[start-nanoclaw] Starting node $EntryPoint"
& node $EntryPoint
