import { describe, expect, test, beforeEach, afterEach } from 'bun:test';

import {
  clearHealthCache,
  parseMcpRemote,
  probeMcpRemoteCached,
  selectRequiredRemotes,
} from './mcp-health.js';

afterEach(() => {
  clearHealthCache();
});

describe('parseMcpRemote', () => {
  test('extracts URL and bearer from canonical container.json form', () => {
    const cfg = {
      command: 'npx',
      args: [
        '-y',
        'mcp-remote',
        'https://mcp-tools.myia.io/roo-state-manager/mcp',
        '--header',
        'Authorization:Bearer secret-token-123',
      ],
    };
    expect(parseMcpRemote(cfg)).toEqual({
      url: 'https://mcp-tools.myia.io/roo-state-manager/mcp',
      bearer: 'secret-token-123',
    });
  });

  test('accepts mcp-remote without -y flag', () => {
    const cfg = {
      command: 'npx',
      args: ['mcp-remote', 'https://example.com/mcp', '--header', 'Authorization:Bearer abc'],
    };
    expect(parseMcpRemote(cfg)).toEqual({
      url: 'https://example.com/mcp',
      bearer: 'abc',
    });
  });

  test('tolerates space after Authorization colon', () => {
    const cfg = {
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://x.test/mcp', '--header', 'Authorization: Bearer xyz'],
    };
    expect(parseMcpRemote(cfg)?.bearer).toBe('xyz');
  });

  test('returns null for non-mcp-remote configs (local stdio)', () => {
    expect(parseMcpRemote({ command: 'bun', args: ['run', '/app/mcp-tools/index.ts'] })).toBeNull();
    expect(parseMcpRemote({ command: 'pnpm', args: ['dlx', '@modelcontextprotocol/server-memory'] })).toBeNull();
  });

  test('returns null when URL is missing or non-http', () => {
    expect(parseMcpRemote({ command: 'npx', args: ['-y', 'mcp-remote'] })).toBeNull();
    expect(parseMcpRemote({ command: 'npx', args: ['-y', 'mcp-remote', 'not-a-url'] })).toBeNull();
  });

  test('returns null bearer when no --header is present (still resolves URL)', () => {
    const result = parseMcpRemote({
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://anonymous.test/mcp'],
    });
    expect(result).toEqual({ url: 'https://anonymous.test/mcp', bearer: null });
  });
});

describe('selectRequiredRemotes', () => {
  const remoteA = {
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://a.test/mcp', '--header', 'Authorization:Bearer t1'],
  };
  const remoteB = {
    command: 'npx',
    args: ['-y', 'mcp-remote', 'https://b.test/mcp'],
  };
  const localBuiltin = {
    command: 'bun',
    args: ['run', '/app/mcp-tools/index.ts'],
  };

  test('mcp-remote servers are required by default', () => {
    const result = selectRequiredRemotes({ a: remoteA, b: remoteB });
    expect(result.map((r) => r.name).sort()).toEqual(['a', 'b']);
  });

  test('local stdio MCPs are not probed (no parsed URL)', () => {
    const result = selectRequiredRemotes({ nanoclaw: localBuiltin });
    expect(result).toHaveLength(0);
  });

  test('explicit required:false opts a remote out', () => {
    const result = selectRequiredRemotes({
      a: remoteA,
      b: { ...remoteB, required: false },
    });
    expect(result.map((r) => r.name)).toEqual(['a']);
  });

  test('mixed config: required remotes + opted-out + local', () => {
    const result = selectRequiredRemotes({
      'roo-state-manager': remoteA,
      'optional-thing': { ...remoteB, required: false },
      nanoclaw: localBuiltin,
    });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('roo-state-manager');
  });
});

// [PATCH-myia #29] The per-turn fail-fast gate caches probe results to avoid
// hammering the proxy. Caching a FAILURE for 60s turned a sub-second proxy
// blip into a 60s window where every inbound was blocked — the bug behind the
// 2026-05-23 "lost MCPs" symptom (36 spurious 🛑 BLOCKED rows while the chain
// was actually healthy). The cache must therefore store successes only.
describe('[PATCH-myia #29] probeMcpRemoteCached cache policy', () => {
  const parsed = { url: 'https://cache-policy.test/mcp', bearer: null } as const;
  const OK_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05' } });
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Stub fetch with a fixed response sequence; returns a call counter. */
  function stubFetch(seq: Array<{ status: number; body: string }>): () => number {
    let calls = 0;
    globalThis.fetch = (async () => {
      const r = seq[Math.min(calls, seq.length - 1)];
      calls += 1;
      return new Response(r.body, { status: r.status });
    }) as unknown as typeof globalThis.fetch;
    return () => calls;
  }

  test('a successful probe is cached — the second call is served without re-fetching', async () => {
    const calls = stubFetch([{ status: 200, body: OK_BODY }]);
    const first = await probeMcpRemoteCached(parsed);
    const second = await probeMcpRemoteCached(parsed);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(calls()).toBe(1); // second served from cache
  });

  test('a failed probe is NOT cached — the next call re-probes and recovers immediately', async () => {
    const calls = stubFetch([
      { status: 500, body: 'upstream boom' }, // transient blip
      { status: 200, body: OK_BODY }, // chain recovered
    ]);
    const first = await probeMcpRemoteCached(parsed);
    expect(first.ok).toBe(false);
    const second = await probeMcpRemoteCached(parsed);
    expect(second.ok).toBe(true); // unblocked within one retry window
    expect(calls()).toBe(2); // failure was not cached → re-probed
  });
});
