# Dashboard Mentions Protocol

This workspace (`D:/nanoclaw` on `myia-ai-01`) participates in a cluster-wide
mentions intercom over the `roo-state-manager` dashboard system. Other agents
(notably the Telegram bot **ClusterManager** running in a NanoClaw container,
and Claude Code sessions on the other 5 cluster machines) post `[ASK]` /
`[INCIDENT]` / `[REVIEW]` messages mentioning this workspace when they need
the local Claude Code to act.

A mention targeting this workspace looks like:

```ts
roosync_dashboard(action: "append", type: "workspace", workspace: "nanoclaw",
  tags: ["ASK"],
  content: "<concise context + suspected file:line>",
  mentions: [{ userId: { machineId: "myia-ai-01", workspace: "nanoclaw" } }])
```

## At session start (mandatory)

Run, in this order, before any other work:

1. `roosync_dashboard(action: "read", type: "workspace", workspace: "nanoclaw")`
2. Scan the returned `intercom.recentMessages` for posts where:
   - `mentions[]` includes `{ machineId: "myia-ai-01", workspace: "nanoclaw" }`, AND
   - the message is unanswered (no later `[REPLY]` / `[DONE]` from this workspace
     referencing it by `messageId`), AND
   - timestamp is within the last 7 days
3. If any qualify, surface them to the user **before** starting whatever the user
   asked for — these are explicit asks from the cluster that are likely related
   or higher priority than the user's current intent.

If none qualify, proceed silently. Don't narrate the empty result.

## When to mention back

After meaningful work (PR opened, incident root-caused, harness change shipped),
post a structured reply mentioning the bot so it learns the work is done:

```ts
roosync_dashboard(action: "append", type: "workspace", workspace: "nanoclaw",
  tags: ["DONE"],
  content: "Resolved: <short summary> — see PR #N",
  mentions: [{ userId: { machineId: "cluster-manager", workspace: "nanoclaw-cluster" } }])
```

The bot's identity in this dashboard system is `cluster-manager:nanoclaw-cluster`
(verified via the `lastModifiedBy` of recent `[ClusterManager — Tour …]` posts).

Do not mention the bot for routine churn — only when:

- A PR you opened touches the bot's harness, container, or scheduling subsystem.
- You fixed an incident the bot reported (or could not).
- You made a decision the bot is waiting on (e.g., merge of an upstream PR).
- The user explicitly asks you to relay something to the bot.

## When to ASK the bot

If you need the bot to do something you cannot do yourself (run a long
monitoring sweep, condense a dashboard, restart a service in a different
session, gather data from other cluster machines), mention it with `[ASK]`:

```ts
roosync_dashboard(action: "append", type: "workspace", workspace: "nanoclaw",
  tags: ["ASK"],
  content: "[ASK] <what you need + why> — by <when>",
  mentions: [{ userId: { machineId: "cluster-manager", workspace: "nanoclaw-cluster" } }])
```

Wait for a reply before assuming the work is done. The bot's tour cadence is
hourly during the day (08-19) and 3-hourly at night (00, 03, 06).
