# NanoClaw Migration Guide — jsboige/nanoclaw fork → upstream v2.x

**Generated:** 2026-04-24 (pre-migration prep during credit-bonus window)
**Base:** `a81e1651` (merge-base with upstream/main at v1.2.53 sync)
**HEAD at generation:** `f35a5e1` (working tree M on src/container-runner.ts, trivial blank line)
**Upstream:** `ce28e7f` (post-v2.0.10, includes Signal adapter + approvals refactor)
**Tier:** 3 (complex — ~20 customizations, 4 skills applied, source-level changes to core)
**Deployment:** myia-ai-01 Windows via NSSM service

## Migration Plan (Tier 3)

Order of operations:
1. **Safety net + backup** — tag `pre-migrate-<hash>-<ts>` + branch `backup/pre-migrate-*`; snapshot Docker volumes (`cluster-groups`, `cluster-global`, `cluster-ipc`, `explorer-*`, `store/`) via `docker run alpine tar czf` to `.v1-backup/`; dump `store/messages.db` and `.env`.
2. **Stop NanoClaw service** — `nssm stop NanoClaw` (or `sc stop NanoClaw` if the service is not NSSM). Pause watchdog `MCP-Chain-Watchdog` task (reboot-safety only, not re-register).
3. **Create `.upgrade-worktree`** on `upstream/main`. `pnpm install --frozen-lockfile`.
4. **Apply skills in worktree** (§ Applied Skills below).
5. **Reapply customizations** (§ Customizations below) — priority order: config/env → skill → fragment `CLAUDE.local.md` → `.mcp.json` → patch (last resort, ≤ 10 budget, document in `PATCHES.md`).
6. **Build + test in worktree** (`pnpm install && pnpm run build && pnpm test`).
7. **Live test from worktree** (symlink `store/`, `data/`, `groups/`, `.env` from main, start `pnpm run dev` — **skip** initially, too risky on Windows with NSSM; do smoke test after swap instead).
8. **Swap** — `git reset --hard $UPGRADE_COMMIT`; restore `.nanoclaw-migrations/`; commit.
9. **Rebuild container image** — `./container/build.sh` (Bun v2 image).
10. **Reconfigure OneCLI** (or keep native credential-proxy skill — see customization #1).
11. **Restore service** — update NSSM paths if needed; `nssm start NanoClaw`.
12. **Re-enable MCP-Chain-Watchdog**.
13. **Smoke test** — send Telegram message, verify round-trip.
14. **Post-migration** — close issues #3/#4/#6, enable #5 on clean v2 base, document divergence budget.

Staging: do not start the two agent_groups (cluster-manager, web-explorer) on day 1 — validate with ONE group (main) first, then add the second in follow-up. Exp 2 (Web Explorer isolated network) is issue #5 — track separately.

**Risk areas:**
- `groups/global/CLAUDE.md` is DELETED by `migrateGroupsToClaudeLocal()` on v2 host startup. Content must migrate to `container/CLAUDE.md` OR per-group `CLAUDE.local.md` BEFORE the v2 host starts.
- `store/messages.db` is v1-only; v2 uses `data/v2.db`. In-flight sessions will NOT resume. User agreed 2026-04-24: bot wraps up before migration.
- Docker networks: our `deploy/docker-compose.yml` runs TWO nanoclaw processes; v2 is ONE host with N agent_groups. Architectural shift — see decision #A.
- Windows NSSM + PowerShell paths: `scripts/service/*.ps1` need no changes if we keep the same entry point, but verify `pnpm start` vs `npm start` in start-nanoclaw.ps1.

**Interactions:**
- Custom #1 (z.ai credential-proxy) interacts with skill `native-credential-proxy`. If we install the skill, #1 is handled. If we switch to OneCLI, we need a OneCLI secret with z.ai host-pattern.
- Custom #3 (mount-allowlist env override) is REDUNDANT — v2 has `src/modules/mount-security/` with `MOUNT_ALLOWLIST_PATH` natively.
- Custom #6 + #7 (MCP HTTP roo-state-manager + timeout 1800) both require stdio wrapper (`mcp-remote`) because v2 `container.json:mcpServers` is stdio-only.

---

## Architectural Decisions

### Decision A — Two experiments: one nanoclaw host, two agent_groups

**Context:** v1 runs two separate nanoclaw processes (cluster + explorer), one per experiment. v2 architecture spawns per-session containers from a SINGLE host — multiple experiments = multiple agent_groups in one install.

**Decision:** Collapse `deploy/docker-compose.yml` two-service setup into ONE v2 install with two agent_groups: `cluster-manager` and `web-explorer`. Container network isolation handled per-spawn (see customization #9).

**How to apply:** Delete `deploy/docker-compose.yml` (or simplify to just host orchestration). Create:
- `groups/cluster-manager/container.json` — internal MCPs, no WebSearch/WebFetch
- `groups/web-explorer/container.json` — web access, Playwright, no cluster MCPs

Exp 2 (web-explorer) activation is issue #5 — track separately. For migration day, validate `main` (existing channel) first.

### Decision B — Native credential proxy vs OneCLI Vault for z.ai

**Context:** Our fork uses `src/credential-proxy.ts` (originated from `skill/native-credential-proxy`, merged 2026-03-xx). z.ai endpoint needs `ANTHROPIC_BASE_URL` rewrite. OneCLI Vault is v2's default; native proxy is escape hatch.

**Decision (from user 2026-04-24):** Try OneCLI first. OneCLI secrets with host-pattern matching for z.ai endpoint. If z.ai requires non-standard routing (e.g., URL path rewrite, custom headers), fallback to `use-native-credential-proxy` skill merge.

**How to apply:**
1. Run `/init-onecli` in worktree after upgrade. Register a z.ai secret: `onecli secrets create --name ZAI --type anthropic --value <z.ai-key> --host-pattern <z.ai-host>`.
2. Test wake via Telegram. If 401/unreachable, apply fallback:
   ```bash
   git merge upstream/skill/native-credential-proxy
   ```
   and add to `.env`: `ANTHROPIC_BASE_URL=<z.ai-endpoint>`, `ANTHROPIC_API_KEY=<z.ai-key>`.

### Decision C — Cherry-pick swap (user preference 2026-04-24)

Use `git reset --hard $UPGRADE_COMMIT` (the skill's default) — already cherry-pick-style in intent (worktree contains clean upstream + reapplied customs, no merge). History stays clean.

### Decision D — Non-negotiable rules location

**Context:** `groups/global/CLAUDE.md` (our non-negotiable rules, commit 404d30e) is DELETED by `migrateGroupsToClaudeLocal()` in v2. The content (cluster-wide rules: no self-LGTM, PR review rigor, etc.) must live somewhere that applies to ALL agents.

**Decision:** Move content into `container/CLAUDE.md` (shared base, mounted RO at `/app/CLAUDE.md` in all containers). This is the only place that guarantees all agents see the rules. This IS a minimal `src/` patch (technically a content file in the tree, not code), acceptable given the rules are non-negotiable. Document in `PATCHES.md`.

Alternative considered and rejected: replicate per-group in each `CLAUDE.local.md` — too fragile, easy to forget when adding a new group.

---

## Applied Skills

Skills previously merged from upstream that need to be re-applied on the clean v2 base:

- **`native-credential-proxy`** — branch `upstream/skill/native-credential-proxy`, merged in v1 at commit `1f62a89`. Decision B: try without first (OneCLI); re-merge only if z.ai routing fails under OneCLI.

Skills that ship features we have but merged from non-upstream remotes (need re-implementation via upstream `/add-<name>`):
- **Telegram** — our v1 merged `telegram/main` remote (not `upstream/skill/add-telegram`). v2 path: run `/add-telegram` skill inside worktree. This installs from `upstream/channels` branch and wires up pinned versions.

Custom skills (user-created, not from upstream, to copy from main tree as-is):
- None. We don't have any `.claude/skills/custom/*` today.

### Skill Interactions

No currently-applied upstream skills interact with each other on our fork. The `native-credential-proxy` skill modifies `src/index.ts`, `src/container-runner.ts`, `src/container-runtime.ts`, `src/config.ts` — if we re-merge it, re-verify OneCLI-related edits (which would have landed in v2) don't overlap.

---

## Customizations

### 1. Credential proxy for z.ai (Anthropic-compatible third-party endpoint)

**Intent:** Allow NanoClaw containers to hit z.ai (GLM-5.1 / GLM-5-turbo) via Anthropic-compatible API proxying. Two separate z.ai keys for cluster-manager vs web-explorer so we can track quota independently.

**Files:** `.env`, OneCLI vault (or `src/credential-proxy.ts` via `native-credential-proxy` skill if fallback).

**How to apply (primary path — OneCLI):**
1. Run `/init-onecli` in the upgrade worktree (Phase 4 of that skill).
2. Create two OneCLI secrets (one per experiment):
   ```bash
   onecli secrets create --name ZAI-cluster --type anthropic --value $CLUSTER_Z_AI_API_KEY --host-pattern <z.ai-host>
   onecli secrets create --name ZAI-explorer --type anthropic --value $EXPLORER_Z_AI_API_KEY --host-pattern <z.ai-host>
   ```
3. Set `ANTHROPIC_BASE_URL=<z.ai-endpoint>` in `.env`.
4. For per-agent-group secret assignment:
   ```bash
   onecli agents set-secret-mode --id <cluster-agent-id> --mode selective
   onecli agents set-secrets --id <cluster-agent-id> --secret-ids <ZAI-cluster-id>
   onecli agents set-secret-mode --id <explorer-agent-id> --mode selective
   onecli agents set-secrets --id <explorer-agent-id> --secret-ids <ZAI-explorer-id>
   ```

**Fallback path (if OneCLI z.ai doesn't work):**
```bash
cd .upgrade-worktree && git merge upstream/skill/native-credential-proxy --no-edit
```
Then set in `.env`:
```
ANTHROPIC_BASE_URL=<z.ai-endpoint>
ANTHROPIC_API_KEY=<z.ai-key>
CREDENTIAL_PROXY_PORT=3001
```

Note: v2 `.env` has `ONECLI_URL` set — leave it as-is so future OneCLI adoption is trivial.

### 2. Multi-identity GitHub (4 accounts)

**Intent:** Agents can `gh` as any of 4 different GitHub accounts (jsboige + 3 alts) depending on the repo/context. v1 hardcodes this in `container/agent-runner/src/index.ts`.

**Files:** new `.claude/skills/custom/multi-identity-github/SKILL.md` + env vars in `.env`.

**How to apply:**
1. Add env vars to `.env` (user provides values):
   ```
   GH_TOKEN_JSBOIGE=<token>
   GH_TOKEN_ALT1=<token>
   GH_TOKEN_ALT2=<token>
   GH_TOKEN_ALT3=<token>
   ```
2. Create `.claude/skills/custom/multi-identity-github/SKILL.md` that teaches the agent to:
   - Detect repo owner via `gh repo view --json owner`
   - Select token env var based on owner (jsboige → `GH_TOKEN_JSBOIGE`, etc.)
   - `gh auth login --with-token < <(echo $GH_TOKEN_X)` before any `gh` action
   - Logout after (`gh auth logout --hostname github.com --user <name>`) to avoid leakage

3. The skill is loaded inside containers via `container/skills/multi-identity-github/` (if we want it available to all agents) OR added to specific `container.json:skills` arrays.

4. Ensure env vars reach the container: v2 does not auto-pass host env to containers — we need a patch to `buildContainerArgs` OR pass them via `providerContribution.env` via a new provider. Simpler: just add them to `container.json` (not supported today for per-group env — would need `container.json:env` field).

**Alternative:** Patch `src/container-runner.ts buildContainerArgs` to allow-list GH_TOKEN_* env vars (small patch, document in PATCHES.md).

### 3. Mount allowlist env override — REDUNDANT, drop

**Intent (v1):** Override the mount-allowlist path via `NANOCLAW_MOUNT_ALLOWLIST_PATH` env var.

**Status:** v2 has `src/modules/mount-security/` natively, using `MOUNT_ALLOWLIST_PATH` (same concept, env-var-driven, default `~/.config/nanoclaw/mount-allowlist.json`).

**How to apply:** DELETE our patch (commit `55043c2` becomes redundant). In `.env`:
```
MOUNT_ALLOWLIST_PATH=D:\nanoclaw\config\mount-allowlist.json
```
Migrate the content of our v1 mount-allowlist file to the v2-expected location.

### 4. ASR transcription (Telegram voice → Whisper)

**Intent:** Telegram voice messages transcribed via configurable Whisper endpoint, result injected into the message text.

**Files:** `src/transcription.ts` (deleted in v2), `src/channels/telegram.ts` (patched in v1).

**How to apply:**
- If we run `/add-voice-transcription` skill (doesn't exist upstream) — not an option, it's our custom.
- Option A: Port our `src/transcription.ts` as a container skill (`container/skills/voice-transcription/`). The skill processes voice message URLs via `fetch`, POSTs to `ASR_ENDPOINT` (Whisper), returns text. Agent calls it when it sees a voice message.
- Option B: Host-side pre-processor hook in the Telegram channel adapter. In v2, channels are installed via `/add-telegram` — the channel skill's code lives under `upstream/channels` branch. We'd patch the Telegram adapter to transcribe before routing (same pattern as v1).

**Decision for tomorrow:** Option B is closest to v1 behavior. Locate the v2 Telegram adapter code (`upstream/channels:src/channels/telegram.ts`), patch it with ASR logic, document as fork of the channel skill.

**Env vars to preserve:**
```
ASR_ENDPOINT=https://whisper-api.myia.io/transcribe
ASR_API_KEY=<key>
ASR_TIMEOUT_MS=30000
```

### 5. NSSM Windows service

**Intent:** Run nanoclaw as a Windows service on myia-ai-01 via NSSM, with reboot-safety.

**Files:** `scripts/service/{install,uninstall,start,stop}-service.ps1`, `scripts/service/nssm.exe`, `scripts/service/install-roosync-watcher-task.ps1`, `scripts/service/start-roosync-watcher.ps1`, `scripts/service/README.md`.

**How to apply:** Copy the `scripts/service/` directory from the main tree into the worktree unchanged. v2 doesn't provide Windows service setup by default, so this is pure add-on (non-intrusive to upstream).

**Change needed:** Verify `start-nanoclaw.ps1` uses `pnpm run start` (v2) instead of `npm start` (v1). Edit one line.

**Verify post-migration:** `nssm edit NanoClaw` — Application path should still point to `D:\nanoclaw\scripts\service\start-nanoclaw.ps1` (via PowerShell interpreter). No NSSM config change needed.

### 6. MCP HTTP roo-state-manager access

**Intent:** Containers access `mcp-tools.myia.io` HTTP MCP server (TBXark proxy → sparfenyuk → roo-state-manager stdio) for dashboard, conversation_browser, codebase_search, etc.

**Files:** v1 patches `container/agent-runner/src/index.ts buildExtraMcpServers()` with custom HTTP MCP type. v2 `container.json:mcpServers` is stdio-only (`command` + `args` + `env`).

**How to apply:** Use `mcp-remote` stdio-to-HTTP bridge. Per-group `container.json` declares:

```json
{
  "mcpServers": {
    "roo-state-manager": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp-tools.myia.io/mcp",
        "--header",
        "Authorization:Bearer ${ROO_STATE_MANAGER_TOKEN}"
      ],
      "env": {
        "ROO_STATE_MANAGER_TOKEN": "${ROO_STATE_MANAGER_TOKEN}"
      },
      "instructions": "Use roo-state-manager MCP tools for cluster coordination: roosync_dashboard, conversation_browser, codebase_search, roosync_search. See CLAUDE.md section 'MCP Tools'."
    }
  }
}
```

**Gotcha:** `mcp-remote` package must be available via `npx` in the container. Either:
- Add to Dockerfile: `RUN npm install -g mcp-remote`
- Or trust `-y` to fetch on-demand (adds cold-start latency, first container spawn will be slow)

### 7. Timeout 1800s for long-running MCP calls

**Intent:** Some roo-state-manager tools (dashboard condense via LLM) take > 60s. Default MCP client timeout (60s) kills them. v1 sets 1800s.

**Files:** v1 patches `container/agent-runner/src/index.ts` (5 lines). v2 has no `timeout` field in `container.json:McpServerConfig`.

**How to apply:**
- **Option A (PR upstream):** add `timeout?: number` field to `McpServerConfig` interface in `src/container-config.ts`, propagate through to `container/agent-runner/src/providers/claude.ts` → SDK's `mcpServers` config. Probably 10-line change. **Recommended** — clean, upstream-friendly, unblocks others.
- **Option B (minimal patch):** patch `container/agent-runner/src/providers/claude.ts` to read a `MCP_TOOL_TIMEOUT_MS` env var and set it on all MCP servers. Document in `PATCHES.md` with exit condition "Upstream PR merges timeout field in container.json".

**Decision:** Start with Option B (faster to apply). Open Option A as PR on day 2.

### 8. RooSync bridge (inbox + dashboard access from containers)

**Intent:** Containers running cluster-manager can read/write the RooSync shared state (dashboards, inbox messages, cluster coordination) via a mounted volume + MCP tools.

**Files:** v1 has `src/roosync-inbox-standalone.ts`, `src/roosync-inbox-watcher.ts`, `src/ipc.ts` (patched). v2 deletes IPC entirely.

**How to apply:** Rebuild as a custom MCP server that exposes `roosync_*` tools to containers. This is already the architecture served via HTTP roo-state-manager (see customization #6). So **this customization collapses into #6** — no separate RooSync bridge code needed on the host side. The HTTP MCP server (roo-state-manager) on the host handles all RooSync operations.

**What remains:** ensure `ROOSYNC_SHARED_PATH=G:\Mon Drive\Synchronisation\RooSync\.shared-state` is in `.env`. roo-state-manager reads it directly.

**What disappears:** the 550 lines of inbox-watcher code from our fork are no longer needed. This is a **win**.

### 9. Role-based tool gating (cluster-manager vs web-explorer)

**Intent:** Cluster-manager has no WebSearch/WebFetch (internal network, no browsing). Web-explorer has WebSearch/WebFetch + Playwright, no cluster MCPs.

**Files:** v1 patches `container/agent-runner/src/index.ts` (~100 lines). v2 has a hardcoded `TOOL_ALLOWLIST` in `container/agent-runner/src/providers/claude.ts` (same for all agents).

**How to apply:**
- Network-level (primary): two Docker networks. `nanoclaw-cluster` network: `internal: true` (no outbound). `nanoclaw-web` network: bridge standard (web access). `container-runner.ts` uses `hostGatewayArgs()` for networking — we'll need to check if this supports per-group network selection. If not: small patch to `container-runner.ts` accepting `networkName` from `container.json`.
- Tool-level (secondary): v2's `TOOL_ALLOWLIST` is in `providers/claude.ts` lines 37-58. To differentiate, we'd need to read it from `container.json:skills` or a new `container.json:tools` field. This is a follow-up patch — for MVP, rely on network-level (fail-closed on WebSearch when network is internal-only).

**Decision:** Network-level isolation is sufficient for day 1. Tool-level gating is a follow-up (optional patch).

Per-group `container.json`:

`groups/cluster-manager/container.json`:
```json
{
  "mcpServers": { "roo-state-manager": { "...": "see customization #6" } },
  "skills": ["multi-identity-github"],
  "provider": "claude",
  "groupName": "ClusterManager",
  "assistantName": "ClusterManager",
  "additionalMounts": [
    { "hostPath": "G:\\Mon Drive\\Synchronisation\\RooSync\\.shared-state", "containerPath": "roosync", "readonly": true }
  ]
}
```

`groups/web-explorer/container.json`:
```json
{
  "mcpServers": {},
  "skills": ["voice-transcription"],
  "provider": "claude",
  "groupName": "WebExplorer",
  "assistantName": "WebExplorer"
}
```

### 10. Non-negotiable cluster rules — migrate from groups/global to container/CLAUDE.md

**Intent:** Apply 8 non-negotiable rules (no self-LGTM, PR review rigor, etc.) + PR Review Requirements to ALL agents in this install.

**Files:** v1 has `groups/global/CLAUDE.md` with the rules. v2 deletes `groups/global/` on startup.

**How to apply:** Patch `container/CLAUDE.md` (shared base) to APPEND our rules after the existing v2 content. This is a minimal content change, not a code change, but counts toward our patch budget. Document in `PATCHES.md`.

**Content to append** (the 8 non-negotiable rules + PR review requirements from `groups/global/CLAUDE.md` lines 5-23):

```markdown
## Non-negotiable Rules — ALL agents

1. NEVER approve your own work without verification...
[...full content from v1 groups/global/CLAUDE.md lines 5-24...]
```

Keep our existing `groups/main/CLAUDE.md` content (ClusterManager mission, topology, etc.) — v2 auto-renames it to `groups/main/CLAUDE.local.md`.

---

## Customizations (secondary)

### 11. Context-recovery playbook (commit `e5da504`)

**Intent:** Instructions for the agent to detect context compaction and recover via `conversations/` archives.

**Files:** currently in `groups/main/CLAUDE.md` lines 107-131.

**How to apply:** After v2 auto-renames `groups/main/CLAUDE.md` → `groups/main/CLAUDE.local.md`, this content is preserved. No action needed.

### 12. GitHub issues pointer (commit `c16e1ba`)

**Intent:** "Chantiers ouverts" section points to `gh issue list --repo jsboige/nanoclaw`.

**Files:** `CLAUDE.md` root, our fork-specific.

**How to apply:** v2's `CLAUDE.md` root is upstream's — our project-level `CLAUDE.md` becomes the composed one. Our fork-specific content goes in a NEW `CLAUDE.md` (untracked) or a new `docs/fork-readme.md`. Minor; can be done post-swap.

### 13. Cluster-manager identity (commit `d98a061`)

**Intent:** ClusterManager system prompt / personality (mission, topology, local LLM endpoints, Telegram formatting rules).

**Files:** `groups/main/CLAUDE.md` lines 1-96.

**How to apply:** Auto-preserved via `migrateGroupsToClaudeLocal()`. No action needed.

### 14. Cluster-manager vs Web-explorer split (commits `d1b7393`, `38ba0c7`)

**Intent:** Two experiments with distinct security profiles.

**Status:** v1 used `deploy/docker-compose.yml` two-service setup. v2 uses two agent_groups in one install. See Decision A above.

**How to apply:** Create `groups/cluster-manager/` and `groups/web-explorer/` with distinct `container.json` and `CLAUDE.local.md` (see customization #9). Migrate `deploy/docker-compose.yml` to either:
- Delete (if nanoclaw host runs directly via NSSM, no Docker orchestration needed)
- Simplify to a single-service wrapper for the nanoclaw host process

### 15. Telegram thread_id, reply context, file download

**Intent:** Upstream features merged into our fork from `telegram/*` remotes (PRs #141, file-download branch).

**Status:** These features probably made it into `upstream/channels` by now. Verify after `/add-telegram` skill installs the v2 Telegram adapter.

**How to apply:** Run `/add-telegram` skill in worktree. Check whether thread_id / reply context / file download are present. If missing, open PRs upstream instead of re-patching.

### 16. Fork setup artifacts (commit `9de0056`)

**Files:** `deploy/.env.example`, `deploy/docker-compose.yml`, `CLAUDE.upstream.md` (we split upstream CLAUDE.md to make room for our fork-specific one).

**How to apply:** After swap, our v1 `CLAUDE.md` becomes our new fork CLAUDE.md (copy from main tree). `CLAUDE.upstream.md` is obsolete (v2 has its own CLAUDE.md we shouldn't split). Delete `CLAUDE.upstream.md`. `deploy/*` becomes minimal or deleted per Decision A.

### 17. roo-state-manager RW shared mount + prep script (commits `b334098`, `92063df`)

**Files:** `scripts/prepare-roo-state-manager.sh`, various mount config.

**How to apply:** Keep `scripts/prepare-roo-state-manager.sh` unchanged (host-side prep, not intrusive to v2 src/). The mount is now declared per-group in `container.json:additionalMounts` (see customization #9).

### 18. Agent-runner force-exit after close sentinel (commit `5eaa121`)

**Intent:** v1 agent-runner sometimes hangs after finishing; force-exit after grace period.

**Status:** v2 agent-runner is completely different (Bun, session DB poll loop, heartbeat-based). Probably no longer needed. Verify behavior in smoke test; if hangs still happen, open upstream issue.

---

## Summary of Patches Expected (PATCHES.md budget)

Total expected `src/`-level patches on v2 after migration:

1. **Container env passthrough for `GH_TOKEN_*`** (customization #2) — patch `src/container-runner.ts buildContainerArgs`. ~5 lines. Exit condition: v2 adds a `container.json:env` field or a per-group env-passthrough mechanism.
2. **MCP HTTP timeout** (customization #7 Option B) — env var `MCP_TOOL_TIMEOUT_MS` read in `providers/claude.ts`. ~5 lines. Exit condition: upstream PR adding `timeout` to `McpServerConfig` merges.
3. **Network name per group** (customization #9) — if `buildContainerArgs` doesn't support per-group network, ~10-line patch. Exit condition: v2 adds `container.json:dockerNetwork` field.
4. **Non-negotiable rules in container/CLAUDE.md** (customization #10) — ~30 lines of content appended. Exit condition: v2 adds a `container/CLAUDE.local.md` or per-install base-CLAUDE-md mechanism.
5. **Telegram ASR integration** (customization #4 Option B) — patch the v2 Telegram adapter in `upstream/channels`. Line count depends on v2 adapter structure. Exit condition: upstream accepts a PR for pluggable voice-message preprocessors.

**Target: ≤ 10 patches total.** Currently projecting 5. Room for unexpected.

---

## Post-migration actions

1. Update `CLAUDE.md` section "Synchronisation upstream" with the anti-divergence discipline (rule: prefer skill/fragment/env over src/ patch; document any patch in PATCHES.md with exit condition).
2. Create `PATCHES.md` at repo root listing the 5 patches above with their hash, reason, and exit condition.
3. Close GitHub issues:
   - #3 (RETEX obsolète) — reference this migration as the definitive answer
   - #4 (OpenClaw) — nothing changes, keep as-is or close
   - #6 (upstream-sync strategy) — this migration IS the strategy, close with link to this guide
4. Mark issue #5 (Web Explorer experiment) as ready to start on clean v2 base. Do NOT tackle on migration day.
5. Open new issue `maintenance/divergence-budget` documenting the ≤ 10 patches rule.
6. Run `/init-first-agent` (v2 skill) to re-register the main Telegram group if the central DB `data/v2.db` doesn't contain it automatically (v2 migration doesn't seed `data/v2.db` from our v1 `store/messages.db` — they're incompatible schemas).
