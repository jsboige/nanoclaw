import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { getPendingMessages, markCompleted, type MessageInRow } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import {
  formatMessages,
  extractRouting,
  isClearCommand,
  isRunnerCommand,
  GENERIC_FAILURE_NOTICE,
} from './formatter.js';
// [PATCH-myia #28] evaluateToolStuckBudget, [PATCH-myia #35] evaluateStaleRetryCap,
// [PATCH-myia #40] isProviderStatusNoise, [PATCH-myia #41] evaluateMidLifeRotation,
// [PATCH-myia #52] evaluateBatchBoundaryRotation
import {
  evaluateBatchBoundaryRotation,
  evaluateMidLifeRotation,
  evaluateStaleRetryCap,
  evaluateToolStuckBudget,
  isCorruptionError,
  isProviderStatusNoise,
  processQuery,
} from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import type { AgentQuery, ProviderEvent, ProviderExchange } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { processAfter?: string; trigger?: 0 | 1; onWake?: 0 | 1 },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, kind, opts?.processAfter ?? null, opts?.trigger ?? 1, opts?.onWake ?? 0, JSON.stringify(content));
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as distinct <message> blocks', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    // The <messages> envelope was dropped in fe2e881b (#2556) so the SDK calls
    // the API; each message is now its own self-contained <message> block.
    expect(prompt).not.toContain('<messages>');
    expect(prompt.match(/<message /g) ?? []).toHaveLength(2);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<task');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('source="github"');
    expect(prompt).toContain('event="push"');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('action="register_group"');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('<system_response');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('on_wake filtering', () => {
  it('first poll returns on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('subsequent polls skip on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(0);
  });

  it('normal messages returned regardless of isFirstPoll', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'hello' });
    expect(getPendingMessages(true)).toHaveLength(1);

    // Reset: mark completed so we can re-test with a fresh message
    markCompleted(['m1']);
    insertMessage('m2', 'chat', { sender: 'A', text: 'hello again' });
    expect(getPendingMessages(false)).toHaveLength(1);
  });

  it('mixed batch: first poll returns both normal and on_wake messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('mixed batch: subsequent poll returns only normal messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('on_wake defaults to 0 for inserts without explicit value', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    // Should be returned even on non-first poll (on_wake=0)
    expect(getPendingMessages(false)).toHaveLength(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });
});

