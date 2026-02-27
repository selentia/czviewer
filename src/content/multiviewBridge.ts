/**
 * @file src/content/multiviewBridge.ts
 *
 * @description
 * Bridge between hosted multiview web page and extension runtime.
 *
 * Message flow:
 *
 * Page → Extension (window.postMessage):
 * - CMV_SUBSCRIBE_LATENCY
 * - CMV_UNSUBSCRIBE_LATENCY
 * - CMV_FETCH_CHANNEL_NAME_REQUEST
 * - CMV_FF_REQUEST
 *
 * Extension → Page (window.postMessage):
 * - CMV_LATENCY_UPDATE
 * - CMV_FETCH_CHANNEL_NAME_RESPONSE
 *
 * Extension runtime (chrome.runtime):
 * - Uses CHZZK_LATENCY_DATA (from background)
 * - Uses FETCH_CHANNEL_NAME / CMV_FF_REQUEST (to background)
 *
 * Notes:
 * - This file is protocol bridge only; it contains no UI logic
 * - All origin checks are strict (same-origin only)
 */

import { MSG, ExtensionToWebMessage, WebToExtensionMessage } from '../shared/messages';

// -----------------------------------------------------------------------------
// Constants / state
// -----------------------------------------------------------------------------

const pageOrigin = window.location.origin;
const EXT_READY_EVENT = 'CMV_EXT_READY';
const rewardClaimEnabled = new URLSearchParams(window.location.search).get('lp') === '1';

// channelId subscriptions for latency updates
const subscribedLatency = new Set<string>();

let pingSent = false;
let extMarked = false;

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

const isString = (v: unknown): v is string => typeof v === 'string';

function normalizeRewardTargetSrc(rawSrc: string): string | null {
  try {
    const url = new URL(rawSrc, window.location.href);
    const host = url.hostname.toLowerCase();
    const isLiveHost = host === 'chzzk.naver.com' || host === 'm.chzzk.naver.com';
    const isLivePath = /^\/live\/[^/]+\/?$/.test(url.pathname);

    if (!isLiveHost || !isLivePath) return null;

    url.searchParams.set('cmv_lp', rewardClaimEnabled ? '1' : '0');
    return url.toString();
  } catch {
    return null;
  }
}

function patchIframeRewardParam(iframe: HTMLIFrameElement): void {
  const rawAttr = iframe.getAttribute('src');
  const source = rawAttr || iframe.src;
  if (!source) return;

  const next = normalizeRewardTargetSrc(source);
  if (!next) return;

  let currentAbs = '';
  try {
    currentAbs = new URL(source, window.location.href).toString();
  } catch {
    currentAbs = source;
  }

  if (currentAbs === next) return;
  iframe.src = next;
}

function installRewardParamPatcher(): void {
  type QueryRoot = Document | Element;
  const pendingIframes = new Set<HTMLIFrameElement>();
  const pendingRoots = new Set<QueryRoot>();
  let rafId: number | null = null;

  const flush = () => {
    rafId = null;

    pendingIframes.forEach((iframe) => patchIframeRewardParam(iframe));
    pendingIframes.clear();

    pendingRoots.forEach((root) => {
      root.querySelectorAll('iframe').forEach((el) => patchIframeRewardParam(el as HTMLIFrameElement));
    });
    pendingRoots.clear();
  };

  const queueFlush = () => {
    if (rafId != null) return;
    rafId = window.requestAnimationFrame(flush);
  };

  const enqueueIframe = (iframe: HTMLIFrameElement) => {
    pendingIframes.add(iframe);
    queueFlush();
  };

  const enqueueRoot = (root: QueryRoot) => {
    pendingRoots.add(root);
    queueFlush();
  };

  enqueueRoot(document);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.target instanceof HTMLIFrameElement) {
        enqueueIframe(mutation.target);
        continue;
      }

      if (mutation.type !== 'childList' || !mutation.addedNodes.length) continue;

      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLIFrameElement) {
          enqueueIframe(node);
          return;
        }

        if (node instanceof Element) {
          enqueueRoot(node);
        }
      });
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });

  window.addEventListener('pagehide', () => {
    observer.disconnect();
    if (rafId != null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    pendingIframes.clear();
    pendingRoots.clear();
  });
}

function postToPage(message: ExtensionToWebMessage): void {
  window.postMessage(message, pageOrigin);
}

// -----------------------------------------------------------------------------
// Page → Extension handlers
// -----------------------------------------------------------------------------

