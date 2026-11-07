/**
 * [PATCH-myia #51] Delivery-ledger + claim-time idempotence guard tests
 * (roo-extensions#3350, class b: in-container double execution of the same
 * task_id).
 *
 * Three layers:
 * 1. Facade: chat rows written under a live task exec land in the ledger;
 *    other kinds and exec-less writes do not; a turn's many messages keep
 *    one row per task (upsert).
 * 2. Provoked proof, claim side: a task whose id is already in the ledger is
 *    re-claimed (ack removed, row pending again — the exact post-crash
 *    shape) and the loop SKIPS it without ever calling the provider.
 * 3. Positive control: a fresh task runs; the exec attribution is published
 *    at batch start and a chat write during the turn produces the ledger row
 *    that would suppress any later re-claim.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getDeliveredTaskIds, recordTaskDelivery } from './db/task-delivery-ledger.js';
import { writeMessageOut } from './db/messages-out.js';
import { getCurrentTaskExec, setCurrentTaskExec } from './db/session-state.js';
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentProvider, ProviderEvent } from './providers/types.js';

const CONTRACT = { textDelivery: 'mid-turn-complete', commands: { formatting: 'xml' } } as const;

function insertTask(id: string, seriesId: string | null = null): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
       (id, kind, timestamp, status, trigger, series_id, content)
       VALUES (?, 'task', ?, 'pending', 1, ?, ?)`,
    )
    .run(id, new Date().toISOString(), seriesId, JSON.stringify({ prompt: `run ${id}` }));
}

function statusOf(id: string): string | undefined {
  // The container never writes inbound.db — finalized state lives in
  // processing_ack (outbound), for both markCompleted and markScriptSkipped.
  const row = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
    | { status: string }
    | undefined;
  return row?.status;
}

function taskRunLogs(): Array<{ task_id: string; status: string; result: string | null }> {
  return getOutboundDb()
    .prepare('SELECT task_id, status, result FROM task_run_logs ORDER BY id')
    .all() as Array<{ task_id: string; status: string; result: string | null }>;
}

async function waitFor(predicate: () => boolean, label = 'condition'): Promise<void> {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  setCurrentTaskExec(null);
  closeSessionDb();
});

describe('[PATCH #51] ledger attribution at the writeMessageOut funnel', () => {
  it('records a chat row for the live exec task ids and only those', async () => {
    setCurrentTaskExec({ token: 'exec-1', taskIds: ['task-a', 'task-b'] });
    await writeMessageOut({ id: 'out-1', kind: 'chat', content: JSON.stringify({ text: 'delivered' }) });
    setCurrentTaskExec(null);

    expect(getDeliveredTaskIds(['task-a'])).toEqual(['task-a']);
    expect(getDeliveredTaskIds(['task-a', 'task-b', 'task-c'])).toEqual(['task-a', 'task-b']);
    // Not delivered: never written under an exec.
    expect(getDeliveredTaskIds(['task-c'])).toEqual([]);
  });

  it('ignores non-chat kinds and writes without a live exec', async () => {
    await writeMessageOut({ id: 'out-2', kind: 'chat', content: '{}' }); // no exec
    setCurrentTaskExec({ token: 'exec-2', taskIds: ['task-d'] });
    await writeMessageOut({ id: 'out-3', kind: 'task_log', content: '{}' }); // wrong kind
    await writeMessageOut({ id: 'out-4', kind: 'message', content: '{}' }); // wrong kind

    expect(getDeliveredTaskIds(['task-d'])).toEqual([]);
  });

  it('keeps one row per task across a multi-message turn (upsert)', async () => {
    setCurrentTaskExec({ token: 'exec-3', taskIds: ['task-e'] });
    for (let i = 0; i < 5; i++) {
      await writeMessageOut({ id: `out-5-${i}`, kind: 'chat', platform_id: 'telegram:-100', content: '{}' });
    }
    setCurrentTaskExec(null);

    const rows = getOutboundDb()
      .prepare('SELECT task_id, destination, token FROM task_delivery_ledger')
      .all() as Array<{ task_id: string; destination: string; token: string }>;
    expect(rows).toEqual([{ task_id: 'task-e', destination: 'telegram:-100', token: 'exec-3' }]);
  });

  it('prunes ledger rows older than the retention window on the next record', () => {
    recordTaskDelivery(['task-old'], 'telegram:-100', 'exec-old');
    getOutboundDb()
      .prepare('UPDATE task_delivery_ledger SET published_at = ? WHERE task_id = ?')
      .run('2026-01-01T00:00:00.000Z', 'task-old');
    recordTaskDelivery(['task-fresh'], 'telegram:-100', 'exec-fresh');

    expect(getDeliveredTaskIds(['task-old', 'task-fresh'])).toEqual(['task-fresh']);
  });
});

describe('[PATCH #51] claim-time guard inside runPollLoop', () => {
  function providerStub(onQuery: () => AsyncGenerator<ProviderEvent>): { provider: AgentProvider; calls: () => number } {
    let queryCalls = 0;
    const provider: AgentProvider = {
      registerMemorySessionHook: () => {},
      isSessionInvalid: () => false,
      onExchangeComplete: () => {},
      query: () => {
        queryCalls += 1;
        return {
          events: onQuery(),
          push: () => {},
          end: () => {},
          abort: () => {},
        };
      },
    };
    return { provider, calls: () => queryCalls };
  }

  it('skips a re-claimed already-delivered task without waking the agent', async () => {
    // Execution 1 delivered for this task id (ledger row); the run then died
    // before its ack drained, so the row is pending again — the exact
    // post-crash re-claim shape from roo-extensions#3350.
    recordTaskDelivery(['task-dup'], 'telegram:-100', 'exec-previous');
    insertTask('task-dup', 'series-1');

    const controller = new AbortController();
    const { provider, calls } = providerStub(async function* () {
      throw new Error('provider must not be called for a skipped task');
    });

    const loop = runPollLoop({
      provider,
      providerContract: CONTRACT,
      providerName: 'mock',
      cwd: '/workspace/agent',
      signal: controller.signal,
    });
    try {
      await waitFor(() => statusOf('task-dup') === 'completed', 'task to be skipped+finalized');
    } finally {
      controller.abort();
      await loop;
    }

    // The agent never ran: the guard skipped the row before any query.
    expect(calls()).toBe(0);
    // The row is finalized (not reset) — markScriptSkipped ack shape, same
    // as the pre-task script gate, so it can never be re-claimed again.
    expect(statusOf('task-dup')).toBe('completed');
    // The skip is observable in task_run_logs with the reason.
    expect(taskRunLogs()).toEqual([
      { task_id: 'task-dup', status: 'skipped', result: JSON.stringify({ skipped: 'already-delivered' }) },
    ]);
  });

  it('positive control: a fresh task runs, publishes exec attribution, and its chat write lands in the ledger', async () => {
    insertTask('task-fresh', 'series-1');

    const controller = new AbortController();
    const { provider } = providerStub(async function* () {
      // The exec attribution must be live while the turn is processing.
      await waitFor(() => getCurrentTaskExec()?.taskIds.includes('task-fresh') ?? false, 'exec attribution');
      // Simulates the MCP send_message subprocess writing during the turn —
      // the exact path the facade tests cover, exercised inside the loop.
      await writeMessageOut({ id: 'out-turn', kind: 'chat', platform_id: 'telegram:-100', content: '{}' });
      yield { type: 'result', text: '' };
    });

    const loop = runPollLoop({
      provider,
      providerContract: CONTRACT,
      providerName: 'mock',
      cwd: '/workspace/agent',
      signal: controller.signal,
    });
    try {
      await waitFor(() => statusOf('task-fresh') === 'completed', 'task to complete');
      await waitFor(() => getDeliveredTaskIds(['task-fresh']).length === 1, 'ledger row');
    } finally {
      controller.abort();
      await loop;
    }

    // The turn produced exactly the ledger row a later re-claim would need.
    expect(getDeliveredTaskIds(['task-fresh'])).toEqual(['task-fresh']);
    // And a non-delivered sibling task stays claimable (guard is per id).
    expect(getDeliveredTaskIds(['task-other'])).toEqual([]);
  });
});
