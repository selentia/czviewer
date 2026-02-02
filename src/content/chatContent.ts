/**
 * @file src/content/chatContent.ts
 *
 * @description
 * Content script for CHZZK chat frames.
 *
 * Responsibilities:
 * - Request main-world chat timestamp hook
 * - Inject chat timestamp styles
 *
 * Notes:
 * - Runs only when ?ts=1 is present
 */

(() => {
  // ---------------------------------------------------------------------------
  // Global bridge
  // ---------------------------------------------------------------------------

  interface CMVGlobal {
    MSG: Record<string, string>;
  }

  const CMV = (globalThis as any).CMV as CMVGlobal | undefined;
  if (!CMV) return;

  const { MSG } = CMV;

  // ---------------------------------------------------------------------------
  // Guards
  // ---------------------------------------------------------------------------

  if (!/\/chat\/?$/.test(window.location.pathname)) return;

  const params = new URLSearchParams(window.location.search);
  if (params.get('ts') !== '1') return;

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const ensureStyles = (): void => {
    const STYLE_ID = 'cmv-chat-ts-style';
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      html {
        --cmv-chat-timestamp: 1;
      }

      [class^="live_chatting_message_chatting_message__"]::before {
        content: attr(data-timestamp);
        color: var(--color-content-04);
        margin-right: 4px;
      }
    `;

    const target = document.head || document.documentElement;
    target.appendChild(style);
  };

  // ---------------------------------------------------------------------------
  // Main-world injection
  // ---------------------------------------------------------------------------

  const requestChatInject = (): void => {
    try {
      chrome.runtime.sendMessage({ type: MSG.CHZZK_CHAT_INJECT }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[chatContent] chat inject request error', chrome.runtime.lastError);
        }
      });
    } catch {
      // ignore
    }
  };

  // ---------------------------------------------------------------------------
  // Entry
  // ---------------------------------------------------------------------------

  ensureStyles();
  requestChatInject();
})();
