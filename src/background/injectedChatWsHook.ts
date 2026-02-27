/**
 * @file src/background/injectedChatWsHook.ts
 *
 * @description
 * In-page injected script for CHZZK chat frames.
 *
 * Responsibilities:
 * - Attach timestamps to chat lines using React props
 * - Update data attributes for CSS rendering
 *
 * Notes:
 * - Runs in the page context (not extension world)
 * - DOM manipulation is done here
 */

(() => {
  const FLAG = '__CMV_CHAT_TS_HOOKED__';
  if ((window as any)[FLAG]) return;
  (window as any)[FLAG] = true;

  const TIMESTAMP_VAR = '--cmv-chat-timestamp';
  const LIVE_LIST_WRAPPER = '[class^="live_chatting_list_wrapper__"]';
  const LIVE_ITEM_PREFIX = 'live_chatting_list_item__';
  const VOD_LIST_WRAPPER = '[class^="vod_chatting_list__"]';
  const VOD_ITEM_PREFIX = 'vod_chatting_item__';
  const MESSAGE_WRAPPER_SELECTOR =
    '[class^="live_chatting_message_chatting_message__"], [class^="vod_chatting_message_chatting_message__"]';

  const isTimestampEnabled = (): boolean => {
    const value = window.getComputedStyle(document.documentElement).getPropertyValue(TIMESTAMP_VAR);
    return value != null && value.trim() !== '' && value.trim() !== '0';
  };

  const getReactProps = (node: Element | null): any => {
    if (node == null) return null;
    const entry = Object.entries(node as any).find(([key]) => key.startsWith('__reactProps$'));
    return entry ? (entry as any)[1] : null;
  };

  const padNumber = (n: number, len = 2): string => String(n).padStart(len, '0');

  const formatLiveTimestamp = (value: unknown): string | null => {
    const date = new Date(value as any);
    if (Number.isNaN(date.getTime())) return null;
    return `${padNumber(date.getHours())}:${padNumber(date.getMinutes())}`;
  };

  const formatVodTimestamp = (value: unknown): string | null => {
    const raw = Number(value);
    if (!Number.isFinite(raw)) return null;
    const t = Math.floor(raw / 1000);
    const h = Math.floor(t / 3600);
    const m = Math.floor(t / 60) % 60;
    const s = t % 60;
    return h ? `${h}:${padNumber(m)}:${padNumber(s)}` : `${m}:${padNumber(s)}`;
  };

  const getMessageWrapper = (item: Element): HTMLElement | null =>
    item.querySelector(MESSAGE_WRAPPER_SELECTOR) as HTMLElement | null;

  const applyTimestamp = (item: Element, isLive: boolean): void => {
    const className = String((item as HTMLElement).className || '');
    const expectedPrefix = isLive ? LIVE_ITEM_PREFIX : VOD_ITEM_PREFIX;
    if (!className.startsWith(expectedPrefix)) return;

    const props = getReactProps(item);
    const message = props?.children?.props?.chatMessage;
    if (message == null) return;

    const wrapper = getMessageWrapper(item);
    if (wrapper == null || wrapper.dataset.timestamp) return;

    const stamp = isLive ? formatLiveTimestamp(message.time) : formatVodTimestamp(message.playerMessageTime);
    if (!stamp) return;

    wrapper.dataset.timestamp = stamp;
    props.children.props.messageChangeHandler?.();
  };

  const scanExisting = (wrapper: Element, isLive: boolean): void => {
    const selector = isLive ? `[class^="${LIVE_ITEM_PREFIX}"]` : `[class^="${VOD_ITEM_PREFIX}"]`;
    wrapper.querySelectorAll(selector).forEach((item) => applyTimestamp(item, isLive));
  };

  const attachListObserver = (wrapper: Element, isLive: boolean): MutationObserver => {
    scanExisting(wrapper, isLive);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) {
            applyTimestamp(node, isLive);
          }
        }
      }
    });
    observer.observe(wrapper, { childList: true });
    return observer;
  };

  let listObserver: MutationObserver | null = null;
  let currentWrapper: Element | null = null;
  let currentIsLive = true;
  let attachRafId: number | null = null;

  const attachIfChanged = (wrapper: Element, isLive: boolean): void => {
    if (currentWrapper === wrapper && currentIsLive === isLive) return;
    listObserver?.disconnect();
    currentWrapper = wrapper;
    currentIsLive = isLive;
    listObserver = attachListObserver(wrapper, isLive);
  };

  const tryAttach = (): void => {
    if (listObserver && currentWrapper && currentWrapper.isConnected) return;

    if (!isTimestampEnabled()) return;

    const liveWrapper = document.querySelector(LIVE_LIST_WRAPPER);
    if (liveWrapper) {
      attachIfChanged(liveWrapper, true);
      return;
    }

    const vodWrapper = document.querySelector(VOD_LIST_WRAPPER);
    if (vodWrapper) {
      attachIfChanged(vodWrapper, false);
    }
  };

  const scheduleAttach = (): void => {
    if (attachRafId != null) return;
    attachRafId = window.requestAnimationFrame(() => {
      attachRafId = null;
      tryAttach();
    });
  };

  const rootObserver = new MutationObserver(() => {
    scheduleAttach();
  });

  rootObserver.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scheduleAttach(), { once: true });
  } else {
    scheduleAttach();
  }

  window.addEventListener(
    'pagehide',
    () => {
      rootObserver.disconnect();
      listObserver?.disconnect();
      listObserver = null;
      currentWrapper = null;
      if (attachRafId != null) {
        window.cancelAnimationFrame(attachRafId);
        attachRafId = null;
      }
    },
    { once: true }
  );
})();
