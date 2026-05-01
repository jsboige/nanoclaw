# Overlay Strategy — minimizing drift from upstream

**Status:** active since 2026-05-01 sync (upstream `8c962d3` / v2.0.23).

## Goal

Keep our fork's divergence from `qwibitai/nanoclaw` low enough that quarterly syncs are mechanical and resolvable in under an hour, while preserving the cluster-specific behaviour we depend on.

## The two kinds of divergence

Every line of code we have that upstream doesn't (or vice-versa) is either:

1. **Carried forward** — a feature/fix we add that upstream doesn't have. Generates conflicts when upstream changes the surrounding code.
2. **Stylistic** — wording, comment length, error message detail. Generates conflicts every time upstream tweaks docs.

Stylistic divergence is the silent killer. A 10-character difference in an error message produces the same merge conflict as a 200-line feature.

## Rules

### Conflict resolution playbook

When `git merge upstream/main` produces a conflict in a shared file:

- **Doc-only / stylistic conflict** → take upstream verbatim. Always. We have zero ROI on owning a longer comment, and we pay the cost forever.
- **Functional conflict where the two sides do the same thing differently** → take upstream. Adapt our callers if needed.
- **Functional conflict where we add something upstream doesn't** → preserve our code, mark it `[PATCH-myia #N]` referencing PATCHES.md. The marker is an explicit signal to the next sync reviewer that this is intentional drift.
- **Functional conflict where upstream adds something we removed** → restore upstream unless PATCHES.md justifies the removal.

### File-level rules

- **Files we add that upstream doesn't have** must have an entry in PATCHES.md. No orphan additions.
- **Files upstream removes** must be evaluated each sync: do we still need them? If not, drop them. If yes, ensure their PATCHES.md entry is current.
- **Tests we add for fork-specific behavior** live next to the patched module (`*.test.ts`). They should be runnable in isolation (per-process tmp dirs, closed DB handles in `afterEach`) so they don't interfere with the upstream test suite.

### What goes where

| Layer | Owner | Sync behavior |
|---|---|---|
| `src/**/*.ts` (shared modules) | upstream — we add markers when we patch | High conflict surface — minimize |
| `container/agent-runner/src/**/*.ts` | upstream — we add markers when we patch | High conflict surface — minimize |
| `groups/<folder>/` | jsboige fork (gitignored, per-machine) | No upstream conflict possible |
| `scripts/service/*.ps1` | jsboige fork — Windows tooling | Upstream doesn't ship Windows scripts |
| `.nanoclaw-migrations/*` | jsboige fork — migration history | Upstream doesn't ship these |
| `.claude/skills/`, `.claude/rules/` | jsboige fork (project) | Auto-loaded by Claude Code, no upstream surface |
| `PATCHES.md`, `OVERLAY-STRATEGY.md` | jsboige fork | No upstream version |

## Long-term reduction plan

Three exit ramps to shrink the patch budget:

1. **Upstream contributions** — for each PATCHES.md entry with a generic exit condition (e.g. "upstream adds a `container.json:env` field"), open a PR upstream proposing the field. The patch goes from "carried indefinitely" to "carried until upstream merges PR #X".

2. **Skill migration** — fork-specific runtime behaviour (voice transcription, GitHub multi-identity, Windows-specific fragment copy) can move into `container/skills/` or `.claude/skills/`. Skills are install-time choices, not codebase patches.

3. **Cluster reorg** — some patches exist because of cluster topology decisions (legacy `nanoclaw send` IPC channel, file-shared RooSync inbox). Migrating those workloads to MCP-only delivery would eliminate the corresponding patches. Tracked in cluster-level issues, not here.

## Reference: what we deliberately diverge on

Six categories that are NOT going away soon. Future-syncs should expect to re-resolve these:

- Env passthrough into container (PATCHES #1, #6) — until upstream adds `container.json:env`.
- `${VAR}` expansion in container.json (PATCHES #2) — until upstream adopts vault-based MCP credentials.
- `container/CLAUDE.md` non-negotiable rules (PATCHES #3) — until upstream provides a per-install rule slot.
- `gh` CLI in Dockerfile (PATCHES #4) — until cluster-manager moves to a sibling image.
- Windows fragment-copy in `claude-md-compose.ts` (PATCHES #5) — until Node/Windows fixes the symlink target translation.
- Concurrency cap in container wake (PATCHES #7) — until upstream grows queue-aware backpressure.

The other 5 entries (#8–#12: mcp-health, task-run-logs, roosync-inbox-standalone, ipc-watcher, transcription) are **migration debt** — they're features we restored from v1 because v2 dropped them. Each has a credible path off (skill, or cluster reorg) and should shrink over time.

## When to deviate from this strategy

If upstream proposes a refactor that would break MORE than half our patches at once, the cost-benefit flips. In that case, evaluate whether to:

- **Skip the upstream version** entirely and pin to the previous baseline until the dust settles, OR
- **Open an upstream PR** proposing the union of our patches BEFORE the refactor lands, so the refactor accommodates them.

Don't silently absorb a refactor that 5x's the patch surface.
