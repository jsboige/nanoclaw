/**
 * One-shot patch: point the ClusterManager bot's MCP servers (roo-state-manager,
 * sk-agent) directly at the local TBXark proxy (myia-mcp-proxy, published on
 * 0.0.0.0:9090 on this host) instead of through the public HTTPS edge
 * https://mcp-tools.myia.io.
 *
 * Why: 2026-06-21 myia-po-2023 crashed, taking down the IIS ARR reverse proxy
 * that fronts mcp-tools.myia.io. The actual MCP backend (TBXark) runs locally on
 * ai-01 and is healthy — the bot was just routing ai-01 -> po-2023 -> back to
 * ai-01:9090, an absurd round-trip through a dead hop. Going direct via
 * host.docker.internal:9090 keeps BOTH servers and the same bearer, drops the
 * dead edge, and incidentally sidesteps the TLS layer entirely (loopback HTTP).
 *
 * Hermes (po-2026) already connects straight to ai-01:9090 — same pattern.
 *
 * Bearer is unchanged: MCP_PROXY_BEARER == TBXark authToken (ad28ecc7…), which
 * TBXark accepts directly on :9090 (verified: POST initialize -> HTTP 200).
 *
 * --allow-http (added 2026-06-24): the MCP servers are stdio bridges spawned via
 * `npx -y mcp-remote <url> ...`. Current mcp-remote REFUSES plain-http:// URLs for
 * any host that isn't localhost ("Non-HTTPS URLs are only allowed for localhost or
 * when --allow-http flag is provided") and exits, so the SDK reports the server
 * `failed` at init. The original edge URL was https:// (accepted); switching to the
 * loopback http:// proxy tripped that guard. host.docker.internal is not localhost,
 * so the DIRECT (http) config MUST carry --allow-http. This is safe: the traffic is
 * loopback to the host's TBXark proxy and already authenticated by the bearer.
 * The EDGE (https) config drops the flag (https is always allowed). This script
 * keeps the flag in sync with the scheme on every run, and is idempotent.
 *
 * Usage:
 *   pnpm exec tsx scripts/bypass-mcp-edge.ts            # apply bypass (http + --allow-http)
 *   pnpm exec tsx scripts/bypass-mcp-edge.ts --revert   # restore edge URL (https, no flag)
 *
 * After running, restart the bot so the container respawns with the new config:
 *   ncl groups restart --id ag-1776992584813-k3oj0w
 *   (or Stop-Service / Start-Service nanoclaw)
 */
import Database from 'better-sqlite3';
import path from 'node:path';

const AG_ID = 'ag-1776992584813-k3oj0w';
const EDGE = 'https://mcp-tools.myia.io';
const DIRECT = 'http://host.docker.internal:9090';

const revert = process.argv.includes('--revert');
// targetBase = where URLs should point after this run; otherBase = where they might be now.
const [targetBase, otherBase] = revert ? [EDGE, DIRECT] : [DIRECT, EDGE];
const needsAllowHttp = targetBase.startsWith('http://'); // mcp-remote refuses non-localhost http without it

const dbPath = path.resolve('data/v2.db');
const db = new Database(dbPath);

const row = db
  .prepare('SELECT mcp_servers FROM container_configs WHERE agent_group_id = ?')
  .get(AG_ID) as { mcp_servers: string } | undefined;
if (!row) throw new Error(`No container_configs row for ${AG_ID}`);

const cfg = JSON.parse(row.mcp_servers) as Record<
  string,
  { command: string; args: string[]; env?: Record<string, string>; timeout?: number }
>;

let changed = false;
for (const name of Object.keys(cfg)) {
  const args = cfg[name].args;
  // 1. Rewrite the base URL (otherBase -> targetBase) wherever it appears.
  for (let i = 0; i < args.length; i++) {
    if (args[i].includes(otherBase)) {
      args[i] = args[i].replace(otherBase, targetBase);
      changed = true;
    }
  }
  // 2. Keep --allow-http in sync with the scheme: present for http://, absent for https://.
  const hasFlag = args.includes('--allow-http');
  if (needsAllowHttp && !hasFlag) {
    const urlIdx = args.findIndex((a) => a.includes('/mcp'));
    args.splice(urlIdx >= 0 ? urlIdx + 1 : args.length, 0, '--allow-http');
    changed = true;
  } else if (!needsAllowHttp && hasFlag) {
    cfg[name].args = args.filter((a) => a !== '--allow-http');
    changed = true;
  }
  const url = cfg[name].args.find((a) => a.includes('/mcp'));
  const flag = cfg[name].args.includes('--allow-http') ? ' (--allow-http)' : '';
  console.log(`${revert ? 'edge' : 'direct'} ${name}: ${url}${flag}`);
}

if (!changed) {
  console.log(
    `No-op: already on ${revert ? 'edge (https)' : 'direct (http + --allow-http)'}.`,
  );
  console.log('CURRENT:', row.mcp_servers);
  db.close();
  process.exit(0);
}

const newJson = JSON.stringify(cfg);
db.prepare(
  'UPDATE container_configs SET mcp_servers = ?, updated_at = ? WHERE agent_group_id = ?',
).run(newJson, new Date().toISOString(), AG_ID);

const after = db
  .prepare('SELECT mcp_servers FROM container_configs WHERE agent_group_id = ?')
  .get(AG_ID) as { mcp_servers: string };
console.log('AFTER:', after.mcp_servers);
db.close();
