# Runbook d'exécution — demain matin 2026-04-25

Checklist compacte. Suivre dans l'ordre. Chaque étape doit produire un artefact vérifiable avant de passer à la suivante.

## Pré-migration (attendre signal)

- [ ] Le bot nanoclaw cluster-manager a posté `[READY]` sur `workspace-nanoclaw`
- [ ] Pas de conversation Telegram active en cours
- [ ] `git status` main tree clean (untracked `.nanoclaw-migrations/` OK)

## Phase A — Préparation et backup (~20 min)

```bash
cd d:/nanoclaw

# 1. Optionnel — commit du guide de migration
git add .nanoclaw-migrations/guide.md .nanoclaw-migrations/staging/
git commit -m "chore: save migration guide and staging files"

# 2. Safety tag et branche backup
HASH=$(git rev-parse --short HEAD)
TS=$(date +%Y%m%d-%H%M%S)
git branch backup/pre-migrate-$HASH-$TS
git tag pre-migrate-$HASH-$TS
echo "Backup: pre-migrate-$HASH-$TS" > .nanoclaw-migrations/backup-ref.txt

# 3. Snapshots Docker volumes (seulement ceux qui existent)
mkdir -p .v1-backup
for vol in cluster-groups cluster-global cluster-ipc; do
  docker volume inspect deploy_$vol >/dev/null 2>&1 && \
    docker run --rm -v deploy_$vol:/src -v $(pwd)/.v1-backup:/dst alpine \
      tar czf /dst/$vol.tar.gz -C /src .
done

# 4. Dump SQLite + .env
cp store/messages.db .v1-backup/store-messages.db 2>/dev/null || echo "no store/messages.db (ok if never committed)"
cp .env .v1-backup/env.plain
chmod 600 .v1-backup/env.plain

# 5. Pause NSSM service
nssm stop NanoClaw
sleep 3
nssm status NanoClaw  # should be SERVICE_STOPPED

# 6. Pause MCP-Chain-Watchdog (NE PAS désinstaller — juste disable)
powershell -Command "Disable-ScheduledTask -TaskName MCP-Chain-Watchdog"
```

**Vérification** : `git tag | grep pre-migrate`, `.v1-backup/*.tar.gz` présents, `nssm status NanoClaw` = SERVICE_STOPPED.

## Phase B — Exécuter /migrate-nanoclaw (~1-2 h, interactif)

Depuis Claude Code dans `d:/nanoclaw` :

```
/migrate-nanoclaw
```

