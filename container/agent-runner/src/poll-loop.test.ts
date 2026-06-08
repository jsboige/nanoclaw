import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getPendingMessages, markCompleted } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { formatMessages, extractRouting } from './formatter.js';
import { evaluateStaleRetryCap, evaluateToolStuckBudget, isCorruptionError } from './poll-loop.js'; // [PATCH-myia #28] evaluateToolStuckBudget, [PATCH-myia #35] evaluateStaleRetryCap
import { MockProvider } from './providers/mock.js';

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
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
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
        writeMessageOut({
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
    const { setContainerToolInFlight, clearContainerToolInFlight, getContainerToolInFlight } =
      await import('./db/connection.js');

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
