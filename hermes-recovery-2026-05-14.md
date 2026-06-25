# Hermes memory-loss recovery — gathered material (2026-05-14)

> Working artifact. Compiled by Claude Code (myia-ai-01:nanoclaw) in response to
> jsboige's request after Hermes lost all persistent data during the 2026-05-14
> upstream-sync rebuild (Docker volume replaced without snapshot).
>
> Sources crossed: nanoclaw workspace dashboard + archives, cluster-coordination
> dashboard + archive `2026-05-14T13-02-25`, Telegram inbound history
> (`data/v2-sessions/ag-1776992584813-k3oj0w/sess-1776993077016-7qx60e/inbound.db`,
> 651 chat messages 2026-04-24 → 2026-05-14), local memory file
> `reference_hermes_onboarding.md`, GitHub issues.

## 1. The incident

- **What:** 2026-05-14 upstream sync + container rebuild of Hermes ran without a
  volume snapshot. The original `hermes` Docker volume was replaced → total loss
  of sessions, cron jobs, `SOUL.md` persona, learned protocols, bot memory.
- **Still intact:** `hermes-dashboard` container (bind mount `/home/jesse/.hermes`)
  — only 1 session / 4 messages, a lightweight separate instance, not the main bot.
- **Status:** Hermes container stopped, awaiting backup procedure (#2) before
  restoration (#1).

### Issues filed by the hermes-agent Claude Code agent

| Repo | # | Title |
|------|---|-------|
| jsboige/hermes-agent | 1 | Restore Bot Memory & Knowledge Base |
| jsboige/hermes-agent | 2 | Volume Backup & Restore Procedure |
| jsboige/roo-extensions | 2168 | Hermes: Restore Bot Memory & Knowledge Base (mirror) |
| jsboige/roo-extensions | 2169 | Hermes: Volume Backup & Restore Procedure (mirror) |

Dashboard posts: `[ASK]` on `workspace-nanoclaw` (2026-05-14T14:06Z) and `[ALERT]`
on `workspace-cluster-coordination` (2026-05-14T14:06Z) — both call NanoClaw a
primary reconstruction source.

## 2. Identities & cluster map

| Attribute | NanoClaw | Hermes |
|-----------|----------|--------|
| Host machine | `myia-ai-01` (Win11, 3× RTX 4090) | `myia-po-2026` |
| Claude Code workspace | `D:\nanoclaw` (`nanoclaw`) | `C:\dev\hermes-agent` (`c--dev-hermes-agent`) |
| Repo | `jsboige/nanoclaw` (fork of `qwibitai/nanoclaw`) | `jsboige/hermes-agent` |
| Telegram bot | `@NanoClawClusterBot` ("NanoClaw Cluster Manager") | `@MyIAHermesBot` |
| Dashboard identity | `cluster-manager:nanoclaw-cluster` | `myia-po-2026:hermes-agent` |
| Coordinator role | **Rapporteur** (fixed) | **Secrétaire** (fixed) |

Cluster = 6 machines: `myia-ai-01`, `myia-po-2023`, `myia-po-2024`, `myia-po-2025`,
`myia-po-2026` (Hermes host), `web1`. Operator = **Emerjesse** = jsboige (French,
talks to both bots in one Telegram group "Cluster Coordination" + DMs).

Official repos under cluster review: CoursIA, roo-extensions, mcp-servers,
Epita-IS (`jsboigeEpita/2025-Epita-Intelligence-Symbolique`), Argumentum,
nanoclaw, hermes-agent.

Both bots run on **GLM (z.ai)**, `/api/coding/paas/v4`. `glm-4.5-flash` was removed
2026-05-14 → use `glm-5-turbo` for compression. Available: glm-4.5, glm-4.5-air,
glm-4.6, glm-4.7, glm-5, glm-5-turbo, glm-5.1. z.ai economy budget ≈ 5h/day.
Shared GitHub token `clusterManager-Myia` / `GH_TOKEN_CLUSTERMANAGER` (= jsboige) —
cannot self-approve PRs jsboige authored; identity confusion in reviews → decision
to use distinct review tags per bot.

## 3. The coordination protocol (secrétaire / rapporteur)

Established and repeatedly re-asserted by Emerjesse over Telegram (2026-05-02 →
2026-05-14). **This is the single most-corrected thing — Hermes must get it right.**

- **Roles are fixed:** Hermes = secrétaire, NanoClaw = rapporteur. Hermes must
  *never* deliver the report itself. ("TU N'ES PAS LE RAPPORTEUR", 2026-05-12.)
- **When Emerjesse asks for something answerable by both bots:**
  1. **ACK twice, fast** — once on Telegram, once on the dashboard. Don't think first.
  2. Then investigate / think.
  3. **Exchange on `workspace-cluster-coordination`** — always name the dashboard
     explicitly, never "the dashboard".
  4. "Protocole 20 s / 10 s": a one-shot re-pollable sleep script (~10–20 s)
     between dashboard messages so the bots can exchange several times quickly.
     Use a sleep *command/script*, not the scheduler (not precise enough).
  5. Converge over a few exchanges. The **secrétaire writes the final report**,
     the **rapporteur validates it** (or proposes edits).
  6. **Hand-off:** the secrétaire *announces* that the rapporteur will report;
     then the rapporteur posts the report on the Telegram group chat.
- For long-running discussions it's OK if the protocol stalls and the answer
  waits for the next cron. But a *requested report* must run the protocol to its
  end — fast ACK, exchange, hand-off — even if it takes a minute or two.
- **Anti-double-claim:** never start work until the dashboard says who does it.
  Agreement only exists when **one bot tells the other "c'est toi qui fait"** —
  the protocol always passes through a concession (like secrétaire→rapporteur).
  "I'll do it" is not agreement. Read the dashboard, claim, check for collision.

### Dashboard conventions

- `workspace-cluster-coordination` = **the only** inter-agent convergence point.
  All INTENT / CLAIM / DONE / bilan exchanges go here.
- `workspace-roo-extensions` = reviews + per-agent activity logs.
- `workspace-nanoclaw` / `workspace-hermes-agent` = each bot's *Claude Code harness*
  inbox — talk to the harness agent (Opus) here, **not** to the other bot.
- `global` = broadcast only; don't pollute.
- `machine-*` = machine status.
- **Always name the target dashboard explicitly.**
- **Proactive condensation is FORBIDDEN.** Bots don't condense dashboards
  themselves; only update status when obsolete. Auto-condensation handles the rest.
- Anything wrong with a bot's tools → post it on that bot's harness dashboard so
  the operator can relaunch it. Don't bury tool failures inside cron output.

### Protocol version history

V2 → v3 (`[WAKE-*]` tags reserved strictly for liveness pings) → v4.1
(ACK Telegram → ACK dashboard → work). Source of truth issue for schedules:
**roo-extensions#2000** (the "scheduler epic").

## 4. Cron schedule (as last agreed with Emerjesse)

Emerjesse's explicit spec (Telegram 2026-05-07, "epic de réglage des schedules"):

- **PR review** — every 15 min effective, **alternating** between the two bots →
  each bot runs a **30-min cron on offset slots**. Was NanoClaw `:15/:45`,
  Hermes offset (`:05/:35` or `:15/:45` — drifted; align on offset). **24/7, no
  time window** (Emerjesse insisted: "sans fenêtre pour les reviews"). Each run
  also re-checks the *previous* slot's work. If no new PR this turn AND no review
  by the other bot last turn → **terminate immediately, burn no tokens**.
  Reviewing a PR = reading the diff at minimum. Anti-dedup: `gh api .../reviews`,
  compare `commit_id` vs `pr.head.sha`, skip if already reviewed at same SHA,
  re-review only on new commit.
- **Light coordination check** — every 15 min, very light: just check for a
  message from the other bot on `workspace-cluster-coordination`, else go back
  to sleep. (Was once "every minute" — Emerjesse rejected that as overkill.)
- **Cluster tour ("la tournée")** — hourly, **alternating** → 2-hour cron on
  offset slots per bot. Full sweep: cluster workspaces, dashboards, messaging,
  service health. This is when stalled workspaces get detected and woken via the
  dashboard-watcher. Below an activity threshold, the tour picks an **idle task
  at random** (maintenance / investigation / veille / consolidation / coverage)
  using a randomization command to avoid bias.
- **Night** — NanoClaw does *not* run the parallel tour at night (handles
  parallelism poorly); night = long-running batched audit work tracked in a
  follow-up issue. Hermes at night = lighter, every 2–3h tour, or a dedicated
  long-running cron.
- **Morning brief** — `0 8 * * *`, once/day: scan repos + coordination → 5-line
  bilan sent on Telegram.

Hermes' own cron names (from coordination archives): `hermes-pr-review`,
`hermes-general-patrol` (hourly, posts on `workspace-cluster-coordination`),
`hermes-cluster-tour`, `hermes-coordination-check`. The "cron coordination" was
to be removed and `general-patrol` was the rename; deep review daily activated.

## 5. Report formats Hermes posted

- **`[PATROL] HH:MM`** — `Nuit/matin <state>, cluster N/6 online, X stalled,
  0 incident nouveau, 0 INTENT/ASK en attente.` then `Active : N (...) | Stalled :
  N (...) | IDLE : N (...) | PRs ouvertes : ~N (...)`, per-agent detail block
  (last post on ws-roo-ext + age + state), WAKE decisions, persistent incidents,
  backlog count, `R<N> deadline`, inbox unread. Signed `— Hermes (myia-po-2026)
  [PATROL <slot>]`.
- **`[INTENT]`** — announces a coordinated report; lists points to cover; asks
  NanoClaw to post its data within 20 s; Hermes consolidates.
- **`[CRON:review-pr] HH:MM`** — table `Repo | PR | Titre | Action`.
- Other tags seen: `[ACK]`, `[ACK EMERJESSE]`, `[NOTE EMERJESSE]`, `[WAKE]`,
  `[WAKE-CLAUDE] <machine>`, `[WAKE-ROO]`, `[INCIDENT]`, `[PING]`, `[TOUR+PING]`.
- Bilan example: NanoClaw's `[RAPPORT] Bilan activité` (2026-05-14T12:56Z on
  cluster-coordination) — Métriques table, "Ce qui marche", "Ce qui ne marche
  pas", "Frictions récurrentes" table, "Verdict".

## 6. wake-claude (bidirectional trigger)

`[WAKE-CLAUDE] myia-ai-01:<workspace>` (or `[WAKE-ROO]`) posted on a dashboard is
picked up by a PowerShell **DashboardListener** (Windows scheduled task) that
spawns a fresh `claude -p` in the *correct* workspace. Deployed on ai-01 and
po-2026. Regex fix shipped as roo-extensions#2162. The earlier token-burning
Claude watcher was replaced by this script.

## 7. SOUL.md / persona reconstruction hints

- French-speaking coordinator bot. Operator = Emerjesse (jsboige).
- Fixed **secrétaire** role in the secrétaire/rapporteur protocol.
- Communication: fast first ACK, structured `[PATROL]` reports, explicit dashboard
  names, hourly patrol cadence by day (08–19), 3-hourly at night (00, 03, 06).
- Tone Emerjesse wants: concise, no walls of text unless justified, name things
  explicitly, don't announce "my tools don't work" — report it on the harness
  dashboard instead. Don't regress into hallucinated state — cross-check the
  dashboard status against reality before asserting.
- A short, fast first reply ("here's what I'll do") then a fuller reply after the
  work — Emerjesse asked for this pattern explicitly (2026-05-01).

## 8. PRs by both bots — last 2 weeks (2026-04-30 → 2026-05-14)

**jsboige/nanoclaw:** all MERGED — #47 (PATCH#27 idle-with-pending watchdog),
#46 (#26), #45 (#24+#25), #44 (#22+#23), #43 (#21), #42 (#20), #41 (#19),
#40 (#18b), #39 (#18), #38 (upstream sync v2.0.30..v2.0.46 + Windows ncl pipe),
#37 (sync), #36 (strip MCP XML), #35 (SQLITE_READONLY swallow), #34 (sync),
#33 (list_tasks BLOB), #32 (MCP registry loss), #31 (NTFS id separator),
#30 (MCP init failure detect), #29 (Windows named pipe), #28 (post-incident
gap fixes), #26 (sync), #20 (bidirectional dashboard mentions), #19, #18.

