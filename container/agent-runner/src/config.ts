/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

const CONFIG_PATH = '/workspace/agent/container.json';

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}

const DEFAULT_MAX_MESSAGES = 10;

let _config: RunnerConfig | null = null;

/**
 * jsboige/nanoclaw fork patch — expand `${VAR}` references against process.env
 * before handing the config to the SDK. Lets container.json reference secrets
 * that arrive via `docker -e` rather than being baked into a committed file.
 * PATCHES.md#6. Exit condition: upstream grows native env-substitution.
 */
function expandEnv<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, name) => process.env[name] ?? '') as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEnv(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = expandEnv(v);
    return out as unknown as T;
  }
  return value;
}

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${CONFIG_PATH}, using defaults`);
  }

  const mcpServers = expandEnv(
    (raw.mcpServers as RunnerConfig['mcpServers']) || {},
  );

  _config = {
    provider: (raw.provider as string) || 'claude',
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers,
  };

  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
