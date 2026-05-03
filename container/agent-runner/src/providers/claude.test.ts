import { describe, expect, test } from 'bun:test';

import { detectMissingMcpTool } from './claude.js';

const required = new Set(['roo-state-manager', 'sk-agent']);

describe('detectMissingMcpTool', () => {
  test('detects tool_result with is_error=true and string content for a required server', () => {
    const msg = {
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            is_error: true,
            content: 'No such tool available: mcp__roo-state-manager__roosync_dashboard',
          },
        ],
      },
    };
    expect(detectMissingMcpTool(msg, required)).toEqual({
      toolName: 'mcp__roo-state-manager__roosync_dashboard',
      serverName: 'roo-state-manager',
    });
  });

  test('detects when content is array of text blocks', () => {
    const msg = {
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            is_error: true,
            content: [{ type: 'text', text: 'No such tool available: mcp__sk-agent__call_agent' }],
          },
        ],
      },
    };
    expect(detectMissingMcpTool(msg, required)).toEqual({
      toolName: 'mcp__sk-agent__call_agent',
      serverName: 'sk-agent',
    });
  });

  test('ignores tool_result for a non-required server (model hallucination)', () => {
    const msg = {
      message: {
        content: [
          {
            type: 'tool_result',
            is_error: true,
            content: 'No such tool available: mcp__bogus_server__do_thing',
          },
        ],
      },
    };
    expect(detectMissingMcpTool(msg, required)).toBeNull();
  });

  test('ignores tool_result with is_error=false (normal failures)', () => {
    const msg = {
      message: {
        content: [
          {
            type: 'tool_result',
            is_error: false,
            content: 'No such tool available: mcp__roo-state-manager__missing',
          },
        ],
      },
    };
    expect(detectMissingMcpTool(msg, required)).toBeNull();
  });

  test('ignores non-MCP fake tool names', () => {
    const msg = {
      message: {
        content: [
          {
            type: 'tool_result',
            is_error: true,
            content: 'No such tool available: Bashh',
          },
        ],
      },
    };
    expect(detectMissingMcpTool(msg, required)).toBeNull();
  });

  test('ignores other tool_result error texts (e.g. server crash)', () => {
    const msg = {
      message: {
        content: [
          {
            type: 'tool_result',
            is_error: true,
            content: 'Tool execution failed: timeout after 30s',
          },
        ],
      },
    };
    expect(detectMissingMcpTool(msg, required)).toBeNull();
  });

  test('returns null when content is missing or wrong shape', () => {
    expect(detectMissingMcpTool({}, required)).toBeNull();
    expect(detectMissingMcpTool({ message: {} }, required)).toBeNull();
    expect(detectMissingMcpTool({ message: { content: 'plain string' } }, required)).toBeNull();
  });

  test('finds the missing tool even when other content blocks precede it', () => {
    const msg = {
      message: {
        content: [
          { type: 'text', text: 'unrelated narration' },
          { type: 'tool_result', is_error: false, content: 'ok' },
          {
            type: 'tool_result',
            is_error: true,
            content: 'No such tool available: mcp__roo-state-manager__codebase_search',
          },
        ],
      },
    };
    expect(detectMissingMcpTool(msg, required)).toEqual({
      toolName: 'mcp__roo-state-manager__codebase_search',
      serverName: 'roo-state-manager',
    });
  });
});
