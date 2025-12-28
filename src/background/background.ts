/**
 * @file src/background/background.ts
 *
 * @description
 * Background entry point for CZ MultiViewer extension.
 *
 * This file intentionally contains no logic.
 * Importing each module is sufficient to:
 * - register message listeners
 * - initialize background-side services
 *
 * Imported modules:
 * - latencyRouter      : relays latency / FF messages between contexts
 * - fetchChannelName   : resolves channel display names via CHZZK API
 * - cookieBridge       : manages partitioned Naver login cookies
 *
 * Notes:
 * - All side effects are executed at module load time
 * - Order is not significant
 * - This file exists to make background responsibilities explicit
 */

import '../shared/messages';
import './latencyRouter';
import './fetchChannelName';
import './cookieBridge';
