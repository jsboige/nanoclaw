# NanoClaw — Fork jsboige/nanoclaw (myia-ai-01 deployment)

**Upstream:** [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)
**Fork:** [jsboige/nanoclaw](https://github.com/jsboige/nanoclaw)
**Machine:** myia-ai-01 (coordinateur RooSync)
**MAJ:** 2026-04-11

---

## Mission

Deployer NanoClaw comme assistant IA containerise sur ai-01, integre au cluster RooSync multi-agent.
Le fork contient les configs Docker et les customisations specifiques a notre infrastructure.

## Architecture upstream (reference)

Voir [CLAUDE.upstream.md](CLAUDE.upstream.md) pour la documentation upstream complete.

**Resume :** Single Node.js process, skill-based channels (WhatsApp, Telegram, Slack, Discord, Gmail),
Claude Agent SDK dans des containers Docker isoles, SQLite, per-group memory.

---

## Structure du fork

```
deploy/                 # Config Docker specifique ai-01
  docker-compose.yml    # Compose pour deploiement
  .env.example          # Template variables d'environnement
  .env                  # Variables reelles (gitignored)
container/              # Dockerfile + agent-runner (upstream)
src/                    # Code source NanoClaw (upstream)
groups/                 # Workspaces par groupe (upstream)
.claude/                # Configuration Claude Code (notre fork)
CLAUDE.md               # Ce fichier
CLAUDE.upstream.md      # CLAUDE.md original upstream
```

---

## Deploiement sur ai-01

### Prerequis

- Docker Desktop installe et fonctionnel
- Node.js 20+
- Claude Code CLI installe
- Acces au Google Drive RooSync (`.shared-state/`)

### Setup initial

```bash
# 1. Installer les dependances
npm install

# 2. Copier et configurer l'environnement
cp deploy/.env.example deploy/.env
# Editer deploy/.env avec les bonnes valeurs

# 3. Builder le container agent
./container/build.sh
# OU sur Windows :
docker build -t nanoclaw-agent -f container/Dockerfile container/

# 4. Lancer avec Docker Compose
cd deploy && docker compose up -d

# 5. Verifier
docker compose logs -f nanoclaw
```

### Developpement local (sans Docker)

```bash
npm run dev          # Hot reload
npm run build        # Compile TypeScript
npm test             # Tests vitest
```

---

## Integration RooSync

### Bridge prevu (#1319)

NanoClaw sera connecte au cluster RooSync via un skill custom qui expose
les outils roo-state-manager (dashboard, messages, search) comme des
capabilities du container agent.

### Volumes Docker

| Volume | Contenu | Mode |
|--------|---------|------|
| `nanoclaw-groups` | Workspaces par groupe | RW |
| `nanoclaw-global` | Memoire globale | RW |
| `nanoclaw-ipc` | IPC tasks | RW |
| `roosync` | `.shared-state/` GDrive | RO |

---

## Synchronisation upstream

Pour recuperer les mises a jour upstream :

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
git fetch upstream
git merge upstream/main --no-edit
# Resoudre conflits si necessaire, surtout dans deploy/ et CLAUDE.md
```

---

## Conventions

- **Language :** Code/commits en anglais. Communication coordination en francais.
- **Commits :** Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)
- **Secrets :** JAMAIS dans git. Utiliser `deploy/.env` (gitignored) ou OneCLI vault.
- **Docker :** Toujours tester le build container avant push.

---

## Coordination

Ce workspace fait partie du cluster RooSync (6 machines).
Le dashboard est accessible via `roosync_dashboard(type: "workspace")` depuis roo-state-manager.

**Issues liees (roo-extensions) :**
- [#1318](https://github.com/jsboige/roo-extensions/issues/1318) — Deploy NanoClaw v1 on ai-01
- [#1319](https://github.com/jsboige/roo-extensions/issues/1319) — Bridge NanoClaw <-> RooSync
- [#1320](https://github.com/jsboige/roo-extensions/issues/1320) — Adopt claw-code harness patterns

---

## Regles

1. Ne pas modifier les fichiers upstream sans raison — preferer des ajouts dans `deploy/` et `.claude/`
2. Tester le build Docker apres toute modification
3. Garder la synchronisation upstream facile (pas de divergence inutile)
4. Les credentials Docker/API vont dans `.env` (gitignored), jamais dans le code
