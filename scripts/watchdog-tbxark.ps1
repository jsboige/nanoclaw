# watchdog-tbxark.ps1 — Probe TBXark MCP proxy *end-to-end* and restart if the
# roo-state-manager (RSM) backend is dead, not just the HTTP front door.
#
# Why a full handshake instead of a simple ping:
#   TBXark (myia-mcp-proxy) answers `initialize` with HTTP 200 from its own HTTP
#   layer even when the upstream RSM backend (sparfenyuk -> node -> GoogleDriveFS)
#   has died or gone stale. The RSM node child restarts independently of TBXark;
#   when it does, TBXark keeps a stale upstream session and silently serves a
#   dead backend. A bare `initialize` 200 check is blind to this — bots then see
#   "roo-state-manager down" every cron cycle while the watchdog logs "OK".
#
#   So this probe drives the real MCP handshake (initialize -> Mcp-Session-Id ->
#   tools/list) and requires tools/list to return > 0 tools. If TBXark answers
#   but RSM serves no tools, the upstream session is stale -> restart TBXark
#   (which re-pairs all upstream sessions). Same remedy if TBXark itself is dead.
#
# A cooldown ($CooldownMinutes) prevents restart storms when the backend is
# genuinely down (vs. merely stale): one restart fixes the stale case; if it's
# still down after a restart we back off instead of looping every 5 minutes.
#
# Scheduled via Windows Task Scheduler. Typical: every 5 minutes.

$ErrorActionPreference = 'Stop'
$ProxyPort = 9090
$ContainerName = 'myia-mcp-proxy'
$LogFile = 'D:\nanoclaw\logs\watchdog-tbxark.log'
$CooldownFile = 'D:\nanoclaw\logs\.tbxark-last-restart'
$CooldownMinutes = 20
# Probe the deepest/slowest backend; if RSM is healthy the shallow ones are too.
$ProbeServer = 'roo-state-manager'

# Auth token: TBXark's mcpProxy.options.authTokens[0]. It rotates, so read it
# from the live config and fall back to the last-known value if unreadable.
$AuthToken = 'ad28ecc74e0963765de2e69d2f75bb542b3b65e378c9b306e8eeeeb98b15906b'
$cfgPath = 'D:\roo-extensions\docker\mcp-proxy\config.json'
if (Test-Path $cfgPath) {
    try {
        $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
        $t = $cfg.mcpProxy.options.authTokens[0]
        if ($t) { $AuthToken = $t }
    } catch { }
}

function Write-Log($msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$ts] $msg"
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    Write-Output $line
}

# Full MCP handshake against one server through TBXark.
# Returns @{ httpOk = <bool>; toolsOk = <bool>; tools = <int>; detail = <str> }
#   httpOk  : TBXark's HTTP layer answered initialize (front door alive)
#   toolsOk : tools/list returned > 0 tools (backend actually serving)
function Test-McpBackend($server) {
    $uri = "http://127.0.0.1:${ProxyPort}/$server/mcp"
    $accept = 'application/json, text/event-stream'
    $initBody = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"watchdog","version":"2.0"}}}'

    # 1) initialize -> capture Mcp-Session-Id
    try {
        $h = @{ 'Authorization' = "Bearer $AuthToken"; 'Content-Type' = 'application/json'; 'Accept' = $accept }
        $r1 = Invoke-WebRequest -Uri $uri -Method POST -Headers $h -Body $initBody -TimeoutSec 15 -UseBasicParsing
    }
    catch {
        $status = $_.Exception.Response.StatusCode.value__
        return @{ httpOk = $false; toolsOk = $false; tools = 0; detail = "initialize failed (HTTP $status / $($_.Exception.Message))" }
    }

    # TBXark serves tools/list statelessly for these servers — it does NOT
    # return an Mcp-Session-Id on initialize and does NOT require one on
    # tools/list. So the session id is optional: forward it only if present,
    # and judge health purely on whether tools/list returns tools.
    $sid = $null
    if ($r1.Headers['Mcp-Session-Id']) { $sid = @($r1.Headers['Mcp-Session-Id'])[0] }

    # 2) tools/list (carry the session id only if TBXark gave us one)
    try {
        $h2 = @{ 'Authorization' = "Bearer $AuthToken"; 'Content-Type' = 'application/json'; 'Accept' = $accept }
        if ($sid) { $h2['Mcp-Session-Id'] = $sid }
        $listBody = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
        $r2 = Invoke-WebRequest -Uri $uri -Method POST -Headers $h2 -Body $listBody -TimeoutSec 25 -UseBasicParsing
    }
    catch {
        $status = $_.Exception.Response.StatusCode.value__
        return @{ httpOk = $true; toolsOk = $false; tools = 0; detail = "tools/list failed (HTTP $status / $($_.Exception.Message))" }
    }

    # Response may be plain JSON or an SSE 'data: {...}' event.
    $content = $r2.Content
    $obj = $null
    try {
        if ($content -match 'data:\s*(\{[\s\S]*\})\s*$') {
            $obj = $Matches[1] | ConvertFrom-Json
        } else {
            $obj = $content | ConvertFrom-Json
        }
    } catch {
        return @{ httpOk = $true; toolsOk = $false; tools = 0; detail = 'tools/list returned unparseable body' }
    }

    $tools = @($obj.result.tools).Count
    return @{ httpOk = $true; toolsOk = ($tools -gt 0); tools = $tools; detail = "$tools tools" }
}

