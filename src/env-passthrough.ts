/**
 * [PATCH-myia #1/#6/#38/#44/#39] Host env forwarded into agent containers.
 *
 * Single source of truth: `composeSessionSpec` fills the spec's env lane from
 * this map, and `mountPolicy()` lists the same keys so `validateSpec`'s
 * no-credentials check exempts exactly what this call injects — the fork's
 * documented credential model (PATCHES.md#2: the OneCLI gateway is optional
 * here, z.ai/GitHub credentials ride env by design, unlike upstream's
 * gateway-injects-everything invariant). Changing this function changes both
 * the injection and its policy sanction in one edit.
 */

/** [PATCH-myia #1] Forward selected host env by prefix. See PATCHES.md#1. */
const ENV_PASSTHROUGH_PREFIXES = ['ANTHROPIC_', 'GH_TOKEN_', 'MCP_', 'ASR_', 'LOCAL_MEDIUM_', 'LOCAL_MINI_'];

export function passthroughEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  // [PATCH-myia #1] Host env passthrough — only vars read by code we don't
  // own; everything NanoClaw-specific travels in container.json (read by the
  // runner at startup).
  //   `ANTHROPIC_*` — z.ai credentials + base URL so the Claude SDK inside
  //     the container reaches z.ai directly (OneCLI gateway optional, #2).
  //   `GH_TOKEN_*` — multi-identity-github skill switches `gh auth` per owner.
  //   `MCP_PROXY_BEARER`, `MCP_TOOL_TIMEOUT_MS` — roo-state-manager HTTP MCP
  //     via mcp-remote (stdio wrapper) + timeout override for long tools.
  //   `ASR_*` — Telegram voice-transcription skill (host-side ASR endpoint).
  //   `LOCAL_MEDIUM_*`, `LOCAL_MINI_*` — internal vLLM endpoints the
  //     cluster-manager skill curls directly for lightweight local inference.
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && ENV_PASSTHROUGH_PREFIXES.some((p) => key.startsWith(p))) {
      env[key] = value;
    }
  }

  // [PATCH-myia #6] Pass host GH_TOKEN through (the GH_TOKEN_ prefix above
  // only matches identity-suffixed tokens). Fall back to GH_TOKEN_JSBOIGE so
  // bare `gh` works without the multi-identity-github skill switching
  // identity — the skill still overrides per repo owner.
  const ghTokenDefault = process.env.GH_TOKEN ?? process.env.GH_TOKEN_JSBOIGE;
  if (ghTokenDefault) env.GH_TOKEN = ghTokenDefault;

  // [PATCH-myia #38] The agent-runner reads CLAUDE_CODE_AUTO_COMPACT_WINDOW
  // from its process.env, but no prefix above covers CLAUDE_*. Wire this one
  // specific var (not the broad CLAUDE_CODE_ prefix, which would also forward
  // settings.json-managed flags). Used to cap condensation at 250k on the
  // 1M-context glm-5.2.
  if (process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  }

  // [PATCH-myia #44] Same gap as #38, one var later: the mid-life rotation
  // guard reads CLAUDE_TRANSCRIPT_ROTATE_BYTES from the container's env and
  // falls back to a 12MB default when absent. The operator override lives in
  // .env (4MB) — without this forward it never reached the container and the
  // proactive rotation was dead while sessions climbed into the thrash zone.
  if (process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES) {
    env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES;
  }

  // [PATCH-myia #39] Exempt internal hosts from the OneCLI HTTPS proxy. The
  // gateway's contribution injects HTTP(S)_PROXY=…@host.docker.internal:10255
  // + NODE_USE_ENV_PROXY=1 so the agent's *external* API calls route through
  // the vault for credential injection — but it sets no NO_PROXY, so traffic
  // to the host's *internal* services is forced through the credential proxy
  // too, which 401s it. The big casualty is the roo-state-manager + sk-agent
  // MCP at host.docker.internal:9090 (PATCHES.md#2 bypass): it carries its
  // own bearer and must NOT be proxied — a proxied MCP bus means bot
  // crash-loop. Rides the base env lane (the gateway emits no NO_PROXY, so no
  // collision; if it ever did, contributedEnv wins and this must be
  // revisited). Both cases set since some clients check only one form.
  // Regressed in with the v2.1.17 OneCLI SDK 0.5→2.2 bump, which started
  // injecting the proxy env.
  const noProxy = 'host.docker.internal,localhost,127.0.0.1';
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;

  return env;
}
