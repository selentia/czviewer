/**
 * @file src/content/liveContent.ts
 *
 * @description
 * Content script for CHZZK live pages.
 *
 * Message flow:
 * - Receives: CHZZK_FF_APPLY (Fast-Forward / buffer pull)
 * - Sends:    CHZZK_LATENCY_INJECT (request main-world hook)
 * - Sends:    CHZZK_LATENCY_DATA   (latency + buffer metrics)
 * - Listens:  CHZZK_LATENCY_MAIN   (from injected main-world script)
 *
 * Notes:
 * - Does NOT run on /chat frames
 * - All heavy DOM / video inspection stays in content scope
 */

(() => {
  // ---------------------------------------------------------------------------
  // Global bridge
  // ---------------------------------------------------------------------------

  interface CMVGlobal {
    MSG: Record<string, string>;
    extractChannelId: (input: string) => string | null;
  }

  const CMV = (globalThis as any).CMV as CMVGlobal | undefined;
  if (!CMV) return;

  const { MSG, extractChannelId } = CMV;

  // ---------------------------------------------------------------------------
  // Page guard
  // ---------------------------------------------------------------------------

  // Do not operate inside chat frames
  if (/\/chat\/?$/.test(window.location.pathname)) return;

  const extracted = extractChannelId(window.location.href);
  if (!extracted) return;
  const channelId = extracted;
  const autoRewardClaimEnabled = new URLSearchParams(window.location.search).get('cmv_lp') === '1';

  // ---------------------------------------------------------------------------
  // Shared utilities
  // ---------------------------------------------------------------------------

  const getVideoElement = (): HTMLVideoElement | null => document.querySelector('video') as HTMLVideoElement | null;

  const toSafeNumber = (value: unknown, fallback = 0): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  // ===========================================================================
  // (A) FF (Fast-Forward / buffer pull)
  // ===========================================================================

  type RewardRunResponse = {
    ok: boolean;
    claimed: boolean;
    channelId: string;
    claimCount?: number;
    skipped?: string;
    error?: string;
  };

  let runRewardClaimOnce: (() => Promise<{ claimed: boolean; claimCount: number }>) | null = null;
  let rewardClaimInFlight: Promise<{ claimed: boolean; claimCount: number }> | null = null;

  chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === MSG.CHZZK_FF_APPLY) {
      if (String(msg.channelId ?? '') !== channelId) return;

      const marginRaw = Number(msg.marginSec);
      const marginSec = Number.isFinite(marginRaw) ? marginRaw : 0.6;

      const video = getVideoElement();
      if (!video) return;

      try {
        const buf = video.buffered;
        if (!buf || buf.length === 0) return;

        const i = buf.length - 1;
        const end = buf.end(i);
        const start = buf.start(i);

        const target = end - marginSec;
        if (target > video.currentTime && target > start) {
          video.currentTime = target;
        }
      } catch {
        // ignore playback edge errors
      }
      return;
    }

    if (msg.type !== MSG.CHZZK_REWARD_RUN) return;

    if (!autoRewardClaimEnabled || !runRewardClaimOnce) {
      sendResponse?.({
        ok: true,
        claimed: false,
        channelId,
        skipped: 'DISABLED',
      } satisfies RewardRunResponse);
      return;
    }

    const targetChannelId = String(msg.channelId ?? '').trim();
    if (targetChannelId && targetChannelId !== channelId) {
      sendResponse?.({
        ok: false,
        claimed: false,
        channelId,
        error: 'CHANNEL_MISMATCH',
      } satisfies RewardRunResponse);
      return;
    }

    void runRewardClaimOnce()
      .then((result) =>
        sendResponse?.({
          ok: true,
          claimed: !!result.claimed,
          channelId,
          claimCount: Number(result.claimCount || 0),
        } satisfies RewardRunResponse)
      )
      .catch((err) =>
        sendResponse?.({
          ok: false,
          claimed: false,
          channelId,
          error: String(err?.message ?? err),
        } satisfies RewardRunResponse)
      );

    return true;
  });

  // ===========================================================================
  // (B) Latency hook (main-world bridge)
  // ===========================================================================

  let lastLatencyMs: number | null = null;
  let lastLatencyAt = 0;

  /**
   * Ask background to inject injectedMain into page context.
   * This enables access to window.__getLiveInfo().
   */
  const requestLatencyHook = () => {
    try {
      chrome.runtime.sendMessage({ type: MSG.CHZZK_LATENCY_INJECT }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[liveContent] latency inject request error', chrome.runtime.lastError);
        }
      });
      console.debug('[liveContent] requested latency inject for', channelId);
    } catch {
      // ignore
    }
  };

  requestLatencyHook();

  /**
   * Receive latency values posted from injected main-world script.
   */
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return;

    const data: any = e.data;
    if (!data || data.type !== MSG.CHZZK_LATENCY_MAIN) return;

    const v = Number(data.latency);
    if (Number.isFinite(v)) {
      lastLatencyMs = v;
      lastLatencyAt = Date.now();
    }
  });

  // ===========================================================================
  // (C) Reward auto-claim (WATCH_1_HOUR)
  // ===========================================================================

  const TARGET_REWARD_TYPE = 'WATCH_1_HOUR';
  const REWARD_HEARTBEAT_MS = 15_000;
  const REWARD_FETCH_TIMEOUT_MS = 10_000;

  const sendRewardPresence = (
    type: typeof MSG.CHZZK_REWARD_REGISTER | typeof MSG.CHZZK_REWARD_HEARTBEAT | typeof MSG.CHZZK_REWARD_UNREGISTER
  ): void => {
    if (!autoRewardClaimEnabled) return;

    try {
      chrome.runtime.sendMessage(
        {
          type,
          channelId,
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
    } catch {
      // ignore
    }
  };

  const fetchWithTimeout = async (input: string, init: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REWARD_FETCH_TIMEOUT_MS);

    try {
      return await fetch(input, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      window.clearTimeout(timeoutId);
    }
  };

  const fetchClaimableRewardIds = async (): Promise<string[]> => {
    const url = `https://api.chzzk.naver.com/service/v1/channels/${encodeURIComponent(channelId)}/log-power`;

    try {
      const res = await fetchWithTimeout(url, {
        credentials: 'include',
      });
      if (!res.ok) return [];

      const data = await res.json();
      const claims = Array.isArray(data?.content?.claims) ? data.content.claims : [];

      return claims
        .filter((claim: any) => String(claim?.claimType || '').toUpperCase() === TARGET_REWARD_TYPE && !!claim?.claimId)
        .map((claim: any) => String(claim.claimId));
    } catch {
      return [];
    }
  };

  const submitRewardClaims = async (claimIds: string[]): Promise<boolean> => {
    if (!claimIds.length) return false;
    let claimed = false;

    for (const claimId of claimIds) {
      const putUrl = `https://api.chzzk.naver.com/service/v1/channels/${encodeURIComponent(
        channelId
      )}/log-power/claims/${encodeURIComponent(claimId)}`;

      try {
        const res = await fetchWithTimeout(putUrl, {
          method: 'PUT',
          credentials: 'include',
        });
        if (res.ok) claimed = true;
      } catch {
        // ignore individual claim failures
      }
    }

    return claimed;
  };

  const executeRewardClaimOnce = async (): Promise<{
    claimed: boolean;
    claimCount: number;
  }> => {
    const claimIds = await fetchClaimableRewardIds();
    if (!claimIds.length) {
      return { claimed: false, claimCount: 0 };
    }

    const claimed = await submitRewardClaims(claimIds);
    return { claimed, claimCount: claimIds.length };
  };

  runRewardClaimOnce = async () => {
    if (rewardClaimInFlight) {
      return rewardClaimInFlight;
    }

    rewardClaimInFlight = executeRewardClaimOnce().finally(() => {
      rewardClaimInFlight = null;
    });

    return rewardClaimInFlight;
  };

  if (autoRewardClaimEnabled) {
    sendRewardPresence(MSG.CHZZK_REWARD_REGISTER);
    const rewardHeartbeatIntervalId = window.setInterval(
      () => sendRewardPresence(MSG.CHZZK_REWARD_HEARTBEAT),
      REWARD_HEARTBEAT_MS
    );

    window.addEventListener('pagehide', () => {
      sendRewardPresence(MSG.CHZZK_REWARD_UNREGISTER);
      window.clearInterval(rewardHeartbeatIntervalId);
    });
  }

  // ===========================================================================
  // (D) Periodic latency / buffer reporting
  // ===========================================================================

  let warnedNoLatency = false;

  const latencyIntervalId = window.setInterval(() => {
    const video = getVideoElement();
    const now = Date.now();

    let latencyMs = 0;

    // Prefer injected __getLiveInfo latency (fresh within 3s)
    if (lastLatencyMs != null && now - lastLatencyAt <= 3000) {
      latencyMs = lastLatencyMs;
    } else {
      // Fallback: derive from video state
      try {
        if (video) {
          const seekable = video.seekable;
          const liveEdge = seekable && seekable.length ? seekable.end(seekable.length - 1) : null;

          if (typeof liveEdge === 'number' && typeof video.currentTime === 'number') {
            latencyMs = Math.max(0, (liveEdge - video.currentTime) * 1000);
          } else {
            const real = (video as any)?.getRealCurrentTime?.();
            if (typeof real === 'number' && typeof video.currentTime === 'number') {
              latencyMs = Math.max(0, (real - video.currentTime) * 1000);
            }
          }
        }
      } catch {
        // ignore
      }
    }

    if (latencyMs === 0 && !warnedNoLatency) {
      warnedNoLatency = true;
      console.debug('[liveContent] latency unavailable; using fallback', { lastLatencyMs });
    }

    let bufferedEnd = 0;
    let currentTime = 0;

    if (video) {
      try {
        if (video.buffered?.length) {
          bufferedEnd = video.buffered.end(video.buffered.length - 1);
        }
        currentTime = video.currentTime ?? 0;
      } catch {
        // ignore
      }
    }

    const safeLatency = toSafeNumber(latencyMs, 0);
    const safeBuffered = toSafeNumber(bufferedEnd, 0);
    const safeCurrent = toSafeNumber(currentTime, 0);

    try {
      // Stop reporting if extension is unloaded
      if (!chrome?.runtime?.id) {
        window.clearInterval(latencyIntervalId);
        return;
      }

      chrome.runtime.sendMessage({
        type: MSG.CHZZK_LATENCY_DATA,
        channelId,
        latencyMs: safeLatency,
        bufferedEnd: safeBuffered,
        currentTime: safeCurrent,
      });
    } catch {
      window.clearInterval(latencyIntervalId);
    }
  }, 1000);

  window.addEventListener('pagehide', () => {
    window.clearInterval(latencyIntervalId);
  });
})();