describe('origin metadata (from= attribute)', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function insertWithRouting(id: string, kind: string, content: object, channelType: string | null, platformId: string | null): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
      )
      .run(id, kind, platformId, channelType, JSON.stringify(content));
  }

  it('chat message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="discord-main"');
  });

  it('chat message falls back to raw routing when no destination matches', () => {
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chat-999');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="unknown:telegram:chat-999"');
  });

  it('chat message omits from= when routing is null', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).not.toContain('from=');
  });

  it('task message includes from= when destination matches', () => {
    seedDestination('slack-ops', 'slack', 'C-OPS');
    insertWithRouting('t1', 'task', { prompt: 'check status' }, 'slack', 'C-OPS');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).toContain('from="slack-ops"');
  });

  it('task message omits from= when routing is null', () => {
    insertMessage('t1', 'task', { prompt: 'check status' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).not.toContain('from=');
  });

  it('webhook message includes from= when destination matches', () => {
    seedDestination('github-ch', 'github', 'repo-1');
    insertWithRouting('w1', 'webhook', { source: 'github', event: 'push', payload: {} }, 'github', 'repo-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('from="github-ch"');
  });

  it('system message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('s1', 'system', { action: 'test', status: 'ok', result: null }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('from="discord-main"');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(3);
    expect(typed[0].type).toBe('init');
    // The mock streams text before the result repeats it.
    expect(typed[1].type).toBe('text');
    expect(typed[2].type).toBe('result');
    expect((typed[2] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        await writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

// [PATCH-myia #28] Tool-stuck budget watchdog. Models the 2026-05-18 incident
// where mcp__roo-state-manager__roosync_dashboard hung for 22h while #26's
// SDK-event watchdog kept rearming. The decision is purely time-based on
// container_state, so we test the pure helper rather than the setInterval.
describe('[PATCH-myia #28] evaluateToolStuckBudget', () => {
  const NOW = Date.parse('2026-05-19T00:00:00.000Z');
  const DEFAULT = 5 * 60 * 1000;

  it('returns abort:false when no tool is in flight (state null)', () => {
    expect(evaluateToolStuckBudget(null, NOW).abort).toBe(false);
  });

  it('returns abort:false when current_tool is null', () => {
    const r = evaluateToolStuckBudget(
      { current_tool: null, tool_declared_timeout_ms: null, tool_started_at: null },
      NOW,
    );
    expect(r.abort).toBe(false);
  });

  it('returns abort:false when tool_started_at is null (defensive)', () => {
    const r = evaluateToolStuckBudget(
      { current_tool: 'mcp__roo-state-manager__roosync_dashboard', tool_declared_timeout_ms: null, tool_started_at: null },
      NOW,
    );
    expect(r.abort).toBe(false);
  });

  it('returns abort:false when tool_started_at is unparseable (defensive)', () => {
    const r = evaluateToolStuckBudget(
      { current_tool: 'Bash', tool_declared_timeout_ms: null, tool_started_at: 'not a date' },
      NOW,
    );
    expect(r.abort).toBe(false);
  });

  it('does not abort a fresh tool call (1s elapsed << default budget)', () => {
    const r = evaluateToolStuckBudget(
      {
        current_tool: 'mcp__roo-state-manager__roosync_dashboard',
        tool_declared_timeout_ms: null,
        tool_started_at: new Date(NOW - 1000).toISOString(),
      },
      NOW,
    );
    expect(r.abort).toBe(false);
  });

  it('does not abort just before the default budget elapses', () => {
    const r = evaluateToolStuckBudget(
      {
        current_tool: 'mcp__roo-state-manager__roosync_dashboard',
        tool_declared_timeout_ms: null,
        tool_started_at: new Date(NOW - (DEFAULT - 1)).toISOString(),
      },
      NOW,
    );
    expect(r.abort).toBe(false);
  });

  it('aborts an MCP tool stuck past the default 5min budget', () => {
    const r = evaluateToolStuckBudget(
      {
        current_tool: 'mcp__roo-state-manager__roosync_dashboard',
        tool_declared_timeout_ms: null,
        tool_started_at: new Date(NOW - 22 * 3600 * 1000).toISOString(), // 22h — the 2026-05-18 incident
      },
      NOW,
    );
    expect(r.abort).toBe(true);
    if (r.abort) {
      expect(r.tool).toBe('mcp__roo-state-manager__roosync_dashboard');
      expect(r.elapsedMs).toBeGreaterThanOrEqual(22 * 3600 * 1000);
      expect(r.budgetMs).toBe(DEFAULT);
      expect(r.declaredMs).toBeNull();
    }
  });

  it('respects a declared timeout with 1.5x slack (no abort within 1.5x)', () => {
    // Bash with a 10min user-declared timeout: budget = max(10min*1.5, 5min) = 15min
    const declared = 10 * 60 * 1000;
    const r = evaluateToolStuckBudget(
      {
        current_tool: 'Bash',
        tool_declared_timeout_ms: declared,
        tool_started_at: new Date(NOW - 14 * 60 * 1000).toISOString(),
      },
      NOW,
    );
    expect(r.abort).toBe(false);
  });

  it('aborts when elapsed exceeds 1.5x declared timeout', () => {
    const declared = 10 * 60 * 1000;
    const r = evaluateToolStuckBudget(
      {
        current_tool: 'Bash',
        tool_declared_timeout_ms: declared,
        tool_started_at: new Date(NOW - 16 * 60 * 1000).toISOString(),
      },
      NOW,
    );
    expect(r.abort).toBe(true);
    if (r.abort) {
      expect(r.budgetMs).toBe(15 * 60 * 1000); // 1.5x declared
      expect(r.declaredMs).toBe(declared);
    }
  });

  it('uses the default budget when declared is less than default (floor)', () => {
    // A 1min declared timeout shouldn't shrink the budget below 5min default
    const declared = 60 * 1000;
    const r = evaluateToolStuckBudget(
      {
        current_tool: 'mcp__sk-agent__call_agent',
        tool_declared_timeout_ms: declared,
        tool_started_at: new Date(NOW - 4 * 60 * 1000).toISOString(),
      },
      NOW,
    );
    expect(r.abort).toBe(false); // 4min < 5min default floor
  });

  it('accepts a custom default budget for tests', () => {
    const r = evaluateToolStuckBudget(
      {
        current_tool: 'Bash',
        tool_declared_timeout_ms: null,
        tool_started_at: new Date(NOW - 11_000).toISOString(),
      },
      NOW,
      10_000,
    );
    expect(r.abort).toBe(true);
  });
});

// [PATCH-myia #28 startup cleanup] A container killed by the host (ceiling /
// claim-stuck) or crashed mid-tool leaves a stale container_state row whose
// tool_started_at points at the dead container's clock — PostToolUse never
// fired to clear it. The next container's first tool-stuck check would read
// that row and spuriously abort a brand-new query. runPollLoop now clears the
// row at startup (alongside clearStaleProcessingAcks). This reproduces the
// 7qx60e zombie (a roosync_dashboard call left in flight that survived
// restarts) and proves the cleanup defuses it.
describe('[PATCH-myia #28] startup container_state cleanup', () => {
  it('clearContainerToolInFlight defuses a stale in-flight row left by a dead container', async () => {
    const { setContainerToolInFlight, clearContainerToolInFlight } = await import('./db/container-state.js');
    const { getContainerToolInFlight } = await import('./mailbox/sqlite/connection.js');

    // Simulate the zombie: a dashboard call claimed in flight by a container
    // that was then killed, with tool_started_at far in the past.
    setContainerToolInFlight('mcp__roo-state-manager__roosync_dashboard', 600_000);
    getOutboundDb()
      .prepare(`UPDATE container_state SET tool_started_at = ? WHERE id = 1`)
      .run(new Date(Date.now() - 12 * 3600 * 1000).toISOString());

    // Before cleanup: a fresh container's first watchdog tick would abort.
    const stale = getContainerToolInFlight();
    expect(evaluateToolStuckBudget(stale, Date.now()).abort).toBe(true);

    // Startup cleanup — what runPollLoop now runs next to clearStaleProcessingAcks.
    clearContainerToolInFlight();

    const cleared = getContainerToolInFlight();
    expect(cleared?.current_tool).toBeNull();
    expect(cleared?.tool_started_at).toBeNull();
    expect(evaluateToolStuckBudget(cleared, Date.now()).abort).toBe(false);
  });
});

// [PATCH-myia #35] Stale-retry cap. PATCH #31 introduced a soft fail-fast loop
// for transient SDK init failures (resetProcessingAcks + sleep + retry). The
// 2026-05-28 cert SAN gap revealed that the loop had no upper bound: a
// persistent failure (TLS-workaround on, but SDK MCP init still rejecting)
// produced one "Review cycle :30 starting" PING per retry until the host
// killed the container. The fix is a per-id counter that flips
// `stalledAborted=false` on cap exhaustion so markCompleted runs and the host's
// handleRecurrence advances the cron series at the next sweep.
describe('[PATCH-myia #35] evaluateStaleRetryCap', () => {
  it('first failure on a single id does not exhaust', () => {
    const counter = new Map<string, number>();
    const decision = evaluateStaleRetryCap(counter, ['task-1'], 3);
    expect(decision.exhausted).toBe(false);
    expect(decision.maxRetries).toBe(1);
    expect(counter.get('task-1')).toBe(1);
  });

  it('exhausts when any id in the batch reaches the cap', () => {
    const counter = new Map<string, number>();
    evaluateStaleRetryCap(counter, ['task-1'], 3);
    evaluateStaleRetryCap(counter, ['task-1'], 3);
    const third = evaluateStaleRetryCap(counter, ['task-1'], 3);
    expect(third.exhausted).toBe(true);
    expect(third.maxRetries).toBe(3);
  });

  it('does not exhaust before the cap', () => {
    const counter = new Map<string, number>();
    evaluateStaleRetryCap(counter, ['task-1'], 3);
    const second = evaluateStaleRetryCap(counter, ['task-1'], 3);
    expect(second.exhausted).toBe(false);
    expect(second.maxRetries).toBe(2);
  });

  it('accumulates per-id across batches that mix ids', () => {
    const counter = new Map<string, number>();
    evaluateStaleRetryCap(counter, ['task-1', 'task-2'], 3);
    evaluateStaleRetryCap(counter, ['task-1'], 3);
    const decision = evaluateStaleRetryCap(counter, ['task-1', 'task-2'], 3);
    expect(decision.maxRetries).toBe(3); // task-1 hit 3 first
    expect(decision.exhausted).toBe(true);
    expect(counter.get('task-1')).toBe(3);
    expect(counter.get('task-2')).toBe(2);
  });

  it('caller-driven reset (delete on markCompleted) restores fresh budget', () => {
    const counter = new Map<string, number>();
    evaluateStaleRetryCap(counter, ['task-1'], 3);
    evaluateStaleRetryCap(counter, ['task-1'], 3);
    // Simulate successful batch — caller clears entries.
    counter.delete('task-1');
    const fresh = evaluateStaleRetryCap(counter, ['task-1'], 3);
    expect(fresh.exhausted).toBe(false);
    expect(fresh.maxRetries).toBe(1);
  });

  it('a configurable cap of 2 surrenders on the second consecutive failure', () => {
    // Documents the tuning knob: matches the user's "<=3 lines per cycle"
    // directive at the strictest setting (1 initial attempt + 1 retry = cap).
    const counter = new Map<string, number>();
    const first = evaluateStaleRetryCap(counter, ['task-1'], 2);
    expect(first.exhausted).toBe(false);
    const second = evaluateStaleRetryCap(counter, ['task-1'], 2);
    expect(second.exhausted).toBe(true);
  });

  it('empty batch never exhausts (defensive — no rows means no work to gate)', () => {
    const counter = new Map<string, number>();
    const decision = evaluateStaleRetryCap(counter, [], 3);
    expect(decision.exhausted).toBe(false);
    expect(decision.maxRetries).toBe(0);
    expect(counter.size).toBe(0);
  });
});

/**
 * Build a one-shot stub query that yields init + a single result event, then
 * ends. `pushes` records any follow-ups the loop tried to inject (e.g. the
 * re-wrap nudge), so a test can assert the loop did NOT re-hammer.
 */
function makeResultQuery(result: ProviderEvent): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    yield result;
  }
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    },
  };
}

const ERR_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
};

