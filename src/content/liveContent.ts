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

  chrome.runtime.onMessage.addListener((msg: any) => {
    if (!msg || msg.type !== MSG.CHZZK_FF_APPLY) return;
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
  // (C) Periodic latency / buffer reporting
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
