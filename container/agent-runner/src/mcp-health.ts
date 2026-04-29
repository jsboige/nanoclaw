/**
 * Health check for required MCP servers (fail-fast policy).
 *
 * "Required" means the agent cannot honestly serve a turn without it. If a
 * required MCP is unreachable we halt the container (boot-time) or block the
 * turn (per-turn) and surface an explicit message — rather than continuing
 * silently while tool calls to that server fail and the agent routes around
 * them. Silent partial-degraded operation was the failure mode that triggered
 * this code: a 404 on roo-state-manager was masked by sk-agent still working,
 * and the agent kept replying as if everything was fine.
 *
 * Only `mcp-remote` servers (HTTP-backed) are health-checked. Local stdio
 * MCPs (`bun run`, `npx <local-pkg>`) are assumed up because they crash at
 * spawn rather than misbehave. A server can opt out with `required: false`
 * in container.json; conversely a non-mcp-remote can opt in with
 * `required: true` (currently noop — we don't have a probe for stdio).
 */

interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ParsedMcpRemote {
  url: string;
  bearer: string | null;
}

/**
 * Detect mcp-remote servers and extract their URL + bearer token. Returns
 * null for non-mcp-remote configs.
 *
 * Accepts both `npx -y mcp-remote <url> ...` and `npx mcp-remote <url> ...`.
 * Bearer is read from `--header Authorization:Bearer <token>` (the canonical
 * form used in container.json — single arg with colon, no space). Also
 * tolerates a space after `Authorization:` for hand-written variants.
 */
export function parseMcpRemote(cfg: McpServerConfig): ParsedMcpRemote | null {
  const args = cfg.args ?? [];
  const mcpRemoteIdx = args.findIndex((a) => a === 'mcp-remote' || a.endsWith('/mcp-remote'));
  if (mcpRemoteIdx < 0) return null;

  const url = args[mcpRemoteIdx + 1];
  if (!url || !/^https?:\/\//.test(url)) return null;

  let bearer: string | null = null;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '--header') continue;
    const m = args[i + 1].match(/Authorization\s*:\s*Bearer\s+(.+)/i);
    if (m) {
      bearer = m[1].trim();
      break;
    }
  }
  return { url, bearer };
}

export interface HealthResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * POST initialize to verify the endpoint is alive AND speaking JSON-RPC.
 * Returns ok=true only when HTTP 200 AND the body looks like a successful
 * initialize response (mentions `serverInfo` / `result` / `protocolVersion`).
 *
 * Timeout default 8s — long enough for IIS ARR + TBXark + sparfenyuk +
 * upstream stdio handshake on a cold proxy, short enough to fail-fast.
 */
export async function probeMcpRemote(parsed: ParsedMcpRemote, timeoutMs = 8000): Promise<HealthResult> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'nanoclaw-health', version: '1.0' },
    },
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (parsed.bearer) headers.Authorization = `Bearer ${parsed.bearer}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(parsed.url, { method: 'POST', headers, body, signal: ac.signal });
    if (res.status !== 200) {
      let snippet = '';
      try {
        snippet = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      return { ok: false, status: res.status, error: `HTTP ${res.status}${snippet ? `: ${snippet}` : ''}` };
    }
    const text = await res.text();
    if (!/serverInfo|protocolVersion|"result"/.test(text)) {
      return { ok: false, status: 200, error: `unexpected body: ${text.slice(0, 160)}` };
    }
    return { ok: true, status: 200 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export interface RequiredRemote {
  name: string;
  parsed: ParsedMcpRemote;
}

/**
 * Resolve which servers are required AND are mcp-remote (probeable).
 * - `required: false` → skipped explicitly.
 * - mcp-remote with no `required` field → required by default. The remote
 *   chain is the common failure mode; fail fast unless opted out.
 * - non-mcp-remote → never returned (no probe available).
 */
export function selectRequiredRemotes(
  mcpServers: Record<string, McpServerConfig & { required?: boolean }>,
): RequiredRemote[] {
  const out: RequiredRemote[] = [];
  for (const [name, cfg] of Object.entries(mcpServers)) {
    if ((cfg as { required?: boolean }).required === false) continue;
    const parsed = parseMcpRemote(cfg);
    if (parsed) out.push({ name, parsed });
  }
  return out;
}

interface CacheEntry {
  result: HealthResult;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

/**
 * Probe with an in-memory TTL cache so the per-turn check doesn't hammer the
 * proxy on every batch. Keyed by URL — token rotation is rare and a stale
 * "ok" cache entry would only mask a freshly-broken auth, which the next
 * tool call would surface anyway.
 */
export async function probeMcpRemoteCached(
  parsed: ParsedMcpRemote,
  ttlMs = 60_000,
): Promise<HealthResult> {
  const now = Date.now();
  const hit = cache.get(parsed.url);
  if (hit && hit.expiresAt > now) return hit.result;
  const result = await probeMcpRemote(parsed);
  cache.set(parsed.url, { result, expiresAt: now + ttlMs });
  return result;
}

export function clearHealthCache(): void {
  cache.clear();
}

/** Format a list of failed health results into a single line for messages/logs. */
export function formatFailures(failed: { name: string; result: HealthResult }[]): string {
  return failed
    .map((f) => `${f.name} (${f.result.error || `HTTP ${f.result.status}`})`)
    .join('; ');
}
