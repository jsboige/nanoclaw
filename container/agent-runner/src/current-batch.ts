/**
 * Per-batch context the poll loop publishes for downstream consumers
 * (MCP tools, etc.) that don't sit on the poll-loop's call stack.
 *
 * Today the only field is `inReplyTo` — the id of the first inbound
 * message in the batch the agent is currently processing. MCP tools like
 * `send_message` and `send_file` read this and stamp it onto the outbound
 * row so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * This is module-level state on purpose: the agent-runner is single-process
 * and processes one batch at a time. Poll-loop calls `setCurrentInReplyTo`
 * before invoking the provider and `clearCurrentInReplyTo` after the batch
 * completes (or errors out).
 */
let currentInReplyTo: string | null = null;

// [PATCH-myia #37] Per-batch send_message call counter. Prevents GLM tool-call
// loops where the model calls send_message with identical args hundreds of times
// in a single batch. PATCH #36 caps <message to> blocks in the text output, but
// tool-call loops bypass that entirely — each call writes directly to messages_out.
// The cap is generous (20) to avoid blocking legitimate multi-destination sends.
const MAX_SENDS_PER_BATCH = 20;
let batchSendCount = 0;

export function setCurrentInReplyTo(id: string | null): void {
  currentInReplyTo = id;
}

export function clearCurrentInReplyTo(): void {
  currentInReplyTo = null;
  batchSendCount = 0; // reset on batch boundary
}

export function getCurrentInReplyTo(): string | null {
  return currentInReplyTo;
}

/** [PATCH-myia #37] Increment send count and check if the batch cap has been hit. */
export function checkAndIncrementSendCount(): boolean {
  batchSendCount++;
  return batchSendCount > MAX_SENDS_PER_BATCH;
}