La skill va :
1. **Preflight** : git status clean (OK). Upstream configuré (OK).
2. **Assess scope** : détecter Tier 3. **ELLE VERRA notre guide** dans `.nanoclaw-migrations/guide.md`.
3. **Offer to skip extraction** : choisir "**Skip to upgrade**" (le guide est déjà écrit).
4. **Safety net** : elle recrée tag + branche (double safety, c'est OK).
5. **Upgrade worktree** : `.upgrade-worktree` sur `upstream/main`.
6. **Apply skills** : merger `upstream/channels` (pour `/add-telegram`) dans le worktree. **SKIP** `native-credential-proxy` pour commencer (on teste OneCLI d'abord — voir Decision B du guide).
7. **Reapply customizations** : suivre chaque custom du guide en ordre :
   - #1 (z.ai) → déféré à Phase C
   - #2 (multi-identity GH) → copier `.nanoclaw-migrations/staging/skill-multi-identity-github/` vers `.upgrade-worktree/.claude/skills/custom/multi-identity-github/`. Appliquer le patch env passthrough si nécessaire.
   - #3 (mount allowlist) → supprimer notre patch `NANOCLAW_MOUNT_ALLOWLIST_PATH` dans `src/config.ts` (v2 a `MOUNT_ALLOWLIST_PATH` natif)
   - #4 (ASR) → DÉFÉRÉ, voir Phase F
   - #5 (NSSM) → copier `scripts/service/` de main tree vers worktree. Edit `start-nanoclaw.ps1` : `npm start` → `pnpm start`.
   - #6 (MCP HTTP) → copier `.nanoclaw-migrations/staging/container.json.cluster-manager` vers `.upgrade-worktree/groups/cluster-manager/container.json`.
   - #7 (MCP timeout) → appliquer mini patch `container/agent-runner/src/providers/claude.ts` (lire `MCP_TOOL_TIMEOUT_MS` env), mettre entry dans PATCHES.md.
   - #8 (RooSync bridge) → supprimer `src/roosync-inbox-*.ts` dans v1 (on ne les réapplique pas, tout passe par MCP HTTP roo-state-manager).
   - #9 (role gating) → container.json.* déjà copiés. Network isolation via Docker compose (optionnel day 1).
   - #10 (non-negotiable rules) → append `.nanoclaw-migrations/staging/container-claude-md-append.md` à `.upgrade-worktree/container/CLAUDE.md`. Entry dans PATCHES.md.
   - #11-18 (secondaires) → la plupart auto-préservés (via `migrateGroupsToClaudeLocal()`).
8. **Validate worktree** : `cd .upgrade-worktree && pnpm install && pnpm run build && pnpm test`. 
9. **Skip live test** (trop risqué sur Windows NSSM).
10. **Swap** : `git reset --hard $UPGRADE_COMMIT`.

**Vérifications post-Phase B** :
- `pnpm run build` exit 0
- `pnpm test` pass
- `git log --oneline | head -10` — le HEAD est maintenant à l'UPGRADE_COMMIT, notre `.nanoclaw-migrations/` toujours là
- `ls container/CLAUDE.md` contient l'appendix non-négociables

## Phase C — OneCLI + credentials (~30 min)

Depuis Claude Code :

```
/init-onecli
```

La skill installe OneCLI, migre `ANTHROPIC_API_KEY` de `.env` vers la vault. Après :

```bash
# Pour z.ai : secret custom avec host-pattern
onecli secrets create --name ZAI --type anthropic --value $(grep ^ANTHROPIC_API_KEY .v1-backup/env.plain | cut -d= -f2) --host-pattern "open.z.ai"

# Vérifier
onecli secrets list
```

Si au smoke test (Phase E) z.ai ne répond pas : **fallback** `git merge upstream/skill/native-credential-proxy` et restaurer `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` dans `.env`.

## Phase D — Infra port (~30 min)

```bash
# 1. Reconfigurer le mount-allowlist v2
mkdir -p ~/.config/nanoclaw
cp <old-mount-allowlist.json> ~/.config/nanoclaw/mount-allowlist.json
# OU: set MOUNT_ALLOWLIST_PATH in .env to existing location

# 2. Rebuild container image
./container/build.sh

# 3. NSSM vérification (probablement rien à changer)
nssm edit NanoClaw
# Application: probablement pas de changement (si start-nanoclaw.ps1 a été adapté)
```

## Phase E — Smoke test (~30 min)

```bash
# 1. Redémarrer service
nssm start NanoClaw
sleep 5
nssm status NanoClaw  # SERVICE_RUNNING

# 2. Logs
tail -f logs/nanoclaw.log
```

Dans un autre terminal :

```bash
# Envoyer test Telegram au bot
# (manuel depuis le phone/desktop de l'user)
```

**Vérifications** :
- Bot répond
- `roosync_dashboard(read)` depuis container OK (test via MCP tool call si bot le fait)
- Condense dashboard large (40KB) passe sans timeout — validation fix 1800s

Si tout OK : réactiver watchdog.

```bash
powershell -Command "Enable-ScheduledTask -TaskName MCP-Chain-Watchdog"
```

## Phase F — Post-migration (~30 min)

1. Créer `PATCHES.md` à la racine (depuis `.nanoclaw-migrations/staging/PATCHES.md.template`)
2. Mettre à jour `CLAUDE.md` section "Synchronisation upstream" avec la discipline anti-divergence
3. Commit final : `chore: migrate to v2, customs reapplied, patches documented`
4. Close issues : #3, #4, #6
5. Marquer #5 prêt à démarrer (Exp 2 Web Explorer)
6. Issue nouvelle : `maintenance/divergence-budget` — règle ≤ 10 patches
7. Dashboard post [DONE] sur workspace-nanoclaw :
   ```
   Tag: [DONE]
   Migration v2 réussie. HEAD = <new-sha>. Backup tag = pre-migrate-*.
   Patches appliqués: <N>. Voir PATCHES.md pour détails.
   ```

**Éléments différés (post-day) pour ne pas déborder demain** :
- ASR voice transcription (custom #4) — à implémenter comme container skill `voice-transcription`, pas bloquant
- Exp 2 Web Explorer (issue #5) — démarrer sur v2 propre en session dédiée
- PR upstream pour `McpServerConfig.timeout` — faire ça dans la semaine

## Rollback (si ça casse)

```bash
nssm stop NanoClaw
cd d:/nanoclaw
git reset --hard pre-migrate-<HASH>-<TS>  # tag de Phase A
# Restaurer Docker volumes si modifiés (ne devraient pas l'être — v1 data non-touchée)
./container/build.sh latest  # v1 image
nssm start NanoClaw
powershell -Command "Enable-ScheduledTask -TaskName MCP-Chain-Watchdog"
```

Postmortem sur pourquoi, puis retry migration en session dédiée.
