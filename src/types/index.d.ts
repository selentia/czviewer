/**
 * @file types/index.d.ts
 *
 * @description
 * Global type declarations for CZ MultiViewer.
 *
 * This file provides type visibility only.
 * It MUST NOT introduce any runtime behavior.
 *
 * Purposes:
 * - Preserve legacy global access patterns (CMV.MSG)
 * - Declare injected / main-world flags used across execution contexts
 *
 * Notes:
 * - Actual value injection happens elsewhere
 *   (e.g. src/shared/messages.ts, injected scripts)
 * - All properties are optional by design
 */

export {};

declare global {
  /**
   * Legacy global namespace.
   *
   * Some content / popup scripts access message constants via:
   *   globalThis.CMV.MSG
   *
   * This declaration exists for type safety only.
   * Actual assignment is performed in shared/messages.ts.
   */
  var CMV:
    | {
        MSG?: Record<string, string>;
      }
    | undefined;

  /**
   * Window-scoped flags and helpers injected at runtime.
   *
   * These are used to:
   * - Prevent duplicate injections
   * - Coordinate content ↔ main-world scripts
   * - Access CHZZK internal live info when available
   */
  interface Window {
    // injectedMain.ts
    __CHZZK_LATENCY_HOOKED__?: boolean;
    __CHZZK_LATENCY_TIMER__?: number;

    // injectedMain.ts (player wide-mode hook)
    __CMV_PLAYER_WIDE_HOOKED__?: boolean;

    // CHZZK internal (best-effort; may be absent)
    __getLiveInfo?: () => { latency?: number } | undefined;
  }
}
