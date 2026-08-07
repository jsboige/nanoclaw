/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getOutboundDb } from './connection.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT value FROM session_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}

/**
 * The a2a reply stamp: the id of the first inbound message in the batch the
 * agent is currently processing. The poll loop publishes it at batch start;
 * MCP tools (`send_message`, `send_file`) read it and stamp it onto outbound
 * rows so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * This lives in outbound.db rather than module state because the MCP server
 * runs as a separate stdio subprocess from the poll loop — module state set
 * by the poll loop is invisible to it. Both processes open outbound.db
 * (journal_mode=DELETE + busy_timeout make intra-container access safe).
 */
const IN_REPLY_TO_KEY = 'current_in_reply_to';

/**
 * Ignore a stamp older than this. The poll loop clears the stamp in a
 * finally, but a container killed mid-batch (SIGKILL) can leave one behind;
 * the guard stops a later out-of-batch read from picking up a dead stamp.
 * Generous so a long-running batch's late sends still stamp correctly.
 */
const IN_REPLY_TO_MAX_AGE_MS = 30 * 60 * 1000;

export function setCurrentInReplyTo(id: string | null): void {
  if (id === null) {
    clearCurrentInReplyTo();
    return;
  }
  setValue(IN_REPLY_TO_KEY, id);
}

export function clearCurrentInReplyTo(): void {
  deleteValue(IN_REPLY_TO_KEY);
}

export function getCurrentInReplyTo(): string | null {
  const row = getOutboundDb()
    .prepare('SELECT value, updated_at FROM session_state WHERE key = ?')
    .get(IN_REPLY_TO_KEY) as { value: string; updated_at: string } | undefined;
  if (!row) return null;
  const age = Date.now() - new Date(row.updated_at).getTime();
  if (!Number.isFinite(age) || age > IN_REPLY_TO_MAX_AGE_MS) return null;
  return row.value;
}

/**
 * [PATCH-myia #37] Per-batch send_message call counter. Prevents GLM tool-call
 * loops where the model calls send_message with identical args hundreds of times
 * in a single batch (incident 2026-06-07: 39 "stop loop" sends in one batch).
 *
 * PATCH #36 caps <message to> text blocks in dispatchResultText, but tool-call
 * loops bypass that — each call writes directly to messages_out. This counter
 * caps the tool vector. The cap (20) is generous for legitimate multi-destination
 * sends.
 *
 * Persisted to outbound.db (not module state) because the nanoclaw MCP tools run
 * in a separate stdio subprocess from the poll loop — and that subprocess is
 * long-lived across batches in push mode (#25), so an in-memory counter would
 * accumulate across batches and cap legitimate sends. The poll loop resets this
 * at batch start (next to setCurrentInReplyTo); outbound.db (journal_mode=DELETE
 * + busy_timeout) makes the cross-process access safe.
 */
const BATCH_SEND_COUNT_KEY = 'batch_send_count';
const MAX_SENDS_PER_BATCH = 20;

/** Increment the per-batch send count and report whether the cap was hit. */
export function checkAndIncrementSendCount(): boolean {
  const current = Number(getValue(BATCH_SEND_COUNT_KEY) ?? '0') + 1;
  setValue(BATCH_SEND_COUNT_KEY, String(current));
  return current > MAX_SENDS_PER_BATCH;
}

/** Reset the per-batch send count. Called by the poll loop at batch start. */
export function resetBatchSendCount(): void {
  deleteValue(BATCH_SEND_COUNT_KEY);
}
