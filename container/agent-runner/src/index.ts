/**
 * NanoClaw Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { clearStaleProcessingAcks, touchHeartbeat } from './db/connection.js';
import { writeMessageOut } from './db/messages-out.js';
import { getTaskSeriesId } from './db/session-routing.js';
import { buildSystemPromptAddendum, getAllDestinations } from './destinations.js';
import { formatFailures, probeMcpRemoteWithRetry, selectRequiredRemotes, type RequiredRemote } from './mcp-health.js';
import { ensureMemoryScaffold } from './memory/scaffold.js';
import { MEMORY_SESSION_HOOK } from './memory/session-hook.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import { runPollLoop } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

async function main(): Promise<void> {
  // Signal liveness + clear orphan claims BEFORE anything that can block (MCP
  // health probes, config IO). The host sweep kills containers whose claim
  // age exceeds tolerance with no fresher heartbeat — if we delay these two
  // calls, a pre-existing stale `processing_ack` row from a previously
  // crashed container can race the boot path and the host kills us before
  // we ever clean it. Symptom: tight kill/respawn loop, claimAge grows
  // monotonically across boots. Both calls are cheap and idempotent.
  touchHeartbeat();
  try {
    clearStaleProcessingAcks();
  } catch (err) {
    log(`Failed to clear stale processing acks at boot: ${err instanceof Error ? err.message : String(err)}`);
  }

  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Every provider shares one persistent memory tree. Legacy imports are an
  // operator-run migration and never happen in this normal startup path.
  ensureMemoryScaffold();

  // Runtime-generated system-prompt addendum: agent identity (name) plus
  // the live destinations map. Everything else (capabilities, per-module
  // instructions, per-channel formatting) is loaded by Claude Code from
  // /workspace/agent/CLAUDE.md — the composed entry imports the shared
  // base (/app/CLAUDE.md) and each enabled module's fragment. Memory is
  // supplied separately by each provider's native lifecycle hook.
  const taskId = getTaskSeriesId();
  const instructions = buildSystemPromptAddendum(
    config.assistantName || undefined,
    taskId ? { kind: 'task', taskId } : { kind: 'chat' },
  );

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // Build MCP servers config: nanoclaw built-in + any from container.json
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    nanoclaw: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
  };

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    mcpServers[name] = serverConfig;
    log(`Additional MCP server: ${name} (${serverConfig.command})`);
  }

  // Boot-time fail-fast: probe each required mcp-remote. If anything required
  // is unreachable, exit 1 — the host will spawn a fresh container, which
  // re-checks. Once the chain recovers (the watchdog auto-repairs at
  // D:\roo-extensions\scripts\mcp-watchdog\) the next boot succeeds. Surface
  // an explicit message to the first configured destination so a human sees
  // the halt instead of a silent loop.
  const requiredRemotes = selectRequiredRemotes(
    config.mcpServers as Record<string, { command: string; args: string[]; env?: Record<string, string>; required?: boolean }>,
  );
  if (requiredRemotes.length > 0) {
    log(`Health-checking ${requiredRemotes.length} required MCP remote(s): ${requiredRemotes.map((r) => r.name).join(', ')}`);
    const results = await Promise.all(
      requiredRemotes.map(async (r) => ({ name: r.name, result: await probeMcpRemoteWithRetry(r.parsed) })),
    );
    const failed = results.filter((r) => !r.result.ok);
    if (failed.length > 0) {
      const failList = formatFailures(failed);
      log(`FATAL: required MCP server(s) unreachable: ${failList}`);
      try {
        const dests = getAllDestinations();
        const dest = dests[0];
        if (dest) {
          const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
          const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
          writeMessageOut({
            id: `health-alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: 'chat',
            platform_id: platformId,
            channel_type: channelType,
            content: JSON.stringify({
              text: `🛑 Agent halted: required MCP server(s) unreachable.\n\n${failList}\n\nThe container will exit and the host will retry. If the chain stays down, manual repair is required (see watchdog log on the host).`,
            }),
          });
        }
      } catch (err) {
        log(`Failed to write health alert: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
    log('All required MCP remotes healthy.');
  }

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
    model: config.model,
    effort: config.effort,
  });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

  await runPollLoop({
    provider,
    providerName,
    cwd: CWD,
    systemContext: { instructions },
    requiredRemotes,
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
