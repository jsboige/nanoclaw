/**
 * One-shot revert: drop NODE_TLS_REJECT_UNAUTHORIZED=0 + required:false from
 * the ClusterManager bot's MCP server config now that the
 * mcp-tools.myia.io cert has been reissued (2026-05-18) with proper SAN
 * coverage (verified 2026-05-28 19:38Z via openssl + strict curl).
 *
 * Restores the proactive `mcp-health` probe safety net.
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
  if (cfg[name].env) {
    delete cfg[name].env!.NODE_TLS_REJECT_UNAUTHORIZED;
    if (Object.keys(cfg[name].env!).length === 0) delete cfg[name].env;
  }
  delete cfg[name].required;
  console.log(`reverted ${name}: removed required + NODE_TLS_REJECT_UNAUTHORIZED`);
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
