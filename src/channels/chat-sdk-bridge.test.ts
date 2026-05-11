import { describe, expect, it } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

import {
  createChatSdkBridge,
  isParseEntitiesError,
  isReactionTargetGoneError,
  postWithMarkdownFallback,
  splitForLimit,
} from './chat-sdk-bridge.js';

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface PostCall {
  threadId: string;
  message: AdapterPostableMessage;
}

function makePostCapture() {
  const calls: PostCall[] = [];
  const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
    calls.push({ threadId, message });
    return { id: 'msg-stub', threadId, raw: {} };
  };
  return { calls, postMessage };
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });
});

describe('createChatSdkBridge.deliver — display cards (send_card)', () => {
  // The send_card MCP tool writes outbound rows with `{ type: 'card', card, fallbackText }`.
  // Before this branch existed the bridge silently dropped them: cards have no
  // `text` / `markdown`, so the trailing fallback `if (text)` was false and the
  // function returned without calling the adapter. These tests pin the contract
  // for the dedicated card branch.

  it('renders title, description, and string children, then posts via the adapter', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Daily',
          description: 'Your plate today',
          children: ['• item one', '• item two'],
        },
        fallbackText: 'Daily: your plate',
      },
    });
    expect(id).toBe('msg-stub');
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { card?: unknown; fallbackText?: string };
    expect(msg.fallbackText).toBe('Daily: your plate');
    expect(msg.card).toBeDefined();
  });

  it('drops actions without url (send_card is fire-and-forget; non-URL buttons would have nowhere to land)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Card',
          description: 'has only label-only actions',
          actions: [{ label: 'Add' }, { label: 'Skip' }],
        },
      },
    });
    expect(calls).toHaveLength(1);
    // Cast through the public Card shape to read the children we set
    const msg = calls[0].message as { card?: { children?: Array<{ type?: string }> } };
    const childTypes = (msg.card?.children ?? []).map((c) => c.type);
    expect(childTypes).not.toContain('actions');
  });

  it('renders url actions as link buttons inside an Actions row', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [{ label: 'Open', url: 'https://example.com' }, { label: 'No-link' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    const buttons = actionsRow?.children ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].type).toBe('link-button');
    expect(buttons[0].url).toBe('https://example.com');
  });

  it('skips delivery when the card has neither title nor body content', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: {} },
    });
    expect(id).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('falls through to the text branch for non-card chat-sdk payloads (no regression)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { text: 'plain hello' },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('plain hello');
  });
});

describe('error classifiers (PATCH-myia anti-silent-drop)', () => {
  it('detects Telegram parse-entities rejection', () => {
    const err = Object.assign(new Error("Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 1243"), {
      name: 'ValidationError',
    });
    expect(isParseEntitiesError(err)).toBe(true);
  });

  it('does not classify generic errors as parse-entities', () => {
    expect(isParseEntitiesError(new Error('something else'))).toBe(false);
    expect(isParseEntitiesError(null)).toBe(false);
    expect(isParseEntitiesError(undefined)).toBe(false);
  });

  it('detects Telegram reaction-target-gone rejection', () => {
    const err = Object.assign(new Error('Bad Request: message to react not found'), {
      name: 'ValidationError',
    });
    expect(isReactionTargetGoneError(err)).toBe(true);
  });

  it('does not confuse reaction-not-found with other not-found errors', () => {
    expect(isReactionTargetGoneError(new Error('Bad Request: chat not found'))).toBe(false);
  });
});

