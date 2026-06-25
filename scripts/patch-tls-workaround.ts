/**
 * One-shot patch: add NODE_TLS_REJECT_UNAUTHORIZED=0 + required:false to the
 * ClusterManager bot's MCP server config so it can boot while the
 * mcp-tools.myia.io TLS cert is broken (SAN missing for that hostname,
 * renewed 2026-05-09, only covers DNS:myia.io).
 *
 * Revert: remove `required: false` and the env var, restart bot.
 */
import Database from 'better-sqlite3';
import path from 'node:path';

const AG_ID = 'ag-1776992584813-k3oj0w';
const dbPath = path.resolve('data/v2.db');
const db = new Database(dbPath);

const row = db
  .prepare('SELECT mcp_servers FROM container_configs WHERE agent_group_id = ?')
  .get(AG_ID) as { mcp_servers: string } | undefined;
if (!row) throw new Error(`No container_configs row for ${AG_ID}`);

const cfg = JSON.parse(row.mcp_servers) as Record<
  string,
  {
    command: string;
    args: string[];
    env?: Record<string, string>;
    timeout?: number;
    required?: boolean;
  }
>;

for (const name of Object.keys(cfg)) {
  cfg[name].env = { ...(cfg[name].env ?? {}), NODE_TLS_REJECT_UNAUTHORIZED: '0' };
  cfg[name].required = false;
  console.log(`patched ${name}: required=false, NODE_TLS_REJECT_UNAUTHORIZED=0`);
}

const newJson = JSON.stringify(cfg);
db.prepare('UPDATE container_configs SET mcp_servers = ?, updated_at = ? WHERE agent_group_id = ?').run(
  newJson,
  new Date().toISOString(),
  AG_ID,
);

const after = db
  .prepare('SELECT mcp_servers FROM container_configs WHERE agent_group_id = ?')
  .get(AG_ID) as { mcp_servers: string };
console.log('AFTER:', after.mcp_servers);
db.close();