const AGENT_ROUTING = { platformId: 'ag-a', channelType: 'agent', threadId: null, inReplyTo: 'm1' };

it('does not push accumulated-only follow-ups into an active query', async () => {
  const pushes: string[] = [];

  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    insertMessage('m1', 'chat', { sender: 'A', text: 'context only' }, { trigger: 0 });
    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  await processQuery(
    {
      push: (message) => pushes.push(message),
      end: () => {},
      events: events(),
      abort: () => {},
    },
    ERR_ROUTING,
    [],
    'claude',
    undefined,
    'prompt',
    undefined,
  );

  expect(pushes).toHaveLength(0);
  expect(getPendingMessages().map((m) => m.id)).toEqual(['m1']);
});

describe('error result with no <message> envelope', () => {
  it('delivers a budget/billing error to the triggering channel and does not nudge', async () => {
    const budgetText = 'Spending limit reached. Add your own key at https://example.com/keys';
    const { query, pushes } = makeResultQuery({ type: 'result', text: budgetText, isError: true });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content)).toEqual({
      text: GENERIC_FAILURE_NOTICE,
      failureNotice: true,
    });
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    // No re-wrap nudge — an error result must not re-hammer the gateway.
    expect(pushes).toHaveLength(0);
  });

  it.each([
    '<internal>PRIVATE THOUGHTS</internal>\n\nOpenCode prompt failed: {"responseHeaders":{"authorization":"fixture-secret"}}',
    'Unwrapped private reasoning\n\n{"responseBody":"fixture-secret"}',
    '',
  ])('keeps failed-turn scratchpad and diagnostics out of chat: %s', async (text) => {
    const { query, pushes } = makeResultQuery({ type: 'result', text, isError: true });
    const exchanges: ProviderExchange[] = [];
    await processQuery(query, ERR_ROUTING, ['m1'], 'mock', (exchange) => exchanges.push(exchange), 'prompt', undefined);
    expect(getUndeliveredMessages().map((row) => JSON.parse(row.content).text)).toEqual([GENERIC_FAILURE_NOTICE]);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].status).toBe('error');
    expect(exchanges[0].result).toBe(text);
    expect(pushes).toHaveLength(0);
  });

  it.each([
    ['provider error', 'billing hard-stop', 'billing hard-stop'],
    ['fallback text', undefined, GENERIC_FAILURE_NOTICE],
  ])('logs a skipped notice once when answering a failure notice: %s', async (_label, error, expected) => {
    const { query } = makeResultQuery({ type: 'result', text: '', isError: true, error });
    const noticeRouting = { ...AGENT_ROUTING, failureNoticeWake: true };
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((line) => {
      lines.push(String(line));
    });
    try {
      await processQuery(query, noticeRouting, ['m1'], 'mock', undefined, 'prompt', undefined);
    } finally {
      spy.mockRestore();
    }

    expect(lines.filter((line) => line.includes(expected))).toHaveLength(1);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  // Upstream semantics (adopted 2026-11 sync, #19 retired): a normal
  // unwrapped result is NOT delivered raw — the informed wrap-nudge quotes
  // the undelivered text back to the model for a wrapped re-send.
  it('still nudges (and does not deliver) a normal unwrapped result', async () => {
    const { query, pushes } = makeResultQuery({ type: 'result', text: 'bare text, no envelope' });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('was not delivered');
  });
});