describe('postWithMarkdownFallback (PATCH-myia anti-silent-drop)', () => {
  it('returns first attempt result when markdown succeeds', async () => {
    const calls: Array<{ message: AdapterPostableMessage }> = [];
    const adapter = stubAdapter({
      postMessage: async (_threadId: string, message: AdapterPostableMessage) => {
        calls.push({ message });
        return { id: 'ok-1', threadId: 't', raw: {} } as RawMessage<unknown>;
      },
    });
    const result = await postWithMarkdownFallback(adapter, 't', { markdown: '**bold**' });
    expect(result?.id).toBe('ok-1');
    expect(calls).toHaveLength(1);
    expect((calls[0].message as { markdown?: string }).markdown).toBe('**bold**');
  });

  it('retries as raw text on parse-entities error', async () => {
    let attempt = 0;
    const calls: Array<{ message: AdapterPostableMessage }> = [];
    const adapter = stubAdapter({
      postMessage: async (_threadId: string, message: AdapterPostableMessage) => {
        attempt += 1;
        calls.push({ message });
        if (attempt === 1) {
          const err = Object.assign(new Error("Bad Request: can't parse entities: ..."), {
            name: 'ValidationError',
          });
          throw err;
        }
        return { id: 'raw-ok', threadId: 't', raw: {} } as RawMessage<unknown>;
      },
    });
    const result = await postWithMarkdownFallback(adapter, 't', { markdown: 'a *broken markdown' });
    expect(result?.id).toBe('raw-ok');
    expect(calls).toHaveLength(2);
    expect((calls[0].message as { markdown?: string }).markdown).toBe('a *broken markdown');
    expect((calls[1].message as { raw?: string }).raw).toBe('a *broken markdown');
    expect((calls[1].message as { markdown?: string }).markdown).toBeUndefined();
  });

  it('rethrows non-parse errors without retrying', async () => {
    let attempts = 0;
    const adapter = stubAdapter({
      postMessage: async () => {
        attempts += 1;
        throw new Error('Internal Server Error');
      },
    });
    await expect(postWithMarkdownFallback(adapter, 't', { markdown: 'x' })).rejects.toThrow('Internal Server Error');
    expect(attempts).toBe(1);
  });

  it('preserves file uploads in the raw fallback so attachments are not lost', async () => {
    let attempt = 0;
    const calls: Array<{ message: AdapterPostableMessage }> = [];
    const adapter = stubAdapter({
      postMessage: async (_threadId: string, message: AdapterPostableMessage) => {
        attempt += 1;
        calls.push({ message });
        if (attempt === 1) {
          throw Object.assign(new Error("Bad Request: can't parse entities: x"), {
            name: 'ValidationError',
          });
        }
        return { id: 'ok', threadId: 't', raw: {} } as RawMessage<unknown>;
      },
    });
    const files = [{ data: Buffer.from('payload'), filename: 'a.txt' }];
    await postWithMarkdownFallback(adapter, 't', { markdown: '_x', files });
    expect(calls).toHaveLength(2);
    const second = calls[1].message as { files?: Array<{ filename: string }> };
    expect(second.files?.[0]?.filename).toBe('a.txt');
  });
});

describe('createChatSdkBridge.deliver — reaction error handling (PATCH-myia)', () => {
  it('swallows "message to react not found" instead of throwing', async () => {
    let reactionCalls = 0;
    const adapter = stubAdapter({
      addReaction: async () => {
        reactionCalls += 1;
        throw Object.assign(new Error('Bad Request: message to react not found'), {
          name: 'ValidationError',
        });
      },
    });
    const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
    await expect(
      bridge.deliver('telegram:42', null, {
        kind: 'chat-sdk',
        content: { operation: 'reaction', messageId: '999', emoji: '👀' },
      }),
    ).resolves.toBeUndefined();
    expect(reactionCalls).toBe(1);
  });

  it('still throws on other reaction errors so they bubble to the retry path', async () => {
    const adapter = stubAdapter({
      addReaction: async () => {
        throw new Error('Bad Request: REACTION_INVALID');
      },
    });
    const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
    await expect(
      bridge.deliver('telegram:42', null, {
        kind: 'chat-sdk',
        content: { operation: 'reaction', messageId: '999', emoji: 'bogus' },
      }),
    ).rejects.toThrow(/REACTION_INVALID/);
  });
});
