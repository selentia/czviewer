/**
 * @file src/background/latencyRouter.ts
 *
 * @description
 * Background-side message router for latency and FF (Fast-Forward) actions.
 *
 * Responsibilities:
 * (1) Relay latency data between frames and runtime
 * (2) Forward FF requests to appropriate live tabs
 * (3) Inject main-world script when requested
 *
 * Notes:
 * - This file intentionally contains multiple message branches
 * - Message duplication is prevented via internal flags
 * - All routing decisions are made in background for isolation
 */

import { MSG } from '../shared/messages';

// -----------------------------------------------------------------------------
// Shared loose typing
// -----------------------------------------------------------------------------

type AnyObj = Record<string, any>;

type RewardParticipant = {
  tabId: number;
  frameId: number;
  channelId: string;
  updatedAt: number;
};

type RewardRunResponse = {
  ok?: boolean;
  claimed?: boolean;
};

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

/**
 * Returns true if sender originates from a /chat frame.
 * Used to prevent duplicate relays and unwanted injections.
 */
const isChatFrame = (sender: chrome.runtime.MessageSender): boolean => {
  try {
    const u = sender?.url ? new URL(sender.url) : null;
    return !!u && /\/chat\/?$/.test(u.pathname);
  } catch {
    return false;
  }
};

/**
 * Guarded execution wrapper.
 * Used to prevent background crashes from propagation errors.
 */
const safeSend = (fn: () => void): void => {
  try {
    fn();
  } catch {
    /* ignore */
  }
};

const REWARD_HEARTBEAT_STALE_MS = 45_000;
const REWARD_SCHEDULE_INTERVAL_MS = 15_000;
const REWARD_COOLDOWN_MS = 55 * 60 * 1000;
const REWARD_RUN_RESPONSE_TIMEOUT_MS = 12_000;
const REWARD_IDB_NAME = 'cmv-reward';
const REWARD_IDB_STORE = 'kv';
const REWARD_COOLDOWN_KEY = 'cooldownUntil';

const rewardParticipants = new Map<string, RewardParticipant>();
let rewardRoundRobinCursor = 0;
let rewardCooldownUntil = 0;
let rewardTickInFlight = false;
let rewardCooldownReady = false;
let rewardSchedulerIntervalId: number | null = null;

let rewardDbPromise: Promise<IDBDatabase | null> | null = null;

const getRewardParticipantKey = (tabId: number, frameId: number): string => `${tabId}:${frameId}`;

