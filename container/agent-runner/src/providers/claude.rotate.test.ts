import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ClaudeProvider, detectAutocompactThrash } from './claude.js';

// maybeRotateContinuation guards the cold-resume failure mode: a long-lived
// session whose on-disk transcript has grown so large (or old) that the SDK
// can't reload it before the host's idle ceiling kills the container.

let tmp: string;
let prevHome: string | undefined;
let prevConv: string | undefined;
let prevBytes: string | undefined;
let prevDays: string | undefined;

const PROJECT_DIR = '-workspace-agent';
const CWD = '/workspace/agent';

function writeTranscript(sessionId: string, bytes: number, firstTs?: string): string {
  const dir = path.join(tmp, '.claude', 'projects', PROJECT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${sessionId}.jsonl`);
  const first =
    JSON.stringify({
      type: 'user',
      timestamp: firstTs ?? new Date().toISOString(),
      message: { role: 'user', content: 'hello' },
    }) + '\n';
  const filler = 'x'.repeat(Math.max(0, bytes - first.length));
  fs.writeFileSync(p, first + filler);
  return p;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-rotate-'));
  prevHome = process.env.HOME;
  prevConv = process.env.NANOCLAW_CONVERSATIONS_DIR;
  prevBytes = process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES;
  prevDays = process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS;
  process.env.HOME = tmp;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.NANOCLAW_CONVERSATIONS_DIR = path.join(tmp, 'conversations');
});

afterEach(() => {
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore('HOME', prevHome);
  restore('NANOCLAW_CONVERSATIONS_DIR', prevConv);
  restore('CLAUDE_TRANSCRIPT_ROTATE_BYTES', prevBytes);
  restore('CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS', prevDays);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ClaudeProvider.maybeRotateContinuation', () => {
  it('keeps a small, recent transcript (returns null, leaves file in place)', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(1024 * 1024);
    const p = writeTranscript('sess-small', 4096);
    const provider = new ClaudeProvider();
    expect(provider.maybeRotateContinuation('sess-small', CWD)).toBeNull();
    expect(fs.existsSync(p)).toBe(true);
  });

  it('rotates an oversized transcript (returns reason, moves the .jsonl aside)', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(64 * 1024);
    const p = writeTranscript('sess-big', 200 * 1024);
    const provider = new ClaudeProvider();
    const reason = provider.maybeRotateContinuation('sess-big', CWD);
    expect(reason).toContain('MB');
    expect(fs.existsSync(p)).toBe(false); // original moved out of the resume path
    const dir = path.dirname(p);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('sess-big.jsonl.rotated-'))).toBe(true);
  });

  it('rotates an aged transcript even when small', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(1024 * 1024);
    process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS = '7';
    const old = new Date(Date.now() - 10 * 86400_000).toISOString();
    writeTranscript('sess-old', 2048, old);
    const provider = new ClaudeProvider();
    expect(provider.maybeRotateContinuation('sess-old', CWD)).toContain('d');
  });

  it('returns null for an unknown session id', () => {
    const provider = new ClaudeProvider();
    expect(provider.maybeRotateContinuation('does-not-exist', CWD)).toBeNull();
  });
});

// [PATCH-myia #42] isSessionInvalid must match the autocompact-thrash result
// text so the poll-loop's result path can clear the continuation and let the
// next turn start fresh — the self-heal that breaks the infinite thrash loop.
// The SDK surfaces it as a result error string (not a thrown Error), so both
// the string and Error-message shapes must match.
describe('ClaudeProvider.isSessionInvalid (thrash detection)', () => {
  it('matches the autocompact-thrash result text (string form, from result path)', () => {
    const provider = new ClaudeProvider();
    expect(
      provider.isSessionInvalid(
        'Error: Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row.',
      ),
    ).toBe(true);
  });

  it('matches an Error carrying the thrash message (thrown-error form, catch path)', () => {
    const provider = new ClaudeProvider();
    expect(provider.isSessionInvalid(new Error('Autocompact is thrashing: refill loop'))).toBe(true);
  });

  it('does not match a non-session error (e.g. billing) — regression guard', () => {
    const provider = new ClaudeProvider();
    expect(provider.isSessionInvalid('Error: 403 billing_error: usage limit reached')).toBe(false);
  });
});

// [PATCH-myia #43] The thrash notice arrives as an ASSISTANT text message, not
// a result error — verified firsthand in transcript 6b55129b (2026-07-19),
// where the final assistant block was "Autocompact is thrashing: the context
// refilled...". detectAutocompactThrash must find it in that shape so
// translateEvents can throw and route into the message-preserving recovery.
describe('detectAutocompactThrash (assistant-message shape)', () => {
  it('detects the thrash notice in an assistant text block (real SDK shape)', () => {
    const msg = {
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row. Use /clear to start fresh.',
          },
        ],
      },
    };
    expect(detectAutocompactThrash(msg)).toContain('thrashing');
  });

  it('detects the thrash even when mixed with other blocks', () => {
    const msg = {
      message: {
        content: [
          { type: 'text', text: 'Working on the review...' },
          { type: 'tool_use', name: 'Bash', input: {} },
          { type: 'text', text: 'Autocompact is thrashing: refill loop, 3x in a row.' },
        ],
      },
    };
    expect(detectAutocompactThrash(msg)).toContain('thrashing');
  });

  it('does not fire on a casual mention without the SDK colon format — false-positive guard', () => {
    const msg = {
      message: {
        content: [{ type: 'text', text: 'I noticed the autocompact is thrashing again on that session, investigating.' }],
      },
    };
    expect(detectAutocompactThrash(msg)).toBeNull();
  });

  it('returns null for a normal assistant reply', () => {
    const msg = { message: { content: [{ type: 'text', text: 'Here is the PR review summary.' }] } };
    expect(detectAutocompactThrash(msg)).toBeNull();
  });

  it('returns null when content is missing or malformed', () => {
    expect(detectAutocompactThrash({})).toBeNull();
    expect(detectAutocompactThrash({ message: {} })).toBeNull();
    expect(detectAutocompactThrash({ message: { content: 'not-an-array' } })).toBeNull();
  });
});
