import { describe, expect, test, afterEach } from 'bun:test';

import { clearHealthCache, parseMcpRemote, selectRequiredRemotes } from './mcp-health.js';

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
