// Diagnose the bot's MCP chain end-to-end through TBXark (localhost:9090 == host.docker.internal:9090).
// Does a real streamable-http handshake (initialize -> session id -> tools/list) for each server,
// so we distinguish "TBXark HTTP layer answers" (initialize 200) from "backend serves tools" (tools/list works).
const BEARER = process.env.MCP_PROXY_BEARER;
if (!BEARER) { console.error('MCP_PROXY_BEARER not set'); process.exit(2); }
const BASE = 'http://localhost:9090';

function parseBody(text) {
  // TBXark may answer JSON or SSE (event: message\ndata: {...})
  const t = text.trim();
  if (t.startsWith('{')) { try { return JSON.parse(t); } catch { return null; } }
  for (const line of t.split('\n')) {
    const l = line.trim();
    if (l.startsWith('data:')) { try { return JSON.parse(l.slice(5).trim()); } catch {} }
  }
  return null;
}

async function probe(server) {
  const url = `${BASE}/${server}/mcp`;
  const headers = {
    'Authorization': `Bearer ${BEARER}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  const out = { server, init: null, sessionId: null, toolsCount: null, sampleTools: [], error: null };
  try {
    // 1) initialize
    const initRes = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'diag', version: '1' } } }),
      signal: AbortSignal.timeout(15000),
    });
    out.init = initRes.status;
    out.sessionId = initRes.headers.get('mcp-session-id') || initRes.headers.get('Mcp-Session-Id');
    const initBody = parseBody(await initRes.text());
    if (initRes.status !== 200) { out.error = `initialize HTTP ${initRes.status}`; return out; }
    if (!initBody || initBody.error) { out.error = `initialize body err: ${JSON.stringify(initBody?.error)}`; return out; }

    const sessHeaders = { ...headers };
    if (out.sessionId) sessHeaders['mcp-session-id'] = out.sessionId;

    // 2) initialized notification
    await fetch(url, { method: 'POST', headers: sessHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(10000) }).catch(() => {});

    // 3) tools/list — the real backend test
    const tlRes = await fetch(url, { method: 'POST', headers: sessHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(20000) });
    const tlBody = parseBody(await tlRes.text());
    if (tlRes.status !== 200) { out.error = `tools/list HTTP ${tlRes.status}`; return out; }
    if (!tlBody || tlBody.error) { out.error = `tools/list err: ${JSON.stringify(tlBody?.error)}`; return out; }
    const tools = tlBody.result?.tools || [];
    out.toolsCount = tools.length;
    out.sampleTools = tools.slice(0, 5).map((t) => t.name);
  } catch (e) {
    out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  return out;
}

for (const srv of ['roo-state-manager', 'sk-agent', 'searxng']) {
  const r = await probe(srv);
  console.log(JSON.stringify(r));
}