function Restart-Tbxark($reason) {
    # Cooldown guard — avoid restart storms when the backend is genuinely down.
    if (Test-Path $CooldownFile) {
        try {
            $last = [datetime]::Parse((Get-Content $CooldownFile -Raw).Trim())
            $age = (Get-Date) - $last
            if ($age.TotalMinutes -lt $CooldownMinutes) {
                Write-Log "WARN: $reason — restart suppressed (last restart $([int]$age.TotalMinutes)m ago < ${CooldownMinutes}m cooldown)"
                return
            }
        } catch { }
    }

    Write-Log "WARN: $reason — force-restarting $ContainerName"
    docker kill $ContainerName 2>$null | Out-Null
    Start-Sleep -Seconds 3
    docker start $ContainerName 2>$null
    if ($LASTEXITCODE -eq 0) {
        (Get-Date).ToString('o') | Set-Content -Path $CooldownFile -Encoding UTF8 -NoNewline
        Write-Log "OK: Restarted $ContainerName. Waiting 8s for upstreams to re-pair..."
        Start-Sleep -Seconds 8
        $verify = Test-McpBackend $ProbeServer
        if ($verify.toolsOk) {
            Write-Log "OK: Post-restart RSM healthy ($($verify.tools) tools)."
        } else {
            Write-Log "ERROR: Post-restart RSM still unhealthy ($($verify.detail)). Backend may be genuinely down."
        }
    } else {
        Write-Log "ERROR: Failed to restart $ContainerName."
    }
}

try {
    # Is the container running at all?
    $state = docker inspect $ContainerName --format '{{.State.Status}}' 2>$null
    if ($LASTEXITCODE -ne 0 -or $state -ne 'running') {
        Write-Log "WARN: Container $ContainerName not running (state=$state). Starting..."
        docker start $ContainerName 2>$null
        if ($LASTEXITCODE -eq 0) { Write-Log "OK: Container started." } else { Write-Log "ERROR: Failed to start container." }
        exit 0
    }

    # End-to-end RSM probe.
    $probe = Test-McpBackend $ProbeServer
    if ($probe.toolsOk) {
        Write-Log "OK: RSM healthy via TBXark ($($probe.detail))"
        exit 0
    }

    if (-not $probe.httpOk) {
        Restart-Tbxark "TBXark front door down ($($probe.detail))"
    } else {
        # The exact silent-failure mode the old watchdog missed.
        Restart-Tbxark "TBXark up but RSM backend stale/dead ($($probe.detail))"
    }
}
catch {
    Write-Log "ERROR: Unhandled exception: $($_.Exception.Message)"
}
