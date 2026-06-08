/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { setCurrentInReplyTo, clearCurrentInReplyTo } from '../current-batch.js';
// Re-import so the per-test reset (clearCurrentInReplyTo) also resets the send counter.
import { sendMessage } from './core.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  clearCurrentInReplyTo();
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps current batch in_reply_to on outbound rows', async () => {
    setCurrentInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // No setCurrentInReplyTo before this call — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

describe('send_message MCP tool — PATCH #37 batch cap', () => {
  it('should allow up to 20 send_message calls per batch', async () => {
    for (let i = 0; i < 20; i++) {
      const result = await sendMessage.handler({ to: 'peer', text: `msg ${i}` });
      expect(result.isError).toBeFalsy();
    }
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(20);
  });

  it('should reject send_message calls beyond the batch cap', async () => {
    for (let i = 0; i < 25; i++) {
      await sendMessage.handler({ to: 'peer', text: `msg ${i}` });
    }
    // Only 20 should have been written, the rest rejected
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(20);
  });

  it('should reset the cap when batch is cleared', async () => {
    // Fill to cap
    for (let i = 0; i < 22; i++) {
      await sendMessage.handler({ to: 'peer', text: `msg ${i}` });
    }
    // Clear batch (simulates poll-loop batch boundary)
    clearCurrentInReplyTo();
    // Should be able to send again
    const result = await sendMessage.handler({ to: 'peer', text: 'after reset' });
    expect(result.isError).toBeFalsy();
  });
});
