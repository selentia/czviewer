/**
 * @file src/shared/messages.ts
 *
 * @description
 * Central message protocol definitions for CZ MultiViewer.
 *
 * This file is the single source of truth for:
 * - message type constants
 * - cross-context message contracts
 *
 * Contexts involved:
 * - Web page (hosted multiview)
 * - Content scripts
 * - Background service worker
 * - Injected main-world scripts
 *
 * Notes:
 * - Message strings MUST remain stable (Chrome runtime & postMessage)
 * - Legacy global access via globalThis.CMV.MSG is preserved
 */

// -----------------------------------------------------------------------------
// Message type constants
// -----------------------------------------------------------------------------

export const MSG = Object.freeze({
  // Background utilities
  FETCH_CHANNEL_NAME: 'FETCH_CHANNEL_NAME',

  // Latency pipeline (content ↔ background ↔ main-world)
  CHZZK_LATENCY_DATA: 'CHZZK_LATENCY_DATA',
  CHZZK_LATENCY_INJECT: 'CHZZK_LATENCY_INJECT',
  CHZZK_LATENCY_MAIN: 'CHZZK_LATENCY_MAIN',

  CHZZK_CHAT_INJECT: 'CHZZK_CHAT_INJECT',
  CHZZK_CHAT_CTIME: 'CHZZK_CHAT_CTIME',

  // Fast-forward (buffer pull)
  CHZZK_FF_REQUEST: 'CHZZK_FF_REQUEST',
  CHZZK_FF_APPLY: 'CHZZK_FF_APPLY',

  // Multiview (web ↔ extension)
  CMV_SUBSCRIBE_LATENCY: 'CMV_SUBSCRIBE_LATENCY',
  CMV_UNSUBSCRIBE_LATENCY: 'CMV_UNSUBSCRIBE_LATENCY',
  CMV_LATENCY_UPDATE: 'CMV_LATENCY_UPDATE',

  CMV_FF_REQUEST: 'CMV_FF_REQUEST',

  CMV_FETCH_CHANNEL_NAME_REQUEST: 'CMV_FETCH_CHANNEL_NAME_REQUEST',
  CMV_FETCH_CHANNEL_NAME_RESPONSE: 'CMV_FETCH_CHANNEL_NAME_RESPONSE',
} as const);

export type MsgType = (typeof MSG)[keyof typeof MSG];

// -----------------------------------------------------------------------------
// Legacy global compatibility
// -----------------------------------------------------------------------------

/**
 * Preserve legacy access pattern:
 *   globalThis.CMV.MSG
 *
 * Some content / popup scripts rely on this being present
 * without ESM imports.
 */
(() => {
  const g = globalThis as any;
  g.CMV = g.CMV || {};
  g.CMV.MSG = g.CMV.MSG || MSG;
})();

// -----------------------------------------------------------------------------
// Web → Extension messages
// -----------------------------------------------------------------------------

export type CmvSubscribeLatencyMessage = {
  type: typeof MSG.CMV_SUBSCRIBE_LATENCY;
  channelId: string;
};

export type CmvUnsubscribeLatencyMessage = {
  type: typeof MSG.CMV_UNSUBSCRIBE_LATENCY;
  channelId: string;
};

export type CmvForceFFMessage = {
  type: typeof MSG.CMV_FF_REQUEST;
  channelId: string;
  marginSec?: number;
};

export type CmvFetchChannelNameRequest = {
  type: typeof MSG.CMV_FETCH_CHANNEL_NAME_REQUEST;
  channelId: string;
  requestId?: string;
};

// Aggregate: messages sent from hosted web page to extension
export type WebToExtensionMessage =
  | CmvSubscribeLatencyMessage
  | CmvUnsubscribeLatencyMessage
  | CmvForceFFMessage
  | CmvFetchChannelNameRequest;

// -----------------------------------------------------------------------------
// Extension → Web messages
// -----------------------------------------------------------------------------

export type CmvLatencyUpdateMessage = {
  type: typeof MSG.CMV_LATENCY_UPDATE;
  channelId: string;
  latencyMs: number;
  bufferedEnd: number;
  currentTime: number;
};

export type CmvFetchChannelNameResponse = {
  type: typeof MSG.CMV_FETCH_CHANNEL_NAME_RESPONSE;
  channelId: string;
  name: string | null;
  ok: boolean;
  requestId?: string;
  error?: string;
};

// Aggregate: messages sent from extension to hosted web page
export type ExtensionToWebMessage = CmvLatencyUpdateMessage | CmvFetchChannelNameResponse;
