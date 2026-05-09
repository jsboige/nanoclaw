import { beforeEach, describe, expect, test } from 'bun:test';

import { getInboundDb, getOutboundDb, initTestSessionDb } from './connection.js';
import {
  getPendingMessages,
  markCompleted,
  markProcessing,
  resetProcessingAcks,
} from './messages-in.js';

beforeEach(() => {
  initTestSessionDb();
});

function seedMessage(id: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 1, '{"text":"hi"}')`,
    )
    .run(id);
}

describe('resetProcessingAcks (PATCH-myia #18)', () => {
  test('removes processing claim — message becomes pending again', () => {
    seedMessage('m1');
    markProcessing(['m1']);
    expect(getPendingMessages().map((m) => m.id)).toEqual([]);

    resetProcessingAcks(['m1']);
    expect(getPendingMessages().map((m) => m.id)).toEqual(['m1']);
  });

  test('removes completed claim — message becomes re-processable', () => {
    // Push-mode stall scenario: a follow-up was marked completed (pre-fix
    // behavior) but the SDK never produced a result. Reset clears the row
    // so the message can be retried.
    seedMessage('m1');
    markProcessing(['m1']);
    markCompleted(['m1']);
    expect(getPendingMessages().map((m) => m.id)).toEqual([]);

    resetProcessingAcks(['m1']);
    expect(getPendingMessages().map((m) => m.id)).toEqual(['m1']);
  });

  test('no-op on empty list', () => {
    seedMessage('m1');
    markProcessing(['m1']);
    resetProcessingAcks([]);
    // Original claim still in place.
    expect(getPendingMessages().map((m) => m.id)).toEqual([]);
  });

  test('only resets the specified ids', () => {
    seedMessage('m1');
    seedMessage('m2');
    markProcessing(['m1', 'm2']);
    resetProcessingAcks(['m1']);

    const rows = getOutboundDb()
      .prepare('SELECT message_id, status FROM processing_ack ORDER BY message_id')
      .all() as Array<{ message_id: string; status: string }>;
    expect(rows).toEqual([{ message_id: 'm2', status: 'processing' }]);

    expect(getPendingMessages().map((m) => m.id)).toEqual(['m1']);
  });
});
