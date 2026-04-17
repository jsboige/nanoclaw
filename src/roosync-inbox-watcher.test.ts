import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildSyntheticMessage,
  resolveTargetJid,
  startRoosyncInboxWatcher,
  type InboxMessage,
} from './roosync-inbox-watcher.js';
import { RegisteredGroup } from './types.js';

vi.mock('./db.js', () => ({
  storeMessageDirect: vi.fn(),
}));

import { storeMessageDirect } from './db.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeInboxFile(
  inboxDir: string,
  msg: Partial<InboxMessage> & { id: string },
): void {
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.writeFileSync(
    path.join(inboxDir, `${msg.id}.json`),
    JSON.stringify(msg, null, 2),
  );
}

describe('resolveTargetJid', () => {
  it('returns override when provided', () => {
    expect(resolveTargetJid({}, 'tg:override')).toBe('tg:override');
  });

  it('returns the main group jid when no override', () => {
    const groups: Record<string, RegisteredGroup> = {
      'tg:1': {
        name: 'Secondary',
        folder: 'secondary',
        trigger: '@x',
        added_at: '',
        isMain: false,
      },
      'tg:2': {
        name: 'Main',
        folder: 'main',
        trigger: '@x',
        added_at: '',
        isMain: true,
      },
    };
    expect(resolveTargetJid(groups, '')).toBe('tg:2');
  });

  it('returns null when no main group is registered', () => {
    expect(resolveTargetJid({}, '')).toBeNull();
  });
});

describe('buildSyntheticMessage', () => {
  const fixedNow = new Date('2026-04-17T22:00:00.000Z');

  it('embeds trigger, from/subject, msgId and excerpt', () => {
    const msg: InboxMessage = {
      id: 'msg-123',
      from: 'myia-ai-01:nanoclaw',
      to: 'nanoclaw-cluster:nanoclaw',
      subject: '[MENTION] Dashboard workspace-nanoclaw',
      body: 'Body content with   multiple    spaces\nand lines',
      tags: ['mention', 'v3'],
    };
    const synth = buildSyntheticMessage(msg, 'tg:main', fixedNow);

    expect(synth.id).toBe('roosync-msg-123');
    expect(synth.chat_jid).toBe('tg:main');
    expect(synth.sender).toBe('roosync-inbox');
    expect(synth.sender_name).toBe('RooSync Inbox');
    expect(synth.timestamp).toBe('2026-04-17T22:00:00.000Z');
    expect(synth.is_from_me).toBe(false);
    expect(synth.is_bot_message).toBe(false);
    expect(synth.content).toContain('@ClusterManager');
    expect(synth.content).toContain('[roosync-inbox]');
    expect(synth.content).toContain('msg-123');
    expect(synth.content).toContain('myia-ai-01:nanoclaw');
    expect(synth.content).toContain('[mention, v3]');
    expect(synth.content).toContain(
      'Body content with multiple spaces and lines',
    );
  });

  it('truncates long bodies to 400 chars', () => {
    const longBody = 'x'.repeat(1000);
    const synth = buildSyntheticMessage(
      {
        id: 'm',
        from: 'a:b',
        to: 'c:d',
        subject: 's',
        body: longBody,
      },
      'tg:main',
      fixedNow,
    );
    const excerptMatch = synth.content.match(/Extrait: (x+)/);
    expect(excerptMatch?.[1].length).toBe(400);
  });

  it('handles missing body and tags gracefully', () => {
    const synth = buildSyntheticMessage(
      { id: 'm', from: 'a:b', to: 'c:d', subject: 's' },
      'tg:main',
      fixedNow,
    );
    expect(synth.content).toContain('Extrait:');
    expect(synth.content).not.toContain('[,');
  });
});

