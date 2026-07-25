/**
 * Channel adapter registry.
 *
 * Channels self-register on import. The host calls initChannelAdapters() at startup
 * to instantiate and set up all registered adapters.
 */
import type { ChannelAdapter, ChannelRegistration, ChannelSetup, OutboundFile } from './adapter.js';
import type { ChannelDeliveryAdapter } from '../delivery.js';
import { log } from '../log.js';

const SETUP_RETRY_DELAYS_MS = [2000, 5000, 10000];

/** [PATCH-myia #45] Delay between background re-attempts for a channel whose
 *  setup failed with a transient network error. The inline SETUP_RETRY_DELAYS_MS
 *  budget spans ~17s total; a network outage that outlasts it used to disable
 *  the channel for the entire process lifetime. */
const BACKGROUND_RETRY_DELAY_MS = 60_000;

/** Duck-type check — adapters that throw an Error with `name === 'NetworkError'`
 * (Chat SDK's `@chat-adapter/shared.NetworkError` and similar) get a retry on
 * setup. Avoids depending on `@chat-adapter/shared` at trunk level. */
function isNetworkError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'NetworkError';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const registry = new Map<string, ChannelRegistration>();
const activeAdapters = new Map<string, ChannelAdapter>();

/** [PATCH-myia #45] Set by teardownChannelAdapters so an in-flight background
 *  retry can't resurrect an adapter after shutdown has begun. Cleared at the
 *  top of initChannelAdapters. */
let shuttingDown = false;

/** Register a channel adapter factory. Called by channel modules on import. */
export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registry.set(name, registration);
}

/** Get a live adapter by its EXACT registry key (instance name; default
 *  instances are keyed by channelType itself). No channelType fallback —
 *  callers that address a specific instance (outbound delivery, typing)
 *  must never be rerouted through a sibling instance: that would send
 *  through the wrong bot identity with the wrong token. A missing key
 *  means the owning adapter is offline; callers apply their normal
 *  offline-adapter handling. */
export function getChannelAdapterExact(key: string): ChannelAdapter | undefined {
  return activeAdapters.get(key);
}

/** Get a live adapter by instance name, falling back to any adapter of the
 *  given channel type. The fallback exists ONLY for channelType-only callers
 *  (user-id prefix resolution and cold DMs in user-dm.ts, approval delivery
 *  in channel-approval.ts, the router's thread-policy probe when an event
 *  carries no instance) — they must still resolve when every instance of a
 *  platform is named. First registered wins (Map insertion order,
 *  deterministic). Default instances are keyed by channelType itself, so
 *  single-instance installs always hit the exact-key path. Instance-addressed
 *  dispatch (delivery, typing) must use getChannelAdapterExact instead. */
export function getChannelAdapter(key: string): ChannelAdapter | undefined {
  const exact = activeAdapters.get(key);
  if (exact) return exact;
  for (const [registryKey, adapter] of activeAdapters) {
    if (adapter.channelType === key) {
      log.warn('Channel adapter fallback: requested key resolved through a differently-keyed instance', {
        requested: key,
        resolvedKey: registryKey,
      });
      return adapter;
    }
  }
  return undefined;
}

/**
 * Build the host's outbound delivery bridge: dispatches delivery-poll and
 * typing traffic into the adapter registry. Resolution is EXACT-key only —
 * `instance ?? channelType`. For default-instance messaging_groups rows the
 * stored instance IS the channelType, which matches default-registered
 * adapters, so single-instance behavior is unchanged. A named instance whose
 * adapter is offline gets the normal offline-adapter handling (warn + drop
 * into the delivery retry path) — never a cross-identity send through a
 * sibling bot of the same platform.
 */
