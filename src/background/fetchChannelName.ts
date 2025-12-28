/**
 * @file src/background/fetchChannelName.ts
 *
 * @description Fetches and caches Chzzk channel display names.
 *
 * Purpose:
 * - Resolve channel ID → channelName via Chzzk public API
 * - Cache results to avoid redundant network calls
 * - Act as a background-side resolver for content / injected scripts
 *
 * Notes:
 * - This module does NOT perform authentication itself
 * - Cookies (if required) are handled separately by cookieBridge
 * - Network failures are surfaced as structured error codes
 */

import { MSG } from '../shared/messages';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type FetchChannelNameReq = {
  type: string;
  id?: unknown;
};

type ChzzkChannelApiResponse = {
  code?: number;
  content?: {
    channelName?: unknown;
  };
};

// -----------------------------------------------------------------------------
// Module scope
// -----------------------------------------------------------------------------

(() => {
  /**
   * Cache: channelId (lowercase) → channelName | null
   */
  const channelCache = new Map<string, string | null>();

  function isFetchChannelRequest(msg: unknown): msg is FetchChannelNameReq {
    return !!msg && typeof msg === 'object' && (msg as any).type === MSG.FETCH_CHANNEL_NAME;
  }

  // ---------------------------------------------------------------------------
  // Message handler
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!isFetchChannelRequest(msg)) return;

    const id = String(msg.id ?? '')
      .trim()
      .toLowerCase();
    if (!id) {
      sendResponse({ ok: false, error: 'EMPTY_ID' });
      return true;
    }

    // Cache hit
    if (channelCache.has(id)) {
      sendResponse({
        ok: true,
        name: channelCache.get(id) ?? null,
      });
      return true;
    }

    // Fetch asynchronously
    (async () => {
      try {
        const res = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${encodeURIComponent(id)}`);

        if (!res.ok) {
          sendResponse({ ok: false, error: `HTTP_${res.status}` });
          return;
        }

        const data = (await res.json()) as ChzzkChannelApiResponse;

        if (data.code !== 200) {
          sendResponse({
            ok: false,
            error: `CODE_${String(data.code ?? 'UNKNOWN')}`,
          });
          return;
        }

        const rawName = data.content?.channelName;
        const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null;

        channelCache.set(id, name);
        sendResponse({ ok: true, name });
      } catch {
        sendResponse({ ok: false, error: 'FETCH_ERROR' });
      }
    })();

    return true;
  });
})();
