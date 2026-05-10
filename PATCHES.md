# PATCHES — jsboige/nanoclaw fork

Minimal `src/` and `container/` patches applied on top of upstream v2. Every entry includes its commit hash, reason, and exit condition. Target: ≤ 10 active patches at any time. Monthly review removes those whose exit condition is satisfied.

Baseline: upstream `main` at `ef43cbb` (v2.0.46) — sync 2026-05-09. Previous baseline was `1404f7f` (v2.0.30, 2026-05-04).

## Anti-divergence discipline

Before adding a new patch, verify none of these alternatives suffice:

1. Config value / env var / `.env` entry
2. Skill in `.claude/skills/<name>/` or `container/skills/<name>/`
3. Fragment in `groups/<folder>/CLAUDE.local.md` (per-group) or append to `container/CLAUDE.md` (global)
4. MCP server entry in `groups/<folder>/container.json:mcpServers`
5. Branch-installed channel/provider (via `/add-<name>` skill)

If none works, document the patch here with justification.

---

## Active patches

### 1. Host env passthrough to container

- **Commits:** `bb244ac` (initial: GH_TOKEN_*, MCP_*, ASR_*), `658fa09` (extension: ANTHROPIC_*, LOCAL_MEDIUM_*, LOCAL_MINI_*)
- **File:** `src/container-runner.ts` (function `buildContainerArgs`, after `TZ` arg)
- **Summary:** Allowlist of env var prefixes copied from host `process.env` to container spawn args as `-e KEY=VALUE`. Prefixes: `ANTHROPIC_`, `GH_TOKEN_`, `MCP_`, `ASR_`, `LOCAL_MEDIUM_`, `LOCAL_MINI_`.
- **Why:** v2 has no per-group env passthrough mechanism. `container.json:McpServerConfig.env` only applies to MCP subprocesses, not the agent runtime. Several features need host env inside the container:
  - `ANTHROPIC_*` — z.ai credentials read directly by the Claude SDK (bypasses optional OneCLI gateway — see patch #2 notes below)
  - `GH_TOKEN_*` — `multi-identity-github` skill switches `gh auth` per repo owner
  - `MCP_PROXY_BEARER`, `MCP_TOOL_TIMEOUT_MS` — roo-state-manager HTTP MCP via `mcp-remote` stdio wrapper
  - `ASR_*` — voice-transcription integration (host-side Whisper endpoint)
  - `LOCAL_MEDIUM_*`, `LOCAL_MINI_*` — internal vLLM endpoints
- **Exit condition:** Upstream adds a `container.json:env` field (per-group env passthrough) or a `src/container-runner.ts` hook for supplementary env.
- **Lines:** ~14

### 2. `${VAR}` expansion in container.json mcpServers

- **Commit:** `bb244ac`
- **File:** `container/agent-runner/src/config.ts` (new `expandEnv()` helper + call in `loadConfig()`)
- **Summary:** Recursive `${VAR}` string substitution on `raw.mcpServers` when loading container config. Reads `process.env[VAR]` at runtime.
- **Why:** `groups/main/container.json` declares the roo-state-manager MCP with a bearer token. Keeping `MCP_PROXY_BEARER=<secret>` in `.env` (host, gitignored) and referencing it as `${MCP_PROXY_BEARER}` in the committed container.json is the only way to keep the config in git without leaking credentials.
- **Exit condition:** Upstream accepts PR adding env expansion natively to container config loading, or switches mcpServers credential handling to a vault-based flow.
- **Lines:** ~15

### 3. Non-negotiable rules in container/CLAUDE.md

- **Commit:** `bb244ac`
- **File:** `container/CLAUDE.md`
- **Summary:** Append 8 non-negotiable cluster rules + PR review requirements after the existing v2 content.
- **Why:** These rules must apply to ALL agents in this install. v2 removes `groups/global/` (the v1 location). Alternatives considered: (a) per-group `CLAUDE.local.md` duplication — fragile, easy to forget for new groups; (b) a skill — skills are toggleable per-group, these rules must not be. `container/CLAUDE.md` is the only always-loaded, always-all-agents surface.
- **Exit condition:** Upstream adds a `container/CLAUDE.local.md` (per-install, not tracked) or similar mechanism for install-global rules.
- **Lines:** ~30 (content, not code)

### 4. gh CLI + multi-identity help file in Dockerfile

- **File:** `container/Dockerfile`
- **Summary:** (a) Install `gh` (GitHub CLI) from the official Debian repo during the apt install step, after the Playwright/Chromium deps. (b) Create `/home/node/.gh-identities` with a header listing the 4 `GH_TOKEN_*` env vars the `multi-identity-github` skill expects.
- **Why:** Upstream's `container/Dockerfile` doesn't ship `gh` — the container is for agent-SDK work, not GitHub ops. Our cluster-manager role is GitHub-heavy (PR reviews, issue triage, multi-repo monitoring across 4 identities). The `multi-identity-github` skill references `/home/node/.gh-identities` as a discovery file for available tokens; baking it in the image avoids needing an entrypoint side-effect.
- **Exit condition:** Either (a) upstream adds a `container.json:packages.apt` honored at image-build time (not runtime), or (b) we split the cluster-manager role into a sibling image via docker-compose (Exp 2 plan) — then gh goes on that image only.
- **Lines:** ~12 (apt install block + gh-identities heredoc).

### 5. Copy CLAUDE.md fragments instead of symlinking on Windows

- **File:** `src/claude-md-compose.ts` (`syncSymlink` → `syncFragment`, plus `hostSource` on the desired-fragment map)
- **Summary:** On `win32` hosts, inline the host file content (`fs.readFileSync` + `writeAtomic`) instead of `fs.symlinkSync`. Composition runs per-spawn so the inlined copy is never stale.
- **Why:** The upstream design uses symlinks whose targets are container-side absolute paths (`/app/CLAUDE.md`, `/app/src/mcp-tools/<x>.instructions.md`), valid inside the container via RO mounts, dangling on the POSIX host. On Windows, MSYS2/Git-Bash (NSSM service env, or any Node-via-Bash spawn) rewrites these POSIX-absolute targets at symlink-creation time to `/d/app/...`, which Docker then exposes as `/mnt/host/d/app/...` inside the container — permanently broken. Impact: without this patch the composed `groups/<folder>/CLAUDE.md` imports 1 broken `.claude-shared.md` + 5 broken `.claude-fragments/module-*.md` links, meaning the agent never sees the shared `container/CLAUDE.md` (non-negotiable rules, skills overview) nor the MCP tool instructions (agents, core, interactive, scheduling, self-mod).
- **Exit condition:** Upstream changes the composition to write content directly (not symlinks), or Node/Windows stops translating POSIX-absolute symlink targets.
- **Lines:** ~18 (platform branch in `syncFragment` + `hostSource` plumbing on 3 call sites).

### 6. Default GH_TOKEN from GH_TOKEN_JSBOIGE in host spawn

- **File:** `src/container-runner.ts` (extension of the patch #1 env-passthrough block in `buildContainerArgs`)
- **Summary:** After the prefix-based env passthrough, if `GH_TOKEN` is unset on the host and `GH_TOKEN_JSBOIGE` is set, append `-e GH_TOKEN=<value>` to the spawn args. The `multi-identity-github` skill still overrides per repo owner at runtime — this only provides the default.
- **Why:** `gh` CLI consults `GH_TOKEN` as its primary env credential. Without a default, bare `gh` fails out-of-the-box even though 4 identity tokens are passed through. Had to be host-side (not `entrypoint.sh`) because `container-runner.ts:492` overrides the Dockerfile `ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]` with `--entrypoint bash -c "exec bun run /app/src/index.ts"` — so anything in `entrypoint.sh` is dead code at spawn time.
- **Exit condition:** `multi-identity-github` skill is redesigned to set `GH_TOKEN` directly on startup, or upstream adds a generic env-defaulting hook in `buildContainerArgs`.
- **Lines:** ~5.

### 7. Concurrency cap on container wake (`MAX_CONCURRENT_CONTAINERS`)

- **Commits:** `45661df` (PR #10), preserved through 2026-05-01 upstream sync
- **File:** `src/container-runner.ts` (function `wakeContainer`, just before `spawnContainer`)
- **Summary:** Refuse to spawn beyond `MAX_CONCURRENT_CONTAINERS`. Returns `false` (transient failure) so the host-sweep tick re-wakes once capacity frees up. No row is lost.
- **Why:** Cluster-Manager group regularly receives 5–10 simultaneous DM bursts when the user comes back online. Without a cap, all wake in parallel, OneCLI gateway saturates, all spawns fail simultaneously. v1 had `GroupQueue` with explicit waiting list; v2 leans on the sweep loop.
- **Exit condition:** Upstream adds a native concurrency cap on container spawning, or the host-sweep grows queue-aware backpressure.
- **Lines:** ~12.

### 8. Container-side MCP fail-fast probe (`mcp-health.ts` + SDK init/mid-session guards)

- **Commits:** `efc651b` (PR #17, HTTP probe), `8eac0ba` (PR #30, SDK init guard, issue #27 branch 1), follow-up mid-session detection (issue #27 branch 2).
- **File:** `container/agent-runner/src/mcp-health.ts` + integration in `index.ts` and `poll-loop.ts`; SDK init + mid-session guards in `container/agent-runner/src/providers/claude.ts` (`translateEvents`); `mcp_tool_missing` event handling in `poll-loop.ts` (`processQuery`).
- **Summary:** Three complementary checks. (a) At container boot AND before each turn, probe required `mcp-remote` HTTP MCP endpoints with a JSON-RPC `initialize` call. Halt the container (boot) or block the turn (per-turn) if the chain is unreachable. (b) When the Claude SDK emits its `system/init` message, inspect `mcp_servers[].status` and throw only on **terminal failure** statuses (`'failed'`, `'needs-auth'`). `'pending'` is the normal mid-handshake state — the SDK reports it whenever async MCP connections are still completing — so rejecting it would block every healthy startup. `'connected'` and `'disabled'` are accepted; missing entries are logged but not fatal. (c) Mid-session: when the SDK auto-injects a `tool_result` with `is_error: true` and `"No such tool available: mcp__<required-server>__*"` (typical post-compaction failure on z.ai's Anthropic-pretend endpoint), `detectMissingMcpTool` emits a `mcp_tool_missing` provider event. The poll-loop aborts the turn, clears `continuation:claude`, and writes a single user-visible message asking the user to resend — the next inbound respawns with a fresh init, restoring the registry.
- **Why:** Silent partial-degraded operation is the failure mode that triggered this code. Three distinct silent-failures observed: (a) `roo-state-manager` 404 masked by `sk-agent` still working, agent kept replying as if everything was fine (PR #17 fix). (b) On z.ai's Anthropic-compatible endpoint, the chain probe passes (HTTP 200 from `mcp-tools.myia.io`) but the SDK reports `mcp_servers[].status='failed'` at init for one or more required servers — every `mcp__<server>__*` call then returns "No such tool available" while the bot keeps replying "Dashboard MCP DOWN" indefinitely (PR #30, issue #27 branch 1). (c) Even when init is clean, the SDK loses its tool registry mid-session after auto-compaction on z.ai (22 occurrences observed in session 412a71e3 between 2026-04-24 and 2026-05-01, all post `compact_boundary`). Without branch 2, the bot would reply "MCP down" to every subsequent message until manual container-kill — happening "several times a day" per operator. The HTTP probe alone is insufficient at any phase; only the SDK's own registry signals (init `mcp_servers[]` + per-turn `tool_use_error` blocks) reflect what tools are actually callable.
- **Exit condition:** Upstream adds container-side MCP health probes covering all three phases (HTTP + SDK-init + mid-session tool_use_error) in the agent-runner provider abstraction, or our cluster moves off `mcp-remote` and z.ai Anthropic-pretend to a transport that doesn't lose tool registry post-compaction.
- **Lines:** ~150 (module + integration + tests) + ~25 (SDK init guard) + ~80 (mid-session detection + event plumbing + tests).

### 9. Restored container-side observability surface (`task-run-logs.ts`)

- **Commits:** `97d620d` (PR #12)
- **File:** `container/agent-runner/src/db/task-run-logs.ts`
- **Summary:** Persist per-turn task run logs in `outbound.db` for replay/debugging. Upstream removed this in the v2 refactor.
- **Why:** Cluster-manager scheduler debugging needs after-the-fact visibility into what each task run did. Without it, when a scheduled task misbehaves, the only signal is in `nanoclaw.log` which interleaves all sessions.
- **Exit condition:** Upstream brings back equivalent observability (e.g. structured per-session log file, or v2-native task-run table), or we offload all task tracing to roo-state-manager dashboards.
- **Lines:** ~80.

### 10. Restored RooSync inbox standalone watcher (`roosync-inbox-standalone.ts`)

- **Commits:** `c2372a9` (PR #16, restore TS source) + recurring hardening (PR #19, UTF-8 logs + corrupt JSON archive)
- **File:** `src/roosync-inbox-standalone.ts` + `scripts/service/start-roosync-watcher.ps1`
- **Summary:** Standalone Node process watching `data/ipc/roosync-inbox/messages/` for incoming cross-machine messages. Triggered by host-sweep AND independently as a Windows service so cluster messages are picked up even when the main host is down.
- **Why:** v2's "everything is messages" philosophy moved RooSync ops to the `roo-state-manager` HTTP MCP. But our cluster also has 6 machines pushing files into a shared dir as a fallback path when the MCP chain is unhealthy. Removing the standalone watcher would lose the fallback channel — confirmed bidirectional intercom verification in PR #20 depends on this path.
- **Exit condition:** Either (a) upstream brings back equivalent inbox polling, or (b) we deprecate the file-shared inbox in favor of an MCP-only message channel and remove this watcher AND the corresponding RooSync flow.
- **Lines:** ~200 (module) + 30 (Windows service script).

### 11. Restored IPC watcher (`ipc-watcher.ts`)

- **Commits:** `45661df` (PR #10)
- **File:** `src/ipc-watcher.ts` + `start/stopIpcWatcher` calls in `src/index.ts`
- **Summary:** Polls `data/ipc/inbox/*.json` for incoming messages from the legacy `nanoclaw send` CLI tool used by other machines on the cluster.
- **Why:** Several scheduled tasks on po-2024/po-2025/web1 still use `nanoclaw send` over a shared D: mount as a fire-and-forget signal channel. Migrating them to MCP is non-trivial (they're cron-driven on Windows hosts without easy MCP client). Removing the watcher silently drops these signals.
- **Exit condition:** Cluster-wide migration off `nanoclaw send` to MCP-based delivery, OR upstream restores legacy IPC consumer.
- **Lines:** ~120.

### 12. Voice transcription (`transcription.ts`)

- **Commits:** `45661df` (PR #10)
- **File:** `src/transcription.ts` + integration in `src/channels/chat-sdk-bridge.ts` + `src/channels/telegram.ts`
- **Summary:** Host-side ASR: when a Telegram voice message arrives, fetch via Bot API, POST to `${ASR_BASE_URL}` (Whisper), inline transcript into agent message body as `[Voice: <text>]`.
- **Why:** Voice messages are a primary user input channel (operator preference: "voice OK il préfère parler"). Without transcription, the agent receives only the audio attachment without text and the response latency doubles (the agent has to call back).
- **Exit condition:** Migrate to a container skill `container/skills/voice-transcription/` that the agent invokes (planned in PATCHES.md original entry #9). Once the skill ships, this host-side path can be removed.
- **Lines:** ~80 (module) + ~20 (channel integration).

### 14. Test-singleton reuse in `openInboundDb()`

- **File:** `container/agent-runner/src/db/connection.ts` (function `openInboundDb` + new `closeOpenedInbound` helper) and `container/agent-runner/src/db/messages-in.ts` (call sites use the helper instead of `db.close()`).
- **Summary:** When `_inbound` is set (test mode via `initTestSessionDb()`), `openInboundDb()` returns that singleton instead of opening a fresh `Database` against `DEFAULT_INBOUND_PATH` (`/workspace/inbound.db`). New helper `closeOpenedInbound()` is a no-op for the singleton, so `messages-in.ts` finally-blocks don't tear down test fixtures between calls.
- **Why:** Upstream `ccfdf2d` ("fix(agent-runner): open inbound.db fresh per messages_in read") adopted a "fresh connection per read" pattern to defeat SQLite cache staleness across the host-container mount boundary. The new function hardcodes the production path and ignores the in-memory singleton that tests rely on; result is 25/77 container Bun tests fail with `SQLiteError: unable to open database file`. The patch keeps upstream's fresh-connection semantics in production while restoring test compatibility — it's an additive guard, not a behavior change for the container runtime.
- **Exit condition:** Upstream either accepts a PR adding the same test-singleton fast-path, or refactors `initTestSessionDb()` to write the in-memory DB to a real temp file path that `openInboundDb()` can open.
- **Lines:** ~12 (guard + helper + 4 call-site renames).

### 15. Swallow transient `SQLITE_READONLY` in delivery poll on hot-journal recovery

- **File:** `src/db/session-db.ts` (new `isTransientSqliteReadonlyError` helper) + `src/delivery.ts` (wrap `getDueOutboundMessages` in `drainSession`)
- **Summary:** When the host's 1s active delivery poll opens `outbound.db` read-only and `prepare(SELECT ... FROM messages_out)` runs while the container is mid-commit, `better-sqlite3` throws `SqliteError: attempt to write a readonly database`. The container uses `journal_mode=DELETE` (load-bearing for VirtioFS cross-mount visibility) so a `*-journal` file is the normal during-commit state — but readonly opens cannot recover the hot journal. Catch this specific transient case (code starts with `SQLITE_READONLY` or message matches `/readonly database/i`) and skip the tick; the next poll (~1s) sees a clean DB.
- **Why:** Observed ~67 occurrences in 24h of `Active delivery poll error` log spam on myia-ai-01 (1s poll × ~5 transient hits/hour). Each error logs a full stack to `nanoclaw.err.log` despite being a benign race that resolves on the next tick. Without the swallow, the bug appears as constant noise that masks real delivery failures and clouds the on-call signal-to-noise.
- **Exit condition:** Upstream applies this fix or the agent-runner switches to a journal mode (e.g. WAL with explicit checkpoint) that doesn't leave hot journals readable cross-mount. Filing upstream is straightforward — the helper is portable and the fix is purely defensive.
- **Lines:** ~25 (helper + call-site wrap + 5 unit tests).

### 13. Filesystem-safe per-agent message id separator (`messageIdForAgent`)

- **File:** `src/router.ts` (function `messageIdForAgent` at end of file)
- **Summary:** Replace `${id}:${agentGroupId}` with `${id}_${agentGroupId}` and strip any remaining `:` from `baseId`. Result: id like `-5256188832_1581_ag-...` instead of `-5256188832:1581:ag-...`.
- **Why:** Upstream sync `94170b0` (v2.0.13..v2.0.23) introduced this helper with `:` as separator. Telegram's `message.id` is already `${chatId}:${msgId}`, so the result has 2 colons. The id is consumed as a filesystem directory name in `session-manager.ts:extractAttachmentFiles` (line 291). On Windows NTFS, `:` is reserved (drive prefix and alternate data streams), so `mkdirSync(inbox/<id>)` fails with ENOENT, which crashes inbound routing for every voice/attachment message and eventually kills the host process. POSIX hosts (upstream's default test surface) accept `:` in filenames so upstream did not see this regression. `isSafeAttachmentName` doesn't catch it either — it tests for `/`, `\`, NUL, and `path.basename(name) === name`, which all pass on this id.
- **Exit condition:** Upstream changes `messageIdForAgent` to use a filesystem-safe separator (e.g. `_`) or sanitizes the id before it reaches the inbox path.
- **Lines:** ~10 (1 expression change + 8 lines of explanatory comment).

### 16. Strip leaked MCP tool-call XML envelopes from agent output

- **File:** `container/agent-runner/src/formatter.ts` (new helper `stripLeakedMcpToolcalls`) + `container/agent-runner/src/poll-loop.ts` (call site in `dispatchResultText`).
- **Summary:** After `stripInternalTags`, run `stripLeakedMcpToolcalls` on the assistant text. Drops any `<mcp__server__tool …>…</mcp__server__tool>` paired blocks (back-reference matched) and `<mcp__server__tool … />` self-closing blocks; logs `WARNING: stripped N leaked MCP toolcall block(s)` so the incident is visible in container logs.
- **Why:** z.ai's Anthropic-pretend endpoint occasionally emits the model's tool-call XML envelope as plain text instead of executing it. Without stripping, the dispatcher's single-destination fallback posts the raw `<mcp__nanoclaw__send_message>…</…>` (or `<mcp__nanoclaw__add_reaction />`) as a chat message — the user sees garbage, and worse: an intended private DM is exposed in the public group because the fallback ignores the `to=` parameter inside the leaked XML and always replies to the channel of origin. Recovery is unsafe (parameter conventions differ across MCPs and across model leak variants), so just drop the leak and rely on the next user message to retry.
- **Exit condition:** Upstream applies the same defensive strip OR z.ai fixes the SDK envelope leak OR we switch the agent provider for this group off z.ai.
- **Lines:** ~35 (helper) + ~10 (call site + WARNING log).

### 17. Windows named pipe for new `ncl` CLI socket (`data/ncl.sock`)

- **File:** `src/config.ts` (new `getNclSocketPath()`), `src/cli/socket-client.ts` (use it for `DEFAULT_SOCKET_PATH`), `src/cli/socket-server.ts` (skip `unlinkSync`+`chmodSync` on win32).
- **Summary:** Mirror PATCH #29 (now obsolete-merged at the v2.0.30 sync) for the new upstream `ncl` CLI socket added in v2.0.36+. On Windows, `getNclSocketPath()` returns `\\.\pipe\nanoclaw-ncl` instead of `data/ncl.sock`. Server skips stale-file unlink and `chmod` on the named pipe (OS auto-cleans pipes; chmod is meaningless on `\\.\pipe\`).
- **Why:** Upstream `0855369 refactor(cli): rename nc to ncl` and follow-ups added a NEW host-side CLI socket server using the same Unix-socket-on-disk pattern that PATCH #29 already fixed for `data/cli.sock`. Under NSSM service account on Windows, `net.listen('data/ncl.sock')` returns `EACCES: permission denied` — the daemon binds but cannot chmod, then crashes the host on startup. Without this patch, the service circuit-breaker-loops on every restart after the v2.0.30→v2.0.46 sync. The container's `ncl` does not use this socket (it talks to the host via DB transport — see `container/agent-runner/src/cli/ncl.ts`), so a host-only named pipe is sufficient.
- **Exit condition:** Upstream `src/cli/socket-server.ts` adds platform detection or a config hook for the listen path, OR we deprecate the host-side socket server in favor of the container's DB transport for shell invocations too.
- **Lines:** ~14 (new helper + 3 call-site swaps + win32 guard on cleanup/chmod).

### 18. Push-mode stall recovery + periodic SDK query refresh in container poll-loop

- **File:** `container/agent-runner/src/poll-loop.ts` (defer `markCompleted` for follow-ups + 90s stall watchdog + 2h periodic refresh), `container/agent-runner/src/db/messages-in.ts` (new `resetProcessingAcks()` helper).
- **Summary (PATCH #18):** When a follow-up batch is pushed into an active SDK query, no longer mark those messages `completed` immediately after `query.push()`. Instead, queue their IDs in `pendingFollowUpAcks[]` and only commit the `markCompleted` when the SDK emits a corresponding `result` event (or, if the stream ends without one, reset their `processing_ack` rows for retry). A separate watchdog interval checks every 5s whether `lastPushAt` is older than `STALL_TIMEOUT_MS=90s` — if so, reset the pushed messages back to pending and `query.abort()` the stalled SDK query so the outer poll loop respawns with a fresh stream.
- **Summary (PATCH #18b — periodic refresh):** After each `result` event, also check whether the active SDK query has been alive longer than `QUERY_REFRESH_AFTER_MS=2h`. If so, `query.end()` gracefully — the outer poll loop will spawn a fresh query for the next batch, and the persisted `continuation` token resumes the same conversation. Belt-and-braces against the precipitating anti-pattern: a 12-hour-old single SDK query accumulating module/transcript state until push-mode stalls became frequent.
- **Why:** Push-mode stalls (upstream qwibitai/nanoclaw#2177, recurring in long-lived sessions especially under z.ai's Anthropic-pretend endpoint) silently swallow user messages. Pre-fix flow: `query.push(prompt)` → `markCompleted(keptIds)` immediately → SDK never emits a matching `result` event → messages are gone from the queue and never re-tried. Observed 2026-05-09 evening: a 12-hour-old container produced one final result at 22:00:35 (in reply to a CRON task), but two earlier user messages routed at 21:53:35 and 21:57:56 were marked `completed` in `processing_ack` and have NO corresponding row in `messages_out`. User-visible symptom: "the bot ignored my last 2 messages, then answered something unrelated." The host-sweep watchdog (`ABSOLUTE_CEILING_MS=30min` heartbeat-based, `CLAIM_STUCK_MS=60s` claim-based) cannot catch this because heartbeat stays fresh and claims never lingered (they were marked completed pre-result). The host-sweep `CLAIM_STUCK_MS` rule is now also a bonus safety net for this case (claims linger as `processing` instead of being pre-completed).
- **Exit condition:** Upstream adopts deferred-ack-on-result semantics + periodic refresh (PR target), OR the underlying SDK exposes a per-push acknowledgment hook so the poll-loop can do strict 1-to-1 mapping, OR push-mode is replaced with end+restart-per-batch.
- **Lines:** ~60 (deferred-ack tracking + watchdog interval + `resetProcessingAcks` helper + finally-block reset + periodic refresh check on `result` event).

### 20. Retry transient ASR failures in `transcription.ts`

- **File:** `src/transcription.ts` (`transcribeAudioBuffer` retry loop).
- **Summary:** Wrap the ASR fetch + status-check in a 3-attempt loop with backoff `[200ms, 600ms]`. Retry on `TypeError: fetch failed` (network / SSL handshake / DNS) and on HTTP `5xx`. Do NOT retry on 4xx (auth, malformed). Log warnings on each retry, error only when all attempts are exhausted. The `FormData` is rebuilt on each attempt because `Blob` streams are single-use.
- **Why:** Observed 2026-05-10 in `nanoclaw.err.log`: 5× `Transcription error TypeError fetch failed` + 2× `Transcription request failed status=500` spread across the day, while the same endpoint produced 142 successful transcriptions. Drops are silent from the user's POV — no `🎤` echo, agent never sees `[Voice: ...]` inline → bot looks like it ignored the voice. Two distinct intermittent modes:
  - SSL chain instability on `whisper-api.myia.io` (cert chain incomplete from ARR po-2023; Node fetch fails sporadically depending on which CA chain it tries to verify against).
  - Whisper backend on po-2023 returning sporadic 500 (server-side hiccup, recovers on next call).
  Both are recoverable with a quick retry. Persistent outages still surface as `Transcription error attempt=3` after exhausting attempts.
- **Exit condition:** ARR `whisper-api.myia.io` serves the full intermediate cert chain (PowerShell strict accepts it without `-SkipCertificateCheck`), AND po-2023 Whisper stops emitting transient 500s, OR upstream NanoClaw adds native retry/backoff to its ASR path.
- **Lines:** ~50 (3-attempt loop with attempt-aware logging + helper to rebuild FormData per attempt).

### 19. Routing-source fallback when agent omits `<message to="...">` wrapping

- **File:** `container/agent-runner/src/poll-loop.ts` (`dispatchResultText` — added fallback branch before the silent-drop log path).
- **Summary:** If the agent produces non-empty text but fails to wrap any of it in `<message to="...">` blocks, send the cleaned scratchpad to the source of the inbound that triggered the turn (`routing.platformId` + `routing.channelType` + `routing.threadId` + `routing.inReplyTo`). Pre-fix path: log `WARNING: agent output had no <message to="..."> blocks — nothing was sent` and return — i.e. silently drop the agent's reply.
- **Why:** Observed 2026-05-10: container active 1h, MCP registry was lost mid-session and the SDK rebuilt a fresh query without the destination-wrapping discipline. User sent 4 inbound messages; only 2 outbound rows existed (one auto-error about MCP loss, one partial reply). Container log showed `Result: Mémoire mise à jour. J'attends ta réponse...` followed immediately by `[scratchpad] …` and `WARNING: agent output had no <message to="..."> blocks` — the agent DID generate a reply, but it was thrown away because the wrapping was missing. From the user's POV this looks identical to "the bot ignored me", which is the symptom that motivates this patch (user feedback: "nanoclaw est devenu quasiement inutile en conversation"). Better a reply that goes back to the source channel (the one place we know it's safe) than total silence. Triggered most often by MCP registry loss → continuation cleared → fresh SDK init that drops the wrapping convention.
- **Exit condition:** Upstream adds the same source-channel fallback in `dispatchResultText` OR the agent provider stops dropping the `<message to="...">` discipline after MCP-init churn (e.g. system-prompt re-send on every fresh query, or stricter SDK guidance).
- **Lines:** ~20 (one fallback branch in `dispatchResultText` + comment block + one-line docstring update on the surrounding function).

---

## Deferred / not yet applied

### 7. Per-MCP tool timeout

- **Status:** DEFERRED.
- **Context:** `@anthropic-ai/claude-agent-sdk@0.2.116` has no per-MCP `timeout` field on `McpServerConfig`. Production need: 1800000 ms (30 min) for roo-state-manager dashboard condense (local LLM calls).
- **Plan:** Open upstream PR on `claude-agent-sdk` adding `McpServerConfig.timeout?: number`. Until merged, long-running MCP tools may hit default 60s timeout.
- **Workaround:** `MCP_TOOL_TIMEOUT_MS` env var is already passed through to the container via patch #1 for when the SDK surface gains support.

### 8. Docker network per agent_group

- **Status:** Not applied. Apply only when starting Experience 2 (web-explorer).
- **File (when applied):** `src/container-runner.ts`
- **Plan:** Add `container.json:dockerNetwork` field read during `buildContainerArgs`, append `--network <name>`.
- **Why later:** cluster-manager runs on `internal: true` network (no internet); web-explorer needs standard bridge. Issue #5 on this repo.
- **Exit condition:** Upstream adds `container.json:dockerNetwork` natively.

### 9. Telegram voice transcription (ASR)

- **Status:** Post-migration follow-up.
- **Plan:** Implement as container skill `container/skills/voice-transcription/` that the agent invokes on audio content. Agent script fetches the voice file via Telegram Bot API, POSTs to `ASR_BASE_URL` (Whisper), receives text. No patch to the Telegram adapter.
- **Env vars:** `ASR_BASE_URL`, `ASR_API_KEY` already passed through via patch #1.

---

## Removed / not needed under v2

### ~~Mount allowlist env override~~ — SUPERSEDED BY V2 NATIVE (2026-04-24)

- **Was:** v1 commit `55043c2` patched `src/config.ts` to read `NANOCLAW_MOUNT_ALLOWLIST_PATH`.
- **Removed because:** v2 ships `src/modules/mount-security/` natively with hardcoded `${HOME}/.config/nanoclaw/mount-allowlist.json`. We relocated the allowlist to that path and set `HOME=C:/Users/MYIA` in `.env` for the NSSM service.

### ~~MCP HTTP type for roo-state-manager~~ — REPLACED BY STDIO BRIDGE (2026-04-24)

- **Was:** v1 patched `container/agent-runner/src/index.ts buildExtraMcpServers()` to support HTTP-type MCP servers.
- **Removed because:** Replaced by `mcp-remote` stdio wrapper declared in `groups/main/container.json:mcpServers`. No core patch.

### ~~RooSync inbox watcher~~ — REVISITED (2026-05-01)

- **Was:** Marked OBSOLETE on 2026-04-24 thinking all RooSync would go through the MCP server.
- **Reactivated as patch #10:** PR #16 restored `src/roosync-inbox-standalone.ts` because the cluster also uses a file-shared inbox as a fallback when the MCP chain is degraded. The MCP-first stance held only for one-machine installs.

### ~~Credential proxy (z.ai)~~ — REPLACED BY ENV PASSTHROUGH (2026-04-24)

- **Was:** v1 `src/credential-proxy.ts` from the `native-credential-proxy` skill.
- **Removed because:** The Claude SDK reads `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` directly from env. Combined with patch #1, the container receives z.ai credentials without a proxy process. OneCLI Vault remains available as a gateway option (not used on this install).

### ~~Role-based tool gating (cluster vs explorer)~~ — PENDING DESIGN

- **Was:** v1 patched `container/agent-runner/src/index.ts` with ~100 lines of per-group tool allowlist.
- **Removed because:** v2 has per-group skills via `groups/<folder>/container.json:skills`. Exp 2 (web-explorer) will declare a distinct skills subset — no core patch expected.

---

## Review schedule

- Monthly review of this file. For each active patch, check exit condition.
- If an exit condition is met: open PR removing the patch, reference this file.
- If a new upstream release breaks a patch: fix or open discussion upstream, do not revert silently.
- Budget: 12 active patches (raised from 10 on 2026-05-01 to absorb #7–#12 restored from PRs #10–#17). At 10+, stop adding new and prioritize upstreaming.

## Sync workflow (since 2026-05-01)

For each upstream sync:

1. `git fetch upstream main` and check the commit gap.
2. Read `git log upstream/main ^HEAD --no-merges` for security/stability fixes worth cherry-picking ahead of the full sync.
3. Branch `sync/upstream-vX.Y.Z` from local main, run `git merge upstream/main`.
4. **For every conflict in shared files**: prefer upstream when the change is doc-only or stylistic (we accept upstream's wording to minimize future drift). Preserve local code only if PATCHES.md justifies it; mark with `[PATCH-myia #N]` inline so the next sync reviewer sees it immediately.
5. **For every file we add that upstream doesn't have**: validate it's still in PATCHES.md as an active patch; if not, prepare to drop it.
6. Run host TSC + container TSC + tests.
7. Update PATCHES.md baseline + per-patch state.
8. Open PR. Reference this file in the PR body so the reviewer knows what to expect.

See [OVERLAY-STRATEGY.md](OVERLAY-STRATEGY.md) for the design intent behind the patch budget and the long-term plan.
