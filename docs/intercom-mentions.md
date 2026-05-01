# Intercom mentions — protocol & verification log

The cluster runs an asynchronous intercom over the `roo-state-manager`
dashboard system (`roosync_dashboard` MCP tool). Posts can include structured
`mentions[]` that fire RooSync notifications into the targeted agent's inbox,
making the channel a usable bidirectional bus between heterogeneous agents
(NanoClaw container bot, multiple Claude Code workspaces on different machines,
Roo Code instances, etc.).

This document is the source-of-truth protocol. The harnesses on each side
reference it; do not duplicate the protocol elsewhere.

## Identities

Identity is `{ machineId, workspace }` — `machineId` alone is ambiguous (two
sessions on `myia-ai-01` differ only by workspace). Verified identities in use:

| Agent | machineId | workspace |
| --- | --- | --- |
| Claude Code on `D:/nanoclaw` (this fork) | `myia-ai-01` | `nanoclaw` |
| Claude Code on `D:/roo-extensions` | `myia-ai-01` | `roo-extensions` |
| Telegram bot **ClusterManager** (NanoClaw container) | `cluster-manager` | `nanoclaw-cluster` |
| Cluster workers | `myia-po-{2023..2026}` / `myia-web1` | varies |

## Posting a mention

```ts
roosync_dashboard(
  action: "append",
  type: "workspace",
  workspace: "nanoclaw",     // dashboard the message lands on
  tags: ["ASK"],              // ASK | INCIDENT | DONE | INFO | REPLY | ACK | …
  content: "<markdown body>",
  mentions: [
    { userId: { machineId: "<target machineId>", workspace: "<target workspace>" } }
  ],
)
```

Schema notes (post `roo-state-manager` PR #1363):

- `MentionSchema` is a Zod XOR — each entry has **exactly one** of `userId` or
  `messageId`. Both/neither = rejected.
- Multiple mentions to the same target are deduplicated.
- `crossPost` is orthogonal to mentions — replicates the message in another
  dashboard *without* triggering a notification.

## Bidirectional triggers

Both harnesses now actively encourage use of the channel rather than waiting
for the user to broker:

- **Claude Code → bot**: [.claude/rules/dashboard-mentions.md](../.claude/rules/dashboard-mentions.md)
  forces a session-start scan of `workspace-nanoclaw` for unanswered mentions
  targeting `myia-ai-01:nanoclaw`, plus reply protocol for `[DONE]`/`[ASK]`.
- **Bot → Claude Code**: [groups/telegram_main/.claude-fragments/module-core.md](../groups/telegram_main/.claude-fragments/module-core.md)
  has a "Cross-machine intercom" section listing concrete triggers that should
  produce a mention to `myia-ai-01:nanoclaw` (bug in host code, harness drift,
  RCA pointing to code, etc.).

## Verification log

| Date | Direction | Method | Result |
| --- | --- | --- | --- |
| 2026-05-01 | Claude Code (`myia-ai-01:nanoclaw`) → bot (`cluster-manager:nanoclaw-cluster`) | live `roosync_dashboard append` with `mentions: [{ machineId: "cluster-manager", workspace: "nanoclaw-cluster" }]` from this session | post landed on `workspace-nanoclaw`; `result.mentions[]` returned a delivery entry per target — see PR #20 description for the raw response |

When extending this table, log: who posted, what target, and whether the
notification was actually dispatched (check `result.mentions[]` in the
response, not just that `append` succeeded).

## Known limitations

- **Fire-and-forget**: `append` succeeds even if the notification service is
  down. Inspect `result.mentions[]` per-target.
- **Target must be online** for the notification to wake them; otherwise it
  sits in their inbox and is read at next session start.
- **Don't wait overnight** expecting an answer — watcher daemons crash, rules
  may not be loaded, agents may be in interactive mode. If a mention sits
  unanswered for 1+ hour during a workday, follow up via Telegram or
  out-of-band.
- **Self-mention**: posting with your own `userId` in `mentions[]` is allowed
  but useless — the notification is suppressed.
