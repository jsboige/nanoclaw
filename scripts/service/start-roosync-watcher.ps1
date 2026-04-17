# RooSync inbox standalone watcher launcher
# Loads .env and starts the standalone watcher process.
#
# Runs as a Scheduled Task under the user session (NOT LocalSystem) so the
# watcher can see the user's mapped Google Drive (G:\). It writes IPC JSON
# files that the NanoClaw service consumes (inject_synthetic_message type).

$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$EnvFile = Join-Path $RootDir '.env'
$EntryPoint = Join-Path $RootDir 'dist/roosync-inbox-standalone.js'
$LogDir = Join-Path $RootDir 'logs'
$LogFile = Join-Path $LogDir 'roosync-inbox-standalone.log'

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

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
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
    "[start-roosync-watcher] Loaded .env from $EnvFile" | Tee-Object -FilePath $LogFile -Append
} else {
    "[start-roosync-watcher] WARNING: .env not found at $EnvFile" | Tee-Object -FilePath $LogFile -Append
}

# Launch standalone watcher, appending to the log
"[start-roosync-watcher] Starting node $EntryPoint (pid $PID)" | Tee-Object -FilePath $LogFile -Append
& node $EntryPoint *>> $LogFile
