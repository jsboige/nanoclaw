/**
 * OneCLI — the built-in gateway provider.
 *
 * The same wiring the spawn path always did (ensure the agent exists
 * gateway-side, fetch the per-session container config, treat "not applied" as
 * a transient hard failure), with one change: the contribution crosses into
 * the spec as TYPED env and mounts, merged before validation, instead of raw
 * docker flags appended after it.
 *
 * The SDK's apply surface still emits argv, so this provider parses it at the
 * boundary. The grammar is closed and known from the SDK source: with
 * `addHostMapping: false` it emits exactly `-e KEY=VALUE` pairs (proxy env,
 * CA bundle pointers) and `-v host:container[:ro]` mounts (the CA
 * certificate, credential stub FILES — stubs never ride env). Anything else
 * refuses the spawn: nothing gets to ride raw argv around the spec again. A
 * typed SDK config surface is the successor that deletes this parser.
 */
import { OneCLI } from '@onecli-sh/sdk';

import { ONECLI_API_KEY, ONECLI_URL } from '../config.js';
import type { MountSpec } from '../drivers/types.js';
import { log } from '../log.js';

import {
  registerGatewayProvider,
  type GatewayApprovalRequest,
  type GatewayApprovalSource,
  type GatewayContribution,
} from './gateway-provider-registry.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/**
 * [PATCH-myia #33] Markers that identify a transient network/pipe failure
 * we're willing to retry. Conservative — anything else (auth, validation,
 * unknown agent) bubbles immediately so we don't mask genuine outages.
 *
 * `fetch failed` is OneCLI SDK's wrapped node-fetch error when the gateway
 * socket blips; the `pipe` / `cannot find the file specified` markers are
 * the Windows docker pipe equivalent. The rest are stock Node net errors
 * for the same class.
 */
const TRANSIENT_ERROR_MARKERS = [
  'fetch failed',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'socket hang up',
  'docker_engine',
  'cannot find the file specified',
];

function isTransientRuntimeError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? '';
  if (!msg) return false;
  return TRANSIENT_ERROR_MARKERS.some((marker) => msg.includes(marker));
}

/**
 * [PATCH-myia #33] Wrap the gateway's SDK calls in a bounded transient retry.
 * The SDK's underlying fetch blips when OneCLI restarts or the Windows pipe
 * is briefly unreachable, surfacing as `OneCLIError: fetch failed`. Pre-fix:
 * a single blip threw out of wakeContainer → host-sweep didn't re-try for
 * 60s → inbound message backed up that long. 3 attempts × 1s sleep ≈ 3s
 * worst-case stall; longer would back the inbound queue up. Bails
 * immediately on non-transient errors so genuine misconfiguration surfaces
 * fast.
 */
async function retryOnTransientRuntimeError<T>(
  fn: () => Promise<T>,
  opts: { label: string; attempts?: number; delayMs?: number },
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 1000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await fn();
      if (i > 0) {
        log.info('retryOnTransientRuntimeError recovered', { label: opts.label, attempts: i + 1 });
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (!isTransientRuntimeError(err) || i === attempts - 1) {
        throw err;
      }
      log.warn('retryOnTransientRuntimeError: transient error, will retry', {
        label: opts.label,
        attempt: i + 1,
        maxAttempts: attempts,
        nextRetryInMs: delayMs,
        err: (err as { message?: string }).message ?? 'unknown',
      });
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

/** Argv → typed contribution. Exported for its tests; the grammar is closed. */
export function contributionFromArgs(args: readonly string[], groupScope: string): GatewayContribution {
  const env: Record<string, string> = {};
  const mounts: MountSpec[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '-e' && value?.includes('=')) {
      const eq = value.indexOf('=');
      env[value.slice(0, eq)] = value.slice(eq + 1);
      continue;
    }
    if (flag === '-v' && value) {
      const parts = value.split(':');
      if (parts.length >= 2 && parts.length <= 3 && (parts[2] === undefined || parts[2] === 'ro')) {
        mounts.push({
          class: 'allowlisted-extra',
          hostPath: parts[0],
          containerPath: parts[1],
          mode: parts[2] === 'ro' ? 'ro' : 'rw',
          groupScope,
        });
        continue;
      }
    }
    // Fail-closed on grammar drift: an SDK that starts emitting a flag this
    // parser cannot type must break the spawn loudly, not smuggle argv.
    throw new Error(`OneCLI gateway emitted argv this seam cannot type: '${flag} ${value ?? ''}'`);
  }
  return { env, mounts };
}

/**
 * OneCLI's approvals capability: the SDK's manual-approval long-poll, mapped
 * to the neutral request shape. `listPending`/`decide` are deliberately
 * absent — the gateway does not redeliver un-decided requests on reconnect
 * and the SDK exposes no late-decision surface, so the capability flags
 * honestly say so and the approvals module degrades accordingly.
 */
function onecliApprovalSource(): GatewayApprovalSource {
  return {
    subscribe(handler) {
      const handle = onecli.configureManualApproval(async (request) =>
        // The SDK's ApprovalRequest is structurally the neutral shape (the
        // hosted gateway's `summary` rides as an extra field).
        handler(request as unknown as GatewayApprovalRequest),
      );
      return { stop: () => handle.stop() };
    },
  };
}

registerGatewayProvider('onecli', () => ({
  kind: 'onecli',
  approvals: onecliApprovalSource,
  async contribute({ key, groupName }) {
    // OneCLI agent identifier is always the agent group id — stable across
    // sessions and reversible via getAgentGroup() for approval routing.
    // [PATCH-myia #33] both SDK calls ride the transient retry above.
    await retryOnTransientRuntimeError(() => onecli.ensureAgent({ name: groupName, identifier: key.agentGroupId }), {
      label: `onecli.ensureAgent[${key.agentGroupId}]`,
    });
    const args: string[] = [];
    const applied = await retryOnTransientRuntimeError(
      () => onecli.applyContainerConfig(args, { addHostMapping: false, agent: key.agentGroupId }),
      { label: 'onecli.applyContainerConfig' },
    );
    if (!applied) {
      throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
    }
    log.info('OneCLI gateway applied', { agentGroupId: key.agentGroupId, sessionId: key.sessionId });
    return contributionFromArgs(args, key.agentGroupId);
  },
}));
