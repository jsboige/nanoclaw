import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-claude-md-compose-test';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-claude-md-compose-test/groups',
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { composeGroupClaudeMd } from './claude-md-compose.js';
import { log } from './log.js';
import { ensureContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { PERSONA_PREPEND_FILE } from './group-persona.js';
import type { AgentGroup } from './types.js';

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

function seed(ag: AgentGroup): void {
  createAgentGroup(ag);
  ensureContainerConfig(ag.id);
}

function writePersona(folder: string, text: string): void {
  const dir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PERSONA_PREPEND_FILE), text);
}

function importsOf(folder: string): string[] {
  const md = fs.readFileSync(path.join(GROUPS_DIR, folder, 'CLAUDE.md'), 'utf-8');
  return md.split('\n').filter((line) => line.startsWith('@'));
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('composeGroupClaudeMd persona prepend', () => {
  it('imports the persona fragment FIRST, before the shared base', () => {
    const ag = group('ag-persona', 'persona-group');
    seed(ag);
    writePersona(ag.folder, 'You are an SDR agent.\n');

    composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports[0]).toBe('@./.claude-fragments/persona.md');
    expect(imports[1]).toBe('@./.claude-shared.md');
    expect(fs.readFileSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'persona.md'), 'utf-8')).toBe(
      'You are an SDR agent.',
    );
  });

  it('keeps the persona across a second compose (not pruned)', () => {
    const ag = group('ag-persona-2', 'persona-group-2');
    seed(ag);
    writePersona(ag.folder, 'persona body');

    composeGroupClaudeMd(ag);
    composeGroupClaudeMd(ag);

    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'persona.md'))).toBe(true);
    expect(importsOf(ag.folder)[0]).toBe('@./.claude-fragments/persona.md');
  });

  it('is inert when no persona file is present (non-template groups)', () => {
    const ag = group('ag-no-persona', 'no-persona-group');
    seed(ag);

    composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports[0]).toBe('@./.claude-shared.md');
    expect(imports).not.toContain('@./.claude-fragments/persona.md');
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, '.claude-fragments', 'persona.md'))).toBe(false);
  });
});

describe('composeGroupClaudeMd scheduling instructions (ncl tasks reach-in)', () => {
  // Red-on-delete guard for the `scheduling`/`cli` exclusion at the
  // module-fragment loop: the agent is taught `ncl tasks` iff it has ncl.
  it('imports module-scheduling.md at the default cli_scope', () => {
    const ag = group('ag-sched', 'sched-group');
    seed(ag);

    composeGroupClaudeMd(ag);

    expect(importsOf(ag.folder)).toContain('@./.claude-fragments/module-scheduling.md');
  });

  it('excludes module-scheduling.md (and module-cli.md) when cli_scope is disabled', () => {
    const ag = group('ag-sched-off', 'sched-group-off');
    seed(ag);
    updateContainerConfigScalars(ag.id, { cli_scope: 'disabled' });

    composeGroupClaudeMd(ag);

    const imports = importsOf(ag.folder);
    expect(imports).not.toContain('@./.claude-fragments/module-scheduling.md');
    expect(imports).not.toContain('@./.claude-fragments/module-cli.md');
  });
});

// The bound exercises the REAL production thresholds (64KB / 256KB) rather
// than injected ones: the defect these guard against is a file that grew past
// the shipped limits, so a test that moves the limits proves nothing.
describe('CLAUDE.local.md injection bound', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function localPath(folder: string): string {
    return path.join(GROUPS_DIR, folder, 'CLAUDE.local.md');
  }
  function overflowFiles(folder: string): string[] {
    return fs.readdirSync(path.join(GROUPS_DIR, folder)).filter((f) => f.startsWith('CLAUDE.local.overflow-'));
  }

  it('leaves a file under the warn threshold untouched and silent', () => {
    const ag = group('ag-small', 'bound-small');
    seed(ag);
    composeGroupClaudeMd(ag);
    const body = 'rule\n'.repeat(200);
    fs.writeFileSync(localPath(ag.folder), body);

    composeGroupClaudeMd(ag);

    expect(fs.readFileSync(localPath(ag.folder), 'utf-8')).toBe(body);
    expect(overflowFiles(ag.folder)).toHaveLength(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns past the warn threshold WITHOUT mutating the file', () => {
    const ag = group('ag-warn', 'bound-warn');
    seed(ag);
    composeGroupClaudeMd(ag);
    const body = 'x'.repeat(100 * 1024);
    fs.writeFileSync(localPath(ag.folder), body);

    composeGroupClaudeMd(ag);

    expect(fs.readFileSync(localPath(ag.folder), 'utf-8')).toBe(body);
    expect(overflowFiles(ag.folder)).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('oversized'),
      expect.objectContaining({ folder: ag.folder, bytes: body.length }),
    );
  });

  it('rotates past the bound, preserving the previous contents verbatim', () => {
    const ag = group('ag-rotate', 'bound-rotate');
    seed(ag);
    composeGroupClaudeMd(ag);
    const body = 'y'.repeat(300 * 1024);
    fs.writeFileSync(localPath(ag.folder), body);

    composeGroupClaudeMd(ag);

    const archives = overflowFiles(ag.folder);
    expect(archives).toHaveLength(1);
    // Nothing deleted: the archive is byte-identical to what was rotated out.
    expect(fs.readFileSync(path.join(GROUPS_DIR, ag.folder, archives[0]), 'utf-8')).toBe(body);
    // And the injected surface is now a stub that names the archive.
    const stub = fs.readFileSync(localPath(ag.folder), 'utf-8');
    expect(stub.length).toBeLessThan(2048);
    expect(stub).toContain(archives[0]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('rotated'),
      expect.objectContaining({ archive: archives[0] }),
    );
  });
});
