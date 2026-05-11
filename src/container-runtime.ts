/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/**
 * Retry schedule for {@link ensureContainerRuntimeRunning}. Index 0 = first
 * attempt (no delay). The function tries each entry as a sleep-then-probe step
 * until either the probe succeeds or the schedule is exhausted. Total budget
 * ~180s — enough to absorb a Docker Desktop restart hiccup on Windows
 * (typically 30-90s) before bubbling FATAL up to the circuit breaker.
 *
 * Exported for tests.
 */
export const DEFAULT_RUNTIME_RETRY_DELAYS_MS: number[] = [
  0, 5_000, 10_000, 15_000, 30_000, 60_000, 60_000,
];

/**
 * Ensure the container runtime is running, retrying on transient pipe failures.
 *
 * On Windows the `\\.\pipe\docker_engine` named pipe can briefly disappear
 * during Docker Desktop restarts, WSL kernel churn, or resource pressure. The
 * original one-shot probe turned every such hiccup into a FATAL exit, which
 * tripped the startup circuit breaker into 5-15min backoff and made the host
 * fail to re-attach for far longer than the underlying Docker outage. We now
 * retry inside the function so a transient hiccup doesn't kill the host.
 */
export async function ensureContainerRuntimeRunning(
  retryDelaysMs: number[] = DEFAULT_RUNTIME_RETRY_DELAYS_MS,
): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < retryDelaysMs.length; i++) {
    if (retryDelaysMs[i] > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelaysMs[i]));
    }
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} info`, {
        stdio: 'pipe',
        timeout: 10000,
      });
      if (i > 0) {
        log.info('Container runtime reachable after retries', { attempts: i + 1 });
      } else {
        log.debug('Container runtime already running');
      }
      return;
    } catch (err) {
      lastErr = err;
      const nextDelay = retryDelaysMs[i + 1];
      if (nextDelay !== undefined) {
        const errMsg = (err as { message?: string }).message?.split('\n')[0] ?? 'unknown';
        log.warn('Container runtime not ready, will retry', {
          attempt: i + 1,
          maxAttempts: retryDelaysMs.length,
          nextRetryInMs: nextDelay,
          err: errMsg,
        });
      }
    }
  }
  log.error('Failed to reach container runtime after retries', {
    err: lastErr,
    attempts: retryDelaysMs.length,
  });
  console.error('\n╔════════════════════════════════════════════════════════════════╗');
  console.error('║  FATAL: Container runtime failed to start                      ║');
  console.error('║                                                                ║');
  console.error('║  Agents cannot run without a container runtime. To fix:        ║');
  console.error('║  1. Ensure Docker is installed and running                     ║');
  console.error('║  2. Run: docker info                                           ║');
  console.error('║  3. Restart NanoClaw                                           ║');
  console.error('╚════════════════════════════════════════════════════════════════╝\n');
  throw new Error('Container runtime is required but failed to start', {
    cause: lastErr,
  });
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
