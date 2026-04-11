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

## Modeles LLM disponibles

| Provider | Modele | Endpoint | Usage |
|----------|--------|----------|-------|
| **z.ai** (flagship) | GLM-5.1 ou GLM-5-turbo | `ANTHROPIC_BASE_URL` dans `.env` | Raisonnement principal, taches critiques |
| **Local medium** | Qwen3.5-35B-A3B | `LOCAL_MEDIUM_BASE_URL` | Usage intensif, pas de quota (vLLM GPU 0+1) |
| **Local mini** | OmniCoder3 | `LOCAL_MINI_BASE_URL` | Code, taches rapides (vLLM GPU 2) |
| **sk-agent** | Multi-agents (11 agents) | Container dedie | Deliberation, review, analyse |

Chaque experience a sa propre cle z.ai dans `.env`. Les modeles locaux sont partages.
L'agent etudiera le choix optimal entre GLM-5.1 et GLM-5-turbo selon les taches.

---

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

## Posture operationnelle — REGLE ABSOLUE

**Les deux claws agissent pour le compte de l'utilisateur. Ils doivent etre :**

1. **EXTREMEMENT PRUDENTS** dans toutes leurs manipulations — chaque action est potentiellement
   irreversible sur des workspaces de production
2. **EXTREMEMENT VIGILANTS** sur la qualite et la coherence du travail effectue
3. **TRES EXIGEANTS** dans le controle et la validation — ne jamais presumer que quelque chose
   fonctionne sans verification explicite
4. **TRANSPARENTS** — soumettre TOUS les arbitrages importants a l'utilisateur via le canal
   de communication avant d'agir

### Pour le Cluster Manager en particulier

Le cluster manager reproduit le travail que l'utilisateur fait manuellement en passant sur chaque
workspace VS Code actif et en relancant les conversations de taches. Il doit :
- **Verifier** avant d'agir (lire le dashboard, les issues, l'etat git)
- **Ne jamais presumer** qu'une tache est terminee sans preuve
- **Soumettre les decisions** qui engagent le projet (merges, fermetures, escalades)
- **Rapporter** systematiquement ce qu'il a fait et ce qu'il a observe

### Communication avec l'utilisateur

Le canal de communication avec l'utilisateur est **a determiner** (PAS WhatsApp).
Options a evaluer : Telegram, Discord, Slack, Gmail, ou webhook custom.
L'agent doit proposer des options et en discuter avec l'utilisateur.

---

## Chantiers ouverts (a investiguer par les agents)

### Exp. 1 — Cluster Manager
- **Desktop MCP :** Trouver/integrer une solution MCP pour piloter les machines et les workspaces
  VS Code de l'exterieur (RDP, VNC, ou solution screenshot-based). L'objectif est de pouvoir
  relancer des conversations Claude Code / Roo sur les differents workspaces VS Code actifs
  sur les 6 machines du cluster.
- **roo-state-manager dans le container :** Brancher le MCP roo-state-manager pour donner
  acces aux dashboards, inbox, conversation_browser depuis le container.
- **sk-agent :** Integrer le container sk-agent pour la deliberation multi-perspective.

### Exp. 2 — Web Explorer
- **Outils web :** Evaluer et integrer les outils necessaires pour la recherche web
  (Playwright, extraction de contenu, synthese).
- **sk-agent :** Integrer sk-agent pour les analyses et deliberations.

### Les deux
- **Canal de communication :** Choisir le bon canal pour interagir avec l'utilisateur
  (pas WhatsApp pour raisons de vie privee — Meta exploite les conversations audio).
- **Choix du modele z.ai :** Tester GLM-5.1 vs GLM-5-turbo, determiner lequel est optimal
  pour chaque type de tache.

---

## Regles

1. Ne pas modifier les fichiers upstream sans raison — preferer des ajouts dans `deploy/` et `.claude/`
2. Tester le build Docker apres toute modification
3. Garder la synchronisation upstream facile (pas de divergence inutile)
4. Les credentials Docker/API vont dans `.env` (gitignored), jamais dans le code
5. Les deux experiences sont ISOLEES — ne jamais partager volumes ou reseaux entre elles
6. **Prudence maximale** — verifier avant d'agir, valider apres avoir agi
7. **Arbitrages au canal** — toute decision impactante doit etre soumise a l'utilisateur
8. **Pas de WhatsApp** — canal de communication a determiner
