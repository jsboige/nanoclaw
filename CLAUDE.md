# NanoClaw — Fork jsboige/nanoclaw (myia-ai-01 deployment)

**Upstream:** [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)
**Fork:** [jsboige/nanoclaw](https://github.com/jsboige/nanoclaw)
**Machine:** myia-ai-01 (coordinateur RooSync)
**MAJ:** 2026-04-11

---

## Mission

Deployer **deux instances NanoClaw** comme assistants IA containerises sur ai-01,
avec des profils de securite opposes (issue parente: [roo-extensions#921](https://github.com/jsboige/roo-extensions/issues/921)).

| | Exp. 1 : Cluster Manager | Exp. 2 : Web Explorer |
|---|---|---|
| **Container** | `nanoclaw-cluster` | `nanoclaw-explorer` |
| **Port** | 3101 | 3102 |
| **Mission** | Gerer les 5 machines executrices | Explorer le web, rechercher, synthetiser |
| **MCPs** | roo-state-manager, sk-agent, desktop-ctrl | sk-agent, playwright |
| **Reseau** | Interne UNIQUEMENT (pas de web) | Web filtre (pas d'acces interne) |
| **RooSync** | Oui (volume RO) | Non |
| **Risque** | Acces critique cluster → sandboxe serre | Acces web libre → pas d'acces systeme |

## Architecture upstream (reference)

Voir [CLAUDE.upstream.md](CLAUDE.upstream.md) pour la documentation upstream complete.

**Resume :** Single Node.js process, skill-based channels (WhatsApp, Telegram, Slack, Discord, Gmail),
Claude Agent SDK dans des containers Docker isoles, SQLite, per-group memory.

---

## Structure du fork

```
deploy/                 # Config Docker specifique ai-01
  docker-compose.yml    # Compose avec 2 services (cluster + explorer)
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
# Editer deploy/.env avec les bonnes valeurs (ANTHROPIC_API_KEY, ROOSYNC_SHARED_PATH)

# 3. Builder le container agent
./container/build.sh
# OU sur Windows :
docker build -t nanoclaw-agent -f container/Dockerfile container/

# 4. Lancer les deux experiences
cd deploy && docker compose up -d

# 5. Verifier
docker compose ps
docker compose logs -f nanoclaw-cluster
docker compose logs -f nanoclaw-explorer
```

### Developpement local (sans Docker)

```bash
npm run dev          # Hot reload
npm run build        # Compile TypeScript
npm test             # Tests vitest
```

---

## Experiences

### Exp. 1 : Cluster Manager (`nanoclaw-cluster`)

**Objectif :** Assister la gestion des 5 machines executrices depuis ai-01.

**Acces autorises :**
- MCP roo-state-manager : coordination RooSync, dashboards, conversation_browser, inbox
- MCP sk-agent : deliberation multi-perspective, reviews, analyses
- MCP desktop-control (futur) : interaction avec les machines distantes

**Contraintes de securite :**
- Reseau Docker `internal` (bridge, `internal: true`) — pas d'acces internet
- Acces uniquement aux ports internes (vLLM 5001/5002, Qdrant 6333, roo-state-manager)
- Volume RooSync en lecture seule
- Pas d'acces aux volumes sensibles du host (.env, credentials, SSH keys)

### Exp. 2 : Web Explorer (`nanoclaw-explorer`)

**Objectif :** Explorer le web, rechercher et synthetiser de l'information.

**Acces autorises :**
- MCP sk-agent : analyses et deliberations
- MCP playwright : navigation web sandboxee dans le container
- Acces HTTP/HTTPS sortant (optionnellement filtre via proxy)

**Contraintes de securite :**
- Reseau Docker `web` (bridge standard) — acces internet
- PAS d'acces au reseau interne (pas de vLLM, Qdrant, roo-state-manager)
- PAS de volume RooSync
- Pas d'acces filesystem host, Docker socket, SSH

---

## Integration RooSync (Exp. 1 seulement)

### Bridge prevu (roo-extensions#1319)

NanoClaw Cluster sera connecte au cluster RooSync via un skill custom qui expose
les outils roo-state-manager (dashboard, messages, search) comme des
capabilities du container agent.

### Volumes Docker

| Volume | Service | Contenu | Mode |
|--------|---------|---------|------|
| `cluster-groups` | cluster | Workspaces par groupe | RW |
| `cluster-global` | cluster | Memoire globale | RW |
| `cluster-ipc` | cluster | IPC tasks | RW |
| `roosync` | cluster | `.shared-state/` GDrive | RO |
| `explorer-groups` | explorer | Workspaces par groupe | RW |
| `explorer-global` | explorer | Memoire globale | RW |
| `explorer-ipc` | explorer | IPC tasks | RW |

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
- [#921](https://github.com/jsboige/roo-extensions/issues/921) — Investigation OpenClaw (issue parente, 2 experiences)
- [#1073](https://github.com/jsboige/roo-extensions/issues/1073) — Analyse comparative Claw (recommande NanoClaw)
- [#1318](https://github.com/jsboige/roo-extensions/issues/1318) — Deploy NanoClaw v1 on ai-01
- [#1319](https://github.com/jsboige/roo-extensions/issues/1319) — Bridge NanoClaw <-> RooSync
- [#1320](https://github.com/jsboige/roo-extensions/issues/1320) — Adopt claw-code harness patterns

---

## Regles

1. Ne pas modifier les fichiers upstream sans raison — preferer des ajouts dans `deploy/` et `.claude/`
2. Tester le build Docker apres toute modification
3. Garder la synchronisation upstream facile (pas de divergence inutile)
4. Les credentials Docker/API vont dans `.env` (gitignored), jamais dans le code
5. Les deux experiences sont ISOLEES — ne jamais partager volumes ou reseaux entre elles