// Upstream corruption-detection helper. Pairs with CORRUPTION_STREAK_EXIT in
// poll-loop.ts — when 10 successive errors match this predicate, the runner
// hard-exits so the host can recreate the cross-mount session DBs cleanly.
describe('isCorruptionError', () => {
  it('matches the Docker Desktop macOS torn-read symptom', () => {
    expect(isCorruptionError('database disk image is malformed')).toBe(true);
  });

  it('matches wrapped SQLite corruption codes', () => {
    expect(isCorruptionError('SqliteError: SQLITE_CORRUPT_VTAB: ...')).toBe(true);
    expect(isCorruptionError('file is not a database')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isCorruptionError('database is locked')).toBe(false);
    expect(isCorruptionError('no such table: messages_in')).toBe(false);
    expect(isCorruptionError('')).toBe(false);
  });
});

describe('a2a failure notices (never answer a notice with a notice)', () => {
  function insertRow(
    id: string,
    content: object | string,
    channelType: string | null,
    platformId: string | null,
    opts: { trigger?: 0 | 1; onWake?: 0 | 1 } = {},
  ): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, trigger, on_wake, content)
         VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        platformId,
        channelType,
        opts.trigger ?? 1,
        opts.onWake ?? 0,
        typeof content === 'string' ? content : JSON.stringify(content),
      );
  }

  /** One failing turn over every pending row, as the poll loop would run it. */
  async function failTurn(): Promise<void> {
    const rows = getPendingMessages(true);
    const { query } = makeResultQuery({ type: 'result', text: '', isError: true, error: 'Incorrect API key' });
    await processQuery(query, extractRouting(rows), [], 'mock', undefined, 'prompt', undefined);
    markCompleted(rows.map((m) => m.id));
  }

  /** Outbound agent-route rows; routeToSession then starts a fresh inbox. */
  function agentOutbound(): Array<{ platform_id: string | null; content: string }> {
    return getUndeliveredMessages().filter((m) => m.channel_type === 'agent');
  }

  /** The host's a2a route: a fresh session inbox, content passed unchanged. */
  function routeToSession(content: string, fromAgent: string, id: string): void {
    closeSessionDb();
    initTestSessionDb();
    insertRow(id, content, 'agent', fromAgent);
  }

  it('A asks B, B fails: A gets exactly one notice, and a failure there sends nothing back', async () => {
    // B's session: A's request arrives and B's turn fails.
    insertRow('a2a-1', { text: 'please summarize the report', sender: 'A' }, 'agent', 'ag-a');
    await failTurn();
    const toA = agentOutbound();
    expect(toA).toHaveLength(1);
    expect(toA[0].platform_id).toBe('ag-a');
    expect(JSON.parse(toA[0].content)).toEqual({ text: 'Incorrect API key', failureNotice: true });

    // A's session: the notice arrives from B and A's turn fails too.
    routeToSession(toA[0].content, 'ag-b', 'a2a-2');
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((line) => {
      lines.push(String(line));
    });
    try {
      await failTurn();
    } finally {
      spy.mockRestore();
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(lines.filter((line) => line.includes('notice not sent'))).toHaveLength(1);
  });

  it('a self-addressed restart message that fails stops after one notice', async () => {
    const restart = { text: 'verify the new tool', sender: 'system', senderId: 'system' };
    insertRow('restart-1', restart, 'agent', 'ag-self', { onWake: 1 });
    let notices = 0;
    for (let hop = 0; hop < 5; hop++) {
      await failTurn();
      const out = agentOutbound();
      if (out.length === 0) break;
      notices += out.length;
      // Self-send: the host routes the notice straight back to this session.
      routeToSession(out[0].content, 'ag-self', `a2a-hop-${hop}`);
    }
    expect(notices).toBe(1);
  });

  it('a batch mixing a failure notice with a real message still gets a notice', async () => {
    insertRow('n1', { text: 'Incorrect API key', failureNotice: true }, 'agent', 'ag-b');
    insertRow('m2', { text: 'any update?', sender: 'Alice' }, 'discord', 'chan-1');
    await failTurn();
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).failureNotice).toBe(true);
    // The requester hears about it, not the agent whose notice came first.
    expect([out[0].channel_type, out[0].platform_id, out[0].in_reply_to]).toEqual(['discord', 'chan-1', 'm2']);
  });

  it.each([
    ['accumulated context', { channelType: 'discord', platformId: 'chan-1', trigger: 0 as 0 | 1 }],
    ['a cross-session echo', { channelType: 'session-echo', platformId: null, trigger: 1 as 0 | 1 }],
  ])('%s riding along with a failure notice does not earn a notice', async (_label, extra) => {
    insertRow('c1', { text: 'context', sender: 'Bob' }, extra.channelType, extra.platformId, {
      trigger: extra.trigger,
    });
    insertRow('n1', { text: 'Incorrect API key', failureNotice: true }, 'agent', 'ag-b');
    await failTurn();
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('a plain agent route still gets its notice', async () => {
    const { query } = makeResultQuery({ type: 'result', text: '', isError: true });
    await processQuery(query, AGENT_ROUTING, ['m1'], 'mock', undefined, 'prompt', undefined);
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('agent');
    expect(out[0].platform_id).toBe('ag-a');
  });

  it('context between a leading notice and the request does not take the route', () => {
    const row = (id: string, channel: string, platform: string, trigger: number, content: object) =>
      ({
        id,
        kind: 'chat',
        trigger,
        channel_type: channel,
        platform_id: platform,
        thread_id: null,
        content: JSON.stringify(content),
      }) as unknown as MessageInRow;
    const routing = extractRouting([
      row('n1', 'agent', 'ag-b', 1, { text: 'Incorrect API key', failureNotice: true }),
      row('c1', 'discord', 'chan-x', 0, { text: 'context' }),
      row('m2', 'discord', 'chan-1', 1, { text: 'any update?' }),
    ]);
    expect([routing.platformId, routing.inReplyTo, routing.failureNoticeWake]).toEqual(['chan-1', 'm2', false]);
  });

  it('a failure notice is never a runner command', () => {
    insertRow('n1', { text: '/clear is required before retrying', failureNotice: true }, 'agent', 'ag-b');
    insertRow('n2', { text: '/compact failed', failureNotice: true }, 'agent', 'ag-b');
    const [clearLike, compactLike] = getPendingMessages();
    expect(isClearCommand(clearLike)).toBe(false);
    expect(isRunnerCommand(compactLike, 'claude')).toBe(false);
  });

  it.each([
    ['{"text":"hi","failureNotice":"true"}', false],
    ['{"text":"hi","failureNotice":true}', true],
    ['not json', false],
    ['null', false],
  ])('extractRouting reads the marker strictly: %s', (content, expected) => {
    insertRow('x1', content, 'agent', 'ag-b');
    expect(extractRouting(getPendingMessages()).failureNoticeWake).toBe(expected);
  });
});

