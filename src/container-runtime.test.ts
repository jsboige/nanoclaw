import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock child_process — store mock fns so tests can configure them
const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`, {
      stdio: 'pipe',
    });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', async () => {
    mockExecSync.mockReturnValueOnce('');

    await ensureContainerRuntimeRunning([0]);

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('throws when docker info fails on every retry', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    // Three zero-delay attempts so the test runs instantly.
    await expect(ensureContainerRuntimeRunning([0, 0, 0])).rejects.toThrow(
      'Container runtime is required but failed to start',
    );
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(log.error).toHaveBeenCalledWith(
      'Failed to reach container runtime after retries',
      expect.objectContaining({ attempts: 3 }),
    );
  });

  it('recovers when a later retry succeeds (the docker-pipe-hiccup case)', async () => {
    // First two probes fail (pipe gone), third succeeds (Docker came back).
    mockExecSync
      .mockImplementationOnce(() => {
        throw new Error('open //./pipe/docker_engine: The system cannot find the file specified.');
      })
      .mockImplementationOnce(() => {
        throw new Error('open //./pipe/docker_engine: The system cannot find the file specified.');
      })
      .mockReturnValueOnce('');

    await ensureContainerRuntimeRunning([0, 0, 0]);

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith('Container runtime reachable after retries', { attempts: 3 });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs a will-retry warning on each non-final failure', async () => {
    mockExecSync
      .mockImplementationOnce(() => {
        throw new Error('pipe gone');
      })
      .mockReturnValueOnce('');

    await ensureContainerRuntimeRunning([0, 0]);

    expect(log.warn).toHaveBeenCalledWith(
      'Container runtime not ready, will retry',
      expect.objectContaining({ attempt: 1, maxAttempts: 2, nextRetryInMs: 0 }),
    );
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('uses execFileSync (no shell) so quoting is platform-stable', () => {
    mockExecFileSync.mockReturnValueOnce('');

    cleanupOrphans();

    // No shell expansion → single-quote-wrapped {{.Names}} can't slip through
    // and we never invoke execSync for the listing step.
    expect(mockExecFileSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['ps', '--filter', `label=${CONTAINER_INSTALL_LABEL}`, '--format', '{{.Names}}'],
      expect.any(Object),
    );
  });

  it('stops orphaned nanoclaw containers', () => {
    // execFileSync (the ps listing) returns the names.
    mockExecFileSync.mockReturnValueOnce('nanoclaw-group1-111\nnanoclaw-group2-222\n');
    // execSync (the individual stop calls) succeeds.
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(1, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group1-111`, {
      stdio: 'pipe',
    });
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group2-222`, {
      stdio: 'pipe',
    });
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'],
    });
  });

  it('does nothing when no orphans exist', () => {
    mockExecFileSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to list orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('continues stopping remaining containers when one stop fails, and surfaces the error', () => {
    mockExecFileSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails, second succeeds.
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    // Only the one that succeeded is counted as stopped.
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 1,
      names: ['nanoclaw-b-2'],
    });
    // The failed stop is now surfaced as a warn (was silently swallowed previously).
    expect(log.warn).toHaveBeenCalledWith(
      'Could not stop orphan container',
      expect.objectContaining({ name: 'nanoclaw-a-1' }),
    );
  });

  it('regression: quoted name from a broken shell path is now visible as a warn', () => {
    // Before the fix, execSync on Windows + cmd.exe returned names wrapped in
    // single quotes. They failed stopContainer's name regex and the catch
    // silently swallowed the throw, so docker ps -q would still see the
    // container running. This test pins the new behavior: the regex still
    // rejects (we do not want to invoke shell with an arbitrary string), and
    // the rejection is now logged so we'd notice.
    mockExecFileSync.mockReturnValueOnce("'nanoclaw-quoted-1'\n");

    cleanupOrphans();

    // No actual stop happened, but the failure was logged (not swallowed).
    expect(mockExecSync).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Could not stop orphan container',
      expect.objectContaining({ name: "'nanoclaw-quoted-1'" }),
    );
  });
});