const openRewardDb = (): Promise<IDBDatabase | null> => {
  if (rewardDbPromise) return rewardDbPromise;

  rewardDbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(REWARD_IDB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(REWARD_IDB_STORE)) {
          db.createObjectStore(REWARD_IDB_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  return rewardDbPromise;
};

const withRewardStore = async <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>
): Promise<T | null> => {
  const db = await openRewardDb();
  if (!db) return null;

  try {
    const tx = db.transaction(REWARD_IDB_STORE, mode);
    const store = tx.objectStore(REWARD_IDB_STORE);
    return await run(store);
  } catch {
    return null;
  }
};

const readRewardCooldownUntil = async (): Promise<number> => {
  const raw = await withRewardStore(
    'readonly',
    (store) =>
      new Promise<number>((resolve) => {
        try {
          const req = store.get(REWARD_COOLDOWN_KEY);
          req.onsuccess = () => {
            const n = Number(req.result);
            resolve(Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
          };
          req.onerror = () => resolve(0);
        } catch {
          resolve(0);
        }
      })
  );

  return raw ?? 0;
};

const writeRewardCooldownUntil = async (until: number): Promise<void> => {
  await withRewardStore(
    'readwrite',
    (store) =>
      new Promise<void>((resolve) => {
        try {
          const req = store.put(until, REWARD_COOLDOWN_KEY);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
        } catch {
          resolve();
        }
      })
  );
};

const ensureRewardSchedulerRunning = (): void => {
  if (rewardSchedulerIntervalId != null) return;
  rewardSchedulerIntervalId = self.setInterval(runRewardSchedulerTick, REWARD_SCHEDULE_INTERVAL_MS);
};

const stopRewardSchedulerIfIdle = (): void => {
  if (rewardParticipants.size > 0) return;
  if (rewardSchedulerIntervalId == null) return;
  clearInterval(rewardSchedulerIntervalId);
  rewardSchedulerIntervalId = null;
};

const upsertRewardParticipant = (tabId: number, frameId: number, channelId: string): void => {
  const key = getRewardParticipantKey(tabId, frameId);
  rewardParticipants.set(key, {
    tabId,
    frameId,
    channelId,
    updatedAt: Date.now(),
  });
  ensureRewardSchedulerRunning();
};

const removeRewardParticipant = (tabId: number, frameId: number): void => {
  rewardParticipants.delete(getRewardParticipantKey(tabId, frameId));
  stopRewardSchedulerIfIdle();
};

const pruneRewardParticipants = (now: number): void => {
  rewardParticipants.forEach((participant, key) => {
    if (now - participant.updatedAt > REWARD_HEARTBEAT_STALE_MS) {
      rewardParticipants.delete(key);
    }
  });
  stopRewardSchedulerIfIdle();
};

const getRewardNextTarget = (now: number): RewardParticipant | null => {
  pruneRewardParticipants(now);
  const list = Array.from(rewardParticipants.values());
  if (!list.length) return null;

  if (rewardRoundRobinCursor >= list.length) {
    rewardRoundRobinCursor = 0;
  }

  const target = list[rewardRoundRobinCursor] ?? null;
  rewardRoundRobinCursor = (rewardRoundRobinCursor + 1) % list.length;
  return target;
};

const runRewardSchedulerTick = (): void => {
  if (rewardTickInFlight) return;
  if (!rewardCooldownReady) return;

  const now = Date.now();
  if (rewardCooldownUntil > now) return;

  const target = getRewardNextTarget(now);
  if (!target) return;

  rewardTickInFlight = true;
  let sendStarted = false;
  let settled = false;

  const settleTick = (): boolean => {
    if (settled) return false;
    settled = true;
    rewardTickInFlight = false;
    return true;
  };

  const tickTimeoutId = setTimeout(() => {
    settleTick();
  }, REWARD_RUN_RESPONSE_TIMEOUT_MS);

  safeSend(() => {
    sendStarted = true;
    chrome.tabs.sendMessage(
      target.tabId,
      { type: MSG.CHZZK_REWARD_RUN, channelId: target.channelId },
      { frameId: target.frameId },
      (rawResponse: RewardRunResponse | undefined) => {
        clearTimeout(tickTimeoutId);
        settleTick();

        if (chrome.runtime.lastError) {
          const errMsg = String(chrome.runtime.lastError.message || '');
          if (errMsg.includes('Receiving end does not exist') || errMsg.includes('No tab with id')) {
            removeRewardParticipant(target.tabId, target.frameId);
          }
          return;
        }

        const response = rawResponse || {};
        if (response.ok && response.claimed) {
          rewardCooldownUntil = Date.now() + REWARD_COOLDOWN_MS;
          void writeRewardCooldownUntil(rewardCooldownUntil);
        }
      }
    );
  });

  if (!sendStarted) {
    clearTimeout(tickTimeoutId);
    settleTick();
  }
};

const initRewardCooldown = async (): Promise<void> => {
  const stored = await readRewardCooldownUntil();
  const now = Date.now();
  rewardCooldownUntil = stored > now ? stored : 0;
  rewardCooldownReady = true;

  if (stored !== rewardCooldownUntil) {
    void writeRewardCooldownUntil(rewardCooldownUntil);
  }

  runRewardSchedulerTick();
};

void initRewardCooldown();

// -----------------------------------------------------------------------------
// Message router
// -----------------------------------------------------------------------------

(() => {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as AnyObj;
    const senderTabId = sender?.tab?.id;

    // -------------------------------------------------------------------------
    // (1) Latency relay
    // -------------------------------------------------------------------------
    if (m.type === MSG.CHZZK_LATENCY_DATA) {
      // Ignore chat iframe sources
      if (isChatFrame(sender)) return;

      // Prevent relay loops
      if (m.__fromRouter) return;

      safeSend(() => {
        // Runtime-wide relay
        chrome.runtime.sendMessage({ ...m, __fromRouter: true }, () => {
          if (chrome.runtime.lastError) {
            console.warn('[latencyRouter] runtime relay error', chrome.runtime.lastError);
          }
        });

        // Same-tab relay (content scripts)
        if (senderTabId != null) {
          chrome.tabs.sendMessage(senderTabId, { ...m, __fromRouter: true }, () => {
            if (chrome.runtime.lastError) {
              console.warn('[latencyRouter] tab relay error', chrome.runtime.lastError);
            }
          });
        }
      });

      return;
    }

    // -------------------------------------------------------------------------
    // (1-2) FF request from multiview bridge (same-tab)
    // -------------------------------------------------------------------------
    if (m.type === MSG.CMV_FF_REQUEST) {
      const channelId = String(m.channelId ?? '').trim();
      if (!channelId) {
        sendResponse?.({ ok: false, error: 'EMPTY_CHANNEL_ID' });
        return;
      }

      const marginRaw = Number(m.marginSec);
      const marginSec = Number.isFinite(marginRaw) ? marginRaw : 0.6;

      const tabId = senderTabId;
      if (tabId == null) {
        sendResponse?.({ ok: false, error: 'NO_TAB_ID' });
        return;
      }

      safeSend(() =>
        chrome.tabs.sendMessage(tabId, { type: MSG.CHZZK_FF_APPLY, channelId, marginSec }, () => {
          if (chrome.runtime.lastError) {
            console.warn('[latencyRouter] FF apply send error', chrome.runtime.lastError);
          }
        })
      );

      sendResponse?.({ ok: true });
      return true;
    }

    // -------------------------------------------------------------------------
    // (1-3) Reward participant registration
    // -------------------------------------------------------------------------
    if (m.type === MSG.CHZZK_REWARD_REGISTER || m.type === MSG.CHZZK_REWARD_HEARTBEAT) {
      if (isChatFrame(sender)) {
        sendResponse?.({ ok: false, error: 'CHAT_FRAME' });
        return;
      }

      const tabId = sender?.tab?.id;
      const frameId = sender?.frameId;
      const channelId = String(m.channelId ?? '').trim();
      if (tabId == null || frameId == null) {
        sendResponse?.({ ok: false, error: 'NO_SENDER' });
        return;
      }
      if (!channelId) {
        sendResponse?.({ ok: false, error: 'EMPTY_CHANNEL_ID' });
        return;
      }

      const isRegister = m.type === MSG.CHZZK_REWARD_REGISTER;
      upsertRewardParticipant(tabId, frameId, channelId);
      if (isRegister) {
        runRewardSchedulerTick();
      }
      sendResponse?.({ ok: true });
      return;
    }

    if (m.type === MSG.CHZZK_REWARD_UNREGISTER) {
      const tabId = sender?.tab?.id;
      const frameId = sender?.frameId;
      if (tabId == null || frameId == null) {
        sendResponse?.({ ok: false, error: 'NO_SENDER' });
        return;
      }

      removeRewardParticipant(tabId, frameId);
      runRewardSchedulerTick();
      sendResponse?.({ ok: true });
      return;
    }

    // -------------------------------------------------------------------------
    // (2) Inject main-world script
    // -------------------------------------------------------------------------
    if (m.type === MSG.CHZZK_CHAT_INJECT) {
      // Only inject into chat frames
      if (!isChatFrame(sender)) {
        sendResponse?.({ ok: false, error: 'NOT_CHAT_FRAME' });
        return;
      }

      const tabId = sender?.tab?.id;
      const frameId = sender?.frameId;
      if (tabId == null || frameId == null) {
        sendResponse?.({ ok: false, error: 'NO_SENDER' });
        return;
      }

      if (!chrome.scripting?.executeScript) {
        sendResponse?.({ ok: false, error: 'NO_SCRIPTING' });
        return;
      }

      chrome.scripting
        .executeScript({
          target: { tabId, frameIds: [frameId] },
          world: 'MAIN',
          files: ['background/injectedChatWsHook.js'],
        })
        .then(() => sendResponse?.({ ok: true }))
        .catch((err) => {
          console.error('[latencyRouter] failed to inject chat ws hook', err);
          sendResponse?.({
            ok: false,
            error: String(err?.message ?? err),
          });
        });

      return true;
    }

    if (m.type === MSG.CHZZK_LATENCY_INJECT) {
      // Never inject into chat frames
      if (isChatFrame(sender)) {
        sendResponse?.({ ok: false, error: 'CHAT_FRAME' });
        return;
      }

      const tabId = sender?.tab?.id;
      const frameId = sender?.frameId;
      if (tabId == null || frameId == null) {
        sendResponse?.({ ok: false, error: 'NO_SENDER' });
        return;
      }

      if (!chrome.scripting?.executeScript) {
        sendResponse?.({ ok: false, error: 'NO_SCRIPTING' });
        return;
      }

      chrome.scripting
        .executeScript({
          target: { tabId, frameIds: [frameId] },
          world: 'MAIN',
          files: ['background/injectedMain.js'],
        })
        .then(() => sendResponse?.({ ok: true }))
        .catch((err) => {
          console.error('[latencyRouter] failed to inject main script', err);
          sendResponse?.({
            ok: false,
            error: String(err?.message ?? err),
          });
        });

      return true;
    }

    // -------------------------------------------------------------------------
    // (3) FF forward (cross-tab)
    // -------------------------------------------------------------------------
    if (m.type === MSG.CHZZK_FF_REQUEST) {
      const liveTabId = m.liveTabId;
      if (typeof liveTabId !== 'number') {
        sendResponse?.({ ok: false, error: 'NO_LIVE_TAB_ID' });
        return;
      }

      const marginSecRaw = Number(m.marginSec);
      const marginSec = Number.isFinite(marginSecRaw) ? marginSecRaw : 0.6;

      safeSend(() =>
        chrome.tabs.sendMessage(
          liveTabId,
          {
            type: MSG.CHZZK_FF_APPLY,
            channelId: String(m.channelId ?? ''),
            marginSec,
          },
          () => {
            if (chrome.runtime.lastError) {
              console.warn('[latencyRouter] FF forward send error', chrome.runtime.lastError);
            }
          }
        )
      );

      sendResponse?.({ ok: true });
      return true;
    }

    // -------------------------------------------------------------------------
    // Unknown
    // -------------------------------------------------------------------------
    console.warn('[latencyRouter] unknown message type', m?.type, m);
  });
})();

chrome.tabs.onRemoved.addListener((tabId) => {
  rewardParticipants.forEach((participant) => {
    if (participant.tabId === tabId) {
      removeRewardParticipant(participant.tabId, participant.frameId);
    }
  });
});