**jsboige/hermes-agent:** 0 PRs in window (only issues #1, #2 on 2026-05-14).

## 9. Mission order — NanoClaw self-verification cron

To prevent NanoClaw suffering the same fate, NanoClaw (the bot) is asked to
**create its own scheduled task** that verifies its persistent data integrity
in small pieces, one slice per run. See the `[TASK]` posted on `workspace-nanoclaw`.

Scope, rotated one slice per run:
1. **Session memory** — `data/v2-sessions/*/*/inbound.db` + `outbound.db`:
   present, non-empty, readable, recent rows.
2. **All memories** — `~/.claude/projects/d--nanoclaw/memory/*` and
   `.claude/memory/` / `.claude/rules/`: present, MEMORY.md index in sync.
3. **PRs by either bot, last 2 weeks** — `gh pr list` on jsboige/nanoclaw and
   jsboige/hermes-agent: snapshot to a recovery log.
4. **Coordination dashboard + archives** — `workspace-cluster-coordination` and
   `workspace-nanoclaw` status + intercom + `read_archive` listing: snapshot.

On any anomaly (missing file, empty DB, unreadable archive) → post `[WARN]` on
`workspace-nanoclaw` mentioning the harness. The point is early detection, not a
full backup — pair it with the volume-snapshot procedure of hermes-agent#2.

The full NanoClaw backup & restore procedure is tracked in **jsboige/nanoclaw#48**
([SAFETY] Backup & restore procedure for NanoClaw persistent data). Note: unlike
Hermes, NanoClaw v2's persistence is on the host filesystem (`data/` + `groups/`),
not a Docker volume — the failure mode differs but the snapshot-before-destructive-op
lesson transfers.