export function createChannelDeliveryAdapter(): ChannelDeliveryAdapter {
  return {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: OutboundFile[],
      instance?: string,
    ): Promise<string | undefined> {
      const adapter = getChannelAdapterExact(instance ?? channelType);
      if (!adapter) {
        // [PATCH-myia #45] Throw — never `return` silently. A plain return
        // reaches deliverMessage() as a *successful* completion: delivery.ts
        // logs "Message delivered", clearOutbox()es the attachments, and
        // markDelivered()s the row. So an offline adapter destroyed every
        // outbound message while the logs affirmed delivery.
        //
        // 2026-07-21→25 incident: the Telegram adapter failed to register
        // after a boot-time NetworkError (see retryAdapterInBackground below)
        // and five days of agent output went to /dev/null — invisibly.
        // Surveillance read "Message delivered" and called it healthy; the
        // only tell was `platformMsgId=undefined`.
        //
        // Throwing routes the message into the existing retry path in
        // deliverSessionMessages (3 attempts, then a loud "Message delivery
        // failed permanently" ERROR), matching the principle the permission
        // check already documents at delivery.ts:317 — "Failures throw —
        // unlike a silent `return`, an Error falls into the retry path […]
        // instead of marking it delivered when nothing was actually
        // delivered". The cross-identity guarantee is unchanged: we still
        // refuse to reroute through a sibling instance.
        throw new Error(
          `No active channel adapter for instance "${instance ?? channelType}" ` +
            `(channelType=${channelType}) — adapter offline or failed to start`,
        );
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(
      channelType: string,
      platformId: string,
      threadId: string | null,
      instance?: string,
    ): Promise<void> {
      const adapter = getChannelAdapterExact(instance ?? channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
}

/** Get all active adapters. */
export function getActiveAdapters(): ChannelAdapter[] {
  return [...activeAdapters.values()];
}

/** Get all registered channel names. */
export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}

/** Get container config for a channel (used by container-runner for additional mounts/env). */
export function getChannelContainerConfig(name: string): ChannelRegistration['containerConfig'] {
  return registry.get(name)?.containerConfig;
}

/**
 * [PATCH-myia #45] Keep re-attempting a channel whose setup failed with a
 * transient network error, until it comes up (or fails for a non-network
 * reason, or the host shuts down).
 *
 * Without this, a network blip lasting longer than the ~17s inline retry
 * budget killed the channel permanently: the host stayed "up", the agent kept
 * working, and every message it produced was silently discarded by the
 * no-adapter path in createChannelDeliveryAdapter — while inbound had no
 * poller at all. That is exactly what happened on 2026-07-21 (`Failed to
 * start channel adapter channel="telegram" err={type:"NetworkError",
 * message:"Network error calling Telegram deleteWebhook"}`), and it took a
 * manual service restart five days later to notice and recover.
 *
 * Only NetworkError retries forever — a bad token or misconfig still fails
 * fast, so we never spin on an error that a retry cannot fix.
 */
async function retryAdapterInBackground(
  name: string,
  registration: ChannelRegistration,
  setupFn: (adapter: ChannelAdapter) => ChannelSetup,
): Promise<void> {
  let attempt = 0;
  while (!shuttingDown) {
    await sleep(BACKGROUND_RETRY_DELAY_MS);
    if (shuttingDown) return;
    attempt += 1;

    let adapter: ChannelAdapter | undefined;
    try {
      adapter = (await registration.factory()) ?? undefined;
      if (!adapter) {
        log.warn('Channel adapter background retry: credentials missing, giving up', { channel: name });
        return;
      }
      await adapter.setup(setupFn(adapter));

      const key = adapter.instance ?? adapter.channelType;
      // Lost the race (shutdown, or a concurrent init claimed the key):
      // tear our instance down rather than leaking a live poller.
      if (shuttingDown || activeAdapters.has(key)) {
        try {
          await adapter.teardown();
        } catch {
          /* best effort */
        }
        return;
      }

      activeAdapters.set(key, adapter);
      log.info('Channel adapter recovered by background retry', {
        channel: name,
        type: adapter.channelType,
        instance: key,
        attempt,
      });
      return;
    } catch (err) {
      if (adapter) {
        try {
          await adapter.teardown();
        } catch {
          /* best effort */
        }
      }
      if (!isNetworkError(err)) {
        log.error('Channel adapter background retry failed with a non-network error, giving up', {
          channel: name,
          attempt,
          err,
        });
        return;
      }
      log.warn('Channel adapter background retry failed, will retry', {
        channel: name,
        attempt,
        delayMs: BACKGROUND_RETRY_DELAY_MS,
        err: (err as Error).message,
      });
    }
  }
}

/**
 * Instantiate and set up all registered channel adapters.
 * Skips adapters that return null (missing credentials).
 */
export async function initChannelAdapters(setupFn: (adapter: ChannelAdapter) => ChannelSetup): Promise<void> {
  shuttingDown = false;
  for (const [name, registration] of registry) {
    try {
      const adapter = await registration.factory();
      if (!adapter) {
        log.warn('Channel credentials missing, skipping', { channel: name });
        continue;
      }

      const setup = setupFn(adapter);
      // Transient network failures during adapter init (e.g. Telegram deleteWebhook
      // hitting a DNS hiccup at boot) would otherwise leave the channel permanently
      // dead until manual restart. Retry only on NetworkError so misconfigs (bad
      // tokens, etc.) still fail fast.
      let attempt = 0;
      while (true) {
        try {
          await adapter.setup(setup);
          break;
        } catch (err) {
          if (isNetworkError(err) && attempt < SETUP_RETRY_DELAYS_MS.length) {
            const delay = SETUP_RETRY_DELAYS_MS[attempt]!;
            log.warn('Channel adapter setup failed with network error, retrying', {
              channel: name,
              attempt: attempt + 1,
              delayMs: delay,
              err: err.message,
            });
            await sleep(delay);
            attempt += 1;
            continue;
          }
          throw err;
        }
      }
      // Adapters key by instance (default instance = channelType), so N
      // instances of one platform coexist. Duplicate keys warn instead of
      // throwing — boot stays resilient, matching the historical silent
      // last-write-wins, but now visibly.
      const key = adapter.instance ?? adapter.channelType;
      if (activeAdapters.has(key)) {
        log.warn('Duplicate adapter instance key — overwriting previous adapter', { key, channel: name });
      }
      activeAdapters.set(key, adapter);
      log.info('Channel adapter started', { channel: name, type: adapter.channelType, instance: key });
    } catch (err) {
      log.error('Failed to start channel adapter', { channel: name, err });
      // [PATCH-myia #45] A transient network failure used to end here, leaving
      // the channel dead for the process lifetime. Keep trying in the
      // background so the host self-heals once the network returns.
      if (isNetworkError(err)) {
        void retryAdapterInBackground(name, registration, setupFn);
      }
    }
  }
}

/** Tear down all active adapters. */
export async function teardownChannelAdapters(): Promise<void> {
  // [PATCH-myia #45] Stop any in-flight background retry from re-registering
  // an adapter behind us.
  shuttingDown = true;
  for (const [name, adapter] of activeAdapters) {
    try {
      await adapter.teardown();
      log.info('Channel adapter stopped', { channel: name });
    } catch (err) {
      log.error('Failed to stop channel adapter', { channel: name, err });
    }
  }
  activeAdapters.clear();
}