describe('startRoosyncInboxWatcher', () => {
  let sharedPath: string;
  let dataDir: string;
  let inboxDir: string;
  const mainGroups: Record<string, RegisteredGroup> = {
    'tg:main': {
      name: 'Main',
      folder: 'telegram_main',
      trigger: '@ClusterManager',
      added_at: '',
      isMain: true,
    },
  };

  beforeEach(() => {
    sharedPath = tmpDir('roosync-shared-');
    dataDir = tmpDir('nanoclaw-data-');
    inboxDir = path.join(sharedPath, 'messages', 'inbox');
    vi.mocked(storeMessageDirect).mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(sharedPath, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns stop() noop when config is missing', () => {
    const handle = startRoosyncInboxWatcher(
      { registeredGroups: () => mainGroups },
      { sharedPath: '', machineId: '', workspace: '', dataDir },
    );
    expect(typeof handle.stop).toBe('function');
    handle.stop();
  });

  it('injects synthetic message for new matching inbox file', () => {
    writeInboxFile(inboxDir, {
      id: 'msg-20260417T211129-rx40dj',
      from: 'myia-ai-01:nanoclaw',
      to: 'nanoclaw-cluster:nanoclaw',
      subject: '[MENTION] test',
      body: 'ping',
    });

    const handle = startRoosyncInboxWatcher(
      { registeredGroups: () => mainGroups },
      {
        sharedPath,
        machineId: 'nanoclaw-cluster',
        workspace: 'nanoclaw',
        pollInterval: 10,
        dataDir,
        now: () => new Date('2026-04-17T22:00:00.000Z'),
      },
    );

    vi.advanceTimersByTime(15);
    handle.stop();

    expect(storeMessageDirect).toHaveBeenCalledTimes(1);
    const call = vi.mocked(storeMessageDirect).mock.calls[0][0];
    expect(call.id).toBe('roosync-msg-20260417T211129-rx40dj');
    expect(call.chat_jid).toBe('tg:main');

    const stateFile = path.join(dataDir, 'roosync-inbox-processed.json');
    expect(fs.existsSync(stateFile)).toBe(true);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(state.ids).toContain('msg-20260417T211129-rx40dj');
  });

  it('ignores messages addressed to a different machine:workspace', () => {
    writeInboxFile(inboxDir, {
      id: 'msg-other',
      from: 'x:y',
      to: 'other-machine:other-ws',
      subject: 's',
    });

    const handle = startRoosyncInboxWatcher(
      { registeredGroups: () => mainGroups },
      {
        sharedPath,
        machineId: 'nanoclaw-cluster',
        workspace: 'nanoclaw',
        pollInterval: 10,
        dataDir,
      },
    );

    vi.advanceTimersByTime(15);
    handle.stop();
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  it('deduplicates: does not re-inject a message already processed', () => {
    writeInboxFile(inboxDir, {
      id: 'msg-dup',
      from: 'a:b',
      to: 'nanoclaw-cluster:nanoclaw',
      subject: 's',
    });

    const handle = startRoosyncInboxWatcher(
      { registeredGroups: () => mainGroups },
      {
        sharedPath,
        machineId: 'nanoclaw-cluster',
        workspace: 'nanoclaw',
        pollInterval: 10,
        dataDir,
      },
    );

    vi.advanceTimersByTime(15);
    vi.advanceTimersByTime(15);
    vi.advanceTimersByTime(15);
    handle.stop();

    expect(storeMessageDirect).toHaveBeenCalledTimes(1);
  });

  it('skips injection when no main group is registered', () => {
    writeInboxFile(inboxDir, {
      id: 'msg-no-main',
      from: 'a:b',
      to: 'nanoclaw-cluster:nanoclaw',
      subject: 's',
    });

    const handle = startRoosyncInboxWatcher(
      { registeredGroups: () => ({}) },
      {
        sharedPath,
        machineId: 'nanoclaw-cluster',
        workspace: 'nanoclaw',
        pollInterval: 10,
        dataDir,
      },
    );

    vi.advanceTimersByTime(15);
    handle.stop();
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });
});
