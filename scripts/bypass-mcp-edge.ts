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
 * Usage:
 *   pnpm exec tsx scripts/bypass-mcp-edge.ts            # apply bypass
 *   pnpm exec tsx scripts/bypass-mcp-edge.ts --revert   # restore edge URL
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
const [from, to] = revert ? [DIRECT, EDGE] : [EDGE, DIRECT];

const dbPath = path.resolve('data/v2.db');
const db = new Database(dbPath);

const row = db
  .prepare('SELECT mcp_servers FROM container_configs WHERE agent_group_id = ?')
  .get(AG_ID) as { mcp_servers: string } | undefined;
if (!row) throw new Error(`No container_configs row for ${AG_ID}`);

if (!row.mcp_servers.includes(from)) {
  console.log(
    `No-op: "${from}" not present in mcp_servers (already ${revert ? 'reverted' : 'bypassed'}?).`,
  );
  console.log('CURRENT:', row.mcp_servers);
  db.close();
  process.exit(0);
}

const cfg = JSON.parse(row.mcp_servers) as Record<
  string,
  { command: string; args: string[]; env?: Record<string, string>; timeout?: number }
>;

for (const name of Object.keys(cfg)) {
  cfg[name].args = cfg[name].args.map((a) => a.replace(from, to));
  const url = cfg[name].args.find((a) => a.includes('/mcp'));
  console.log(`${revert ? 'reverted' : 'bypassed'} ${name}: ${url}`);
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
