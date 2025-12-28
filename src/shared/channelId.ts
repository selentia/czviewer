/**
 * @file src/shared/channelId.ts
 *
 * @description
 * Shared helpers for resolving CHZZK channel IDs.
 *
 * Responsibilities:
 * - Provide safe string utilities used across extension and web
 * - Extract 32-hex channel IDs from:
 *   - raw IDs
 *   - CHZZK live URLs
 *   - CHZZK channel home URLs
 *
 * Notes:
 * - This module is intentionally defensive:
 *   invalid or unrelated URLs must never produce false positives.
 * - All helpers are attached to the global CMV namespace
 *   to avoid circular imports across execution contexts.
 */

(() => {
  // ---------------------------------------------------------------------------
  // Global namespace contract
  // ---------------------------------------------------------------------------

  type CMVChannelHelpers = {
    safeTrim?: (x: unknown) => string;
    isHex32?: (x: string) => boolean;
    extractChannelId?: (input: string) => string | null;
    // Other CMV keys (e.g. MSG) may coexist
    [key: string]: unknown;
  };

  const g = globalThis as typeof globalThis & {
    CMV?: CMVChannelHelpers;
  };

  // Preserve existing CMV namespace if present
  if (!g.CMV) g.CMV = {};
  const CMV = g.CMV;

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  const HEX32 = /^[0-9a-f]{32}$/i;

  /**
   * Convert unknown input into a trimmed string.
   * Always returns a string.
   */
  const safeTrim = (x: unknown): string => String(x ?? '').trim();

  /**
   * Check whether a string is a valid 32-hex identifier.
   */
  const isHex32 = (x: string): boolean => HEX32.test(x);

  /**
   * Extract CHZZK channel ID from input.
   *
   * Accepted forms:
   * - Raw 32-hex ID
   * - https://chzzk.naver.com/live/{id}
   * - https://chzzk.naver.com/channel/{id}
   * - https://chzzk.naver.com/{id}
   *
   * Returns:
   * - 32-hex channel ID on success
   * - null if input cannot be safely resolved
   */
  const extractChannelId = (input: string): string | null => {
    const raw = safeTrim(input);
    if (!raw) return null;

    // Direct ID
    if (isHex32(raw)) return raw;

    try {
      const url = new URL(raw);

      // Reject non-CHZZK hosts early
      if (!/(\.|^)chzzk\.naver\.com$/i.test(url.hostname)) {
        return null;
      }

      const parts = url.pathname.split('/').filter(Boolean);

      // 1) /live/{id}
      const liveIdx = parts.indexOf('live');
      if (liveIdx !== -1 && parts[liveIdx + 1] && isHex32(parts[liveIdx + 1])) {
        return parts[liveIdx + 1];
      }

      // 2) /channel/{id}
      const channelIdx = parts.indexOf('channel');
      if (channelIdx !== -1 && parts[channelIdx + 1] && isHex32(parts[channelIdx + 1])) {
        return parts[channelIdx + 1];
      }

      // 3) Fallback: last 32-hex segment in path
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        if (isHex32(parts[i])) {
          return parts[i];
        }
      }

      return null;
    } catch {
      // Invalid URL or parsing failure
      return null;
    }
  };

  // ---------------------------------------------------------------------------
  // Export to CMV namespace
  // ---------------------------------------------------------------------------

  CMV.safeTrim = safeTrim;
  CMV.isHex32 = isHex32;
  CMV.extractChannelId = extractChannelId;
})();
