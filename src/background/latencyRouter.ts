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