it('delivers completed wrapped text while recording the failed turn exactly once', async () => {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES ('main', 'main', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
  const text = '<message to="main">Completed before failure.</message>\n\nBackend failed.';
  const { query, pushes } = makeResultQuery({ type: 'result', text, isError: true });
  const exchanges: ProviderExchange[] = [];

  await processQuery(query, ERR_ROUTING, ['m1'], 'mock', (exchange) => exchanges.push(exchange), 'prompt', undefined);

  expect(getUndeliveredMessages().map((row) => JSON.parse(row.content).text)).toEqual([
    'Completed before failure.',
    GENERIC_FAILURE_NOTICE,
  ]);
  expect(exchanges).toEqual([{ prompt: 'prompt', result: text, continuation: 'sess-1', status: 'error' }]);
  expect(pushes).toHaveLength(0);
});


// [PATCH-myia #41] Mid-life continuation rotation. maybeRotateContinuation
// (the transcript-size/age cold-resume guard) is evaluated only at container
// startup; a container up for hours never re-checks, so a transcript that
// grows past the cap between tours rides into the #2177 cold-resume/thrash
// wedge (wedge #7 reached 21MB). The idle branch calls evaluateMidLifeRotation
// to re-probe, throttled. Test the pure policy (probe injected) rather than
// driving runPollLoop's infinite loop — same approach as #28's watchdog.
describe('[PATCH-myia #41] evaluateMidLifeRotation', () => {
  const INTERVAL = 60_000;
  const base = { nowMs: 1_000_000, lastCheckMs: 0, intervalMs: INTERVAL };

  it('does not check when there is no continuation to rotate', () => {
    const probe = () => 'transcript 21.0MB > 12MB cap';
    const r = evaluateMidLifeRotation({ ...base, continuation: undefined, probe });
    expect(r).toEqual({ checked: false, reason: null });
  });

  it('does not check when the provider has no rotation guard', () => {
    const r = evaluateMidLifeRotation({ ...base, continuation: 'sess-a', probe: undefined });
    expect(r).toEqual({ checked: false, reason: null });
  });

  it('is throttled — no probe before the interval elapses', () => {
    let calls = 0;
    const probe = () => {
      calls++;
      return null;
    };
    const r = evaluateMidLifeRotation({
      continuation: 'sess-a',
      nowMs: 30_000,
      lastCheckMs: 0,
      intervalMs: INTERVAL,
      probe,
    });
    expect(r.checked).toBe(false);
    expect(calls).toBe(0);
  });

  it('checks exactly at the interval boundary', () => {
    const probe = () => null;
    const r = evaluateMidLifeRotation({
      continuation: 'sess-a',
      nowMs: INTERVAL,
      lastCheckMs: 0,
      intervalMs: INTERVAL,
      probe,
    });
    expect(r.checked).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('checks but does not rotate when the transcript is under the cap', () => {
    const r = evaluateMidLifeRotation({ ...base, continuation: 'sess-a', probe: () => null });
    expect(r).toEqual({ checked: true, reason: null });
  });

  it('surfaces the rotate reason when the transcript is over the cap (the wedge case)', () => {
    const reason = 'transcript 21.0MB > 12MB cap';
    const r = evaluateMidLifeRotation({ ...base, continuation: 'sess-a', probe: () => reason });
    expect(r).toEqual({ checked: true, reason });
  });

  it('passes the live continuation id to the probe', () => {
    let seen: string | undefined;
    evaluateMidLifeRotation({
      ...base,
      continuation: 'sess-live-123',
      probe: (c) => {
        seen = c;
        return null;
      },
    });
    expect(seen).toBe('sess-live-123');
  });
});

// [PATCH-myia #52] Batch-boundary twin of #41. #41 lives in the idle branch,
// and a session that chains its turns (follow-ups pushed into the open
// stream, then #27 ending the stream straight into the next batch) never
// idles — measured 2026-11-25: one transcript rode to 16.6 MB in 11h46 with
// zero idle iterations. The batch start is the other no-active-query point.
// Same approach as #41: test the pure policy with the probe injected.
describe('[PATCH-myia #52] evaluateBatchBoundaryRotation', () => {
  it('does not check when there is no continuation to rotate', () => {
    const probe = () => 'transcript 21.0MB > 12MB cap';
    const r = evaluateBatchBoundaryRotation({ continuation: undefined, probe });
    expect(r).toEqual({ checked: false, reason: null });
  });

  it('does not check when the provider has no rotation guard', () => {
    const r = evaluateBatchBoundaryRotation({ continuation: 'sess-a', probe: undefined });
    expect(r).toEqual({ checked: false, reason: null });
  });

  it('is not throttled — two back-to-back batches both probe', () => {
    let calls = 0;
    const probe = () => {
      calls++;
      return null;
    };
    evaluateBatchBoundaryRotation({ continuation: 'sess-a', probe });
    const second = evaluateBatchBoundaryRotation({ continuation: 'sess-a', probe });
    expect(second).toEqual({ checked: true, reason: null });
    expect(calls).toBe(2);
  });

  it('checks but does not rotate when the transcript is under the cap', () => {
    const r = evaluateBatchBoundaryRotation({ continuation: 'sess-a', probe: () => null });
    expect(r).toEqual({ checked: true, reason: null });
  });

  it('surfaces the rotate reason when the transcript is over the cap (the never-idle case)', () => {
    const reason = 'transcript 16.6MB > 3MB cap';
    const r = evaluateBatchBoundaryRotation({ continuation: 'sess-a', probe: () => reason });
    expect(r).toEqual({ checked: true, reason });
  });

  it('passes the live continuation id to the probe', () => {
    let seen: string | undefined;
    evaluateBatchBoundaryRotation({
      continuation: 'sess-live-456',
      probe: (c) => {
        seen = c;
        return null;
      },
    });
    expect(seen).toBe('sess-live-456');
  });
});

// [PATCH-myia #40] Provider status telemetry must never reach a user channel.
// Incident 2026-07-15: 91 of 93 chat deliveries to the Telegram group over ~11h
// were auto-compaction notices ("Context compacted (N tokens compacted)." /
// "Autocompact is thrashing…") that a heavy turn emitted with no <message>
// envelope, leaking through poll-loop's three fallback delivery paths. The
// narrow predicate below drops exactly those families while leaving genuine
// agent text and genuine provider errors untouched. See PATCHES.md#40.
describe('[PATCH-myia #40] isProviderStatusNoise', () => {
  it('matches the "Context compacted (N tokens compacted)." notice', () => {
    expect(isProviderStatusNoise('Context compacted (169,252 tokens compacted).')).toBe(true);
  });

  it('matches "Autocompact is thrashing…"', () => {
    expect(
      isProviderStatusNoise('Autocompact is thrashing: context refilled to the limit within 3 turns'),
    ).toBe(true);
  });

  it('matches "Claude Code returned an error result: …"', () => {
    expect(isProviderStatusNoise('Claude Code returned an error result: Autocompact is thrashing')).toBe(true);
  });

  it('strips a leading "Error: " prefix before matching (catch-path shape)', () => {
    // The reactive catch path wraps the throw as `Error: ${errMsg}` before the
    // channel write — the guard must see through that prefix.
    expect(isProviderStatusNoise('Error: Autocompact is thrashing')).toBe(true);
    expect(isProviderStatusNoise('Error: Claude Code returned an error result: x')).toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isProviderStatusNoise('  Context compacted (5 tokens compacted).\n')).toBe(true);
  });

  it('does NOT match genuine agent text', () => {
    expect(isProviderStatusNoise('The answer is 4')).toBe(false);
    expect(isProviderStatusNoise('bare text, no envelope')).toBe(false);
    // A message that merely mentions compaction mid-sentence is not a notice.
    expect(isProviderStatusNoise('I compacted the context, here is the summary')).toBe(false);
  });

  it('does NOT match genuine provider errors (403 billing, MCP init)', () => {
    expect(
      isProviderStatusNoise('Spending limit reached. Add your own key at https://example.com/keys'),
    ).toBe(false);
    expect(isProviderStatusNoise('Error: MCP servers not connected at init')).toBe(false);
    expect(isProviderStatusNoise('')).toBe(false);
  });
});

describe('[PATCH-myia #40] provider status noise is not delivered to channels', () => {
  it('suppresses a "Context compacted" non-error result with no <message> envelope (Site A)', async () => {
    const { query, pushes } = makeResultQuery({
      type: 'result',
      text: 'Context compacted (169,252 tokens compacted).',
    });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    // Without the guard this would fall through the #19 routing-source fallback
    // and post to the channel. Nothing delivered, and no re-wrap nudge fired.
    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });

  it('suppresses an "Autocompact is thrashing" error result with no envelope (Site B)', async () => {
    const { query, pushes } = makeResultQuery({
      type: 'result',
      text: 'Autocompact is thrashing: context refilled to the limit within 3 turns',
      isError: true,
    });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    // Error turns with no envelope route through deliverErrorResult, which now
    // drops known telemetry. No delivery, no nudge.
    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });

  it('still delivers a genuine billing error (regression guard — filter is narrow)', async () => {
    const budgetText = 'Spending limit reached. Add your own key at https://example.com/keys';
    const { query } = makeResultQuery({ type: 'result', text: budgetText, isError: true });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content)).toEqual({ text: GENERIC_FAILURE_NOTICE, failureNotice: true });
  });
});


