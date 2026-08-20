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
#   2026-08-20 lesson: tools/list is ALSO blind. TBXark serves it statelessly
#   from the registry layer — it executes nothing against GDrive. During a
#   6.5h GDrive-stall incident every dashboard WRITE hung (40 `[undelivered]`
#   bot messages) and later reads hung too, while this watchdog logged
#   "healthy (15 tools)" every 2 minutes. Only a real tools/call reaches the
#   execution layer. The probe now drives initialize -> tools/list (diagnostic)
#   -> tools/call roosync_dashboard list (deciding) and requires the call to
#   answer with a result body.
#
#   Repair is likewise two-layer, matching the proven manual remedy: restart
#   the MCP-Proxy-RSM scheduled task (fresh sparfenyuk on :9091; run-proxy.cmd
#   kills the old port-holder) THEN restart TBXark (clears its stale upstream
#   sessions). Restarting TBXark alone does not fix a hung sparfenyuk.
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
# from the live config. Never hardcode a fallback here — this file is tracked.
$AuthToken = $null
$cfgPath = 'D:\roo-extensions\docker\mcp-proxy\config.json'
if (Test-Path $cfgPath) {
    try {
        $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
        $t = $cfg.mcpProxy.options.authTokens[0]
        if ($t) { $AuthToken = $t }
    } catch { }
}
if (-not $AuthToken) {
    Write-Log "ERROR: auth token unreadable ($cfgPath) — cannot probe, refusing to guess."
    exit 1
}

function Write-Log($msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$ts] $msg"
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    Write-Output $line
}

# Full MCP handshake against one server through TBXark.
# Returns @{ httpOk = <bool>; toolsOk = <bool>; callOk = <bool>; tools = <int>; detail = <str> }
#   httpOk  : TBXark's HTTP layer answered initialize (front door alive)
#   toolsOk : tools/list returned > 0 tools (registry layer — diagnostic only)
#   callOk  : a real tools/call returned a result body (execution layer — deciding)
function Test-McpBackend($server, $callTimeoutSec = 40) {
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

    # 3) REAL tool call — the only step that executes against GDrive. A warm
    #    healthy backend answers in well under a second; a stalled one hangs
    #    until timeout. toolsOk above stays diagnostic-only.
    $callTimeout = $callTimeoutSec
    try {
        $h3 = @{ 'Authorization' = "Bearer $AuthToken"; 'Content-Type' = 'application/json'; 'Accept' = $accept }
        if ($sid) { $h3['Mcp-Session-Id'] = $sid }
        $callBody = '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"roosync_dashboard","arguments":{"action":"list"}}}'
        $r3 = Invoke-WebRequest -Uri $uri -Method POST -Headers $h3 -Body $callBody -TimeoutSec $callTimeout -UseBasicParsing
    }
    catch {
        $status = $_.Exception.Response.StatusCode.value__
        return @{ httpOk = $true; toolsOk = ($tools -gt 0); callOk = $false; tools = $tools; detail = "$tools tools; tools/call failed (HTTP $status / $($_.Exception.Message))" }
    }
    $callContent = "$($r3.Content)"
    # roosync_dashboard list answers with a "dashboards" array; a dead RSM
    # instance answers isError:true with an empty text payload instead.
    $callOk = $callContent -match 'dashboards' -and $callContent -notmatch '"isError"\s*:\s*true'
    $callDetail = if ($callOk) { 'tools/call ok' } else { 'tools/call returned no result body (isError/empty)' }
    return @{ httpOk = $true; toolsOk = ($tools -gt 0); callOk = $callOk; tools = $tools; detail = "$tools tools; $callDetail" }
}

function Restart-McpStack($reason) {
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

    # Proven 2026-08-15 + 2026-08-20 remedy, in order: fresh sparfenyuk on
    # :9091 (its run-proxy.cmd kills the hung port-holder before binding),
    # THEN restart TBXark so it drops stale upstream sessions. Reversed or
    # partial sequences leave the hang in place.
    Write-Log "WARN: $reason — restarting MCP stack (MCP-Proxy-RSM task + $ContainerName)"
    Stop-ScheduledTask MCP-Proxy-RSM -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Start-ScheduledTask MCP-Proxy-RSM
    # Wait for sparfenyuk (:9091) to accept TCP before restarting TBXark.
    # A fixed 10s was not enough (observed 2026-08-20 18:35): TBXark booted
    # while its upstream was still starting, the route never mounted, and the
    # bus served a persistent ~2.6ms 404 until a manual restart — the repair
    # "succeeded" while leaving the bus down for the whole cooldown window.
    $upstreamReady = $false
    foreach ($i in 1..30) {
        $t = Test-NetConnection -ComputerName 127.0.0.1 -Port 9091 -WarningAction SilentlyContinue
        if ($t.TcpTestSucceeded) { $upstreamReady = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $upstreamReady) {
        Write-Log "WARN: sparfenyuk :9091 still not accepting TCP after 60s — restarting $ContainerName anyway."
    }
    docker kill $ContainerName 2>$null | Out-Null
    Start-Sleep -Seconds 3
    docker start $ContainerName 2>$null
    if ($LASTEXITCODE -eq 0) {
        (Get-Date).ToString('o') | Set-Content -Path $CooldownFile -Encoding UTF8 -NoNewline
        # A freshly spawned sparfenyuk needs a real tools/call to warm up —
        # the first one can take over 40s while RSM initializes from GDrive
        # (observed 2026-08-20), so give the verify probe a long budget.
        Write-Log "OK: Stack restarted. Verifying with a long-timeout tools/call (cold start can take minutes)..."
        $verify = Test-McpBackend $ProbeServer 120
        if (-not $verify.callOk -and $verify.httpOk) {
            # Front door answered but the call failed — route-drop / stale-
            # upstream residue. One extra TBXark-only restart (upstream is
            # warm now) fixes it without re-touching the scheduled task.
            Write-Log "WARN: Verify failed ($($verify.detail)) — retrying $ContainerName restart once (upstream now warm)."
            docker kill $ContainerName 2>$null | Out-Null
            Start-Sleep -Seconds 3
            docker start $ContainerName 2>$null
            Start-Sleep -Seconds 5
            $verify = Test-McpBackend $ProbeServer 120
        }
        if ($verify.callOk) {
            Write-Log "OK: Post-restart RSM healthy ($($verify.detail))."
        } else {
            Write-Log "ERROR: Post-restart tools/call still failing ($($verify.detail)). Cold start may need a few more minutes; cooldown prevents a second immediate restart."
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

    # End-to-end RSM probe — decided by the real tools/call, not tools/list.
    $probe = Test-McpBackend $ProbeServer
    if ($probe.callOk) {
        Write-Log "OK: RSM healthy via TBXark ($($probe.detail))"
        exit 0
    }

    if (-not $probe.httpOk) {
        Restart-McpStack "TBXark front door down ($($probe.detail))"
    } else {
        # Backend serving handshakes but not executing (stale session, hung
        # sparfenyuk, GDrive stall) — the silent-failure modes.
        Restart-McpStack "TBXark up but RSM not executing tools/call ($($probe.detail))"
    }
}
catch {
    Write-Log "ERROR: Unhandled exception: $($_.Exception.Message)"
}
