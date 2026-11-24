import { describe, it, expect } from 'bun:test';
import { declaredToolTimeoutMs } from './claude.js';
import { evaluateToolStuckBudget } from '../poll-loop.js';

// roo-extensions#1357 — the per-server tool-call timeout is a MILLISECOND value
// (SDK: "Per-server tool-call timeout in milliseconds"). The PreToolUse hook
// used to multiply it by 1000 as if it were seconds, so asking the chain for a
// 5-minute budget would have armed the tool-stuck watchdog for ~3.5 days.
describe('declaredToolTimeoutMs — MCP server timeout unit (ms)', () => {
  const servers = {
    'roo-state-manager': { command: 'npx', args: ['-y', 'mcp-remote'], timeout: 300000 },
    plain: { command: 'npx' },
    remote: { type: 'http', url: 'http://127.0.0.1:9090/mcp', timeout: 300000 },
  } as const;

  it('passes an MCP server timeout through unchanged, in milliseconds', () => {
    expect(declaredToolTimeoutMs('mcp__roo-state-manager__roosync_dashboard', undefined, servers)).toBe(300000);
    expect(declaredToolTimeoutMs('mcp__remote__slow_tool', undefined, servers)).toBe(300000);
  });

  it('keeps Bash tool_input.timeout as-is (already ms)', () => {
    expect(declaredToolTimeoutMs('Bash', { timeout: 600000 }, servers)).toBe(600000);
  });

  it('returns null when no timeout is declared', () => {
    expect(declaredToolTimeoutMs('mcp__plain__anything', undefined, servers)).toBeNull();
    expect(declaredToolTimeoutMs('mcp__unknown__anything', undefined, servers)).toBeNull();
    expect(declaredToolTimeoutMs('Bash', {}, servers)).toBeNull();
    expect(declaredToolTimeoutMs('Read', { timeout: 5000 }, servers)).toBeNull();
  });

  it('a 5-minute MCP budget widens the stuck budget to 7.5 min, never to days', () => {
    const declaredMs = declaredToolTimeoutMs('mcp__roo-state-manager__roosync_dashboard', undefined, servers);
    const started = new Date(0).toISOString();
    const state = {
      current_tool: 'mcp__roo-state-manager__roosync_dashboard',
      tool_declared_timeout_ms: declaredMs,
      tool_started_at: started,
    };
    // budget = max(declared * 1.5, 5 min default) = 450000 ms
    expect(evaluateToolStuckBudget(state, 449_999).abort).toBe(false);
    expect(evaluateToolStuckBudget(state, 450_001).abort).toBe(true);
  });
});