it('delivers completed wrapped text while recording the failed turn exactly once', async () => {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES ('main', 'main', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
  const text = '<message to="main">Completed before failure.</message>\n\nBackend failed.';
  const { query, pushes } = makeResultQuery({ type: 'result', text, isError: true });
  const exchanges: ProviderExchange[] = [];

  await processQuery(query, ERR_ROUTING, ['m1'], 'mock', (exchange) => exchanges.push(exchange), 'prompt', undefined);

  expect(getUndeliveredMessages().map((row) => JSON.parse(row.content).text)).toEqual([
    'Completed before failure.',
    GENERIC_FAILURE_NOTICE,
  ]);
  expect(exchanges).toEqual([{ prompt: 'prompt', result: text, continuation: 'sess-1', status: 'error' }]);
  expect(pushes).toHaveLength(0);
});


// --- Task-run turn wiring: the REAL processQuery path (one-door) ---
// These drive the actual call sites (autoAppendTaskLog at result-handling,
// shouldNudgeTaskBlocks gating, and follow-up turn reset). Deleting the wiring
// — not just the helpers — goes red here.

const TASK_ROUTING = {
  platformId: null,
  channelType: null,
  threadId: 'system:tasks:ser-1',
  inReplyTo: 't1',
  taskRun: true,
};

function taskLogRows(): Array<{ text: string }> {
  return (
    getOutboundDb()
      .prepare("SELECT content FROM messages_out WHERE kind = 'task_log' ORDER BY seq")
      .all() as Array<{ content: string }>
  ).map((r) => JSON.parse(r.content) as { text: string });
}

describe('task-run turn wiring (real processQuery)', () => {
  it('logs a failed task with inert message blocks once and does not retry delivery', async () => {
    const text = '<message to="main">Completed before failure.</message>\n\nBackend failed.';
    const { query, pushes } = makeResultQuery({ type: 'result', text, isError: true });
    const exchanges: ProviderExchange[] = [];

    await processQuery(
      query,
      TASK_ROUTING,
      ['t1'],
      'mock',
      (exchange) => exchanges.push(exchange),
      'prompt',
      undefined,
    );

    expect(taskLogRows()).toEqual([{ text: '[undelivered → main] Completed before failure. Backend failed.' }]);
    expect(getUndeliveredMessages().filter((row) => row.kind === 'chat')).toHaveLength(0);
    expect(exchanges).toEqual([{ prompt: 'prompt', result: text, continuation: 'sess-1', status: 'error' }]);
    expect(pushes).toHaveLength(0);
  });


  it('auto-appends the final text as a task_log row', async () => {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: 'checked feeds — nothing new' };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, events: events(), abort: () => {} };

    await processQuery(query, TASK_ROUTING, ['t1'], 'claude', undefined, 'prompt', undefined);

    const logs = taskLogRows();
    expect(logs).toHaveLength(1);
    expect(logs[0].text).toBe('checked feeds — nothing new');
    // and nothing was delivered as chat
    expect(getUndeliveredMessages().filter((m) => m.kind === 'chat')).toHaveLength(0);
  });

  // Skipped on Linux CI: the follow-up poller never pushes the second task run
  // there (deterministic, even with a 20s window) while passing on Windows in
  // <1s and working in production Linux containers. Upstream runs no container
  // tests in CI, so this is fork-local coverage — keep it green where it can run.
  (process.platform === 'linux' ? it.skip : it)('logs and conditionally nudges a second task run in the same open query', async () => {
    const pushes: string[] = [];

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // Turn 1 uses the legacy wrong door and consumes its one correction.
      yield { type: 'result', text: '<message to="local-cli">fire one result</message>' };
      yield { type: 'result', text: 'first delivery decision handled' };

      // A SECOND task run lands while the query is open — the follow-up poller
      // pushes it and must reset the per-turn correction state.
      insertMessage('t2', 'task', { prompt: 'fire two' });
      // The poller ticks every ACTIVE_POLL_INTERVAL_MS (500ms), so this
      // normally resolves in well under a second. The generous deadline is
      // for slow shared CI runners — and it must stay well below the test's
      // own timeout (set below), so exhaustion fails on the diagnostic throw
      // rather than a mute test timeout.
      const deadline = Date.now() + 15_000;
      while (!pushes.some((p) => p.includes('fire two')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!pushes.some((p) => p.includes('fire two'))) {
        throw new Error(
          `follow-up poller never pushed the second task run within 15s; ` +
            `pushes seen (${pushes.length}): ${JSON.stringify(pushes.map((p) => p.slice(0, 80)))}`,
        );
      }

      // Turn 2 repeats the mistake. This receives a second independent nudge
      // only if the follow-up path reset taskBlockNudged.
      yield { type: 'result', text: '<message to="local-cli">fire two result</message>' };
      yield { type: 'result', text: 'second delivery decision handled' };
    }

    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, TASK_ROUTING, ['t1'], 'claude', undefined, 'prompt', undefined);

    const nudges = pushes.filter((p) => p.includes('If and only if'));
    expect(nudges).toHaveLength(2);
    expect(nudges[0]).toContain('fire one result');
    expect(nudges[1]).toContain('fire two result');

    const logs = taskLogRows().map((l) => l.text);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain('[undelivered → local-cli] fire one result');
    expect(logs[1]).toContain('[undelivered → local-cli] fire two result');
    expect(logs).not.toContain('first delivery decision handled');
    expect(logs).not.toContain('second delivery decision handled');
    // Explicit budget: the default 5s equalled the old inner deadline, so on
    // slow runners the test died as a mute timeout instead of reaching the
    // diagnostic throw above (observed consistently on CI-hosted runners).
  }, 20_000);
});
