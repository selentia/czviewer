/**
 * @file src/background/injectedMain.ts
 *
 * @description
 * In-page injected script for CHZZK live pages.
 *
 * Responsibilities:
 * (A) Latency bridge
 *   - Poll `window.__getLiveInfo().latency`
 *   - Post latency values to same-origin content scripts
 *
 * (B) Player / chat layout enforcement
 *   - Force wide player layout via React internal state
 *   - Auto-collapse chat panel on live pages
 *
 * Notes:
 * - This script runs in the page context (not extension world)
 * - Direct React Fiber traversal is required (no public API available)
 * - All mutations are scoped to CHZZK live pages only
 */

(() => {
  // ---------------------------------------------------------------------------
  // Shared loose typing (intentional)
  // ---------------------------------------------------------------------------

  /**
   * We intentionally use permissive typing here because:
   * - React Fiber internals are private and unstable
   * - CHZZK bundles are not type-safe or documented
   */
  type AnyObj = Record<string, any>;

  type ReactHook = {
    memoizedState: any;
    next: ReactHook | null;
    queue?: { pending?: { hasEagerState?: boolean; eagerState?: any } };
    baseQueue?: { hasEagerState?: boolean; eagerState?: any };
  } & AnyObj;

  type ReactFiber = {
    return: ReactFiber | null;
    memoizedState: ReactHook | null;
  } & AnyObj;

  // ===========================================================================
  // (A) Latency Hook
  // ===========================================================================

  if (!window.__CHZZK_LATENCY_HOOKED__) {
    window.__CHZZK_LATENCY_HOOKED__ = true;

    const ORIGIN = window.location.origin;
    console.debug('[injectedMain] latency hook armed for origin', ORIGIN);

    let warnedNoLatency = false;

    const tick = () => {
      let latency: unknown;
      try {
        latency = window.__getLiveInfo?.()?.latency;
      } catch {
        latency = undefined;
      }

      if (!warnedNoLatency && (latency == null || Number(latency) !== Number(latency))) {
        warnedNoLatency = true;
        console.warn('[injectedMain] __getLiveInfo provided no latency; value =', latency);
      }

      window.postMessage({ type: 'CHZZK_LATENCY_MAIN', latency }, ORIGIN);
    };

    /**
     * Wait until CHZZK injects __getLiveInfo into window.
     * This may appear late during live initialization.
     */
    const waitForLiveInfo = async (): Promise<void> => {
      const MAX_WAIT_MS = 10_000;
      const POLL_MS = 200;
      const started = Date.now();

      while (Date.now() - started < MAX_WAIT_MS) {
        try {
          if (typeof (window as any).__getLiveInfo === 'function') {
            tick();
            window.__CHZZK_LATENCY_TIMER__ = window.setInterval(tick, 1000);
            return;
          }
        } catch {
          /* ignore */
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }

      console.warn('[injectedMain] __getLiveInfo not available within timeout; latency hook disabled');
    };

    void waitForLiveInfo();
  }

  // ===========================================================================
  // (B) Player / Chat Layout Hook
  // ===========================================================================

  /**
   * If parent frame is accessible, this page is not sandboxed.
   * In that case, layout enforcement is unnecessary and skipped.
   */
  let canAccessParent = false;
  try {
    void window.parent.location.hostname;
    canAccessParent = true;
  } catch {
    // cross-origin iframe; expected
  }

  if (canAccessParent) return;

  if (window.__CMV_PLAYER_WIDE_HOOKED__) return;
  window.__CMV_PLAYER_WIDE_HOOKED__ = true;

  // ---------------------------------------------------------------------------
  // React Fiber / Hook traversal utilities
  // ---------------------------------------------------------------------------

  const MAX_RETRY = 500;
  const RETRY_DELAY_MS = 50;

  const getReactFiber = (node: Element | null): ReactFiber | null => {
    if (node == null) return null;

    const entries = Object.entries(node as AnyObj);
    const hit = entries.find(([k]) => k.startsWith('__reactFiber$'))?.[1];

    return (hit as ReactFiber | undefined) ?? null;
  };

  /**
   * Walk up React Fiber tree and scan hook chains.
   * This is the only reliable way to reach layout atoms.
   */
  const findReactState = async (
    node: Element | null,
    criteria: (v: any) => boolean,
    raw = false,
    tries = 0
  ): Promise<any> => {
    if (node == null) return;

    let fiber = getReactFiber(node);
    if (fiber == null) {
      if (tries > MAX_RETRY) return;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return findReactState(node, criteria, raw, tries + 1);
    }

    fiber = fiber.return;
    while (fiber != null) {
      let state = fiber.memoizedState;

      while (state != null) {
        let value = state.memoizedState;

        if (state.queue?.pending?.hasEagerState) {
          value = state.queue.pending.eagerState;
        } else if (state.baseQueue?.hasEagerState) {
          value = state.baseQueue.eagerState;
        }

        if (value != null && criteria(value)) {
          return raw ? state : value;
        }

        state = state.next;
      }

      fiber = fiber.return;
    }
  };

  // ---------------------------------------------------------------------------
  // DOM root & wait utilities
  // ---------------------------------------------------------------------------

  const root = document.getElementById('root');
  if (!root) return;

  const waiting: Array<{ query: string; resolve: (n: Element) => void }> = [];

  const rootObserver = new MutationObserver((mutations) => {
    if (!waiting.length) return;

    for (const mutation of mutations) {
      for (const n of mutation.addedNodes as any) {
        if (n?.querySelector == null) continue;

        for (const w of waiting) {
          const node = n.querySelector(w.query);
          if (node != null) w.resolve(node);
        }
      }
    }
  });

  const WAIT_TIMEOUT_MS = 10_000;

  const waitFor = (query: string): Promise<Element | null> => {
    const node = root.querySelector(query);
    if (node) return Promise.resolve(node);

    return Promise.race([
      new Promise<Element>((resolve) => waiting.push({ query, resolve })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), WAIT_TIMEOUT_MS)),
    ]);
  };

  rootObserver.observe(root, { childList: true, subtree: true });

  // ---------------------------------------------------------------------------
  // Live page observers
  // ---------------------------------------------------------------------------

  const attachPlayerObserver = async (node: Element | null, isLive: boolean, tries = 0): Promise<void> => {
    if (node == null) return;

    const playerLayout = node.querySelector(isLive ? '#live_player_layout' : '#player_layout');

    if (playerLayout == null) {
      if (tries > MAX_RETRY) return;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return attachPlayerObserver(node, isLive, tries + 1);
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const n of mutation.addedNodes as any) {
          if (!String(n?.className || '').startsWith('pip_player_')) {
            void initPlayerFeatures(n as Element, isLive);
          }
        }
      }
    });

    const parent = (playerLayout as any).parentNode as Element | null;
    if (parent) observer.observe(parent, { childList: true });

    await initPlayerFeatures(playerLayout, isLive);
  };

  const initPlayerFeatures = async (node: Element | null, _isLive: boolean): Promise<void> => {
    if (node == null) return;

    const liveWide = await findReactState(node, (state) => state?.length === 3 && state?.[2]?.toString?.() === 'atom7');

    // Atom setter: [1].set([2], true)
    liveWide?.[1].set(liveWide[2], true);
  };

  const initChatFeatures = async (chattingContainer: any): Promise<void> => {
    if (!chattingContainer) return;

    setTimeout(() => {
      const btn = chattingContainer.querySelector(
        '[class*="live_chatting_header_fold__"] > [class^="live_chatting_header_button__"]'
      ) as HTMLElement | null;

      btn?.click();
    }, 300);
  };

  const attachLiveObserver = (node: Element | null): Promise<any> | void => {
    if (node == null) return;

    const wrapper = node.querySelector('[class^="live_wrapper__"]');
    if (wrapper) {
      const liveObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const n of mutation.addedNodes as any) {
            if (n?.tagName === 'ASIDE') {
              void initChatFeatures(n);
            }
          }
        }
      });
      liveObserver.observe(wrapper, { childList: true });
    }

    const player = node.querySelector('[class^="live_information_player__"]');
    if (player) {
      const playerObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const n of mutation.addedNodes as any) {
            if (String(n?.className || '').startsWith('live_information_video_container__')) {
              void attachPlayerObserver(n as Element, true);
            }
          }
        }
      });
      playerObserver.observe(player, { childList: true });
    }

    return Promise.all([
      attachPlayerObserver(node.querySelector('[class^="live_information_video_container__"]'), true),
      initChatFeatures(node.querySelector('aside')),
    ]);
  };

  const attachBodyObserver = async (): Promise<void> => {
    const init = async (node: Element | null) => {
      if (node == null) return;
      if (String((node as HTMLElement).className || '').startsWith('live_')) {
        return attachLiveObserver(node);
      }
    };

    const layoutBody = await waitFor('#layout-body');
    if (layoutBody == null) return;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const n of mutation.addedNodes as any) {
          if (n?.querySelector != null) {
            const section = n.tagName === 'SECTION' ? (n as Element) : (n.querySelector('section') as Element | null);
            void init(section);
          }
        }
      }
    });

    observer.observe(layoutBody, { childList: true });
    await init(layoutBody.querySelector('section'));
  };

  // ===========================================================================
  // Entry
  // ===========================================================================

  (async () => {
    if (!location.pathname.endsWith('/chat')) {
      await attachBodyObserver();
    }
    rootObserver.disconnect();
  })();
})();
