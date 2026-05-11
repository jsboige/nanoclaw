/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFileSync, execSync } from 'child_process';
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
export const DEFAULT_RUNTIME_RETRY_DELAYS_MS: number[] = [0, 5_000, 10_000, 15_000, 30_000, 60_000, 60_000];

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
  let output: string;
  try {
    // Use execFileSync (no shell) so single-quotes around the `--format` value
    // aren't reinterpreted differently by bash (strips them) vs cmd.exe (keeps
    // them). With shell=true on Windows, docker would return literally quoted
    // names like `'nanoclaw-...-1234'`, which `stopContainer` then rejects at
    // the name regex and the orphan goes silently un-stopped — piling up
    // multiple containers on the same session DB.
    output = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['ps', '--filter', `label=${CONTAINER_INSTALL_LABEL}`, '--format', '{{.Names}}'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
  } catch (err) {
    log.warn('Failed to list orphaned containers', { err });
    return;
  }

  const orphans = output.trim().split('\n').filter(Boolean);
  const stopped: string[] = [];
  for (const name of orphans) {
    try {
      stopContainer(name);
      stopped.push(name);
    } catch (err) {
      // Surface the failure — previously a silent swallow hid the
      // quoted-name regex rejection that was the root cause of the orphan
      // pile-up. "Already stopped" is the expected case from a real race;
      // anything else is a code/env bug we need to see.
      log.warn('Could not stop orphan container', { name, err: (err as Error).message });
    }
  }
  if (stopped.length > 0) {
    log.info('Stopped orphaned containers', { count: stopped.length, names: stopped });
  }
}
