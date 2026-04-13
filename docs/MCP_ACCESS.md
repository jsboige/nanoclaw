# NanoClaw — Acces aux MCPs via le container de proxy

**Pour :** Agent workspace NanoClaw (cluster + explorer).
**Contexte :** NanoClaw est **client** du container de proxy MCPs opere sur ai-01.
**Statut :** Operationnel (single-layer TBXark). Cible future 2 etages documentee en [reference roo-extensions](../../roo-extensions/docs/harness/reference/mcp-proxy-architecture.md).
**MAJ :** 2026-04-13

---

## Architecture d'acces

NanoClaw NE monte PAS les MCPs en stdio. Il les consomme en **HTTP Streamable** via :

```
NanoClaw (container Linux)
      |
      | HTTPS + Bearer
      v
https://mcp-tools.myia.io         <-- sous-domaine public (IIS reverse proxy sur po-2023)
      |
      v
ai-01:9090   TBXark/mcp-proxy container   <-- routes /{server}/mcp
      |
      +--> searxng            (stdio dans le container : npm mcp-searxng)
      +--> sk-agent           (stdio dans le container : python /opt/sk-agent)
      +--> roo-state-manager  (HTTP upstream vers ai-01:9091 Scheduled Task Windows)
                                    ^
                                    Le stdio Node.js de roo-state-manager ne tourne pas
                                    dans le container Linux. Il est proxifie 1 fois par
                                    une tache Windows (TBXark local), puis ce pont HTTP
                                    est consomme en upstream par le container TBXark.
```

Pour l'agent NanoClaw, **la double proxification de roo-state-manager est totalement transparente** : un unique endpoint HTTPS + bearer.

---

## Endpoints disponibles

| MCP | URL | Usage typique |
|-----|-----|---------------|
| `searxng` | `https://mcp-tools.myia.io/searxng/mcp` | Recherche web privee (explorer) |
| `sk-agent` | `https://mcp-tools.myia.io/sk-agent/mcp` | Deliberation multi-perspective, reviews |
| `roo-state-manager` | `https://mcp-tools.myia.io/roo-state-manager/mcp` | Dashboards RooSync, conversation_browser, inbox (cluster seulement) |

**Transport :** MCP Streamable HTTP (pas SSE legacy).
**Auth :** Bearer unique pour les 3 MCPs (voir `MCP_PROXY_BEARER` dans `deploy/.env`).

### Note migration

Quand la migration 2 etages (sparfenyuk sur Windows) sera deployee, les URLs deviendront :
- `https://mcp-tools.myia.io/servers/searxng/mcp` (prefixe `/servers/`)
- idem pour sk-agent et roo-state-manager.

Ne pas hardcoder le prefixe dans le code agent : **toujours lire `MCP_PROXY_BASE_URL`**.

---

## Configuration NanoClaw

### 1. Variables d'environnement (`deploy/.env`)

Ajouter (ou copier depuis `.env.example`) :

```
MCP_PROXY_BASE_URL=https://mcp-tools.myia.io
MCP_PROXY_BEARER=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Le coordinateur ai-01 fournit la valeur de `MCP_PROXY_BEARER` via RooSync (GDrive `.shared-state/secrets/`). **Ne jamais committer ce token.**

### 2. Config MCP cote agent

NanoClaw utilise l'API Claude (z.ai ou Anthropic) avec un client MCP integre. Le format exact depend de la version du runner, mais le schema cible est :

```json
{
  "mcpServers": {
    "roo-state-manager": {
      "transport": "streamable-http",
      "url": "https://mcp-tools.myia.io/roo-state-manager/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_PROXY_BEARER>"
      }
    },
    "sk-agent": {
      "transport": "streamable-http",
      "url": "https://mcp-tools.myia.io/sk-agent/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_PROXY_BEARER>"
      }
    }
  }
}
```

- **Exp. 1 (cluster)** : inclure les 3 MCPs (roo-state-manager, sk-agent, searxng optionnel).
- **Exp. 2 (explorer)** : inclure UNIQUEMENT `sk-agent` et `searxng`. **Pas** de `roo-state-manager` (l'explorer n'a pas acces au cluster).

### 3. Point de branchement dans le code

Le runner `container/agent-runner/src/index.ts` charge aujourd'hui la config MCP. A verifier / a creer :
- Lecture de `process.env.MCP_PROXY_BASE_URL` et `MCP_PROXY_BEARER` au boot.
- Injection de la config `mcpServers` dans l'initialisation du SDK Claude Agent.
- Si l'une des deux variables manque : logguer un warning et demarrer sans MCP (degrade proprement).

Le fichier `deploy/roo-state-manager/` (copie locale package.json + mcp-wrapper.cjs) a ete introduit par une experimentation precedente. **Il n'est plus necessaire** avec l'acces HTTP : on peut le garder comme fallback offline, mais le chemin normal est le proxy.

---

## Verification

Depuis le container NanoClaw :

```bash
# Test d'acces HTTP (depuis l'exterieur du container, ou avec curl installe)
curl -sS -H "Authorization: Bearer $MCP_PROXY_BEARER" \
  "$MCP_PROXY_BASE_URL/roo-state-manager/mcp" | head -c 200
```

Reponse attendue : une erreur JSON-RPC de type "method required" ou le handshake MCP. Si 401 → token invalide. Si 404 → route mal configuree cote ai-01.

**Depuis le SDK Claude Agent**, la validation se fait via un appel `list_tools` au demarrage. Une liste non vide (34 outils pour roo-state-manager) confirme le pont complet.

---

## Securite

- Le reseau `internal` du cluster (Docker `internal: true`) **bloque les sorties HTTP**. Pour que le cluster appelle `https://mcp-tools.myia.io`, le reseau cluster doit avoir une sortie HTTPS autorisee (ou un proxy sortant interne vers ai-01:9090).
- Deux options :
  1. **Recommande** : passer le cluster sur le reseau `web` (comme l'explorer) et laisser le bearer token controler l'acces.
  2. **Alternatif** : ajouter `extra_hosts: host.docker.internal:host-gateway` et appeler directement `http://host.docker.internal:9090` en bearer (contournement local, sans IIS).

La decision appartient a l'utilisateur — documenter dans `deploy/` apres choix.

---

## Checklist de relance turnkey

Pour que le user n'ait qu'a `cd deploy && docker compose up -d` :

- [ ] `deploy/.env` contient `MCP_PROXY_BASE_URL` et `MCP_PROXY_BEARER` (non committes)
- [ ] `deploy/.env.example` documente les 2 variables
- [ ] Agent code lit ces 2 variables et construit la config `mcpServers` HTTP
- [ ] Cluster a une sortie reseau vers `mcp-tools.myia.io` (option 1 ou 2 choisie)
- [ ] Container build a jour (`docker compose build`) si agent-runner modifie
- [ ] Test de handshake `list_tools` reussi au demarrage

---

## Contact / responsabilite

- **Proxy container ai-01** : gere par l'agent coordinateur roo-extensions (ai-01).
- **Bearer token rotation** : sur rotation, le coordinateur pousse le nouveau token via RooSync. NanoClaw redemarre apres `.env` mis a jour.
- **Incident proxy** : GitHub roo-extensions, label `mcp-proxy`.