function handleFetchChannelName(message: any): void {
  if (!chrome?.runtime?.sendMessage) return;

  const channelId = isString(message.channelId) ? message.channelId : '';
  if (!channelId) return;

  const requestId = isString(message.requestId)
    ? message.requestId
    : `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  chrome.runtime.sendMessage({ type: MSG.FETCH_CHANNEL_NAME, id: channelId }, (res: any) => {
    if (chrome.runtime.lastError) {
      console.warn('[bridge] fetchChannelName runtime error', chrome.runtime.lastError);
    }

    const response: ExtensionToWebMessage = {
      type: MSG.CMV_FETCH_CHANNEL_NAME_RESPONSE,
      channelId,
      name: res?.name ?? null,
      ok: !!res?.ok,
      requestId,
      error: isString(res?.error) ? res.error : undefined,
    };

    postToPage(response);
  });
}

function handleForceFF(message: any): void {
  if (!chrome?.runtime?.sendMessage) return;

  const channelId = isString(message.channelId) ? message.channelId : '';
  if (!channelId) return;

  const marginSecRaw = Number(message.marginSec);
  const marginSec = Number.isFinite(marginSecRaw) ? marginSecRaw : undefined;

  chrome.runtime.sendMessage(
    {
      type: MSG.CMV_FF_REQUEST,
      channelId,
      marginSec,
    },
    () => {
      if (chrome.runtime.lastError) {
        console.warn('[bridge] FF request error', chrome.runtime.lastError);
      }
    }
  );
}

// -----------------------------------------------------------------------------
// Web message dispatcher
// -----------------------------------------------------------------------------

function handleWebMessage(raw: MessageEvent): void {
  if (raw.source !== window) return;
  if (raw.origin !== pageOrigin) return;

  const data: WebToExtensionMessage | any = raw.data;
  if (!data || typeof data !== 'object') return;

  switch (data.type) {
    case MSG.CMV_SUBSCRIBE_LATENCY: {
      const id = isString(data.channelId) ? data.channelId : '';
      if (id) subscribedLatency.add(id);
      break;
    }

    case MSG.CMV_UNSUBSCRIBE_LATENCY: {
      const id = isString(data.channelId) ? data.channelId : '';
      if (id) subscribedLatency.delete(id);
      break;
    }

    case MSG.CMV_FETCH_CHANNEL_NAME_REQUEST:
      handleFetchChannelName(data);
      break;

    case MSG.CMV_FF_REQUEST:
      handleForceFF(data);
      break;

    default:
      // UI-only messages from page are not this bridge's concern
      if (data?.type === MSG.CMV_LATENCY_UPDATE) return;

      // Warn only for clearly unsupported protocol messages
      if (data?.type) {
        console.warn('[bridge] unsupported message type from page', data.type, data);
      }
      break;
  }
}

// -----------------------------------------------------------------------------
// Runtime → Page handler
// -----------------------------------------------------------------------------

function handleRuntimeMessage(msg: any): void {
  if (!msg || typeof msg !== 'object') return;

  if (!msg.type) {
    console.warn('[bridge] runtime message missing type', msg);
    return;
  }

  if (msg.type !== MSG.CHZZK_LATENCY_DATA) {
    // Allow benign background-only messages silently
    if (msg.type === MSG.CHZZK_FF_APPLY) return;

    console.warn('[bridge] unknown runtime message type', msg.type, msg);
    return;
  }

  const channelId = isString(msg.channelId) ? msg.channelId : '';
  if (!channelId) return;
  if (!subscribedLatency.has(channelId)) return;

  const latencyMsNum = Number(msg.latencyMs);
  const bufferedEndNum = Number(msg.bufferedEnd);
  const currentTimeNum = Number(msg.currentTime);

  const payload: ExtensionToWebMessage = {
    type: MSG.CMV_LATENCY_UPDATE,
    channelId,
    latencyMs: Number.isFinite(latencyMsNum) ? latencyMsNum : 0,
    bufferedEnd: Number.isFinite(bufferedEndNum) ? bufferedEndNum : 0,
    currentTime: Number.isFinite(currentTimeNum) ? currentTimeNum : 0,
  };

  postToPage(payload);
}

// -----------------------------------------------------------------------------
// One-time side effects
// -----------------------------------------------------------------------------

/**
 * Kick cookie bridge once to ensure partitioned cookies are seeded.
 * Best-effort only.
 */
function pingCookieBridgeOnce(): void {
  if (pingSent) return;
  pingSent = true;

  if (!chrome?.runtime?.sendMessage) return;

  try {
    chrome.runtime.sendMessage('PING_COOKIE_BRIDGE', () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // ignore
  }
}

/**
 * Mark extension presence for the hosting page.
 * Used for lightweight capability detection.
 */
function markExtensionPresent(): void {
  if (extMarked) return;
  extMarked = true;

  try {
    document.documentElement.dataset.cmvExt = '1';
  } catch {
    /* ignore */
  }

  try {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `cmv_ext=1; Path=/; SameSite=Lax${secure}`;
  } catch {
    /* ignore cookie set failure */
  }

  try {
    window.dispatchEvent(new CustomEvent(EXT_READY_EVENT));
  } catch {
    /* ignore event failure */
  }
}

// -----------------------------------------------------------------------------
// Entry
// -----------------------------------------------------------------------------

window.addEventListener('message', handleWebMessage, false);
chrome.runtime?.onMessage?.addListener(handleRuntimeMessage);

// Kick background helpers once bridge is active
pingCookieBridgeOnce();
markExtensionPresent();
installRewardParamPatcher();
